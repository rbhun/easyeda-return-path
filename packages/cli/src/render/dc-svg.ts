// DC return-current view as a standalone SVG string. Pure, no I/O. The same layers of information
// the extension draws with indicator markers: streamlines, colour-binned density contours and the
// bottleneck, plus (per-layer views) a binned density raster that markers cannot draw.
import { bbox, DENSITY_LEVELS, densityBin, densityContours, dominantLayer, railLabel, type Board, type DcLayerField, type DcNetResult, type DcResult, type Path, type Paths, type Pt, type Streamline } from '@returnpath/core';

export interface DcViewOptions {
  title: string;
  /** Per-layer view of one net; undefined = overview of both nets on their dominant layers. */
  net?: 'supply' | 'return';
  layer?: number;
  streamlines: { supply: Streamline[]; ret: Streamline[] };
  pxPerMm?: number;
}

/** Bin colours, lowest bin first (bin 0 is below the first level). */
export const BIN_COLORS = ['#334155', '#2563eb', '#10b981', '#facc15', '#ef4444'];
export const SUPPLY_COLOR = '#fbbf24';
export const RETURN_COLOR = '#e879f9';
const PANEL_W = 520;
const FONT = 'DejaVu Sans, Arial, sans-serif';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const f = (n: number) => (Math.round(n * 100) / 100).toString();

