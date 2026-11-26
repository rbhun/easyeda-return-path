import { runSync, type Steps, type Tick } from './budget.js';
import { bbox, cross, dist, inflate, intersect, lerp, pointInPaths, signedArea, simplify, splitIslands, sub } from './geom.js';
import { EdgeGrid } from './spatial.js';
import type { Path, Paths, Pt } from './types.js';

export interface DetourOptions {
  /** Holes smaller than this (mm²) are treated as copper: current flows between antipads. */
  minHoleArea: number;
  /** Initial half-size of the search window around the crossing, mm. */
  window: number;
  /** Give up when a window holds more graph nodes (reflex vertices) than this. */
  maxNodes?: number;
  /** Receives the largest graph size searched, for diagnostics. */
  info?: { nodes: number };
  /** How far inside the copper the path keeps, mm (default 0.005). */
  inset?: number;
  /** Ends closer than the inset to the copper edge are joined straight to a point up to this far inside it, mm. */
  snapEnds?: number;
}

export interface Detour {
  path: Path;
  length: number;
}

/** Returned when the copper around a crossing is too complex for the node budget. */
export const TOO_COMPLEX = 'too-complex' as const;

export const DEFAULT_MAX_DETOUR_NODES = 1500;

/**
 * Pipeline step 3: shortest path from a to b inside a copper region (geodesic).
 * Visibility graph over the region's reflex vertices + A*. The region is clipped to a window
 * around a..b that doubles until the path no longer touches the window border.
 */
export function geodesic(region: Paths, a: Pt, b: Pt, opts: DetourOptions): Detour | null {
  const r = runSync(geodesicSteps(region, a, b, opts));
  return r === TOO_COMPLEX ? null : r;
}

export function* geodesicSteps(region: Paths, a: Pt, b: Pt, opts: DetourOptions): Steps<Detour | null | typeof TOO_COMPLEX> {
  // Ends on different islands of the copper have no path between them, however far the window grows.
  yield { phase: 'detour' };
  const islands = preparedIslands(region, opts.minHoleArea, opts.inset ?? 0.005);
  const ends = [a, b];
  if (opts.snapEnds) {
    a = snapInside(islands, a, opts.snapEnds) ?? a;
    b = snapInside(islands, b, opts.snapEnds) ?? b;
  }
  const whole = islands.find((isl) => pointInPaths(a, isl.paths) && pointInPaths(b, isl.paths));
  if (!whole) return null;
  const withEnds = (path: Path): Path => [...(a === ends[0] ? [] : [ends[0]]), ...path, ...(b === ends[1] ? [] : [ends[1]])];
  const rb = whole.box;
  const regionSize = Math.max(rb.maxX - rb.minX, rb.maxY - rb.minY);
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_DETOUR_NODES;
  let half = Math.max(opts.window, dist(a, b));
  for (;;) {
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const win = { minX: cx - half, minY: cy - half, maxX: cx + half, maxY: cy + half };
    const covers = win.minX <= rb.minX && win.minY <= rb.minY && win.maxX >= rb.maxX && win.maxY >= rb.maxY;
    // Boolean intersection, not rectClip: rectClip does not keep hole orientation.
    const winRect: Path = [
      { x: win.minX, y: win.minY },
      { x: win.maxX, y: win.minY },
      { x: win.maxX, y: win.maxY },
      { x: win.minX, y: win.maxY },
    ];
    yield { phase: 'detour' };
    const local = covers ? [whole.paths] : splitIslands(intersect(whole.paths, [winRect]));
    const island = local.find((isl) => pointInPaths(a, isl) && pointInPaths(b, isl));
    const path = island ? yield* shortestPath(island, a, b, maxNodes, opts.info) : null;
    if (path === TOO_COMPLEX) return TOO_COMPLEX;
    if (path) {
      const touches = path.some(
        (p) => Math.abs(p.x - win.minX) < 1e-3 || Math.abs(p.x - win.maxX) < 1e-3 || Math.abs(p.y - win.minY) < 1e-3 || Math.abs(p.y - win.maxY) < 1e-3,
      );
      if (!touches || covers) {
        const full = withEnds(path);
        return { path: full, length: full.reduce((s, p, i) => (i ? s + dist(full[i - 1], p) : 0), 0) };
      }
    }
    if (covers || half > 4 * regionSize) return null;
    half *= 2;
  }
}

