// Post-processing of a DC solve for drawing: streamlines from the source to each load, and
// current-density contour lines in colour bins (D7: one indicator-marker call per colour).
import type { Path, Pt } from '../types.js';
import { cellCentre, cellOf, inGrid, type Grid } from './raster.js';
import type { DcLayerField, DcNetResult } from './solve.js';

/** Contour levels as a fraction of the net's full scale (its bottleneck density). Log-like: plane currents spread fast. */
export const DENSITY_LEVELS = [0.05, 0.15, 0.35, 0.7];

export interface StreamSegment {
  layer: number;
  pts: Path;
}

export interface Streamline {
  load: string;
  /** Polyline pieces per layer, in the direction of current flow. */
  segments: StreamSegment[];
  /** True when the trace reached the source pads. */
  complete: boolean;
}

export interface StreamOptions {
  perLoad: number;
  maxSteps: number;
  /** End a streamline where it meets an earlier one on the same layer, so shared paths are drawn once (a tree). */
  merge: boolean;
  /** Round off the cell staircase of streamlines through narrow copper. */
  smooth: boolean;
}

/** Streamlines closer than this, mm, merge when drawn. */
const MERGE_MM = 0.6;
/** Radius around a via, mm, on which the flow past it is measured. */
const VIA_RING_MM = 1;
/** Length, mm, over which drawn streamlines are smoothed (the Gaussian's sigma; at least one cell). */
const SMOOTH_MM = 0.35;
/** How far, mm, the drawn line may stray from the smoothed curve when its points are thinned. */
const SMOOTH_TOL_MM = 0.03;
/** A joining streamline meets the earlier one this far, mm, past the point it came close to. */
const JOIN_MM = 1;
/** And at least this many times as far as the earlier line lies aside, so the curve onto it stays shallow. */
const JOIN_SLOPE = 2.5;

interface Mark {
  pt: Pt;
  piece: Path;
  idx: number;
}

/** For drawing: one streamline per load, merged where paths meet and smoothed; several per load crowd the view. */
export const DRAWN_STREAMS: Partial<StreamOptions> = { perLoad: 1, merge: true, smooth: true };
/** For drawing one part's current alone: a few lines from its pads, so parallel paths show. */
export const FOCUS_STREAMS: Partial<StreamOptions> = { ...DRAWN_STREAMS, perLoad: 3 };

/** Index of the density bin of a value: 0 below the first level … DENSITY_LEVELS.length at or above the last. */
export function densityBin(j: number, fullScale: number, levels = DENSITY_LEVELS): number {
  const f = j / fullScale;
  let k = 0;
  while (k < levels.length && f >= levels[k]) k++;
  return k;
}

/** The layer carrying most of the net's flow. */
export function dominantLayer(r: DcNetResult): number {
  return [...r.layers].sort((a, b) => b.flow - a.flow)[0].layer;
}

function sample(g: Grid, f: DcLayerField, p: Pt): Pt {
  const u = (p.x - g.x0) / g.cell - 0.5;
  const v = (p.y - g.y0) / g.cell - 0.5;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fu = u - i;
  const fv = v - j;
  let x = 0;
  let y = 0;
  let wsum = 0;
  for (const [di, dj, w] of [[0, 0, (1 - fu) * (1 - fv)], [1, 0, fu * (1 - fv)], [0, 1, (1 - fu) * fv], [1, 1, fu * fv]] as const) {
    if (!inGrid(g, i + di, j + dj) || w <= 0) continue;
    const c = (j + dj) * g.nx + i + di;
    if (!(f.weight[c] > 0)) continue;
    x += w * f.jx[c];
    y += w * f.jy[c];
    wsum += w;
  }
  return wsum ? { x: x / wsum, y: y / wsum } : { x: 0, y: 0 };
}

/**
 * Traces streamlines from each load back to the source along that load's own current, switching layers
 * at vias where the barrel hands the current to another layer. Seeds are the load's terminal cells
 * with the strongest flow, spread apart.
 */
