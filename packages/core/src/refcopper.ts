import { runSync, type Steps } from './budget.js';
import { circle, difference, dist, dropNarrow, inflate, intersect, pointInPaths, strokePath, union } from './geom.js';
import { sameNet } from './nets.js';
import { MULTI_LAYER, type Board, type Paths, type Pour } from './types.js';

export interface LayerCopper {
  layer: number;
  /** Plane/pour copper per net on this layer. */
  byNet: Map<string, Paths>;
}

export interface RefCopperOptions {
  /** Pour-to-other-net clearance, mm. Used only for pours without a stored POURED fill. */
  clearance: number;
}

/**
 * Pipeline step 1: reference copper per copper layer.
 * Pours are filled in priority order; each fill is the pour outline minus keepouts, minus
 * earlier (higher-priority) fills, minus other-net objects grown by the clearance (antipads).
 * Fill narrower than MIN_COPPER_WIDTH is dropped. Same-net tracks and pads on the layer are merged into the net's copper.
 */
export function buildReferenceCopper(board: Board, opts: RefCopperOptions): Map<number, LayerCopper> {
  return runSync(buildReferenceCopperSteps(board, opts));
}

let refCache: { key: string; value: Map<number, LayerCopper> } | undefined;

/**
 * Identity of the copper a rebuild would read. A repeat run with the same board reuses the last result.
 * Each coordinate is mixed in order: a sum of them is the same for two centered rectangles of different width.
 */
function refKey(board: Board, clearance: number): string {
  let h = 2166136261;
  const mix = (v: number) => {
    h = Math.imul(h ^ Math.round(v * 1000), 16777619);
  };
  const mixStr = (s: string) => {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  };
  const rings = (paths: Paths) => {
    mix(paths.length);
    for (const path of paths) {
      mix(path.length);
      for (const p of path) {
        mix(p.x);
        mix(p.y);
      }
    }
  };
  mix(clearance);
  for (const layer of board.stackup.copper) mix(layer.id);
  rings(board.outline);
  for (const pour of board.pours) {
    mixStr(pour.id);
    mix(pour.layer);
    mixStr(pour.net);
    mixStr(pour.name);
    mix(pour.priority);
    rings(pour.outline);
    mix(pour.poured ? 1 : 0);
    if (pour.poured) rings(pour.poured);
  }
  for (const t of board.tracks) {
    mixStr(t.net);
    mix(t.layer);
    mix(t.width);
    mix(t.a.x);
    mix(t.a.y);
    mix(t.b.x);
    mix(t.b.y);
  }
  for (const v of board.vias) {
    mixStr(v.net);
    mix(v.drill);
    mix(v.diameter);
    mix(v.at.x);
    mix(v.at.y);
  }
  for (const p of board.pads) {
    mixStr(p.net);
    mix(p.layer);
    mix(p.holeDiameter);
    mix(p.at.x);
    mix(p.at.y);
    rings(p.shape);
  }
  for (const k of board.keepouts) {
    mix(k.layer);
    rings(k.outline);
  }
  return (h >>> 0).toString(16);
}

export function* buildReferenceCopperSteps(board: Board, opts: RefCopperOptions): Steps<Map<number, LayerCopper>> {
  const key = refKey(board, opts.clearance);
  if (refCache?.key === key) return refCache.value;
  const result = new Map<number, LayerCopper>();
  const refNets = new Set(board.pours.map((p) => p.net));

  for (const layer of board.stackup.copper) {
    const pours = board.pours.filter((p) => p.layer === layer.id).sort((a, b) => a.priority - b.priority);
    const byNet = new Map<string, Paths>();
    if (!pours.length) {
      result.set(layer.id, { layer: layer.id, byNet });
      continue;
    }

    const keepouts = union(...board.keepouts.filter((k) => k.layer === layer.id || k.layer === MULTI_LAYER).map((k) => k.outline));
    const obstacleCache = new Map<string, Paths>();
    const obstaclesFor = (net: string): Paths => {
      let o = obstacleCache.get(net);
      if (!o) {
        o = otherNetObstacles(board, layer.id, net, opts.clearance);
        obstacleCache.set(net, o);
      }
      return o;
    };

    let claimed: Paths = [];
    for (const [k, pour] of pours.entries()) {
      yield { phase: 'reference copper', fraction: k / pours.length };
      let fill: Paths;
      if (pour.poured) {
        fill = pour.poured;
        // A rebuilt plane can be stale: a keepout or split line added after the last rebuild
        // is still a hole. Signal pours already have those holes in their stored fill.
        if (pour.name === 'plane' && keepouts.length) fill = difference(fill, keepouts);
      } else {
        fill = intersect(pour.outline, board.outline.length ? board.outline : pour.outline);
        fill = difference(fill, keepouts);
        if (claimed.length) fill = difference(fill, inflate(claimed, opts.clearance));
        fill = difference(fill, obstaclesFor(pour.net));
      }
      fill = dropNarrow(fill, MIN_COPPER_WIDTH);
      claimed = union(claimed, fill);
      byNet.set(pour.net, union(byNet.get(pour.net) ?? [], fill));
    }

    for (const net of byNet.keys()) {
      if (!refNets.has(net)) continue;
      yield { phase: 'reference copper' };
      const extra: Paths = [];
      for (const t of board.tracks) if (t.layer === layer.id && t.net === net) extra.push(...strokePath([t.a, t.b], t.width));
      for (const p of board.pads) if ((p.layer === layer.id || p.layer === MULTI_LAYER) && p.net === net) extra.push(...p.shape);
      for (const v of board.vias) if (v.net === net) extra.push(circle(v.at, v.diameter / 2));
      if (extra.length) byNet.set(net, union(byNet.get(net)!, extra));
    }
    result.set(layer.id, { layer: layer.id, byNet });
  }
  refCache = { key, value: result };
  return result;
}

