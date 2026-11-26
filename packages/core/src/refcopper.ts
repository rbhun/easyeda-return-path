import { runSync, type Steps } from './budget.js';
import { circle, difference, dropNarrow, inflate, intersect, strokePath, union } from './geom.js';
import { MULTI_LAYER, type Board, type Paths } from './types.js';

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

export function* buildReferenceCopperSteps(board: Board, opts: RefCopperOptions): Steps<Map<number, LayerCopper>> {
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