export function traceStreamlines(g: Grid, r: DcNetResult, options: Partial<StreamOptions> = {}): Streamline[] {
  const opts: StreamOptions = { perLoad: 3, maxSteps: 4 * (g.nx + g.ny) * 4, merge: false, smooth: false, ...options };
  // Walk towards the source: along the current on the ground, against it on the rail.
  const dir = r.role === 'return' ? 1 : -1;
  // Rebound per load when that load was solved on its own; a line of the combined field bends towards the other loads.
  let byLayer = new Map(r.layers.map((f) => [f.layer, f]));
  let viaAt = new Map<number, (typeof r.vias)[number]>();
  let scale = r.fullScale;
  /** Pad cells of the parts joining a rail's nets, by layer and cell: the part and which side. */
  const bridgeAt = new Map<string, { bridge: number; side: number }>();
  (r.bridges ?? []).forEach((br, bi) => br.sides.forEach((sd, si) => {
    for (const [layer, cells] of sd.cells) for (const c of cells) bridgeAt.set(`${layer}:${c}`, { bridge: bi, side: si });
  }));
  const step = g.cell * 0.4;
  const out: Streamline[] = [];
  /** Streamlines closer than this (cells) are drawn as one. */
  const reach = Math.max(1, Math.ceil(MERGE_MM / g.cell));
  /** Ring around a via, cells, on which the flow past it is measured. */
  const ring = Math.min(8, Math.max(2, Math.round(VIA_RING_MM / g.cell)));
  /** Per layer: where an earlier drawn streamline passed each cell (the point, its piece and the index of the piece's point before it). */
  const taken = new Map<number, Map<number, Mark>>();
  const meets = (layer: number, c: number): Mark | undefined => {
    const t = taken.get(layer);
    if (!t) return undefined;
    const i = c % g.nx;
    const j = (c - i) / g.nx;
    let best: Mark | undefined;
    let bestD = Infinity;
    for (let dj = -reach; dj <= reach; dj++)
      for (let di = -reach; di <= reach; di++) {
        const hit = inGrid(g, i + di, j + dj) ? t.get((j + dj) * g.nx + i + di) : undefined;
        if (hit && di * di + dj * dj < bestD) {
          best = hit;
          bestD = di * di + dj * dj;
        }
      }
    return best;
  };

  for (const ld of r.loadCells) {
    if (ld.current <= 0) continue;
    byLayer = new Map((ld.own?.layers ?? r.layers).map((f) => [f.layer, f]));
    viaAt = new Map();
    for (const v of ld.own?.vias ?? r.vias) if (v.cell >= 0) viaAt.set(v.cell, v);
    scale = ld.own?.fullScale || r.fullScale;
    const seeds: { layer: number; c: number; j: number }[] = [];
    for (const [layer, cells] of ld.cells) for (const c of cells) seeds.push({ layer, c, j: byLayer.get(layer)!.j[c] });
    seeds.sort((a, b) => b.j - a.j);
    const chosen: typeof seeds = [];
    for (const s of seeds) {
      if (chosen.length >= opts.perLoad || !(s.j > 0)) break;
      const p = centreOf(g, s.c);
      if (chosen.every((o) => o.layer !== s.layer || Math.hypot(centreOf(g, o.c).x - p.x, centreOf(g, o.c).y - p.y) >= 2 * g.cell)) chosen.push(s);
    }
    for (const s of chosen) out.push(trace(ld.designator, s.layer, centreOf(g, s.c)));
  }
  // Supply streamlines are traced from the loads and reversed afterwards, so merging always
  // happens on the way to the source.
  return out;

  function trace(load: string, layer: number, start: Pt): Streamline {
    const segments: StreamSegment[] = [{ layer, pts: [start] }];
    const usedVias = new Set<string>();
    const usedBridges = new Set<number>();
    let p = start;
    let f = byLayer.get(layer)!;
    let complete = false;
    let stall = 0;
    let lastCell = -1;
    for (let k = 0; k < opts.maxSteps; k++) {
      const [i, j] = cellOf(g, p);
      if (!inGrid(g, i, j)) break;
      const c = j * g.nx + i;
      if (r.sourceCells.get(layer)?.has(c)) {
        complete = true;
        break;
      }
      if (opts.merge && k > 0) {
        const hit = meets(layer, c);
        if (hit) {
          const pts = segments[segments.length - 1].pts;
          pts.push(...join(pts, p, hit).slice(1));
          complete = true;
          break;
        }
      }
      const onBridge = bridgeAt.get(`${layer}:${c}`);
      if (onBridge && !usedBridges.has(onBridge.bridge)) {
        // The current reaches this pad through the part from its other side: carry on from there.
        usedBridges.add(onBridge.bridge);
        const br = r.bridges[onBridge.bridge];
        const level = (sd: (typeof br.sides)[number]) => {
          let best: { layer: number; c: number; v: number } | undefined;
          for (const [l, cs] of sd.cells) for (const cc of cs) {
            const v = dir * (byLayer.get(l)?.v[cc] ?? NaN);
            if (isFinite(v) && (!best || v < best.v)) best = { layer: l, c: cc, v };
          }
          return best;
        };
        const here = level(br.sides[onBridge.side]);
        const next = br.sides.map((sd, si) => ({ si, lv: si === onBridge.side ? undefined : level(sd) })).filter((x) => x.lv && (!here || x.lv.v < here.v)).sort((a, b) => a.lv!.v - b.lv!.v)[0];
        if (next) {
          const from = br.sides[onBridge.side].at;
          const to = br.sides[next.si].at;
          // Drawn straight across the part, so the line shows the current passing through it.
          segments[segments.length - 1].pts.push(from, to);
          p = to;
          if (next.lv!.layer !== layer) {
            layer = next.lv!.layer;
            f = byLayer.get(layer)!;
            segments.push({ layer, pts: [p] });
          }
          stall = 0;
          lastCell = -1;
          continue;
        }
      }
      const via = viaAt.get(c);
      if (via && !usedVias.has(via.id)) {
        usedVias.add(via.id);
        let best = layer;
        let bestFlow = 0;
        for (const [l, d] of via.delivered) if (d * dir > bestFlow) {
          best = l;
          bestFlow = d * dir;
        }
        // One drawn line stands for the whole flow, so it changes layer only where the barrel takes
        // more current than flows on past the via on this layer. A stitching via that hands over a
        // small part of a flow both layers carry is passed on the same layer.
        const hop = best !== layer && bestFlow > 0.3 * via.current && bestFlow > around(f, c).out;
        if (hop) {
          segments[segments.length - 1].pts.push(via.at);
          layer = best;
          f = byLayer.get(layer)!;
          segments.push({ layer, pts: [via.at] });
          p = via.at;
        }
        // Near a via the field is dominated by the barrel's own radial flow, whose direction at the
        // centre is noise; leave where the current leaves the ring around the via (for a via feeding
        // a nearby sink, that is towards the sink).
        const q = leave(f, c, via.at);
        if (q) {
          p = q;
          segments[segments.length - 1].pts.push(p);
          stall = 0;
          lastCell = -1;
        }
        continue;
      }
      stall = c === lastCell ? stall + 1 : 0;
      lastCell = c;
      let next = stall > 6 ? undefined : rkStep(f, p);
      if (next) {
        const [ni, nj] = cellOf(g, next);
        if (!inGrid(g, ni, nj) || !(f.weight[nj * g.nx + ni] > 0)) next = undefined;
      }
      if (!next) {
        // Narrow copper (track corners, pad edges): step to the neighbour cell lower in potential.
        const d = descend(f, c);
        if (d < 0 && via) {
          // A potential minimum on this layer at a via: the current leaves through the barrel.
          const here = dir * f.v[c];
          const lower = r.layers.filter((o) => o.layer !== layer && o.weight[c] > 0 && dir * o.v[c] < here).sort((a, b) => dir * a.v[c] - dir * b.v[c])[0];
          if (lower) {
            segments[segments.length - 1].pts.push(via.at);
            layer = lower.layer;
            f = lower;
            p = via.at;
            segments.push({ layer, pts: [p] });
            continue;
          }
        }
        if (d < 0) break;
        next = centreOf(g, d);
        stall = 0;
      }
      p = next;
      segments[segments.length - 1].pts.push(p);
    }
    const segs = segments
      .filter((s) => s.pts.length > 1)
      .map((s) => ({ layer: s.layer, pts: opts.smooth ? simplifyLine(smoothOnCopper(s.pts, byLayer.get(s.layer)!), SMOOTH_TOL_MM) : simplifyLine(s.pts, g.cell * 0.25) }));
    // Later streamlines join the drawn (smoothed) pieces, so a join lands on the line as drawn.
    if (opts.merge)
      for (const sg of segs) {
        let t = taken.get(sg.layer);
        if (!t) taken.set(sg.layer, (t = new Map()));
        for (let q = 1; q < sg.pts.length; q++) {
          const a = sg.pts[q - 1];
          const b = sg.pts[q];
          const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (g.cell * 0.5)));
          for (let m = 0; m <= n; m++) {
            const pt = { x: a.x + ((b.x - a.x) * m) / n, y: a.y + ((b.y - a.y) * m) / n };
            const [pi, pj] = cellOf(g, pt);
            if (inGrid(g, pi, pj) && !t.has(pj * g.nx + pi)) t.set(pj * g.nx + pi, { pt, piece: sg.pts, idx: q - 1 });
          }
        }
      }
    // Present every streamline in the direction the current flows.
    if (r.role === 'supply') return { load, segments: segs.map((s) => ({ layer: s.layer, pts: [...s.pts].reverse() })).reverse(), complete };
    return { load, segments: segs, complete };
  }

  /**
   * Gaussian smoothing over a fixed length along the line, so turns read as bends rather than grid
   * corners; the ends (pads, vias, joins) stay put, and a point the smoothing would move off the
   * layer's copper moves only as far as the copper allows.
   */
  function smoothOnCopper(pts: Path, f: (typeof r.layers)[number]): Path {
    const step = Math.min(g.cell, SMOOTH_MM) / 2;
    const rs: Path = [pts[0]];
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1];
      const b = pts[k];
      const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / step));
      for (let m = 1; m <= n; m++) rs.push({ x: a.x + ((b.x - a.x) * m) / n, y: a.y + ((b.y - a.y) * m) / n });
    }
    if (rs.length < 3) return rs;
    const sigma = Math.max(SMOOTH_MM, g.cell);
    const half = Math.ceil((2.5 * sigma) / step);
    const w = Array.from({ length: half + 1 }, (_, k) => Math.exp(-0.5 * ((k * step) / sigma) ** 2));
    const onCopper = (q: Pt) => {
      const [i, j] = cellOf(g, q);
      return inGrid(g, i, j) && f.weight[j * g.nx + i] > 0;
    };
    return rs.map((p, i) => {
      // A window that shrinks towards the ends keeps them in place without pulling the line aside.
      const h = Math.min(half, i, rs.length - 1 - i);
      if (!h) return p;
      let sx = 0;
      let sy = 0;
      let sw = 0;
      for (let k = -h; k <= h; k++) {
        sx += w[Math.abs(k)] * rs[i + k].x;
        sy += w[Math.abs(k)] * rs[i + k].y;
        sw += w[Math.abs(k)];
      }
      for (const a of [1, 0.75, 0.5, 0.25]) {
        const q = { x: p.x + (sx / sw - p.x) * a, y: p.y + (sy / sw - p.y) * a };
        if (onCopper(q)) return q;
      }
      return p;
    });
  }

  /**
   * A curve from p, heading the way the streamline was going, onto an earlier drawn piece: it meets
   * the piece a little downstream of the point it came close to, along the piece's direction, so the
   * two read as one line (a tangent merge instead of a corner).
   */
  function join(pts: Path, p: Pt, hit: Mark): Path {
    const { piece } = hit;
    // Walk down the earlier piece from the point it came close to, until a point far enough from p
    // that the curve onto it stays shallow: well ahead of how far aside the earlier line lies (the
    // close point itself may lie behind p).
    const want = Math.max(JOIN_MM, 3 * g.cell, JOIN_SLOPE * Math.hypot(hit.pt.x - p.x, hit.pt.y - p.y));
    let at = hit.pt;
    let i = hit.idx + 1;
    const fine = g.cell / 4;
    walk: while (i < piece.length) {
      const d = Math.hypot(piece[i].x - at.x, piece[i].y - at.y);
      const n = Math.max(1, Math.ceil(d / fine));
      const from = at;
      for (let m = 1; m <= n; m++) {
        at = { x: from.x + ((piece[i].x - from.x) * m) / n, y: from.y + ((piece[i].y - from.y) * m) / n };
        if (Math.hypot(at.x - p.x, at.y - p.y) >= want) break walk;
      }
      i++;
    }
    const prev = pts.length > 1 ? pts[pts.length - 2] : undefined;
    const unit = (x: number, y: number) => {
      const m = Math.hypot(x, y);
      return m > 1e-9 ? { x: x / m, y: y / m } : undefined;
    };
    const d0 = (prev && unit(p.x - prev.x, p.y - prev.y)) ?? unit(at.x - p.x, at.y - p.y);
    const k = Math.min(i, piece.length - 1);
    const d3 = unit(piece[k].x - piece[Math.max(0, k - 1)].x, piece[k].y - piece[Math.max(0, k - 1)].y) ?? d0;
    const span = Math.hypot(at.x - p.x, at.y - p.y);
    if (!d0 || !d3 || span < 1e-6) return [p, at];
    const c1 = { x: p.x + d0.x * span * 0.4, y: p.y + d0.y * span * 0.4 };
    const c2 = { x: at.x - d3.x * span * 0.4, y: at.y - d3.y * span * 0.4 };
    const out: Path = [];
    for (let n = 0; n <= 8; n++) {
      const u = n / 8;
      const v = 1 - u;
      out.push({
        x: v * v * v * p.x + 3 * v * v * u * c1.x + 3 * v * u * u * c2.x + u * u * u * at.x,
        y: v * v * v * p.y + 3 * v * v * u * c1.y + 3 * v * u * u * c2.y + u * u * u * at.y,
      });
    }
    return out;
  }

  /**
   * Current through a ring around cell c on one layer, A, in the walking direction: what leaves the
   * ring outwards (`out`) and the direction it mostly leaves in.
   */
  function around(f: DcLayerField, c: number): { out: number; x: number; y: number } {
    const ci = c % g.nx;
    const cj = (c - ci) / g.nx;
    const cells: { k: number; ux: number; uy: number }[] = [];
    for (let dj = -ring; dj <= ring; dj++)
      for (let di = -ring; di <= ring; di++) {
        const d = Math.hypot(di, dj);
        if (d >= ring - 0.5 && d < ring + 0.5) cells.push({ k: inGrid(g, ci + di, cj + dj) ? (cj + dj) * g.nx + ci + di : -1, ux: di / d, uy: dj / d });
      }
    const arc = (2 * Math.PI * ring * g.cell) / cells.length;
    let out = 0;
    const flux: number[] = [];
    for (const { k, ux, uy } of cells) {
      const v = k < 0 || !(f.weight[k] > 0) ? 0 : Math.max(0, dir * (f.jx[k] * ux + f.jy[k] * uy) * f.weight[k] * arc);
      flux.push(v);
      out += v;
    }
    // The direction of the densest outflow (the peak and its two neighbours on the ring), not the
    // mean: current spreading into a wide plane would pull the mean off the straight path.
    const order = cells.map((cl, i) => ({ i, a: Math.atan2(cl.uy, cl.ux) })).sort((p, q) => p.a - q.a);
    let peak = 0;
    for (let n = 1; n < order.length; n++) if (flux[order[n].i] > flux[order[peak].i]) peak = n;
    let x = 0;
    let y = 0;
    for (const d of [-1, 0, 1]) {
      const { i } = order[(peak + d + order.length) % order.length];
      x += flux[i] * cells[i].ux;
      y += flux[i] * cells[i].uy;
    }
    return { out, x, y };
  }

  /** Where a streamline leaving a via at cell c continues: on the ring where the current leaves it, on copper. */
  function leave(f: DcLayerField, c: number, at: Pt): Pt | undefined {
    const a = around(f, c);
    const m = Math.hypot(a.x, a.y);
    if (!(m > 0.05 * a.out)) return undefined;
    for (const r of [ring, ring - 1, ring + 1]) {
      const q = { x: at.x + (a.x * r * g.cell) / m, y: at.y + (a.y * r * g.cell) / m };
      const n = 2 * r;
      let onCopper = true;
      for (let s = 1; s <= n && onCopper; s++) {
        const [qi, qj] = cellOf(g, { x: at.x + ((q.x - at.x) * s) / n, y: at.y + ((q.y - at.y) * s) / n });
        const k = qj * g.nx + qi;
        onCopper = inGrid(g, qi, qj) && f.weight[k] > 0 && isFinite(f.v[k]);
      }
      if (onCopper) return q;
    }
    return undefined;
  }

  function rkStep(f: DcLayerField, p: Pt): Pt | undefined {
    const minJ = scale * 1e-4;
    const v1 = sample(g, f, p);
    const m1 = Math.hypot(v1.x, v1.y);
    if (m1 < minJ) return undefined;
    const mid = { x: p.x + (dir * v1.x * step) / (2 * m1), y: p.y + (dir * v1.y * step) / (2 * m1) };
    const v2 = sample(g, f, mid);
    const m2 = Math.hypot(v2.x, v2.y);
    if (m2 < minJ) return undefined;
    return { x: p.x + (dir * v2.x * step) / m2, y: p.y + (dir * v2.y * step) / m2 };
  }

  /** Walking potential: falls towards the source on both nets. */
  function descend(f: DcLayerField, c: number): number {
    const pot = (k: number) => dir * f.v[k];
    const i = c % g.nx;
    const j = (c - i) / g.nx;
    let best = -1;
    let bestPot = pot(c);
    if (!isFinite(bestPot)) return -1;
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        if ((!di && !dj) || !inGrid(g, i + di, j + dj)) continue;
        const k = (j + dj) * g.nx + i + di;
        if (!(f.weight[k] > 0) || !isFinite(f.v[k])) continue;
        if (pot(k) < bestPot) {
          best = k;
          bestPot = pot(k);
        }
      }
    return best;
  }
}

