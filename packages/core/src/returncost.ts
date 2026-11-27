// One return for a signal net: the path of least loop area through the ground copper.
//
// Cost per millimetre is eps + d/h, where d is the distance to the signal and h the dielectric
// height, so walking the trace (d = 0) is almost free and any shortcut pays the area it encloses.
// A via is an edge only where that via actually touches ground copper on both layers. Small
// excursions (area under h²) are drawn back on the trace; large ones (9h² and over) are kept and flagged.
import { buildChains } from './analyze.js';
import type { Steps } from './budget.js';
import { isGroundNet, returnPads } from './dc/rails.js';
import { cellCentre, fillPaths, fillTrack, inGrid, supercover, type Grid } from './dc/raster.js';
import { guessDrivers, isPassive } from './driver.js';
import { dist, distPointSeg, pointInPaths, Polyline } from './geom.js';
import type { LayerCopper } from './refcopper.js';
import { MULTI_LAYER, type Board, type Pad, type Path, type Paths, type Pt, type Track } from './types.js';

const MIL = 0.0254;
/** 3 mil raster, 63 mil dielectric (a 1.6 mm two-layer board) when the stackup does not say. */
export const DEFAULT_GRID_MM = 3 * MIL;
export const DEFAULT_HEIGHT_MM = 63 * MIL;
export const DEFAULT_EPS = 0.02;

export interface ReturnCostOptions {
  /** Raster pitch, mm. */
  gridMm: number;
  /** Dielectric height for the loop-area cost, mm. 0: read the stackup, else 1.6 mm. */
  heightMm: number;
  /** Added to d/h. Following the trace then costs this per millimetre. */
  eps: number;
  /** Designators that drive the net. Empty: guessed from the pin names. */
  drivers?: string[];
}

export interface CostMark {
  at: Pt;
  kind: 'minor' | 'flagged';
  /** Extra enclosed area, mm². */
  area: number;
}

export interface CostVia {
  at: Pt;
  fromLayer: number;
  toLayer: number;
  /** Lateral distance from the signal, mm. */
  distance: number;
}

export interface CostTrace {
  layer: number;
  signalLayer: number;
  pts: Path;
  detour?: boolean;
}

export interface CostReport {
  traces: CostTrace[];
  marks: CostMark[];
  vias: CostVia[];
  /** Drawn length, mm. */
  length: number;
  /** One line per detour, minor cut and layer change, for the result list. */
  notes: { severity: 'ok' | 'warn' | 'error'; kind: string; message: string; at: Pt }[];
}

interface GLayer {
  id: number;
  z: number;
  copper: Uint8Array;
}

const BIG = 1e12;

/** Squared-distance transform of one row or column. f holds 0 on a feature and BIG elsewhere. */
function dist1(f: Float64Array, out: Float64Array): void {
  const n = f.length;
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  const sep = (i: number, q: number) => ((f[q] + q * q) - (f[i] + i * i)) / (2 * q - 2 * i);
  for (let q = 1; q < n; q++) {
    let s = sep(v[k], q);
    while (k > 0 && s <= z[k]) s = sep(v[--k], q);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dx = q - v[k];
    out[q] = dx * dx + f[v[k]];
  }
}

/** Euclidean distance in mm from every cell to the nearest seeded cell. */
function distanceMap(seed: Uint8Array, g: Grid): Float32Array {
  const { nx, ny } = g;
  const tmp = new Float64Array(nx * ny);
  const row = new Float64Array(Math.max(nx, ny));
  const out1 = new Float64Array(Math.max(nx, ny));
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) row[i] = seed[j * nx + i] ? 0 : BIG;
    dist1(row.subarray(0, nx) as Float64Array, out1.subarray(0, nx) as Float64Array);
    for (let i = 0; i < nx; i++) tmp[j * nx + i] = out1[i];
  }
  const d = new Float32Array(nx * ny);
  const col = new Float64Array(ny);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) col[j] = tmp[j * nx + i];
    dist1(col, out1.subarray(0, ny) as Float64Array);
    for (let j = 0; j < ny; j++) d[j * nx + i] = out1[j] >= BIG / 2 ? 1e4 : Math.sqrt(out1[j]) * g.cell;
  }
  return d;
}