/**
 * Narrower fill than this is dropped, mm: stored fills can hold hairline slivers between a pour
 * edge and a clearance that no fab makes and no return current flows in.
 */
const MIN_COPPER_WIDTH = 0.1;

function otherNetObstacles(board: Board, layer: number, net: string, clearance: number): Paths {
  const parts: Paths = [];
  for (const t of board.tracks) {
    if (t.layer !== layer || t.net === net) continue;
    parts.push(...strokePath([t.a, t.b], t.width + 2 * clearance));
  }
  for (const v of board.vias) {
    if (v.net === net) continue;
    parts.push(circle(v.at, v.diameter / 2 + clearance));
  }
  for (const p of board.pads) {
    if (p.net === net && p.net !== '') continue;
    if (p.layer !== layer && p.layer !== MULTI_LAYER) continue;
    parts.push(...inflate(p.shape, clearance));
  }
  return union(parts);
}

export interface PreparedPours {
  board: Board;
  /** Stored fills that do not match the objects on the board. Empty when they were rebuilt. */
  stale: Pour[];
}

/**
 * A stored fill is stale when an other-net via, pad or track on that layer sits in the copper.
 * Holes already in the fill, including slots, stay: filling them would put copper back.
 * With `rebuild`, a stale fill is dropped so the copper is computed from the outline.
 * Otherwise the fill is left and named in `stale`.
 */
let pourCache: { key: string; value: PreparedPours } | undefined;

export function preparePours(board: Board, rebuild: boolean): PreparedPours {
  const key = `${rebuild ? 1 : 0}|${refKey(board, 0)}`;
  if (pourCache?.key === key) return pourCache.value;
  const stale = board.pours.filter((p) => p.poured?.length && pourStale(board, p));
  const value: PreparedPours = !stale.length || !rebuild
    ? { board, stale }
    : {
        board: { ...board, pours: board.pours.map((p) => (stale.includes(p) ? { ...p, poured: undefined } : p)) },
        stale: [],
      };
  pourCache = { key, value };
  return value;
}

function pourStale(board: Board, pour: Pour): boolean {
  const fill = pour.poured;
  const outline = pour.outline;
  if (!fill?.length || !outline.length) return false;
  const onLayer = (layer: number) => layer === pour.layer || layer === MULTI_LAYER;
  for (const v of board.vias) {
    if (!v.net || sameNet(v.net, pour.net)) continue;
    if (pointInPaths(v.at, outline) && pointInPaths(v.at, fill)) return true;
  }
  for (const p of board.pads) {
    if (!p.net || sameNet(p.net, pour.net) || !onLayer(p.layer)) continue;
    if (pointInPaths(p.at, outline) && pointInPaths(p.at, fill)) return true;
  }
  for (const t of board.tracks) {
    if (t.layer !== pour.layer || !t.net || sameNet(t.net, pour.net)) continue;
    if (dist(t.a, t.b) < 0.05) continue;
    for (let i = 0; i <= 4; i++) {
      const p = { x: t.a.x + ((t.b.x - t.a.x) * i) / 4, y: t.a.y + ((t.b.y - t.a.y) * i) / 4 };
      if (pointInPaths(p, outline) && pointInPaths(p, fill)) return true;
    }
  }
  return false;
}

/** All copper of a layer regardless of net. */
export function allCopper(lc: LayerCopper | undefined): Paths {
  if (!lc) return [];
  return union(...lc.byNet.values());
}

/** Vertex count of a region, for diagnostics and complexity limits. */
export function vertexCount(paths: Iterable<Paths>): number {
  let n = 0;
  for (const ps of paths) for (const p of ps) n += p.length;
  return n;
}
