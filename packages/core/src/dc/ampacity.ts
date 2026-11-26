// Whether a trace, a pour neck or a via is too narrow for the current it carries.
// IPC-2221A chart formula, I = k · ΔT^0.44 · A^0.725, with A the copper cross-section in mil²:
// k = 0.048 on an outer layer, 0.024 on an inner layer. The check uses a 10°C rise.
import { distPointSeg } from '../geom.js';
import type { Board, Pt, Track } from '../types.js';
import { cellCentre, cellOf, inGrid, type Grid } from './raster.js';
import type { DcLayerField, DcNetResult } from './solve.js';

const RISE_C = 10;
const MIL = 0.0254;
/** Ignore solver dust. A real trace below this current is still checked by the width formula when it carries more. */
const MIN_A = 0.02;
/** Raster j is noisy at edges; flag only a clear shortfall. */
const SLACK = 0.85;

/** Trace width IPC-2221 allows for this current and copper thickness, mm. */
export function ipc2221WidthMm(currentA: number, thicknessMm: number, external: boolean, riseC = RISE_C): number {
  if (!(currentA > 0) || !(thicknessMm > 0)) return 0;
  const k = external ? 0.048 : 0.024;
  const areaMil2 = (currentA / (k * riseC ** 0.44)) ** (1 / 0.725);
  return (areaMil2 / (thicknessMm / MIL)) * MIL;
}

/** Current IPC-2221 allows through this copper cross-section, A. */
export function ipc2221CurrentA(areaMm2: number, external: boolean, riseC = RISE_C): number {
  if (!(areaMm2 > 0)) return 0;
  const k = external ? 0.048 : 0.024;
  return k * riseC ** 0.44 * (areaMm2 / (MIL * MIL)) ** 0.725;
}

function externalLayer(board: Board, layerId: number): boolean {
  const copper = board.stackup.copper;
  const layer = copper.find((l) => l.id === layerId);
  return !!layer && (layer.index === 0 || layer.index === copper.length - 1);
}

function layerName(board: Board, layerId: number): string {
  return board.stackup.copper.find((l) => l.id === layerId)?.name ?? `L${layerId}`;
}

function perAmp(normalised: boolean): string {
  return normalised ? ' per amp of load current' : '';
}

/** Current in one track, from the sheet density along its middle. j is A/mm, so I = j · width. */
function trackCurrent(g: Grid, field: DcLayerField, track: Track): number | undefined {
  const dx = track.b.x - track.a.x;
  const dy = track.b.y - track.a.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 0) || !(track.width > 0)) return undefined;
  const steps = Math.max(1, Math.round(len / g.cell));
  const js: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (steps > 2 && (t < 0.2 || t > 0.8)) continue;
    const [ci, cj] = cellOf(g, { x: track.a.x + dx * t, y: track.a.y + dy * t });
    if (!inGrid(g, ci, cj)) continue;
    const c = cj * g.nx + ci;
    if (field.weight[c] > 0 && field.j[c] > 0) js.push(field.j[c]);
  }
  if (!js.length) return undefined;
  js.sort((a, b) => a - b);
  return js[Math.floor(js.length / 2)] * track.width;
}

/**
 * Copper width and current across the bottleneck, perpendicular to the flow.
 * j is A per mm of copper width and already divided by the cell's fill, so a step of
 * (fill · cell) mm contributes j times that to the current.
 */
function neck(g: Grid, f: DcLayerField, c: number): { width: number; current: number } {
  const jx = f.jx[c];
  const jy = f.jy[c];
  const mag = Math.hypot(jx, jy) || 1;
  const px = -jy / mag;
  const py = jx / mag;
  const ci = c % g.nx;
  const origin = cellCentre(g, ci, (c - ci) / g.nx);
  const peak = f.j[c];
  let width = 0;
  let current = 0;
  const seen = new Set<number>();
  for (const sign of [-1, 1]) {
    for (let s = 0; s < 400; s++) {
      if (sign < 0 && s === 0) continue;
      const dist = sign * s * g.cell;
      const [i, j] = cellOf(g, { x: origin.x + px * dist, y: origin.y + py * dist });
      if (!inGrid(g, i, j)) break;
      const k = j * g.nx + i;
      if (seen.has(k) || !(f.weight[k] > 0)) break;
      if (s > 0 && f.j[k] < peak * 0.3) break;
      seen.add(k);
      const dw = f.weight[k] * g.cell;
      width += dw;
      current += f.j[k] * dw;
    }
  }
  return { width, current };
}