export function renderDc(board: Board, res: DcResult, view: DcViewOptions): string {
  const s = view.pxPerMm ?? 16;
  const bb = bbox(board.outline);
  const margin = 24;
  const top = 56;
  const W = (bb.maxX - bb.minX) * s + 2 * margin;
  const H = Math.max((bb.maxY - bb.minY) * s + top + margin, 720);
  const P = (p: Pt) => [margin + (p.x - bb.minX) * s, top + (bb.maxY - p.y) * s] as const;
  const d = (paths: Paths, close = true) => paths.filter((p) => p.length).map((p) => 'M' + p.map((q) => P(q).map(f).join(' ')).join('L') + (close ? 'Z' : '')).join('');
  const line = (path: Path) => d([path], false);
  const layerName = (id: number) => board.stackup.copper.find((l) => l.id === id)?.name ?? `L${id}`;
  const out: string[] = [];
  const el = (x: string) => out.push(x);
  const { grid: g, setup } = res;
  const nets = [res.supply, res.ret].filter((x): x is DcNetResult => !!x);
  const unit = setup.normalised ? 'A/mm per A' : 'A/mm';
  const vUnit = setup.normalised ? 'mV/A' : 'mV';

  el(`<svg xmlns="http://www.w3.org/2000/svg" width="${f(W + PANEL_W)}" height="${f(H)}" viewBox="0 0 ${f(W + PANEL_W)} ${f(H)}" font-family="${FONT}">`);
  el(`<rect width="100%" height="100%" fill="#0b0f16"/>`);
  el(`<text x="${margin}" y="34" fill="#e5e7eb" font-size="20" font-weight="bold">${esc(view.title)}</text>`);
  el(`<path d="${d(board.outline)}" fill="#111827" stroke="#94a3b8" stroke-width="1.5"/>`);

  // What to show: (net, layer) pairs for the density, and which streamlines.
  const shown: { net: DcNetResult; field: DcLayerField }[] = [];
  if (view.net && view.layer !== undefined) {
    const net = view.net === 'supply' ? res.supply : res.ret;
    const field = net?.layers.find((l) => l.layer === view.layer);
    if (net && field) shown.push({ net, field });
  } else {
    for (const net of nets) shown.push({ net, field: net.layers.find((l) => l.layer === dominantLayer(net))! });
  }

  // Copper of the shown layers (faint), or a binned density raster in per-layer views.
  for (const { net, field } of shown) {
    const scale = field.peak?.j || net.fullScale;
    const raster = view.net !== undefined;
    for (let j = 0; j < g.ny; j++) {
      let i = 0;
      while (i < g.nx) {
        const c = j * g.nx + i;
        if (!(field.weight[c] > 0)) {
          i++;
          continue;
        }
        const bin = raster ? densityBin(field.j[c], scale) : -1;
        let k = i + 1;
        while (k < g.nx && field.weight[j * g.nx + k] > 0 && (raster ? densityBin(field.j[j * g.nx + k], scale) : -1) === bin) k++;
        const [x, y] = P({ x: g.x0 + i * g.cell, y: g.y0 + (j + 1) * g.cell });
        const fill = raster ? BIN_COLORS[bin] : net.role === 'supply' ? SUPPLY_COLOR : RETURN_COLOR;
        el(`<rect x="${f(x)}" y="${f(y)}" width="${f((k - i) * g.cell * s + 0.3)}" height="${f(g.cell * s + 0.3)}" fill="${fill}" fill-opacity="${raster ? (bin ? 0.85 : 0.6) : 0.08}"/>`);
        i = k;
      }
    }
  }

  // Pads for context.
  for (const p of board.pads) {
    const col = (setup.railNets ?? [setup.rail]).includes(p.net) ? SUPPLY_COLOR : p.net === setup.ground ? RETURN_COLOR : '#64748b';
    el(`<path d="${d(p.shape)}" fill="${col}" fill-opacity="0.35" stroke="${col}" stroke-opacity="0.8" stroke-width="0.8"/>`);
  }

  // Contours, one colour per bin.
  for (const { net, field } of shown) {
    const scale = field.peak?.j || net.fullScale;
    densityContours(g, field, scale).forEach((lines, k) => {
      const dash = !view.net && net.role === 'supply' ? 'stroke-dasharray="4 3"' : '';
      if (lines.length) el(`<path d="${lines.map(line).join('')}" fill="none" stroke="${BIN_COLORS[k + 1]}" stroke-width="1.6" stroke-opacity="0.95" stroke-linejoin="round" ${dash}/>`);
    });
  }

  // Vias of the two nets, sized by current.
  for (const net of nets) {
    const maxI = Math.max(1e-12, ...net.vias.map((v) => v.current));
    for (const v of net.vias) {
      const [x, y] = P(v.at);
      el(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(3 + 4 * (v.current / maxI))}" fill="#0b0f16" stroke="${net.role === 'supply' ? SUPPLY_COLOR : RETURN_COLOR}" stroke-width="1.5" stroke-opacity="${0.3 + 0.7 * (v.current / maxI)}"/>`);
    }
  }

  // Streamlines: solid on the shown layer, dashed elsewhere.
  const drawStreams = (lines: Streamline[], color: string, role: 'supply' | 'return') => {
    if (view.net && view.net !== role) return;
    for (const sl of lines)
      for (const seg of sl.segments) {
        const onLayer = view.layer === undefined || seg.layer === view.layer;
        el(`<path d="${line(seg.pts)}" fill="none" stroke="${color}" stroke-width="${onLayer ? 2.4 : 1.4}" stroke-opacity="${onLayer ? 0.95 : 0.55}" ${onLayer ? '' : 'stroke-dasharray="5 4"'} stroke-linejoin="round" stroke-linecap="round"/>`);
      }
  };
  drawStreams(view.streamlines.supply, SUPPLY_COLOR, 'supply');
  drawStreams(view.streamlines.ret, RETURN_COLOR, 'return');

  // Bottleneck markers.
  for (const { net, field } of shown) {
    const pk = field.peak;
    if (!pk) continue;
    const [x, y] = P(pk.at);
    el(`<circle cx="${f(x)}" cy="${f(y)}" r="11" fill="none" stroke="#ef4444" stroke-width="3"/>`);
    label(x + 14, y - 10, `${net.net} peak ${pk.j.toFixed(2)} ${unit}`, '#fca5a5');
  }

  for (const c of board.components) {
    const [x, y] = P(c.at);
    const role = c.id === setup.source.componentId ? 'source' : setup.loads.some((l) => l.componentId === c.id) ? 'load' : '';
    el(`<text x="${f(x)}" y="${f(y + 1.6 * s)}" fill="${role === 'source' ? '#4ade80' : role ? '#e5e7eb' : '#64748b'}" font-size="12" font-weight="${role ? 'bold' : 'normal'}" text-anchor="middle">${esc(c.designator)}${role ? ` (${role})` : ''}</text>`);
  }

  // Side panel.
  const px = W + 8;
  let py = 34;
  el(`<rect x="${f(W)}" y="0" width="${PANEL_W}" height="${f(H)}" fill="#111827"/>`);
  const text = (t: string, size = 12, color = '#cbd5e1', bold = false, x = px + 8) => {
    el(`<text x="${x}" y="${py}" fill="${color}" font-size="${size}"${bold ? ' font-weight="bold"' : ''}>${esc(t)}</text>`);
    py += size + 6;
  };
  text(`DC loop: ${railLabel(setup)} / ${setup.ground}`, 16, '#e5e7eb', true);
  text(`Source: ${setup.source.designator}`);
  text(`Loads: ${setup.loads.map((l) => `${l.designator} ${setup.normalised ? `${Math.round(l.current * 100)} %` : `${(l.current * 1000).toFixed(0)} mA`}`).join(', ')}`);
  if (setup.normalised) text('No load currents given: 1 A total, split equally.', 11, '#94a3b8');
  py += 6;
  for (const net of nets) {
    text(`${net.net} (${net.role === 'supply' ? 'forward' : 'return'}): drop ${(net.drop * 1000).toFixed(2)} ${vUnit}`, 13, net.role === 'supply' ? SUPPLY_COLOR : RETURN_COLOR, true);
    const total = net.layers.reduce((a, l) => a + l.flow, 0) || 1;
    for (const l of net.layers.filter((x) => x.flow / total > 0.005))
      text(`${layerName(l.layer)}: ${Math.round((100 * l.flow) / total)} % of flow, peak ${(l.peak?.j ?? 0).toFixed(3)} ${unit}`, 11, '#cbd5e1', false, px + 18);
    if (net.bottleneck) text(`Bottleneck: ${layerName(net.bottleneck.layer)} at (${net.bottleneck.at.x.toFixed(1)}, ${net.bottleneck.at.y.toFixed(1)}) mm`, 11, '#fca5a5', false, px + 18);
    py += 4;
  }
  py += 6;
  text(view.net ? 'Density bins (raster and contours)' : `Density contours (${railLabel(setup)} dashed, ${setup.ground} solid)`, 14, '#e5e7eb', true);
  for (const { net, field } of shown) {
    const scale = field.peak?.j || net.fullScale;
    text(`${net.net} on ${layerName(field.layer)} (100 % = ${scale.toFixed(3)} ${unit})`, 11, '#94a3b8');
    const edges = [0, ...DENSITY_LEVELS, Infinity];
    for (let k = 0; k < BIN_COLORS.length; k++) {
      el(`<rect x="${px + 18}" y="${py - 10}" width="22" height="12" fill="${BIN_COLORS[k]}"/>`);
      text(`${Math.round(edges[k] * 100)}${edges[k + 1] === Infinity ? '+ %' : `–${Math.round(edges[k + 1] * 100)} %`}${k ? '' : ' (raster only)'}`, 11, '#cbd5e1', false, px + 48);
    }
  }
  py += 6;
  text('Legend', 14, '#e5e7eb', true);
  for (const [color, t, dash] of [[SUPPLY_COLOR, `${railLabel(setup)} streamlines, source → loads`, false], [RETURN_COLOR, `${setup.ground} streamlines, loads → source`, false], ['#94a3b8', 'dashed: streamline on another layer', true]] as const) {
    el(`<line x1="${px + 18}" y1="${py - 4}" x2="${px + 40}" y2="${py - 4}" stroke="${color}" stroke-width="2.5" ${dash ? 'stroke-dasharray="5 3"' : ''}/>`);
    text(t, 11, '#cbd5e1', false, px + 48);
  }
  el(`<circle cx="${px + 29}" cy="${py - 4}" r="6" fill="none" stroke="#ef4444" stroke-width="2.5"/>`);
  text('peak density away from pads and vias', 11, '#cbd5e1', false, px + 48);
  text('circles at vias: barrel current (bigger = more)', 11, '#cbd5e1', false, px + 48);
  py += 6;
  text(`Raster ${g.cell} mm; copper ${[...res.thickness].map(([id, t]) => `${layerName(id)} ${(t * 1000).toFixed(1)} µm`).join(', ')}`, 10, '#64748b');
  for (const w of res.warnings.slice(0, 6)) for (const ln of wrap(`warning: ${w}`, 80)) text(ln, 10, '#f59e0b');

  el('</svg>');
  return out.join('\n');

  function label(x: number, y: number, t: string, color: string) {
    const w = t.length * 6.6 + 8;
    el(`<rect x="${f(x - 4)}" y="${f(y - 12)}" width="${f(w)}" height="17" rx="3" fill="#0b0f16" fill-opacity="0.85"/>`);
    el(`<text x="${f(x)}" y="${f(y)}" fill="${color}" font-size="12">${esc(t)}</text>`);
  }
}

function wrap(t: string, max: number): string[] {
  const out: string[] = [];
  let ln = '';
  for (const w of t.split(' ')) {
    if ((ln + ' ' + w).trim().length > max && ln) {
      out.push(ln);
      ln = w;
    } else ln = (ln + ' ' + w).trim();
  }
  if (ln) out.push(ln);
  return out;
}
