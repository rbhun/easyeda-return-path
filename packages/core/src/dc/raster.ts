// Copper rasterisation for the DC solve. Each cell holds a copper fill weight in [0, 1]: 1 for
// cells whose centre lies in copper, w/cell for the centreline cells of tracks narrower than a cell
// (so a thin track keeps its true resistance per length and stays 4-connected).
import { distPointSeg } from '../geom.js';
import { MULTI_LAYER, type Board, type Paths, type Pt } from '../types.js';

export interface Grid {
  x0: number;
  y0: number;
  cell: number;
  nx: number;
  ny: number;
}

export const cellCentre = (g: Grid, i: number, j: number): Pt => ({ x: g.x0 + (i + 0.5) * g.cell, y: g.y0 + (j + 0.5) * g.cell });
export const cellOf = (g: Grid, p: Pt): [number, number] => [Math.floor((p.x - g.x0) / g.cell), Math.floor((p.y - g.y0) / g.cell)];
export const inGrid = (g: Grid, i: number, j: number) => i >= 0 && j >= 0 && i < g.nx && j < g.ny;

/** Even-odd scanline fill of a region (Clipper-style paths) at cell centres. */
export function fillPaths(g: Grid, w: Float32Array, paths: Paths, value = 1): void {
  if (!paths.length) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of paths) for (const q of p) {
    minY = Math.min(minY, q.y);
    maxY = Math.max(maxY, q.y);
  }
  const j0 = Math.max(0, Math.floor((minY - g.y0) / g.cell - 0.5));
  const j1 = Math.min(g.ny - 1, Math.ceil((maxY - g.y0) / g.cell - 0.5));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const y = g.y0 + (j + 0.5) * g.cell;
    xs.length = 0;
    for (const p of paths) {
      for (let a = 0, b = p.length - 1; a < p.length; b = a++) {
        const pa = p[a];
        const pb = p[b];
        if (pa.y > y !== pb.y > y) xs.push(pa.x + ((y - pa.y) * (pb.x - pa.x)) / (pb.y - pa.y));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - g.x0) / g.cell - 0.5));
      const i1 = Math.min(g.nx - 1, Math.floor((xs[k + 1] - g.x0) / g.cell - 0.5));
      for (let i = i0; i <= i1; i++) {
        const c = j * g.nx + i;
        if (w[c] < value) w[c] = value;
      }
    }
  }
}

/** Cells a segment passes through, 4-connected (supercover traversal). */
export function supercover(g: Grid, a: Pt, b: Pt, visit: (i: number, j: number) => void): void {
  let [i, j] = cellOf(g, a);
  const [ie, je] = cellOf(g, b);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const si = Math.sign(dx);
  const sj = Math.sign(dy);
  const tdx = si ? g.cell / Math.abs(dx) : Infinity;
  const tdy = sj ? g.cell / Math.abs(dy) : Infinity;
  let tx = si ? ((si > 0 ? g.x0 + (i + 1) * g.cell : g.x0 + i * g.cell) - a.x) / dx : Infinity;
  let ty = sj ? ((sj > 0 ? g.y0 + (j + 1) * g.cell : g.y0 + j * g.cell) - a.y) / dy : Infinity;
  const n = Math.abs(ie - i) + Math.abs(je - j);
  for (let k = 0; k <= n; k++) {
    if (inGrid(g, i, j)) visit(i, j);
    if (tx < ty) {
      tx += tdx;
      i += si;
    } else {
      ty += tdy;
      j += sj;
    }
  }
}

const SUB = 8;

/** Track as a round-ended stroke: each cell gets the fraction of its 8×8 sub-samples inside the stroke. */
export function fillTrack(g: Grid, w: Float32Array, a: Pt, b: Pt, width: number): void {
  const r = width / 2;
  const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - r - g.x0) / g.cell));
  const i1 = Math.min(g.nx - 1, Math.floor((Math.max(a.x, b.x) + r - g.x0) / g.cell));
  const j0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - r - g.y0) / g.cell));
  const j1 = Math.min(g.ny - 1, Math.floor((Math.max(a.y, b.y) + r - g.y0) / g.cell));
  const p: Pt = { x: 0, y: 0 };
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      let n = 0;
      for (let sj = 0; sj < SUB; sj++)
        for (let si = 0; si < SUB; si++) {
          p.x = g.x0 + (i + (si + 0.5) / SUB) * g.cell;
          p.y = g.y0 + (j + (sj + 0.5) / SUB) * g.cell;
          if (distPointSeg(p, a, b) <= r) n++;
        }
      const c = j * g.nx + i;
      if (n && w[c] < n / (SUB * SUB)) w[c] = n / (SUB * SUB);
    }
  // Keep tracks narrower than a cell 4-connected along their centreline.
  const thin = Math.min(1, width / g.cell);
  supercover(g, a, b, (i, j) => {
    const c = j * g.nx + i;
    if (!(w[c] > 0)) w[c] = thin;
  });
}

export function markPoint(g: Grid, w: Float32Array, p: Pt): void {
  const [i, j] = cellOf(g, p);
  if (inGrid(g, i, j)) w[j * g.nx + i] = 1;
}

/**
 * Copper of one net on one copper layer: pour/plane fills (`fills`, already per net), tracks,
 * pads and vias of the net.
 */
export function rasterNet(board: Board, g: Grid, net: string, layer: number, fills: Paths | undefined): Float32Array {
  const w = new Float32Array(g.nx * g.ny);
  if (fills) fillPaths(g, w, fills);
  for (const t of board.tracks) if (t.net === net && t.layer === layer) fillTrack(g, w, t.a, t.b, t.width);
  for (const p of board.pads) {
    if (p.net !== net || (p.layer !== layer && p.layer !== MULTI_LAYER)) continue;
    fillPaths(g, w, p.shape);
    markPoint(g, w, p.at);
  }
  for (const v of board.vias) {
    if (v.net !== net) continue;
    fillTrack(g, w, v.at, v.at, v.diameter);
    markPoint(g, w, v.at);
  }
  return w;
}

/** Cells of a pad on a layer (at least the cell under its centre). */
export function padCells(g: Grid, shape: Paths, at: Pt): number[] {
  const w = new Float32Array(g.nx * g.ny);
  fillPaths(g, w, shape);
  markPoint(g, w, at);
  const out: number[] = [];
  for (let c = 0; c < w.length; c++) if (w[c] > 0) out.push(c);
  return out;
}