class Heap {
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

function bounds(board: Board, tracks: Track[]): { minX: number; minY: number; maxX: number; maxY: number } {
  const pts = board.outline.flat();
  const src = pts.length ? pts : [...tracks.flatMap((t) => [t.a, t.b])];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of src) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}

function copperPaths(board: Board, ref: Map<number, LayerCopper>, layer: number, nets: Set<string>): Paths {
  const pours = board.pours.filter((p) => p.layer === layer && nets.has(p.net));
  if (pours.some((p) => p.poured)) return pours.flatMap((p) => p.poured ?? []);
  const parts: Paths = [];
  for (const n of nets) {
    const c = ref.get(layer)?.byNet.get(n);
    if (c) parts.push(...c);
  }
  return parts;
}

/** Ground pours the return can flow in: the reference nets that are ground, else the reference nets. */
function groundNets(board: Board): Set<string> {
  const pourNets = [...new Set(board.pours.map((p) => p.net))];
  const grounds = pourNets.filter((n) => isGroundNet(n));
  return new Set(grounds.length ? grounds : pourNets);
}

function heightBetween(board: Board, signalLayer: number, groundLayers: number[], override: number): { h: number; thickness: number } {
  const zOf = (id: number) => board.stackup.copper.find((l) => l.id === id)?.z ?? 0;
  const zs = board.stackup.copper.map((l) => l.z);
  const span = zs.length ? Math.max(...zs) - Math.min(...zs) : 0;
  let h = override;
  if (!(h > 0)) {
    const sz = zOf(signalLayer);
    let best = Infinity;
    for (const id of groundLayers) if (id !== signalLayer) best = Math.min(best, Math.abs(zOf(id) - sz));
    h = best < Infinity && best > 0.01 ? best : span > 0.01 ? span : DEFAULT_HEIGHT_MM;
  }
  const thickness = span > 0.01 ? span : h;
  return { h, thickness };
}

interface Line {
  layer: number;
  line: Polyline;
}

function signalLines(tracks: Track[]): Line[] {
  return buildChains(tracks)
    .filter((c) => c.pts.length > 1)
    .map((c) => ({ layer: c.layer, line: new Polyline(c.pts) }));
}

function project(lines: Line[], p: Pt): { line: Line; s: number; d: number } | null {
  let best: { line: Line; s: number; d: number } | null = null;
  for (const line of lines) {
    const s = line.line.project(p);
    const d = dist(p, line.line.at(s));
    if (!best || d < best.d) best = { line, s, d };
  }
  return best;
}

/** The signal arc from a to b, in that direction, when both sit on one chain. */
function signalArc(lines: Line[], a: Pt, b: Pt): Path | null {
  let best: Path | null = null;
  let bestLen = Infinity;
  for (const { line } of lines) {
    const sa = line.project(a);
    const sb = line.project(b);
    if (dist(line.at(sa), a) > 1.2 || dist(line.at(sb), b) > 1.2) continue;
    const len = Math.abs(sb - sa);
    if (len >= bestLen) continue;
    const arc = sa <= sb ? line.slice(sa, sb) : [...line.slice(sb, sa)].reverse();
    best = arc;
    bestLen = len;
  }
  return best;
}

