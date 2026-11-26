// Where the return current of a stretch of trace runs: the path of least loop inductance through
// its reference copper, found on a grid in a corridor round the trace. Under a plane that is the
// strip under the trace; in a coplanar pour it is the nearest pour edge that carries on, so a strip
// that ends gets no current, and the return changes side only where that adds less than staying.
import type { Steps } from './budget.js';
import { dist, distPointSeg, Polyline } from './geom.js';
import type { Path, Pt } from './types.js';

export interface FlowArgs {
  /** p lies in reference copper the return can flow in. */
  inCopper: (p: Pt) => boolean;
  /** The whole trace; the stretch is s0..s1 along it. */
  line: Polyline;
  s0: number;
  s1: number;
  halfWidth: number;
  /** Height of the reference copper above or below the trace's layer, mm (0 when coplanar). */
  h: number;
  /** How far from the trace the return is looked for, mm. */
  corridor: number;
  /** Where the return comes from and goes to; null: anywhere across the trace at that end. */
  from: Pt | null;
  to: Pt | null;
  maxCells?: number;
}

const CELL = 0.05;
/** μ0 / 2π in nH/mm. */
const MU = 0.2;
/** Per-mm cost floor, so that right under the trace the shorter way still wins, nH/mm. */
const FLOOR = 0.01;
/** An open end of the return takes in copper up to this much further from the trace's end than the nearest, mm. */
const END_SPREAD = 0.15;
/** Leeway on how far along the trace one step may move, mm. */
const JUMP_SLACK = 0.2;
/** Longest straight piece the drawn path is pulled into, mm. */
const PULL = 3;

/**
 * The least-inductance path for a stretch of trace: each step costs (μ0/2π)·ln(1 + (s² + h²)/r²)
 * per mm at lateral distance s from the trace (r its half width), as in pathInductance. Cells must
 * be copper with copper on all four sides, so the path keeps a cell inside the copper edge. Null
 * when no path joins the ends within the corridor, or the corridor is too large.
 */