function onTrack(tracks: Track[], at: Pt, slack: number): boolean {
  return tracks.some((t) => distPointSeg(at, t.a, t.b) <= t.width / 2 + slack);
}

function ringArea(drill: number, platingMm: number): number {
  const r = drill / 2;
  const ri = Math.max(0, r - platingMm);
  return Math.PI * (r * r - ri * ri);
}

/**
 * Warnings for copper that cannot carry its current at a 10°C rise: a track narrower than IPC-2221
 * allows, a pour neck (the bottleneck) the same way, and a via barrel whose plating cannot.
 */
export function narrowWarnings(board: Board, g: Grid, net: DcNetResult, nets: string[], thickness: Map<number, number>, platingMm: number, normalised: boolean): string[] {
  const out: string[] = [];
  const suffix = perAmp(normalised);
  const tracks = board.tracks.filter((t) => nets.includes(t.net));
  const narrowTracks: { worse: number; text: string }[] = [];
  for (const track of tracks) {
    const field = net.layers.find((l) => l.layer === track.layer);
    const thick = thickness.get(track.layer);
    if (!field || !(thick && thick > 0)) continue;
    const current = trackCurrent(g, field, track);
    if (current === undefined || current < MIN_A) continue;
    const external = externalLayer(board, track.layer);
    const need = ipc2221WidthMm(current, thick, external);
    if (!(need > 0) || track.width >= need * SLACK) continue;
    narrowTracks.push({
      worse: need / track.width,
      text: `${net.net}: ${track.width.toFixed(2)} mm track on ${layerName(board, track.layer)} carries ${current.toFixed(2)} A${suffix}, narrower than the ${need.toFixed(2)} mm IPC-2221 allows for a 10°C rise.`,
    });
  }
  narrowTracks.sort((a, b) => b.worse - a.worse);
  const shown = narrowTracks.slice(0, 4).map((t) => t.text);
  if (narrowTracks.length > 4) shown.push(`${net.net}: and ${narrowTracks.length - 4} more tracks narrower than IPC-2221 allows for a 10°C rise.`);
  out.push(...shown);

  const peak = net.bottleneck;
  if (peak && !onTrack(tracks, peak.at, g.cell)) {
    const field = net.layers.find((l) => l.layer === peak.layer);
    const thick = thickness.get(peak.layer);
    if (field && thick && thick > 0) {
      const [i, j] = cellOf(g, peak.at);
      if (inGrid(g, i, j)) {
        const cut = neck(g, field, j * g.nx + i);
        const external = externalLayer(board, peak.layer);
        const need = ipc2221WidthMm(cut.current, thick, external);
        if (cut.current >= MIN_A && need > 0 && cut.width < need * SLACK)
          out.push(`${net.net}: choke at (${peak.at.x.toFixed(1)}, ${peak.at.y.toFixed(1)}) mm on ${layerName(board, peak.layer)} is ${cut.width.toFixed(2)} mm of copper carrying ${cut.current.toFixed(2)} A${suffix}; IPC-2221 allows that in ${need.toFixed(2)} mm for a 10°C rise.`);
      }
    }
  }

  const through = board.stackup.copper.length > 2;
  for (const flow of net.vias) {
    if (flow.current < MIN_A) continue;
    const via = board.vias.find((v) => v.id === flow.id);
    const hole = board.pads.find((p) => p.id === flow.id && p.holeDiameter > 0);
    const drill = via ? (via.drill > 0 ? via.drill : via.diameter / 2) : hole?.holeDiameter;
    if (!(drill && drill > 0)) continue;
    const allow = ipc2221CurrentA(ringArea(drill, platingMm), !through);
    // Plating thickness is assumed, so a via just over the chart is not called too narrow.
    if (allow > 0 && flow.current > allow * 1.25)
      out.push(`${net.net}: via at (${flow.at.x.toFixed(1)}, ${flow.at.y.toFixed(1)}) mm carries ${flow.current.toFixed(2)} A${suffix} in a ${drill.toFixed(2)} mm drill; IPC-2221 allows ${allow.toFixed(2)} A for a 10°C rise.`);
  }
  return out;
}