function straighten(pts: Path, tol: number): Path {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let far = -1;
    let md = tol;
    for (let k = i + 1; k < j; k++) {
      const d = distPointSeg(pts[k], pts[i], pts[j]);
      if (d > md) {
        md = d;
        far = k;
      }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([i, far], [far, j]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function nearestCell(g: Grid, copper: Uint8Array, at: Pt, radius: number): number {
  const i0 = Math.max(0, Math.floor((at.x - radius - g.x0) / g.cell));
  const i1 = Math.min(g.nx - 1, Math.ceil((at.x + radius - g.x0) / g.cell));
  const j0 = Math.max(0, Math.floor((at.y - radius - g.y0) / g.cell));
  const j1 = Math.min(g.ny - 1, Math.ceil((at.y + radius - g.y0) / g.cell));
  let best = -1;
  let bd = Infinity;
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const c = j * g.nx + i;
      if (!copper[c]) continue;
      const d = dist(cellCentre(g, i, j), at);
      if (d <= radius && d < bd) {
        bd = d;
        best = c;
      }
    }
  return best;
}

function padCells(g: Grid, copper: Uint8Array, pad: Pad): number[] {
  let minX = pad.at.x - 0.4;
  let minY = pad.at.y - 0.4;
  let maxX = pad.at.x + 0.4;
  let maxY = pad.at.y + 0.4;
  for (const path of pad.shape)
    for (const p of path) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  const i0 = Math.max(0, Math.floor((minX - g.x0) / g.cell));
  const i1 = Math.min(g.nx - 1, Math.ceil((maxX - g.x0) / g.cell));
  const j0 = Math.max(0, Math.floor((minY - g.y0) / g.cell));
  const j1 = Math.min(g.ny - 1, Math.ceil((maxY - g.y0) / g.cell));
  const inside: number[] = [];
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const c = j * g.nx + i;
      if (!copper[c]) continue;
      const p = cellCentre(g, i, j);
      if ((pad.shape.length && pointInPaths(p, pad.shape)) || dist(p, pad.at) <= Math.max(g.cell, 0.3)) inside.push(c);
    }
  if (inside.length) return inside;
  const c = nearestCell(g, copper, pad.at, 0.8);
  return c >= 0 ? [c] : [];
}

interface Raw {
  x: number;
  y: number;
  layer: number;
  d: number;
}

/** Remove loops that enter a pocket and leave through the same cell. */
function dropRevisits(pts: Raw[]): Raw[] {
  const out: Raw[] = [];
  const seen = new Map<string, number>();
  const key = (p: Raw) => `${p.layer}:${Math.round(p.x * 1000)}:${Math.round(p.y * 1000)}`;
  for (const p of pts) {
    const k = key(p);
    const prev = seen.get(k);
    if (prev !== undefined && prev < out.length - 1) {
      for (let i = prev + 1; i < out.length; i++) seen.delete(key(out[i]));
      out.length = prev + 1;
      continue;
    }
    if (prev === undefined) seen.set(k, out.length);
    out.push(p);
  }
  return out.length >= 2 ? out : pts;
}

/** The signal's tracks in order from the driver pin to the receiver pin. */
function orderTrace(tracks: Track[], from: Pt, to: Pt): Pt[] {
  const key = (p: Pt) => `${Math.round(p.x * 50)},${Math.round(p.y * 50)}`;
  const pos = new Map<string, Pt>();
  const adj = new Map<string, string[]>();
  const join = (a: Pt, b: Pt) => {
    const ka = key(a);
    const kb = key(b);
    pos.set(ka, pos.get(ka) ?? a);
    pos.set(kb, pos.get(kb) ?? b);
    if (ka === kb) return;
    (adj.get(ka) ?? adj.set(ka, []).get(ka)!).push(kb);
    (adj.get(kb) ?? adj.set(kb, []).get(kb)!).push(ka);
  };
  for (const t of tracks) join(t.a, t.b);
  let ks = '';
  let kt = '';
  let ds = Infinity;
  let dt = Infinity;
  for (const [k, p] of pos) {
    const df = dist(p, from);
    const dtgt = dist(p, to);
    if (df < ds) {
      ds = df;
      ks = k;
    }
    if (dtgt < dt) {
      dt = dtgt;
      kt = k;
    }
  }
  if (!ks || !kt) return [from, to];
  const prev = new Map<string, string | null>([[ks, null]]);
  const q = [ks];
  for (let i = 0; i < q.length && !prev.has(kt); i++)
    for (const n of adj.get(q[i]) ?? [])
      if (!prev.has(n)) {
        prev.set(n, q[i]);
        q.push(n);
      }
  if (!prev.has(kt)) return [from, to];
  const pts: Pt[] = [];
  for (let k: string | null = kt; k; k = prev.get(k) ?? null) pts.push(pos.get(k)!);
  pts.reverse();
  return pts;
}

/**
 * Least-loop-area return of `signal` through the ground copper, from the driver's ground pad to
 * the receiver end of the trace. Null when the ground copper does not join the two.
 */
export function* solveReturnCost(board: Board, signal: string, ref: Map<number, LayerCopper>, opt: ReturnCostOptions): Steps<CostReport | null> {
  const tick = { phase: 'return path' } as const;
  const tracks = board.tracks.filter((t) => t.net === signal);
  if (!tracks.length) return null;
  const allGround = groundNets(board);
  const comps = new Map(board.components.map((c) => [c.id, c]));
  const named = opt.drivers?.length ? opt.drivers : guessDrivers(board, signal).drivers;
  const driverSet = new Set(named);
  const onSignal = board.pads.filter((p) => p.net === signal && p.componentId && comps.get(p.componentId) && !isPassive(comps.get(p.componentId)!));
  const driverPad = onSignal.find((p) => driverSet.has(comps.get(p.componentId!)!.designator)) ?? onSignal[0];
  const driverComp = driverPad ? comps.get(driverPad.componentId!) : undefined;
  const own = driverComp ? board.pads.filter((p) => p.componentId === driverComp.id) : [];
  // The return starts on the driver's ground pads, and only flows in the ground those pads are on.
  const startPads: Pad[] = [];
  const nets = new Set<string>();
  for (const n of allGround) {
    const pads = returnPads(own, n).pads;
    if (!pads.length) continue;
    startPads.push(...pads);
    nets.add(n);
  }
  if (!nets.size) for (const n of allGround) nets.add(n);
  const cell = opt.gridMm > 0 ? opt.gridMm : DEFAULT_GRID_MM;
  const box = bounds(board, tracks);
  const g: Grid = {
    x0: Math.floor(box.minX / cell) * cell,
    y0: Math.floor(box.minY / cell) * cell,
    cell,
    nx: 0,
    ny: 0,
  };
  g.nx = Math.max(1, Math.ceil((box.maxX - g.x0) / cell));
  g.ny = Math.max(1, Math.ceil((box.maxY - g.y0) / cell));
  const N = g.nx * g.ny;
  yield tick;

  const layers: GLayer[] = [];
  for (const copper of board.stackup.copper) {
    const paths = copperPaths(board, ref, copper.id, nets);
    const w = new Float32Array(N);
    yield tick;
    if (paths.length) fillPaths(g, w, paths);
    for (const t of board.tracks) if (t.layer === copper.id && nets.has(t.net)) fillTrack(g, w, t.a, t.b, t.width);
    for (const p of board.pads) if ((p.layer === copper.id || p.layer === MULTI_LAYER) && p.net && nets.has(p.net)) fillPaths(g, w, p.shape.length ? p.shape : []);
    const mask = new Uint8Array(N);
    let any = false;
    for (let c = 0; c < N; c++) if (w[c] > 0) {
      mask[c] = 1;
      any = true;
    }
    if (any) layers.push({ id: copper.id, z: copper.z, copper: mask });
  }
  if (!layers.length) return null;
  yield tick;

  const seed = new Uint8Array(N);
  for (const t of tracks) supercover(g, t.a, t.b, (i, j) => (seed[j * g.nx + i] = 1));
  const dMap = distanceMap(seed, g);
  const lines = signalLines(tracks);
  const signalLayer = lines.reduce((a, b) => (a.line.length >= b.line.length ? a : b)).layer;
  const groundLayers = layers.map((l) => l.id);
  const { h, thickness } = heightBetween(board, signalLayer, groundLayers, opt.heightMm);
  const eps = opt.eps > 0 ? opt.eps : DEFAULT_EPS;

  // A via (or a through-hole ground pad) joins two layers only where ground copper touches it on both.
  const viaAt = new Map<number, { to: number; cost: number }[]>();
  const addVia = (from: number, to: number, cost: number) => {
    const list = viaAt.get(from);
    if (list) list.push({ to, cost });
    else viaAt.set(from, [{ to, cost }]);
  };
  const touch = (at: Pt, radius: number) => layers.map((l) => nearestCell(g, l.copper, at, radius));
  const link = (at: Pt, radius: number) => {
    const cells = touch(at, radius);
    const [ix, iy] = [Math.round((at.x - g.x0) / cell - 0.5), Math.round((at.y - g.y0) / cell - 0.5)];
    const dc = inGrid(g, ix, iy) ? dMap[iy * g.nx + ix] : 0;
    for (let a = 0; a < layers.length; a++)
      for (let b = a + 1; b < layers.length; b++) {
        if (cells[a] < 0 || cells[b] < 0) continue;
        const dz = Math.abs(layers[a].z - layers[b].z) || thickness;
        const cost = (dz * dc) / h;
        addVia(a * N + cells[a], b * N + cells[b], cost);
        addVia(b * N + cells[b], a * N + cells[a], cost);
      }
  };
  for (const v of board.vias) if (nets.has(v.net)) link(v.at, v.diameter / 2 + cell);
  for (const p of board.pads) if (p.layer === MULTI_LAYER && p.net && nets.has(p.net)) link(p.at, Math.max(p.holeDiameter / 2, 0.3) + cell);
  yield tick;

  // Receiver end: the signal pad at the other end of the trace.
  const receiverPad =
    onSignal.filter((p) => p !== driverPad).sort((a, b) => dist(b.at, driverPad?.at ?? a.at) - dist(a.at, driverPad?.at ?? b.at))[0] ?? null;


  const node = (li: number, c: number) => li * N + c;
  const starts: number[] = [];
  for (const pad of startPads)
    for (let li = 0; li < layers.length; li++) {
      if (pad.layer !== layers[li].id && pad.layer !== MULTI_LAYER) continue;
      for (const c of padCells(g, layers[li].copper, pad)) starts.push(node(li, c));
    }
  if (!starts.length) {
    // No ground pad to start from: the driver end of the trace, on whichever layer has copper there.
    const p0 = driverPad?.at ?? tracks[0].a;
    for (let li = 0; li < layers.length; li++) {
      const c = nearestCell(g, layers[li].copper, p0, 1.5);
      if (c >= 0) starts.push(node(li, c));
    }
  }
  const endPt = receiverPad?.at ?? tracks[tracks.length - 1].b;
  const beginPt = driverPad?.at ?? tracks[0].a;
  // Vertices in order from the driver pin to the receiver pin. A single search to the far end would
  // skip a fold of the trace, since a later part of it is also at distance zero. Each vertex is a
  // goal, so the trace is followed and a gap is only the detour between the vertices it separates.
  const waypoints = orderTrace(tracks, beginPt, endPt).filter((p, i, a) => i === 0 || dist(p, a[i - 1]) > cell);
  if (!waypoints.length) waypoints.push(endPt);
  if (dist(waypoints[waypoints.length - 1], endPt) > cell) waypoints.push(endPt);

  const steps: [number, number][] = [
    [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];
  const gScore = new Float64Array(layers.length * N);
  gScore.fill(Infinity);
  const parent = new Int32Array(layers.length * N);
  parent.fill(-1);
  const touched: number[] = [];
  const wipe = () => {
    for (const id of touched) {
      gScore[id] = Infinity;
      parent[id] = -1;
    }
    touched.length = 0;
  };
  // The goal of a vertex is the copper cell nearest to it, not every cell within that distance:
  // a wide disk would let the path arrive on a different part of the trace.
  const goalsFor = (pt: Pt, maxDist: number): { nodes: Set<number>; slack: number } | null => {
    let bestD = Infinity;
    let bestLi = -1;
    let bestC = -1;
    for (let rad = cell; bestC < 0 && rad / 2 <= maxDist + 1e-9; rad *= 2)
      for (let li = 0; li < layers.length; li++) {
        const c = nearestCell(g, layers[li].copper, pt, rad);
        if (c < 0) continue;
        const d = dist(cellCentre(g, c % g.nx, Math.floor(c / g.nx)), pt);
        if (d < bestD) {
          bestD = d;
          bestLi = li;
          bestC = c;
        }
      }
    if (bestC < 0 || bestD > maxDist) return null;
    const at = cellCentre(g, bestC % g.nx, Math.floor(bestC / g.nx));
    const nodes = new Set<number>();
    const i0 = Math.max(0, Math.floor((at.x - cell - g.x0) / cell));
    const i1 = Math.min(g.nx - 1, Math.ceil((at.x + cell - g.x0) / cell));
    const j0 = Math.max(0, Math.floor((at.y - cell - g.y0) / cell));
    const j1 = Math.min(g.ny - 1, Math.ceil((at.y + cell - g.y0) / cell));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = j * g.nx + i;
        if (layers[bestLi].copper[k] && dist(cellCentre(g, i, j), at) <= cell * 1.5) nodes.add(node(bestLi, k));
      }
    return nodes.size ? { nodes, slack: cell } : null;
  };

  const raw: Raw[] = [];
  let frontier = starts;
  for (let wi = 0; wi < waypoints.length; wi++) {
    const wp = waypoints[wi];
    // Cost against this segment only, so a later fold of the trace is not a free shortcut back to an earlier vertex.
    const sa = wi === 0 ? wp : waypoints[wi - 1];
    const sb = wi === 0 ? (waypoints[1] ?? wp) : wp;
    const segD = (p: Pt) => distPointSeg(p, sa, sb);
    if (!frontier.length) break;
    // A vertex sitting in a gap (no ground within 0.3 mm) is not a stop: the detour is between the
    // grounded vertices on either side, and diving into the nearest dead-end cell makes a hairpin.
    const goal = goalsFor(wp, wi === 0 || wi === waypoints.length - 1 ? 4 : 0.3);
    if (!goal) continue;
    wipe();
    const heap = new Heap();
    for (const s of frontier) {
      if (gScore[s] === Infinity) touched.push(s);
      gScore[s] = 0;
      parent[s] = -1;
      heap.push(s, eps * Math.max(0, dist(cellOf(g, s % N), wp) - goal.slack));
    }
    let hit = -1;
    for (let n = 0; heap.size; n++) {
      if (n % 4096 === 0) yield tick;
      const [id, f] = heap.pop();
      if (f > gScore[id] + eps * Math.max(0, dist(cellOf(g, id % N), wp) - goal.slack) + 1e-9) continue;
      if (goal.nodes.has(id)) {
        hit = id;
        break;
      }
      const li = Math.floor(id / N);
      const c = id % N;
      const x = c % g.nx;
      const y = Math.floor(c / g.nx);
      const copper = layers[li].copper;
      for (const [dx, dy] of steps) {
        const qx = x + dx;
        const qy = y + dy;
        if (!inGrid(g, qx, qy)) continue;
        const nc = qy * g.nx + qx;
        if (!copper[nc]) continue;
        if (dx && dy && (!copper[y * g.nx + qx] || !copper[qy * g.nx + x])) continue;
        const step = Math.hypot(dx, dy) * cell;
        const nid = node(li, nc);
        const ng = gScore[id] + step * (eps + (segD(cellCentre(g, x, y)) + segD(cellCentre(g, qx, qy))) / 2 / h);
        if (ng < gScore[nid]) {
          if (gScore[nid] === Infinity) touched.push(nid);
          gScore[nid] = ng;
          parent[nid] = id;
          heap.push(nid, ng + eps * Math.max(0, dist(cellCentre(g, qx, qy), wp) - goal.slack));
        }
      }
      for (const e of viaAt.get(id) ?? []) {
        const ng = gScore[id] + e.cost;
        if (ng < gScore[e.to]) {
          if (gScore[e.to] === Infinity) touched.push(e.to);
          gScore[e.to] = ng;
          parent[e.to] = id;
          heap.push(e.to, ng + eps * Math.max(0, dist(cellOf(g, e.to % N), wp) - goal.slack));
        }
      }
    }
    if (hit < 0) continue;
    const leg: Raw[] = [];
    for (let id = hit; id >= 0; id = parent[id]) {
      const c = id % N;
      const li = Math.floor(id / N);
      const p = cellCentre(g, c % g.nx, Math.floor(c / g.nx));
      leg.push({ x: p.x, y: p.y, layer: layers[li].id, d: dMap[c] });
    }
    leg.reverse();
    const skip = raw.length && dist(raw[raw.length - 1], leg[0]) < 1e-6 ? 1 : 0;
    for (let i = skip; i < leg.length; i++) raw.push(leg[i]);
    frontier = [hit];
  }
  if (raw.length < 2) return null;
  // A later stop can sit in a dead-end pocket of the pour. The search is then forced in and back
  // out through the same cells: a 180 with no enclosed area. Dropping that loop leaves the path
  // that actually continues. A real detour goes around and does not come back through its entrance.
  const route = dropRevisits(raw);

  const drawn = post(route, lines, tracks, g, h, cell, layers, board.vias.filter((v) => v.net === signal));
  const notes: CostReport['notes'] = [];
  const length = drawn.pts.reduce((s, p, i) => (i ? s + dist(p, drawn.pts[i - 1]) : 0), 0);
  if (drawn.pts.length) notes.push({ severity: 'ok', kind: 'return-length', message: `Return path ${length.toFixed(1)} mm`, at: drawn.pts[0] });
  const mil2 = (mm2: number) => mm2 / (MIL * MIL);
  for (const m of drawn.marks) {
    const area = `${m.area.toFixed(2)} mm² (${mil2(m.area).toFixed(0)} mil²)`;
    notes.push(
      m.kind === 'minor'
        ? { severity: 'ok', kind: 'minor-cut', message: `Minor cut: the trace crosses other copper, ${area}, under h² (${(h * h).toFixed(2)} mm²), so the return is drawn on the trace`, at: m.at }
        : { severity: 'error', kind: 'return-detour', message: `Detour over 9h²: extra loop area ${area}`, at: m.at },
    );
  }
  for (const det of drawn.detours)
    notes.push({ severity: 'warn', kind: 'return-detour', message: `Detour: extra loop area ${det.area.toFixed(2)} mm² (${mil2(det.area).toFixed(0)} mil²)`, at: det.at });
  for (const v of drawn.vias)
    notes.push({ severity: 'ok', kind: 'return-via', message: `Layer change through a ground via ${v.distance.toFixed(2)} mm from the trace`, at: v.at });

  const layerOf = (p: Pt) => project(lines, p)?.line.layer ?? signalLayer;
  const traces: CostTrace[] = [];
  let run: { layer: number; detour: boolean; pts: Path } | null = null;
  for (const p of drawn.tagged) {
    if (!run || run.layer !== p.layer || run.detour !== p.detour) {
      if (run && run.pts.length > 1) traces.push({ layer: run.layer, signalLayer: layerOf(run.pts[0]), pts: straighten(run.pts, cell * 0.6), ...(run.detour ? { detour: true } : {}) });
      run = { layer: p.layer, detour: p.detour, pts: [] };
    }
    const last = run.pts[run.pts.length - 1];
    if (!last || dist(last, p) > 1e-4) run.pts.push(p);
  }
  if (run && run.pts.length > 1) traces.push({ layer: run.layer, signalLayer: layerOf(run.pts[0]), pts: straighten(run.pts, cell * 0.6), ...(run.detour ? { detour: true } : {}) });
  return { traces, marks: drawn.marks, vias: drawn.vias, length, notes };
}

function cellOf(g: Grid, c: number): Pt {
  return cellCentre(g, c % g.nx, Math.floor(c / g.nx));
}

interface Tagged extends Pt {
  layer: number;
  detour: boolean;
}

function post(
  raw: Raw[],
  lines: Line[],
  tracks: Track[],
  g: Grid,
  h: number,
  cell: number,
  layers: GLayer[],
  signalVias: { at: Pt; diameter: number }[],
): { pts: Path; tagged: Tagged[]; marks: CostMark[]; detours: { at: Pt; area: number }[]; vias: CostVia[] } {
  // On the projected trace: the seeded cells. Anything past one cell has left it.
  const left = (d: number) => d > cell * 1.25;
  const copper = new Map(layers.map((l) => [l.id, l.copper]));
  const tagged: Tagged[] = [];
  const marks: CostMark[] = [];
  const detours: { at: Pt; area: number }[] = [];
  const vias: CostVia[] = [];
  const h2 = h * h;
  let i = 0;
  while (i < raw.length) {
    if (!left(raw[i].d)) {
      tagged.push({ ...raw[i], detour: false });
      i++;
      continue;
    }
    let j = i;
    while (j < raw.length && left(raw[j].d) && raw[j].layer === raw[i].layer) j++;
    const back = i > 0 && j < raw.length && raw[i - 1].layer === raw[i].layer && raw[j].layer === raw[i].layer;
    let area = 0;
    const from = Math.max(0, i - 1);
    for (let k = from; k < Math.min(j, raw.length - 1); k++) area += dist(raw[k], raw[k + 1]) * 0.5 * (raw[k].d + raw[k + 1].d);
    const arc = back ? signalArc(lines, raw[i - 1], raw[j]) : null;
    if (back && arc && area < h2) {
      for (const p of arc) {
        const last = tagged[tagged.length - 1];
        if (!last || dist(last, p) > cell * 0.4) tagged.push({ ...p, layer: raw[i].layer, detour: false });
      }
      if (crossesOther(arc, raw[i].layer, tracks, g, copper.get(raw[i].layer), signalVias)) {
        marks.push({ at: arc[Math.floor(arc.length / 2)], kind: 'minor', area });
      }
      i = j;
      continue;
    }
    if (back && area >= h2) {
      let peak = raw[i];
      for (const p of raw.slice(i, j)) if (p.d > peak.d) peak = p;
      if (area >= 9 * h2) marks.push({ at: peak, kind: 'flagged', area });
      else detours.push({ at: peak, area });
      for (let k = i; k < j; k++) tagged.push({ ...raw[k], detour: true });
      i = j;
      continue;
    }
    for (let k = i; k < j; k++) tagged.push({ ...raw[k], detour: false });
    i = j;
  }
  for (let k = 1; k < raw.length; k++)
    if (raw[k].layer !== raw[k - 1].layer) vias.push({ at: raw[k], fromLayer: raw[k - 1].layer, toLayer: raw[k].layer, distance: raw[k].d });
  return { pts: tagged, tagged, marks, detours, vias };
}

/**
 * The straight projection leaves the ground on this layer somewhere that is not the signal's own
 * track or via. That is a cut by other copper. A hop of the signal itself is not one.
 */
function crossesOther(arc: Path, layer: number, tracks: Track[], g: Grid, copper: Uint8Array | undefined, signalVias: { at: Pt; diameter: number }[]): boolean {
  if (!copper) return false;
  const own = (p: Pt) =>
    tracks.some((t) => t.layer === layer && distPointSeg(p, t.a, t.b) <= t.width / 2 + g.cell) ||
    signalVias.some((v) => dist(v.at, p) <= v.diameter / 2 + 0.25);
  for (let k = 1; k < arc.length; k++) {
    const n = Math.max(1, Math.ceil(dist(arc[k - 1], arc[k]) / Math.max(g.cell, 0.05)));
    for (let s = 1; s < n; s++) {
      const p = { x: arc[k - 1].x + ((arc[k].x - arc[k - 1].x) * s) / n, y: arc[k - 1].y + ((arc[k].y - arc[k - 1].y) * s) / n };
      const i = Math.floor((p.x - g.x0) / g.cell);
      const j = Math.floor((p.y - g.y0) / g.cell);
      if (inGrid(g, i, j) && copper[j * g.nx + i]) continue;
      if (!own(p)) return true;
    }
  }
  return false;
}