export function* leastInductancePath(a: FlowArgs): Steps<Path | null> {
  const tick = { phase: 'return path' } as const;
  const { line, s0, s1, corridor } = a;
  const piece = line.slice(s0, s1);
  const xs = piece.map((p) => p.x);
  const ys = piece.map((p) => p.y);
  const minX = Math.min(...xs) - corridor;
  const minY = Math.min(...ys) - corridor;
  const nx = Math.ceil((Math.max(...xs) + corridor - minX) / CELL) + 1;
  const ny = Math.ceil((Math.max(...ys) + corridor - minY) / CELL) + 1;
  if (nx * ny > (a.maxCells ?? 4_000_000)) return null;
  const centre = (i: number): Pt => ({ x: minX + (i % nx) * CELL, y: minY + Math.floor(i / nx) * CELL });

  // The corridor: cells within `corridor` of a segment of the stretch.
  const near = new Uint8Array(nx * ny);
  for (let k = 1; k < piece.length; k++) {
    const [p, q] = [piece[k - 1], piece[k]];
    const x0 = Math.max(0, Math.floor((Math.min(p.x, q.x) - corridor - minX) / CELL));
    const x1 = Math.min(nx - 1, Math.ceil((Math.max(p.x, q.x) + corridor - minX) / CELL));
    const y0 = Math.max(0, Math.floor((Math.min(p.y, q.y) - corridor - minY) / CELL));
    const y1 = Math.min(ny - 1, Math.ceil((Math.max(p.y, q.y) + corridor - minY) / CELL));
    for (let y = y0; y <= y1; y++) {
      if (y % 64 === 0) yield tick;
      for (let x = x0; x <= x1; x++) {
        const i = y * nx + x;
        if (!near[i] && distPointSeg(centre(i), p, q) <= corridor) near[i] = 1;
      }
    }
  }

  const copper = new Uint8Array(nx * ny);
  const weight = new Float64Array(nx * ny);
  const along = new Float64Array(nx * ny);
  const off = new Float64Array(nx * ny);
  const r2 = Math.max(a.halfWidth, 0.05) ** 2;
  let cells = 0;
  let found = false;
  for (let i = 0; i < nx * ny; i++) {
    if (!near[i]) continue;
    if (++cells % 2048 === 0) yield tick;
    const p = centre(i);
    if (!a.inCopper(p)) continue;
    const s = line.project(p);
    const d = dist(p, line.at(s));
    copper[i] = 1;
    along[i] = s;
    off[i] = d;
    weight[i] = MU * Math.log(1 + (d * d + a.h * a.h) / r2) + FLOOR;
    found = true;
  }
  if (!found) return null;
  const ok = new Uint8Array(nx * ny);
  for (let i = 0; i < nx * ny; i++) {
    const [x, y] = [i % nx, Math.floor(i / nx)];
    if (copper[i] && x > 0 && y > 0 && x < nx - 1 && y < ny - 1 && copper[i - 1] && copper[i + 1] && copper[i - nx] && copper[i + nx]) ok[i] = 1;
  }
  const cellOf = (p: Pt) => {
    const x = Math.round((p.x - minX) / CELL);
    const y = Math.round((p.y - minY) / CELL);
    return x < 0 || y < 0 || x >= nx || y >= ny ? -1 : y * nx + x;
  };
  const nearest = (p: Pt) => {
    let best = -1;
    let bd = Infinity;
    const c = cellOf(p);
    if (c < 0) return -1;
    for (let dy = -12; dy <= 12; dy++)
      for (let dx = -12; dx <= 12; dx++) {
        const i = c + dy * nx + dx;
        if (i < 0 || i >= nx * ny || !ok[i]) continue;
        const d = dist(centre(i), p);
        if (d < bd) [best, bd] = [i, d];
      }
    return best;
  };
  // A given end joins at the copper cell nearest it; an open end at the copper nearest the trace's end there.
  const ends = (p: Pt | null, atStart: boolean): number[] => {
    if (p) {
      const i = nearest(p);
      return i < 0 ? [] : [i];
    }
    const e = line.at(atStart ? s0 : s1);
    const d = new Float64Array(nx * ny).fill(Infinity);
    let m = Infinity;
    for (let i = 0; i < nx * ny; i++)
      if (ok[i]) {
        d[i] = dist(centre(i), e);
        m = Math.min(m, d[i]);
      }
    const out: number[] = [];
    for (let i = 0; i < nx * ny; i++) if (d[i] <= m + END_SPREAD) out.push(i);
    return out;
  };
  const sources = ends(a.from, true);
  const targets = new Set(ends(a.to, false));
  if (!sources.length || !targets.size) return null;

  // Image current runs under the part of the trace it mirrors: a step may not jump to another stretch
  // of the trace (across a meander), only as far along it as its distance from the trace allows.
  const follows = (i: number, j: number, l: number) => Math.abs(along[j] - along[i]) <= 2 * Math.max(off[i], off[j]) + l + JUMP_SLACK;

  // Dijkstra on 8 neighbours; a diagonal step needs both cells beside it.
  const cost = new Float64Array(nx * ny).fill(Infinity);
  const prev = new Int32Array(nx * ny).fill(-1);
  const heap = new MinHeap();
  for (const sIdx of sources) {
    cost[sIdx] = 0;
    heap.push(sIdx, 0);
  }
  const steps: [number, number, number][] = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ];
  let hit = -1;
  for (let n = 0; heap.size; n++) {
    if (n % 4096 === 0) yield tick;
    const [i, c] = heap.pop();
    if (c > cost[i]) continue;
    if (targets.has(i)) {
      hit = i;
      break;
    }
    const [x, y] = [i % nx, Math.floor(i / nx)];
    for (const [dx, dy, l] of steps) {
      const [qx, qy] = [x + dx, y + dy];
      if (qx < 0 || qy < 0 || qx >= nx || qy >= ny) continue;
      const j = qy * nx + qx;
      if (!ok[j] || (dx && dy && (!ok[y * nx + qx] || !ok[qy * nx + x])) || !follows(i, j, l * CELL)) continue;
      const nc = c + l * CELL * 0.5 * (weight[i] + weight[j]);
      if (nc < cost[j]) {
        cost[j] = nc;
        prev[j] = i;
        heap.push(j, nc);
      }
    }
  }
  if (hit < 0) return null;
  const idx: number[] = [];
  for (let i = hit; i >= 0; i = prev[i]) idx.push(i);
  idx.reverse();

  // Pull the staircase into straight pieces that stay on the path's cells' copper and cost no more.
  const wAt = (p: Pt) => {
    const i = cellOf(p);
    return i >= 0 ? weight[i] : Infinity;
  };
  const pts = idx.map(centre);
  const pathCost = [0];
  for (let k = 1; k < idx.length; k++) pathCost.push(pathCost[k - 1] + dist(pts[k - 1], pts[k]) * 0.5 * (weight[idx[k - 1]] + weight[idx[k]]));
  const straight = (p: Pt, q: Pt) => {
    const n = Math.max(1, Math.ceil(dist(p, q) / (CELL / 2)));
    let c = 0;
    let last = -1;
    for (let k = 0; k <= n; k++) {
      const r = { x: p.x + ((q.x - p.x) * k) / n, y: p.y + ((q.y - p.y) * k) / n };
      const i = cellOf(r);
      if (i < 0 || !ok[i] || (last >= 0 && !follows(last, i, dist(centre(last), centre(i))))) return Infinity;
      last = i;
      if (k) c += (dist(p, q) / n) * wAt(r);
    }
    return c;
  };
  const out: Path = [pts[0]];
  const reach = Math.round(PULL / CELL);
  for (let i = 0; i < pts.length - 1; ) {
    yield tick;
    let j = Math.min(pts.length - 1, i + reach);
    for (; j > i + 1; j--) if (straight(pts[i], pts[j]) <= (pathCost[j] - pathCost[i]) * 1.001 + 1e-9) break;
    out.push(pts[j]);
    i = j;
  }
  if (a.from) out.unshift(a.from);
  if (a.to) out.push(a.to);
  return out;
}

class MinHeap {
  private readonly ids: number[] = [];
  private readonly keys: number[] = [];
  get size() {
    return this.ids.length;
  }
  push(id: number, key: number) {
    const { ids, keys } = this;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p];
      keys[i] = keys[p];
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop(): [number, number] {
    const { ids, keys } = this;
    const top: [number, number] = [ids[0], keys[0]];
    const id = ids.pop()!;
    const key = keys.pop()!;
    if (ids.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= ids.length) break;
        const r = l + 1;
        const c = r < ids.length && keys[r] < keys[l] ? r : l;
        if (keys[c] >= key) break;
        ids[i] = ids[c];
        keys[i] = keys[c];
        i = c;
      }
      ids[i] = id;
      keys[i] = key;
    }
    return top;
  }
}
