// Pipeline step 5 (prototype form): the overlay as a standalone SVG string. Pure, no I/O.
// In the extension the same primitives become lines/fills on custom overlay layers.
import { allCopper, bbox, intersect, MULTI_LAYER, type Analysis, type Board, type Finding, type Path, type Paths, type Pt, type Severity } from '@returnpath/core';

export interface ViewOptions {
  title: string;
  /** Show only chains referenced to this layer and fill its copper; undefined = overview. */
  refLayer?: number;
  pxPerMm?: number;
}

const SEV: Record<Severity, string> = { ok: '#22c55e', warn: '#f59e0b', error: '#ef4444' };
const NET_COLORS = ['#3b82f6', '#f97316', '#a855f7', '#14b8a6', '#eab308'];
const SIGNAL_COLORS = ['#fde047', '#38bdf8', '#f472b6', '#a3e635'];
const PANEL_W = 560;
const FONT = 'DejaVu Sans, Arial, sans-serif';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const f = (n: number) => (Math.round(n * 100) / 100).toString();

function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const w of text.split(' ')) {
    if ((line + ' ' + w).trim().length > max && line) {
      out.push(line);
      line = w;
    } else line = (line + ' ' + w).trim();
  }
  if (line) out.push(line);
  return out;
}

export function renderOverlay(board: Board, an: Analysis, view: ViewOptions): string {
  const s = view.pxPerMm ?? 15;
  const bb = bbox(board.outline);
  const margin = 24;
  const top = 56;
  const W = (bb.maxX - bb.minX) * s + 2 * margin;
  const H = Math.max((bb.maxY - bb.minY) * s + top + margin, 640);
  const P = (p: Pt) => [margin + (p.x - bb.minX) * s, top + (bb.maxY - p.y) * s] as const;
  const d = (paths: Paths, close = true) =>
    paths
      .filter((p) => p.length)
      .map((p) => 'M' + p.map((q) => P(q).map(f).join(' ')).join('L') + (close ? 'Z' : ''))
      .join('');
  const line = (path: Path) => d([path], false);
  const layerName = (id: number) => board.stackup.copper.find((l) => l.id === id)?.name ?? `L${id}`;
  const out: string[] = [];
  const el = (s: string) => out.push(s);

  const nets = [...new Set([...an.refCopper.values()].flatMap((lc) => [...lc.byNet.keys()]))].sort((a, b) => (a === 'GND' ? -1 : b === 'GND' ? 1 : a.localeCompare(b)));
  const netColor = (n: string) => NET_COLORS[nets.indexOf(n) % NET_COLORS.length];
  const signalLayers = [...new Set(an.chains.map((c) => c.chain.layer))];
  const sigColor = (l: number) => SIGNAL_COLORS[signalLayers.indexOf(l) % SIGNAL_COLORS.length];

  const chains = an.chains.filter((c) => view.refLayer === undefined || c.ref?.layer === view.refLayer);
  const refLayers = view.refLayer !== undefined ? [view.refLayer] : [...new Set(an.chains.map((c) => c.ref?.layer).filter((x): x is number => x !== undefined))];

  el(`<svg xmlns="http://www.w3.org/2000/svg" width="${f(W + PANEL_W)}" height="${f(H)}" viewBox="0 0 ${f(W + PANEL_W)} ${f(H)}" font-family="${FONT}">`);
  el(`<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#ef4444" fill-opacity="0.25"/><line x1="0" y1="0" x2="0" y2="6" stroke="#ef4444" stroke-width="2.5"/></pattern></defs>`);
  el(`<rect width="100%" height="100%" fill="#0b0f16"/>`);
  el(`<text x="${margin}" y="34" fill="#e5e7eb" font-size="20" font-weight="bold">${esc(view.title)}</text>`);
  el(`<path d="${d(board.outline)}" fill="#151b26" stroke="#94a3b8" stroke-width="1.5"/>`);

  // Reference copper.
  for (const rl of refLayers) {
    const lc = an.refCopper.get(rl);
    if (!lc) continue;
    const overview = view.refLayer === undefined;
    for (const [net, paths] of lc.byNet) {
      el(`<path d="${d(paths)}" fill="${netColor(net)}" fill-opacity="${overview ? 0.1 : 0.28}" stroke="${netColor(net)}" stroke-opacity="${overview ? 0.6 : 0.8}" stroke-width="1" ${overview && refLayers.indexOf(rl) > 0 ? 'stroke-dasharray="5 4"' : ''} fill-rule="evenodd"/>`);
    }
  }

  // Pads and other-net vias for context.
  for (const p of board.pads) el(`<path d="${d(p.shape)}" fill="#64748b" fill-opacity="${p.layer === MULTI_LAYER ? 0.9 : 0.6}"/>`);
  for (const v of board.vias) {
    if (v.net === an.net) continue;
    const [x, y] = P(v.at);
    el(`<circle cx="${f(x)}" cy="${f(y)}" r="${f((v.diameter / 2) * s)}" fill="${nets.includes(v.net) ? netColor(v.net) : '#64748b'}" fill-opacity="0.85" stroke="#0b0f16" stroke-width="0.5"/>`);
  }
  for (const c of board.components) {
    const [x, y] = P(c.at);
    el(`<text x="${f(x)}" y="${f(y - 0.9 * s)}" fill="#cbd5e1" font-size="11" text-anchor="middle">${esc(c.designator)}</text>`);
  }

  // ±3h bands: covered (green) / uncovered (red hatch).
  for (const c of chains) {
    if (!c.ref) continue;
    const covered = intersect(c.band, allCopper(an.refCopper.get(c.ref.layer)));
    el(`<path d="${d(covered)}" fill="#22c55e" fill-opacity="0.22" fill-rule="evenodd"/>`);
    el(`<path d="${d(c.bandUncovered)}" fill="url(#hatch)" fill-rule="evenodd"/>`);
  }

  // Detour loops beneath the traces.
  for (const c of chains)
    for (const g of c.gaps) {
      if (!g.detour) continue;
      el(`<path d="${d([g.detour.loop])}" fill="#fb923c" fill-opacity="0.18" fill-rule="evenodd"/>`);
      el(`<path d="${line(g.detour.path)}" fill="none" stroke="#fdba74" stroke-width="3" stroke-dasharray="8 4" stroke-linejoin="round"/>`);
    }

  // Signal traces.
  for (const c of an.chains) {
    const dim = !chains.includes(c);
    const w = Math.max(2, c.chain.pts.length ? board.tracks.find((t) => t.id === c.chain.trackIds[0])!.width * s : 2);
    el(`<path d="${line(c.chain.pts)}" fill="none" stroke="${sigColor(c.chain.layer)}" stroke-opacity="${dim ? 0.3 : 1}" stroke-width="${f(w)}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }

  // Gaps on the trace.
  for (const c of chains)
    for (const g of c.gaps) {
      if (g.kind === 'via-antipad') continue;
      el(`<path d="${line([g.a, g.b])}" stroke="#ef4444" stroke-width="7" stroke-linecap="round" fill="none"/>`);
      if (g.bridge) link(g.bridge.at, { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 }, SEV[g.bridge.severity], `${g.bridge.component.designator} ${g.bridge.distance.toFixed(1)} mm`, 0.7);
      if (g.detour) {
        const mid = g.detour.path[Math.floor(g.detour.path.length / 2)];
        const [x, y] = P(mid);
        label(x + 8, y + 4, `+${g.detour.extraLength.toFixed(1)} mm, +${g.detour.loopArea.toFixed(1)} mm²`, '#fdba74');
      }
    }

  // Signal vias and their return links.
  for (const vr of an.vias) {
    for (const t of vr.transitions) if (t.target) link(vr.via.at, t.target.at, SEV[t.severity], `${t.target.label.replace(/ via .*/, ' via')} ${t.distance!.toFixed(2)} mm`);
    const [x, y] = P(vr.via.at);
    el(`<circle cx="${f(x)}" cy="${f(y)}" r="${f((vr.via.diameter / 2) * s)}" fill="#0b0f16" stroke="#f8fafc" stroke-width="2"/>`);
  }

  // Finding markers.
  const shown = an.findings.filter((x) => view.refLayer === undefined || inView(x));
  shown.forEach((fd, i) => {
    const [x, y] = P(fd.at);
    el(`<circle cx="${f(x - 14)}" cy="${f(y - 14)}" r="9" fill="${SEV[fd.severity]}" stroke="#0b0f16" stroke-width="1.5"/>`);
    el(`<text x="${f(x - 14)}" y="${f(y - 10)}" fill="#0b0f16" font-size="11" font-weight="bold" text-anchor="middle">${i + 1}</text>`);
  });

  // Side panel.
  const px = W + 8;
  let py = 34;
  el(`<rect x="${f(W)}" y="0" width="${PANEL_W}" height="${f(H)}" fill="#111827"/>`);
  el(`<text x="${px + 8}" y="${py}" fill="#e5e7eb" font-size="16" font-weight="bold">Net ${esc(an.net)}: findings</text>`);
  py += 26;
  shown.forEach((fd, i) => {
    el(`<circle cx="${px + 18}" cy="${py - 4}" r="9" fill="${SEV[fd.severity]}"/>`);
    el(`<text x="${px + 18}" y="${py}" fill="#0b0f16" font-size="11" font-weight="bold" text-anchor="middle">${i + 1}</text>`);
    for (const ln of wrap(fd.message, 66)) {
      el(`<text x="${px + 34}" y="${py}" fill="#e5e7eb" font-size="12">${esc(ln)}</text>`);
      py += 16;
    }
    py += 8;
  });
  if (!shown.length) {
    el(`<text x="${px + 8}" y="${py}" fill="#22c55e" font-size="12">No findings in this view.</text>`);
    py += 24;
  }

  py += 10;
  el(`<text x="${px + 8}" y="${py}" fill="#e5e7eb" font-size="14" font-weight="bold">Legend</text>`);
  py += 20;
  const legend: [string, string][] = [
    ['band', '±3h band with reference copper (≈80% of return current)'],
    ['hatch', '±3h band without reference copper'],
    ['gap', 'trace over a gap / split (no copper under centreline)'],
    ['detour', 'geodesic return detour + added loop area'],
    ['ok', 'return via / decap within limit'],
    ['warn', 'return via / decap farther than recommended'],
    ['error', 'no return path / far beyond limit'],
  ];
  for (const [k, txt] of legend) {
    const x0 = px + 10;
    if (k === 'band') el(`<rect x="${x0}" y="${py - 10}" width="22" height="12" fill="#22c55e" fill-opacity="0.35"/>`);
    else if (k === 'hatch') el(`<rect x="${x0}" y="${py - 10}" width="22" height="12" fill="url(#hatch)"/>`);
    else if (k === 'gap') el(`<line x1="${x0}" y1="${py - 4}" x2="${x0 + 22}" y2="${py - 4}" stroke="#ef4444" stroke-width="6"/>`);
    else if (k === 'detour') el(`<line x1="${x0}" y1="${py - 4}" x2="${x0 + 22}" y2="${py - 4}" stroke="#fb923c" stroke-width="2.5" stroke-dasharray="6 3"/>`);
    else el(`<line x1="${x0}" y1="${py - 4}" x2="${x0 + 22}" y2="${py - 4}" stroke="${SEV[k as Severity]}" stroke-width="2.5"/>`);
    el(`<text x="${x0 + 30}" y="${py}" fill="#cbd5e1" font-size="12">${esc(txt)}</text>`);
    py += 18;
  }
  for (const l of signalLayers) {
    el(`<line x1="${px + 10}" y1="${py - 4}" x2="${px + 32}" y2="${py - 4}" stroke="${sigColor(l)}" stroke-width="3"/>`);
    el(`<text x="${px + 40}" y="${py}" fill="#cbd5e1" font-size="12">${esc(an.net)} on ${esc(layerName(l))}</text>`);
    py += 18;
  }
  for (const rl of refLayers) {
    for (const net of an.refCopper.get(rl)?.byNet.keys() ?? []) {
      el(`<rect x="${px + 10}" y="${py - 10}" width="22" height="12" fill="${netColor(net)}" fill-opacity="0.4" stroke="${netColor(net)}"/>`);
      el(`<text x="${px + 40}" y="${py}" fill="#cbd5e1" font-size="12">${esc(net)} copper on ${esc(layerName(rl))}</text>`);
      py += 18;
    }
  }
  py += 10;
  const stack = board.stackup;
  el(`<text x="${px + 8}" y="${py}" fill="#e5e7eb" font-size="14" font-weight="bold">Stackup</text>`);
  py += 18;
  stack.copper.forEach((l, i) => {
    el(`<text x="${px + 10}" y="${py}" fill="#cbd5e1" font-size="12">${esc(l.name)} (id ${l.id})</text>`);
    py += 15;
    const di = stack.dielectrics[i];
    if (di) {
      el(`<text x="${px + 26}" y="${py}" fill="#64748b" font-size="11">${di.thicknessMm.toFixed(3)} mm${di.er ? `, εr ${di.er}` : ''}</text>`);
      py += 15;
    }
  });

  el('</svg>');
  return out.join('\n');

  function inView(fd: Finding): boolean {
    return chains.some((c) => c.chain.pts.some((p) => Math.hypot(p.x - fd.at.x, p.y - fd.at.y) < 1e-6) || c.gaps.some((g) => Math.hypot((g.a.x + g.b.x) / 2 - fd.at.x, (g.a.y + g.b.y) / 2 - fd.at.y) < 1e-6) || c.coverage.some((cv) => Math.hypot((cv.a.x + cv.b.x) / 2 - fd.at.x, (cv.a.y + cv.b.y) / 2 - fd.at.y) < 1e-6)) || an.vias.some((v) => v.via.at.x === fd.at.x && v.via.at.y === fd.at.y);
  }
  function label(x: number, y: number, text: string, color: string) {
    const w = text.length * 6.6 + 8;
    el(`<rect x="${f(x - 4)}" y="${f(y - 12)}" width="${f(w)}" height="17" rx="3" fill="#0b0f16" fill-opacity="0.85"/>`);
    el(`<text x="${f(x)}" y="${f(y)}" fill="${color}" font-size="12">${esc(text)}</text>`);
  }
  function link(a: Pt, b: Pt, color: string, text: string, t = 0.5) {
    const [x1, y1] = P(a);
    const [x2, y2] = P(b);
    el(`<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${color}" stroke-width="2.5"/>`);
    el(`<circle cx="${f(x2)}" cy="${f(y2)}" r="5" fill="none" stroke="${color}" stroke-width="2"/>`);
    label(x1 + (x2 - x1) * t + 6, y1 + (y2 - y1) * t - 6, text, color);
  }
}