/** The nearest point found within `reach` of p that lies in one of the islands; p itself when it does. */
function snapInside(islands: { paths: Paths; box: ReturnType<typeof bbox> }[], p: Pt, reach: number): Pt | null {
  const inside = (q: Pt) => islands.some((isl) => q.x >= isl.box.minX && q.x <= isl.box.maxX && q.y >= isl.box.minY && q.y <= isl.box.maxY && pointInPaths(q, isl.paths));
  if (inside(p)) return p;
  for (let r = 0.02; r <= reach + 1e-9; r += 0.02)
    for (let k = 0; k < 16; k++) {
      const q = { x: p.x + r * Math.cos((k * Math.PI) / 8), y: p.y + r * Math.sin((k * Math.PI) / 8) };
      if (inside(q)) return q;
    }
  return null;
}

const prepared = new WeakMap<Paths, Map<string, { paths: Paths; box: ReturnType<typeof bbox> }[]>>();

/** The region's islands with small holes filled, computed once per region. */
function preparedIslands(region: Paths, minHoleArea: number, inset: number) {
  let byKey = prepared.get(region);
  if (!byKey) prepared.set(region, (byKey = new Map()));
  const key = `${minHoleArea}/${inset}`;
  let islands = byKey.get(key);
  if (!islands) byKey.set(key, (islands = prepareRegion(region, minHoleArea, inset).map((paths) => ({ paths, box: bbox(paths) }))));
  return islands;
}

function prepareRegion(paths: Paths, minHoleArea: number, inset: number): Paths[] {
  const kept = paths.filter((p) => signedArea(p) > 0 || -signedArea(p) >= minHoleArea);
  // Shrink so graph vertices lie strictly inside the copper.
  const shrunk = simplify(inflate(kept, -inset), 0.01);
  return splitIslands(shrunk);
}

function* shortestPath(island: Paths, a: Pt, b: Pt, maxNodes: number, info?: { nodes: number }): Generator<Tick, Path | null | typeof TOO_COMPLEX, void> {
  const nodes: Pt[] = [a, b];
  for (const ring of island) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const prev = ring[(i + n - 1) % n];
      const cur = ring[i];
      const next = ring[(i + 1) % n];
      // Region interior is on the left of every ring, so reflex vertices turn right.
      if (cross(sub(cur, prev), sub(next, cur)) < 0) nodes.push(cur);
    }
  }
  if (info) info.nodes = Math.max(info.nodes, nodes.length);
  if (nodes.length > maxNodes) return TOO_COMPLEX;
  const grid = new EdgeGrid(island);

  const visible = (p: Pt, q: Pt): boolean => {
    if (grid.crosses(p, q)) return false;
    const mid = lerp(p, q, 0.5);
    // Edges between consecutive boundary vertices are valid moves; their midpoint lies on the boundary.
    return grid.contains(mid) || grid.nearBoundary(mid, 1e-7);
  };

  // A* from node 0 (a) to node 1 (b) on the implicit visibility graph.
  const n = nodes.length;
  const g = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  g[0] = 0;
  const open = new Set<number>([0]);
  let checks = 0;
  while (open.size) {
    let u = -1;
    let best = Infinity;
    for (const i of open) {
      const f = g[i] + dist(nodes[i], b);
      if (f < best) {
        best = f;
        u = i;
      }
    }
    open.delete(u);
    if (u === 1) break;
    closed[u] = 1;
    for (let v = 0; v < n; v++) {
      if (closed[v] || v === u) continue;
      const nd = g[u] + dist(nodes[u], nodes[v]);
      if (nd >= g[v] || nd + dist(nodes[v], b) >= g[1]) continue;
      if (++checks % 256 === 0) yield { phase: 'detour' };
      if (!visible(nodes[u], nodes[v])) continue;
      g[v] = nd;
      prev[v] = u;
      open.add(v);
    }
  }
  if (!isFinite(g[1])) return null;
  const out: Path = [];
  for (let i = 1; i !== -1; i = prev[i]) out.push(nodes[i]);
  return out.reverse();
}