const centreOf = (g: Grid, c: number) => {
  const i = c % g.nx;
  return cellCentre(g, i, (c - i) / g.nx);
};

/** Corner cutting (Chaikin), keeping both end points. */
export function chaikin(pts: Path, rounds: number): Path {
  let p = pts;
  for (let r = 0; r < rounds && p.length > 2; r++) {
    const q: Path = [p[0]];
    for (let k = 0; k + 1 < p.length; k++) {
      const a = p[k];
      const b = p[k + 1];
      q.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y }, { x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}

/** Douglas–Peucker. */
export function simplifyLine(pts: Path, eps: number): Path {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1;
    let bestD = eps;
    const ax = pts[a].x;
    const ay = pts[a].y;
    const dx = pts[b].x - ax;
    const dy = pts[b].y - ay;
    const l = Math.hypot(dx, dy);
    for (let k = a + 1; k < b; k++) {
      const d = l ? Math.abs(dx * (pts[k].y - ay) - dy * (pts[k].x - ax)) / l : Math.hypot(pts[k].x - ax, pts[k].y - ay);
      if (d > bestD) {
        best = k;
        bestD = d;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

/**
 * Contour lines of |J| / fullScale at each level on one layer (marching squares on cell centres,
 * copper-free cells count as 0). Returns one list of polylines per level.
 */
export function densityContours(g: Grid, f: DcLayerField, fullScale: number, levels = DENSITY_LEVELS): Path[][] {
  const val = (i: number, j: number) => {
    if (!inGrid(g, i, j)) return 0;
    const c = j * g.nx + i;
    return f.weight[c] > 0 ? f.j[c] / fullScale : 0;
  };
  return levels.map((lv) => {
    const segs: [Pt, Pt][] = [];
    for (let j = -1; j < g.ny; j++)
      for (let i = -1; i < g.nx; i++) {
        const v00 = val(i, j);
        const v10 = val(i + 1, j);
        const v11 = val(i + 1, j + 1);
        const v01 = val(i, j + 1);
        const idx = (v00 >= lv ? 1 : 0) | (v10 >= lv ? 2 : 0) | (v11 >= lv ? 4 : 0) | (v01 >= lv ? 8 : 0);
        if (idx === 0 || idx === 15) continue;
        const p00 = cellCentre(g, i, j);
        const t = (a: number, b: number) => (lv - a) / (b - a);
        const bottom = (): Pt => ({ x: p00.x + t(v00, v10) * g.cell, y: p00.y });
        const right = (): Pt => ({ x: p00.x + g.cell, y: p00.y + t(v10, v11) * g.cell });
        const top = (): Pt => ({ x: p00.x + t(v01, v11) * g.cell, y: p00.y + g.cell });
        const left = (): Pt => ({ x: p00.x, y: p00.y + t(v00, v01) * g.cell });
        const centreHigh = (v00 + v10 + v11 + v01) / 4 >= lv;
        switch (idx) {
          case 1: case 14: segs.push([left(), bottom()]); break;
          case 2: case 13: segs.push([bottom(), right()]); break;
          case 3: case 12: segs.push([left(), right()]); break;
          case 4: case 11: segs.push([right(), top()]); break;
          case 6: case 9: segs.push([bottom(), top()]); break;
          case 7: case 8: segs.push([left(), top()]); break;
          case 5:
            if (centreHigh) segs.push([left(), top()], [bottom(), right()]);
            else segs.push([left(), bottom()], [right(), top()]);
            break;
          case 10:
            if (centreHigh) segs.push([left(), bottom()], [right(), top()]);
            else segs.push([left(), top()], [bottom(), right()]);
            break;
        }
      }
    return joinSegments(segs).map((l) => simplifyLine(l, g.cell * 0.3));
  });
}

function joinSegments(segs: [Pt, Pt][]): Path[] {
  const key = (p: Pt) => `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)}`;
  const ends = new Map<string, number[]>();
  segs.forEach(([a, b], k) => {
    for (const p of [a, b]) {
      const kk = key(p);
      const l = ends.get(kk);
      if (l) l.push(k);
      else ends.set(kk, [k]);
    }
  });
  const used = new Uint8Array(segs.length);
  const out: Path[] = [];
  const extend = (line: Path) => {
    for (;;) {
      const tail = line[line.length - 1];
      const next = ends.get(key(tail))?.find((k) => !used[k]);
      if (next === undefined) return;
      used[next] = 1;
      const [a, b] = segs[next];
      line.push(key(a) === key(tail) ? b : a);
    }
  };
  for (let k = 0; k < segs.length; k++) {
    if (used[k]) continue;
    used[k] = 1;
    const line: Path = [segs[k][0], segs[k][1]];
    extend(line);
    line.reverse();
    extend(line);
    out.push(line);
  }
  return out;
}
