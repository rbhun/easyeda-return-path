import { AnalysisAborted, runAsync, runSync, type RunOptions, type Steps } from './budget.js';
import { isGroundNet, looksLikePowerNet } from './dc/rails.js';
import { resolveNet } from './nets.js';
import { DEFAULT_MAX_DETOUR_NODES, geodesic, geodesicSteps, TOO_COMPLEX, type Detour } from './detour.js';
import { add, circle, difference, dist, distPointSeg, distToPaths, enclosedArea, inflate, intersect, area, mul, pointInPaths, Polyline, strokePath, union } from './geom.js';
import { allCopper, buildReferenceCopperSteps, vertexCount, type LayerCopper } from './refcopper.js';
import { isPassive } from './driver.js';
import { pathInductance, viaInductance } from './inductance.js';
import { buildReturnPath, type ReturnPath } from './returnpath.js';
import { EdgeGrid } from './spatial.js';
import { MULTI_LAYER, type Board, type Component, type Path, type Paths, type Pt, type Track, type Via } from './types.js';

export interface AnalyzeOptions {
  clearance: number;
  /** Centreline sampling step, mm. Grows on long nets so that at most `maxSamples` are taken. */
  sampleStep: number;
  maxSamples: number;
  /** Segments whose ±3h band is less covered than this get flagged. */
  minBandCoverage: number;
  minHoleArea: number;
  returnVia: { good: number; warn: number };
  decap: { good: number; warn: number };
  /** Refuse nets with more track segments than this (complexity budget). */
  maxSegments: number;
  /** Refuse boards whose reference copper has more polygon vertices than this. */
  maxRefVertices: number;
  /** Detour searches with more graph nodes than this are reported instead of solved. */
  maxDetourNodes: number;
  /** A same-layer pour of another net is the reference (coplanar return) when its gap to the trace is
   * at most this fraction of the height above the adjacent reference plane, or when there is none. */
  coplanarRatio: number;
  /** Largest trace-edge-to-pour gap that still counts as coplanar return, mm. */
  maxCoplanarGap: number;
  /** Driver pin → decap → driver pin path length that is fine / acceptable, mm. */
  driverDecap: { good: number; warn: number };
  /** Parts that drive the net (designators); see guessDrivers. */
  drivers?: string[];
  /** Extra return length round a gap, mm: below `ignore` the gap is not reported, below `warn` it is a warning. */
  slotDetour: { ignore: number; warn: number };
  /** Raster pitch of the return solve, mm. 3 mil. */
  returnGridMm: number;
  /** Dielectric height for the loop-area cost, mm. 0 reads the stackup and falls back to 1.6 mm. */
  returnHeightMm: number;
  /** Added to d/h in the return cost, so following the trace costs this per millimetre. */
  returnEps: number;
}

export const defaultOptions: AnalyzeOptions = {
  clearance: 0.25,
  sampleStep: 0.02,
  maxSamples: 40000,
  minBandCoverage: 0.95,
  minHoleArea: 1.0,
  returnVia: { good: 1.5, warn: 4 },
  decap: { good: 3, warn: 8 },
  maxSegments: 4000,
  maxRefVertices: 500000,
  maxDetourNodes: DEFAULT_MAX_DETOUR_NODES,
  coplanarRatio: 0.5,
  maxCoplanarGap: 1.0,
  driverDecap: { good: 4, warn: 10 },
  slotDetour: { ignore: 1, warn: 5 },
  returnGridMm: 3 * 0.0254,
  returnHeightMm: 0,
  returnEps: 0.02,
};

export type Severity = 'error' | 'warn' | 'ok';

export interface Reference {
  layer: number;
  /** Trace-to-plane dielectric height, mm; for coplanar return the trace-edge-to-pour gap. */
  h: number;
  /** Return in a pour on the trace's own layer (2-layer boards, coplanar waveguide style). */
  coplanar?: boolean;
}

export interface Chain {
  net: string;
  layer: number;
  pts: Path;
  /** trackIds[i] is the track under pts[i] → pts[i + 1]. */
  trackIds: string[];
  /** Set where the chain was split because the return changes between a coplanar pour and the adjacent plane. */
  refMode?: 'coplanar' | 'plane';
  /** Start / end of the chain is such a split, not an end of the trace. */
  cut?: [boolean, boolean];
  /** At a split at the start: the via that takes the return between the pour and the plane. */
  cutVia?: Via;
}

export type GapKind = 'slot' | 'split' | 'off-reference' | 'via-antipad';

export interface Bridge {
  component: Component;
  at: Pt;
  distance: number;
  severity: Severity;
}

export interface Gap {
  kind: GapKind;
  s0: number;
  s1: number;
  a: Pt;
  b: Pt;
  netBefore: string | null;
  netAfter: string | null;
  detour?: Detour & { directLength: number; extraLength: number; loopArea: number; loop: Path };
  /** For splits between nets, or slots without an in-plane path. */
  bridge?: Bridge | null;
  /** Taken instead of a detour on the reference layer when its loop inductance is lower, or when there is none. */
  viaRoute?: ViaRoute;
  /** The detour as drawn: around every hole of the copper, also the small ones its length ignores. */
  drawn?: Path;
}

export interface ChainResult {
  chain: Chain;
  ref: Reference | null;
  refNets: string[];
  band: Paths;
  bandUncovered: Paths;
  coverage: { trackId: string; a: Pt; b: Pt; ratio: number }[];
  /** Segments reported for too little reference copper (band-coverage findings). */
  thin: { a: Pt; b: Pt; ratio: number }[];
  gaps: Gap[];
  /** Slots whose detour adds next to nothing: not reported, but the return is drawn along the detour. */
  quietGaps: Gap[];
}

/** A return that leaves its reference copper through a via and comes back through another. */
export interface ViaRoute {
  vias: [Pt, Pt];
  /** Reference layer to the first via, the other layer between the vias, reference layer from the second. */
  legs: { layer: number; path: Path }[];
  length: number;
  /** Loop inductance the route adds against the trace, vias included, nH. */
  inductance: number;
}

/** How a return route is weighed: against this trace, at these heights from its layer (mm). */
interface RouteCost {
  signal: Polyline;
  halfWidth: number;
  /** Height of the reference layer and of the other layer from the trace's layer, mm. */
  hRef: number;
  hOther: number;
}

/** A return the drawing takes between two points of its reference copper. */
export interface ReturnRoute {
  legs: { layer: number; path: Path }[];
  /** Vias the route passes through, from one layer to the other. */
  vias: Pt[];
  inductance: number;
}

export interface ViaTransition {
  fromLayer: number;
  toLayer: number;
  fromRef: Reference | null;
  toRef: Reference | null;
  fromNet: string | null;
  toNet: string | null;
  kind: 'shared-plane' | 'stitching-via' | 'decap' | 'no-reference';
  target?: { id: string; label: string; at: Pt };
  distance?: number;
  /** distance × plane separation: vertical loop added by the transition, mm². */
  loopArea?: number;
  severity: Severity;
}

export interface ViaResult {
  via: Via;
  transitions: ViaTransition[];
}

export interface Finding {
  severity: Severity;
  kind: string;
  message: string;
  at: Pt;
}

/** Sizes of the work done, for diagnostics. */
export interface AnalysisStats {
  segments: number;
  chains: number;
  vias: number;
  pours: number;
  refVertices: number;
  samples: number;
  sampleStep: number;
  coplanarChains: number;
  detours: number;
  detourNodes: number;
  detoursTooComplex: number;
}

export interface Analysis {
  net: string;
  refCopper: Map<number, LayerCopper>;
  chains: ChainResult[];
  vias: ViaResult[];
  returnPath: ReturnPath;
  findings: Finding[];
  stats: AnalysisStats;
}

export interface HfScope {
  ok: boolean;
  kind?: 'ground' | 'power' | 'plane' | 'bias';
  message?: string;
}

/**
 * Whether the high-frequency return-path check applies to a net. Ground, supply and plane nets are
 * the return path (or carry DC), and their many segments over large pours make the check slow
 * and meaningless; the DC return-current view is the right tool for them.
 */
/** Track width from which a net counts as a supply path rather than a signal, mm. */
const POWER_TRACK_MM = 0.8;
const INDUCTOR_DES = /^(?:L|FB)\d/i;

export function hfApplicability(board: Pick<Board, 'pours'> & Partial<Pick<Board, 'tracks' | 'pads' | 'components'>>, net: string): HfScope {
  net = resolveNet(board, net);
  const dc = 'Use "DC Return Current..." to see how supply current flows and returns.';
  if (isGroundNet(net))
    return { ok: false, kind: 'ground', message: `${net} is a ground net: it is the return path, not a signal. Select a signal net routed over it. ${dc}` };
  if (looksLikePowerNet(net)) return { ok: false, kind: 'power', message: `${net} looks like a power rail. The high-frequency return-path check is for signal nets. ${dc}` };
  if (board.pours.some((p) => p.net === net))
    return { ok: false, kind: 'plane', message: `${net} owns copper pours (a plane net). The high-frequency return-path check is for signal traces. ${dc}` };
  const onNet = new Set((board.pads ?? []).filter((p) => p.net === net && p.componentId).map((p) => p.componentId));
  const inductor = (board.components ?? []).find((c) => onNet.has(c.id) && INDUCTOR_DES.test(c.designator));
  if (inductor)
    return { ok: false, kind: 'power', message: `${net} connects to ${inductor.designator}, an inductor or ferrite bead: a supply or switching node, not a signal. ${dc}` };
  // One active part whose only company on the net is resistors or capacitors to a rail: a bias pin
  // (current reference, charge-pump or VCOM capacitor), not a signal travelling between parts.
  const parts = (board.components ?? []).filter((c) => onNet.has(c.id));
  const active = parts.filter((c) => !isPassive(c));
  const passives = parts.filter((c) => isPassive(c));
  const rcOnly = passives.every((c) => /^(?:R|RN|C)\d/i.test(c.designator));
  const railOf = (c: Component) => (board.pads ?? []).filter((p) => p.componentId === c.id && p.net !== net).map((p) => p.net);
  if (active.length === 1 && passives.length && rcOnly && passives.every((c) => railOf(c).length && railOf(c).every((n) => !!n && (isGroundNet(n) || looksLikePowerNet(n))))) {
    const rails = [...new Set(passives.flatMap(railOf))].join(', ');
    return {
      ok: false,
      kind: 'bias',
      message: `${net} joins only ${active[0].designator} to ${passives.map((c) => c.designator).join(', ')}, tied to ${rails}: a bias or reference pin, not a signal travelling between parts, so it has no high-frequency return path to follow.`,
    };
  }
  const widths = (board.tracks ?? []).filter((t) => t.net === net).map((t) => t.width).sort((x, y) => x - y);
  const median = widths[Math.floor(widths.length / 2)];
  if (median >= POWER_TRACK_MM)
    return { ok: false, kind: 'power', message: `${net} is routed ${median.toFixed(2)} mm wide, like a supply path, not a signal. ${dc}` };
  return { ok: true };
}

/** Pipeline steps 1–4 for one net. Pure: no I/O. Runs on the calling thread. */
export function analyzeNet(board: Board, net: string, options: Partial<AnalyzeOptions> = {}, run: RunOptions = {}): Analysis {
  return runSync(analyzeNetSteps(board, net, options), run);
}

/** Same as analyzeNet, in time slices that hand control back to the host between slices. */
export function analyzeNetAsync(board: Board, net: string, options: Partial<AnalyzeOptions> = {}, run: RunOptions = {}): Promise<Analysis> {
  return runAsync(analyzeNetSteps(board, net, options), run);
}

export function* analyzeNetSteps(board: Board, net: string, options: Partial<AnalyzeOptions> = {}): Steps<Analysis> {
  net = resolveNet(board, net);
  const opts = { ...defaultOptions, ...options };
  const tracks = board.tracks.filter((t) => t.net === net);
  if (!tracks.length) {
    const pad = board.pads.find((p) => p.net === net);
    return {
      net,
      refCopper: new Map(),
      chains: [],
      vias: [],
      returnPath: { traces: [], jumps: [], drivers: [], marks: [], transitions: [], length: 0 },
      findings: [{ severity: 'warn', kind: 'no-tracks', message: `${net} has no tracks: it is not routed, or its pads are joined only by pours or touching copper, so there is no trace whose return could be followed`, at: pad?.at ?? { x: 0, y: 0 } }],
      stats: { segments: 0, chains: 0, vias: 0, pours: board.pours.length, refVertices: 0, samples: 0, sampleStep: opts.sampleStep, coplanarChains: 0, detours: 0, detourNodes: 0, detoursTooComplex: 0 },
    };
  }
  if (tracks.length > opts.maxSegments)
    throw new AnalysisAborted('complexity', `Net ${net} has ${tracks.length} track segments (limit ${opts.maxSegments}). That is a power or plane-sized net, not a signal trace.`, 'start');
  yield { phase: 'reference copper', fraction: 0 };
  const refCopper = yield* buildReferenceCopperSteps(board, { clearance: opts.clearance });
  const refVertices = vertexCount([...refCopper.values()].flatMap((lc) => [...lc.byNet.values()]));
  if (refVertices > opts.maxRefVertices)
    throw new AnalysisAborted('complexity', `Reference copper has ${refVertices} polygon vertices (limit ${opts.maxRefVertices}).`, 'reference copper');
  const ownVias = board.vias.filter((v) => v.net === net);
  const findings: Finding[] = [];
  const chains0 = buildChains(tracks);
  const totalLength = chains0.reduce((s, c) => s + new Polyline(c.pts).length, 0);
  const stats: AnalysisStats = {
    segments: tracks.length,
    chains: chains0.length,
    vias: ownVias.length,
    pours: board.pours.length,
    refVertices,
    samples: 0,
    sampleStep: Math.max(opts.sampleStep, totalLength / opts.maxSamples),
    coplanarChains: 0,
    detours: 0,
    detourNodes: 0,
    detoursTooComplex: 0,
  };
  const ctx = new Context(board, refCopper, opts, stats);
  const chains = chains0.flatMap((c) => splitByReference(ctx, c));
  stats.chains = chains.length;
  const results: ChainResult[] = [];
  for (const [i, chain] of chains.entries()) {
    yield { phase: 'chains', fraction: i / chains.length, steps: chains.length };
    results.push(yield* analyzeChain(ctx, chain, ownVias, findings));
  }
  const vias: ViaResult[] = [];
  for (const [i, via] of ownVias.entries()) {
    yield { phase: 'vias', fraction: i / ownVias.length };
    vias.push(analyzeVia(ctx, via, tracks, results, findings));
  }
  const returnPath = yield* buildReturnPath(board, net, results, vias, ctx, findings, opts, refCopper);
  return { net, refCopper, chains: results, vias, returnPath, findings, stats };
}

/** Per-analysis caches: spatial indexes of each layer's reference nets and merged copper. */
class Context {
  private readonly indexes = new Map<number, [string, EdgeGrid][]>();
  private readonly merged = new Map<string, Paths>();
  /** Tracks, pads and vias of a net on a layer that has no pour of that net. */
  private readonly trackOnly = new Map<string, Paths>();
  constructor(
    readonly board: Board,
    readonly refCopper: Map<number, LayerCopper>,
    readonly opts: AnalyzeOptions,
    readonly stats: AnalysisStats,
  ) {}

  layerName(id: number) {
    return this.board.stackup.copper.find((l) => l.id === id)?.name ?? `L${id}`;
  }

  index(layer: number): [string, EdgeGrid][] {
    let idx = this.indexes.get(layer);
    if (!idx) {
      idx = [...(this.refCopper.get(layer)?.byNet ?? [])].map(([net, paths]) => [net, new EdgeGrid(paths)] as [string, EdgeGrid]);
      this.indexes.set(layer, idx);
    }
    return idx;
  }

  private readonly conductors = new Map<number, Map<string, { net: string; hit: (p: Pt) => boolean }[]>>();

  /**
   * True where p lies on a track, pad or via of a net that has no pour on the layer: copper the return
   * cannot flow through, such as a neighbouring signal trace or another leg of the trace itself.
   * Copper of `ignore` does not count; with `only`, only that net's copper does.
   */
  blockedAt(p: Pt, layer: number, ignore?: string, only?: string): boolean {
    let grid = this.conductors.get(layer);
    if (!grid) {
      grid = new Map();
      const pourNets = this.refCopper.get(layer)?.byNet ?? new Map();
      const put = (x0: number, y0: number, x1: number, y1: number, net: string, hit: (q: Pt) => boolean) => {
        for (let i = Math.floor(x0); i <= Math.floor(x1); i++)
          for (let j = Math.floor(y0); j <= Math.floor(y1); j++) {
            const k = `${i},${j}`;
            grid!.get(k)?.push({ net, hit }) ?? grid!.set(k, [{ net, hit }]);
          }
      };
      for (const t of this.board.tracks) {
        if (t.layer !== layer || pourNets.has(t.net)) continue;
        const r = t.width / 2;
        put(Math.min(t.a.x, t.b.x) - r, Math.min(t.a.y, t.b.y) - r, Math.max(t.a.x, t.b.x) + r, Math.max(t.a.y, t.b.y) + r, t.net, (q) => distPointSeg(q, t.a, t.b) <= r);
      }
      for (const v of this.board.vias) {
        if (pourNets.has(v.net)) continue;
        const r = v.diameter / 2;
        put(v.at.x - r, v.at.y - r, v.at.x + r, v.at.y + r, v.net, (q) => dist(q, v.at) <= r);
      }
      for (const pd of this.board.pads) {
        if ((pd.layer !== layer && pd.layer !== MULTI_LAYER) || (pd.net && pourNets.has(pd.net))) continue;
        const xs = pd.shape.flat();
        if (!xs.length) continue;
        put(Math.min(...xs.map((q) => q.x)), Math.min(...xs.map((q) => q.y)), Math.max(...xs.map((q) => q.x)), Math.max(...xs.map((q) => q.y)), pd.net ?? '', (q) => pointInPaths(q, pd.shape));
      }
      this.conductors.set(layer, grid);
    }
    return !!grid.get(`${Math.floor(p.x)},${Math.floor(p.y)}`)?.some((c) => c.net !== ignore && (only === undefined || c.net === only) && c.hit(p));
  }

  /**
   * Distance from the trace edge (at p, along unit normal n) to the first copper of a pour net other
   * than `net`, up to maxGap; null when nothing is that close. Other nets' traces in between do not
   * stop it (the pour beyond a neighbouring trace is still the nearest return copper); with `ownBlocks`,
   * the trace's own copper does, such as another leg of a meander.
   */
  pourBeside(p: Pt, n: Pt, halfWidth: number, layer: number, net: string, maxGap: number, ownBlocks = false, step = 0.025): { d: number; net: string } | null {
    for (let d = step; d <= maxGap + 1e-9; d += step) {
      const q = add(p, mul(n, halfWidth + d));
      const hit = this.netAt(q, layer, net);
      if (hit) return { d, net: hit };
      if (ownBlocks && this.blockedAt(q, layer, undefined, net)) return null;
    }
    return null;
  }

  /** Net of the reference copper at p (optionally ignoring one net). */
  netAt(p: Pt, layer: number, exclude?: string): string | null {
    for (const [net, g] of this.index(layer)) if (net !== exclude && g.contains(p)) return net;
    return null;
  }

  /**
   * The return of a chain from a to b, both in `net` copper on the chain's reference layer: round
   * through that copper, or down a via, along the other layer and back up, whichever adds less loop
   * inductance. Null when neither way exists.
   */
  returnRoute(c: ChainResult, net: string, a: Pt, b: Pt): ReturnRoute | null {
    const ref = c.ref;
    const region = ref && this.refCopper.get(ref.layer)?.byNet.get(net);
    if (!ref || !region) return null;
    const cost = routeCost(this, c.chain, ref);
    const round = drawnGeodesic(region, a, b, this.opts.maxDetourNodes);
    const inPlane = round ? pathInductance(round.path, cost.signal, cost.halfWidth, cost.hRef) : Infinity;
    const other = ref.coplanar ? referenceFor(this.board, c.chain.layer, this.refCopper)?.layer : c.chain.layer;
    const via = other === undefined ? null : viaRoute(this, net, ref.layer, other, a, b, cost, inPlane);
    if (via) return { legs: via.legs, vias: via.vias, inductance: via.inductance };
    return round ? { legs: [{ layer: ref.layer, path: round.path }], vias: [], inductance: inPlane } : null;
  }

  /**
   * Copper of `net` on a layer: its pour where it has one, and otherwise the tracks, pads and vias
   * that carry it (a ground pad tied to a via by a short trace, on a layer with no pour).
   */
  netCopper(layer: number, net: string): Paths {
    const poured = this.refCopper.get(layer)?.byNet.get(net);
    if (poured) return poured;
    const k = `${layer}|${net}`;
    let c = this.trackOnly.get(k);
    if (!c) {
      const parts: Paths = [];
      for (const t of this.board.tracks) if (t.layer === layer && t.net === net) parts.push(...strokePath([t.a, t.b], t.width));
      for (const p of this.board.pads) if ((p.layer === layer || p.layer === MULTI_LAYER) && p.net === net) parts.push(...p.shape);
      for (const v of this.board.vias) if (v.net === net) parts.push(circle(v.at, v.diameter / 2));
      c = parts.length ? union(parts) : [];
      this.trackOnly.set(k, c);
    }
    return c;
  }

  copperPath(layer: number, net: string, a: Pt, b: Pt): Path | null {
    const region = this.netCopper(layer, net);
    if (!region.length) return null;
    return drawnGeodesic(region, a, b, this.opts.maxDetourNodes)?.path ?? null;
  }

  copper(layer: number, exclude?: string): Paths {
    const k = `${layer}|${exclude ?? ''}`;
    let c = this.merged.get(k);
    if (!c) {
      const lc = this.refCopper.get(layer);
      c = exclude === undefined ? allCopper(lc) : union(...[...(lc?.byNet ?? [])].filter(([n]) => n !== exclude).map(([, p]) => p));
      this.merged.set(k, c);
    }
    return c;
  }
}

function routeCost(ctx: Context, chain: Chain, ref: Reference): RouteCost {
  const track = ctx.board.tracks.find((t) => t.id === chain.trackIds[0]);
  const adjacent = ref.coplanar ? referenceFor(ctx.board, chain.layer, ctx.refCopper) : null;
  return {
    signal: new Polyline(chain.pts),
    halfWidth: (track?.width ?? 0.2) / 2,
    hRef: ref.coplanar ? 0 : ref.h,
    hOther: ref.coplanar ? (adjacent?.h ?? 0) : 0,
  };
}

/** Nearest copper layer above/below that has reference copper. */
export function referenceFor(board: Board, layerId: number, refCopper: Map<number, LayerCopper>): Reference | null {
  const { copper, dielectrics } = board.stackup;
  const i = copper.findIndex((l) => l.id === layerId);
  if (i < 0) return null;
  const cands: Reference[] = [];
  for (const j of [i - 1, i + 1]) {
    if (j < 0 || j >= copper.length) continue;
    if (!refCopper.get(copper[j].id)?.byNet.size) continue;
    cands.push({ layer: copper[j].id, h: dielectrics[Math.min(i, j)].thicknessMm });
  }
  cands.sort((p, q) => p.h - q.h);
  return cands[0] ?? null;
}

const key = (p: Pt) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;

/** Group a net's tracks into connected polylines per layer. */
export function buildChains(tracks: Track[]): Chain[] {
  const chains: Chain[] = [];
  const layers = [...new Set(tracks.map((t) => t.layer))];
  for (const layer of layers) {
    const ts = tracks.filter((t) => t.layer === layer);
    const adj = new Map<string, Track[]>();
    for (const t of ts) for (const p of [t.a, t.b]) adj.set(key(p), [...(adj.get(key(p)) ?? []), t]);
    const used = new Set<string>();
    const starts = [...ts.flatMap((t) => [t.a, t.b]).filter((p) => adj.get(key(p))!.length === 1), ...ts.map((t) => t.a)];
    for (const start of starts) {
      let cur = start;
      const pts: Path = [cur];
      const ids: string[] = [];
      for (;;) {
        const next = adj.get(key(cur))!.find((t) => !used.has(t.id));
        if (!next) break;
        used.add(next.id);
        ids.push(next.id);
        cur = key(next.a) === key(cur) ? next.b : next.a;
        pts.push(cur);
      }
      if (ids.length) chains.push({ net: tracks[0].net, layer, pts, trackIds: ids });
    }
  }
  return chains;
}

const normal = (d: Pt): Pt => ({ x: -d.y, y: d.x });

/**
 * Median gap between the trace edge and same-layer pour copper of another net, probing both sides
 * at points along the chain. Null when fewer than a third of the probes find copper within maxGap.
 */
function coplanarGap(ctx: Context, chain: Chain, line: Polyline, halfWidth: number): number | null {
  if (!ctx.index(chain.layer).some(([n]) => n !== chain.net)) return null;
  const k = Math.max(4, Math.min(40, Math.ceil(line.length / 0.5)));
  const gaps: number[] = [];
  const step = 0.025;
  for (let i = 0; i < k; i++) {
    const s = ((i + 0.5) / k) * line.length;
    const p = line.at(s);
    const n = normal(line.dirAt(s));
    const side = [n, mul(n, -1)].map((nv) => ctx.pourBeside(p, nv, halfWidth, chain.layer, chain.net, ctx.opts.maxCoplanarGap, false, step)?.d ?? Infinity);
    if (Math.min(...side) < Infinity) gaps.push(Math.min(...side));
  }
  if (gaps.length < k / 3) return null;
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1];
}

/**
 * Splits a chain where its return changes between a pour beside it (coplanar) and the plane on the
 * adjacent layer: coplanar where same-layer copper of another net lies within coplanarRatio·h of the
 * trace edge, the plane elsewhere. Without an adjacent plane the chain stays whole.
 */
function splitByReference(ctx: Context, chain: Chain): Chain[] {
  const { board, opts } = ctx;
  const adjacent = referenceFor(board, chain.layer, ctx.refCopper);
  if (!adjacent || !ctx.index(chain.layer).some(([n]) => n !== chain.net)) return [chain];
  const limit = Math.min(opts.maxCoplanarGap, opts.coplanarRatio * adjacent.h);
  const halfWidth = (board.tracks.find((t) => t.id === chain.trackIds[0])?.width ?? 0.2) / 2;
  const line = new Polyline(chain.pts);
  const L = line.length;
  const n = Math.max(1, Math.ceil(L / 0.25));
  const besideAt = (s: number) => {
    const p = line.at(s);
    const nv = normal(line.dirAt(s));
    return !!(ctx.pourBeside(p, nv, halfWidth, chain.layer, chain.net, limit) ?? ctx.pourBeside(p, mul(nv, -1), halfWidth, chain.layer, chain.net, limit));
  };
  const runs: { s0: number; s1: number; coplanar: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const s0 = (L * i) / n;
    const s1 = (L * (i + 1)) / n;
    const c = besideAt((s0 + s1) / 2);
    if (runs.length && runs[runs.length - 1].coplanar === c) runs[runs.length - 1].s1 = s1;
    else runs.push({ s0, s1, coplanar: c });
  }
  // A probe that lands in a pad clearance is not a change of reference; a short stretch of pour is not one either.
  const merge = (short: (r: (typeof runs)[number], i: number) => boolean) => {
    for (let i = 0; i < runs.length; i++) {
      if (runs.length < 2 || !short(runs[i], i)) continue;
      const into = i > 0 ? i - 1 : i + 1;
      runs[into] = { s0: Math.min(runs[into].s0, runs[i].s0), s1: Math.max(runs[into].s1, runs[i].s1), coplanar: runs[into].coplanar };
      runs.splice(i, 1);
      for (let j = Math.max(0, into - 1); j < runs.length - 1; j++)
        if (runs[j].coplanar === runs[j + 1].coplanar) runs.splice(j, 2, { s0: runs[j].s0, s1: runs[j + 1].s1, coplanar: runs[j].coplanar });
      i = -1;
    }
  };
  merge((r, i) => !r.coplanar && r.s1 - r.s0 < 0.6 && i > 0 && i < runs.length - 1);
  // Where the pour beside the trace lasts less than two via reaches, the return stays on the plane rather
  // than changing layer twice to use it.
  const reach = Math.max(2, 2 * adjacent.h);
  merge((r) => r.coplanar && r.s1 - r.s0 < 2 * reach);
  // Nor does it drop to the plane and come back up through vias for less than a via reach.
  merge((r, i) => !r.coplanar && r.s1 - r.s0 < reach && i > 0 && i < runs.length - 1);
  // The return changes layer only through a via of the pour's net near the split; elsewhere the
  // shorter side takes the reference of the longer one (a coplanar gap then shows as a slot).
  const viaAt = (i: number): Via | undefined => {
    const s = runs[i].s1;
    const co = runs[i].coplanar ? runs[i] : runs[i + 1];
    const probeS = Math.min(Math.max(s, co.s0 + 0.1), co.s1 - 0.1);
    const p = line.at(probeS);
    const nv = normal(line.dirAt(probeS));
    const pourNet = (ctx.pourBeside(p, nv, halfWidth, chain.layer, chain.net, limit) ?? ctx.pourBeside(p, mul(nv, -1), halfWidth, chain.layer, chain.net, limit))?.net ?? null;
    const at = line.at(s);
    return board.vias.filter((v) => v.net === pourNet && dist(v.at, at) <= reach).sort((a, b) => dist(a.at, at) - dist(b.at, at))[0];
  };
  const vias: (Via | undefined)[] = [];
  for (let changed = true; changed; ) {
    changed = false;
    vias.length = 0;
    for (let i = 0; i < runs.length - 1; i++) {
      const v = viaAt(i);
      vias.push(v);
      if (v) continue;
      const [a, b] = [runs[i], runs[i + 1]];
      const keep = a.s1 - a.s0 >= b.s1 - b.s0 ? a : b;
      runs.splice(i, 2, { s0: a.s0, s1: b.s1, coplanar: keep.coplanar });
      for (let j = Math.max(0, i - 1); j < runs.length - 1; j++)
        if (runs[j].coplanar === runs[j + 1].coplanar) runs.splice(j, 2, { s0: runs[j].s0, s1: runs[j + 1].s1, coplanar: runs[j].coplanar });
      changed = true;
      break;
    }
  }
  if (runs.length === 1) return [{ ...chain, refMode: runs[0].coplanar ? 'coplanar' : 'plane' }];
  return runs.map((r, i) => ({
    ...sliceChain(chain, line, r.s0, r.s1),
    refMode: r.coplanar ? 'coplanar' : 'plane',
    cut: [i > 0, i < runs.length - 1],
    cutVia: i > 0 ? vias[i - 1] : undefined,
  }));
}

/** The part of a chain between arc lengths s0 and s1, keeping each piece's track id. */
function sliceChain(chain: Chain, line: Polyline, s0: number, s1: number): Chain {
  const pts: Path = [line.at(s0)];
  const trackIds: string[] = [];
  for (let i = 0; i < chain.trackIds.length; i++) {
    const a = Math.max(s0, line.cum[i]);
    const b = Math.min(s1, line.cum[i + 1]);
    if (b - a <= 1e-9) continue;
    pts.push(line.at(b));
    trackIds.push(chain.trackIds[i]);
  }
  return { net: chain.net, layer: chain.layer, pts, trackIds };
}

/**
 * Return from a to b on `refLayer` that crosses through `otherLayer`: to a via (or through-hole pad)
 * of the net near a, in that net's copper on the other layer to one near b, and on to b. The one
 * with the least loop inductance, vias included; null when none is below maxInductance.
 */
function viaRoute(ctx: Context, net: string, refLayer: number, otherLayer: number, a: Pt, b: Pt, cost: RouteCost, maxInductance: number): ViaRoute | null {
  const { board, opts } = ctx;
  const here = ctx.refCopper.get(refLayer)?.byNet.get(net);
  const there = ctx.refCopper.get(otherLayer)?.byNet.get(net);
  if (!here || !there) return null;
  const stops = [
    ...board.vias.filter((v) => v.net === net).map((v) => ({ at: v.at, drill: v.drill })),
    ...board.pads.filter((p) => p.net === net && p.layer === MULTI_LAYER).map((p) => ({ at: p.at, drill: p.holeDiameter })),
  ];
  const barrel = (drill: number) => viaInductance(Math.abs(cost.hRef - cost.hOther), drill);
  const go = (region: Paths, p: Pt, q: Pt, h: number) => {
    const d = drawnGeodesic(region, p, q, opts.maxDetourNodes);
    return d ? { ...d, inductance: pathInductance(d.path, cost.signal, cost.halfWidth, h) } : null;
  };
  const near = (p: Pt) =>
    stops
      .filter((s) => dist(s.at, p) <= VIA_ROUTE_REACH)
      .sort((u, v) => dist(u.at, p) - dist(v.at, p))
      .slice(0, 3);
  const fromA = near(a).flatMap((v) => {
    const d = go(here, a, v.at, cost.hRef);
    return d ? [{ v, d }] : [];
  });
  const toB = near(b).flatMap((v) => {
    const d = go(here, v.at, b, cost.hRef);
    return d ? [{ v, d }] : [];
  });
  let best: ViaRoute | null = null;
  for (const s of fromA)
    for (const e of toB) {
      const ends = s.d.inductance + e.d.inductance + barrel(s.v.drill) + barrel(e.v.drill);
      if (dist(s.v.at, e.v.at) < 1e-6 || ends >= (best?.inductance ?? maxInductance)) continue;
      const m = go(there, s.v.at, e.v.at, cost.hOther);
      if (!m || ends + m.inductance >= (best?.inductance ?? maxInductance)) continue;
      best = {
        vias: [s.v.at, e.v.at],
        length: s.d.length + m.length + e.d.length,
        inductance: ends + m.inductance,
        legs: [{ layer: refLayer, path: s.d.path }, { layer: otherLayer, path: m.path }, { layer: refLayer, path: e.d.path }],
      };
    }
  return best;
}

/** How far from a gap end a via is looked for to take the return through the other layer, mm. */
const VIA_ROUTE_REACH = 6;
/** Holes a drawn return goes around, however small (mm²): a line across an antipad would pass through a via. */
const DRAWN_HOLE_AREA = 1e-4;
/** How far inside the copper a drawn return keeps, so the line does not straddle the copper edge, mm; tried in order. */
const DRAWN_INSETS = [0.1, 0.05, 0.02];

/**
 * The return as drawn: around every hole, inside the copper by the largest inset that still joins
 * a and b (ends at a gap edge, close to the copper edge, step straight in), along the edge where none does.
 */
function drawnGeodesic(region: Paths, a: Pt, b: Pt, maxNodes?: number) {
  const o = { minHoleArea: DRAWN_HOLE_AREA, window: 5, maxNodes };
  for (const inset of DRAWN_INSETS) {
    const d = geodesic(region, a, b, { ...o, inset, snapEnds: 2 * inset });
    if (d) return d;
  }
  return geodesic(region, a, b, o);
}

function* analyzeChain(ctx: Context, chain: Chain, ownVias: Via[], findings: Finding[]): Steps<ChainResult> {
  const { board, opts, stats } = ctx;
  const line = new Polyline(chain.pts);
  const trackById = new Map(board.tracks.map((t) => [t.id, t]));
  const halfWidth = (trackById.get(chain.trackIds[0])?.width ?? 0.2) / 2;
  const adjacent = referenceFor(board, chain.layer, ctx.refCopper);
  const gap = chain.refMode === 'plane' && adjacent ? null : coplanarGap(ctx, chain, line, halfWidth);
  let ref = adjacent;
  if (gap !== null && (!adjacent || chain.refMode === 'coplanar' || gap <= opts.coplanarRatio * adjacent.h)) ref = { layer: chain.layer, h: gap, coplanar: true };
  const layerName = (id: number) => ctx.layerName(id);
  if (!ref) {
    findings.push({
      severity: 'error',
      kind: 'no-reference',
      message: `${layerName(chain.layer)} trace has no reference copper: no pour on an adjacent layer and no coplanar pour beside it`,
      at: line.at(line.length / 2),
    });
    return { chain, ref: null, refNets: [], band: [], bandUncovered: [], coverage: [], thin: [], gaps: [], quietGaps: [] };
  }
  if (ref.coplanar) stats.coplanarChains++;
  const lc = ctx.refCopper.get(ref.layer)!;
  const exclude = ref.coplanar ? chain.net : undefined;
  const copper = ctx.copper(ref.layer, exclude);
  // Coplanar: the band is the strip beside the trace keepout, ±3·gap wide; otherwise ±3h around the centreline.
  const inner = ref.coplanar ? halfWidth + 1.25 * ref.h : 0;
  const halfBand = ref.coplanar ? inner + 3 * ref.h : 3 * ref.h;
  const keepout = ref.coplanar ? strokePath(chain.pts, 2 * inner, true) : [];
  const ownPads = ref.coplanar ? board.pads.filter((p) => p.net === chain.net && (p.layer === chain.layer || p.layer === MULTI_LAYER)) : [];
  const antipads = union(
    ownVias.map((v) => circle(v.at, v.diameter / 2 + opts.clearance + 0.05)),
    ...ownPads.map((p) => inflate(p.shape, opts.clearance + 0.05)),
  );

  const strip = difference(strokePath(chain.pts, 2 * halfBand, true), keepout);
  const band = board.outline.length ? intersect(strip, board.outline) : strip;
  const bandCopper = intersect(band, copper);
  const bandUncovered = difference(difference(band, bandCopper), antipads);

  // ±band coverage per track segment (own-net via antipads excluded: handled in step 4).
  const coverage: ChainResult['coverage'] = [];
  for (const [i, id] of chain.trackIds.entries()) {
    yield { phase: 'band coverage', fraction: i / chain.trackIds.length };
    const [a, b] = [chain.pts[i], chain.pts[i + 1]];
    coverage.push({ trackId: id, a, b, ratio: ref.coplanar ? coplanarCoverage(a, b, halfBand, antipads, keepout, bandCopper) : planeCoverage(a, b, ref.h, antipads, bandCopper) });
  }

  // Classify the centreline by the reference net underneath (coplanar: beside it), then refine run boundaries.
  const probe = ref.coplanar ? halfWidth + 1.5 * ref.h + 0.05 : 0;
  const sides = (s: number): [Pt, Pt] => {
    const p = line.at(s);
    const n = normal(line.dirAt(s));
    return [add(p, mul(n, probe)), add(p, mul(n, -probe))];
  };
  const classify = (s: number): string | null => {
    if (!ref.coplanar) return ctx.netAt(line.at(s), ref.layer);
    const [l, r] = sides(s);
    return ctx.netAt(l, ref.layer, exclude) ?? ctx.netAt(r, ref.layer, exclude);
  };
  const L = line.length;
  const n = Math.max(2, Math.ceil(L / stats.sampleStep));
  stats.samples += n + 1;
  const cls: (string | null)[] = [];
  for (let i = 0; i <= n; i++) {
    if (i % 512 === 0) yield { phase: 'sampling', fraction: i / n };
    cls.push(classify((L * i) / n));
  }
  const refine = (s0: number, s1: number, c0: string | null) => {
    for (let k = 0; k < 20; k++) {
      const m = (s0 + s1) / 2;
      if (classify(m) === c0) s0 = m;
      else s1 = m;
    }
    return (s0 + s1) / 2;
  };
  const runs: { s0: number; s1: number; net: string | null }[] = [];
  let start = 0;
  for (let i = 1; i <= n + 1; i++) {
    if (i <= n && cls[i] === cls[start]) continue;
    const s0 = start === 0 ? 0 : refine((L * (start - 1)) / n, (L * start) / n, cls[start - 1]);
    const s1 = i > n ? L : refine((L * (i - 1)) / n, (L * i) / n, cls[i - 1]);
    runs.push({ s0, s1, net: cls[start] });
    start = i;
  }

  const gaps: Gap[] = [];
  // Gaps whose detour adds next to nothing: not reported, but their segments get no coverage warning either.
  const minorGaps: Gap[] = [];
  const where = ref.coplanar ? `${layerName(chain.layer)} (coplanar return)` : `${layerName(chain.layer)} over ${layerName(ref.layer)}`;
  for (const [i, r] of runs.entries()) {
    if (r.net !== null) continue;
    yield { phase: 'gaps', fraction: i / runs.length };
    const before = runs[i - 1]?.net ?? null;
    const after = runs[i + 1]?.net ?? null;
    const a = line.at(r.s0);
    const b = line.at(r.s1);
    const atEnd = r.s0 <= 1e-9 || r.s1 >= L - 1e-9;
    // The neighbouring piece of the chain, on the other reference, covers a gap at a split.
    if ((r.s0 <= 1e-9 && chain.cut?.[0]) || (r.s1 >= L - 1e-9 && chain.cut?.[1])) continue;
    const endPt = r.s0 <= 1e-9 ? chain.pts[0] : chain.pts[chain.pts.length - 1];
    let kind: GapKind;
    // Coplanar pours keep their clearance around the trace's own pads too, so the trace leaves the pour where it ends on a pad.
    const terminal = (p: Pt) =>
      ownVias.some((v) => dist(v.at, p) < v.diameter / 2 + opts.clearance + 0.1) ||
      (!!ref.coplanar && board.pads.some((pd) => pd.net === chain.net && (pd.layer === chain.layer || pd.layer === MULTI_LAYER) && distToPaths(p, pd.shape) < 0.05));
    if (atEnd) kind = terminal(endPt) && r.s1 - r.s0 < 3 * halfBand ? 'via-antipad' : 'off-reference';
    else kind = before === after ? 'slot' : 'split';
    const gap: Gap = { kind, s0: r.s0, s1: r.s1, a, b, netBefore: before, netAfter: after };
    const mid = line.at((r.s0 + r.s1) / 2);

    if (kind === 'slot') {
      const eps = Math.min(0.1, (runs[i - 1].s1 - runs[i - 1].s0) / 2, (runs[i + 1].s1 - runs[i + 1].s0) / 2);
      let pa = line.at(r.s0 - eps);
      let pb = line.at(r.s1 + eps);
      if (ref.coplanar) {
        // End points in the pour beside the trace, on a side that has copper at both ends.
        const [la, ra] = sides(r.s0 - eps);
        const [lb, rb] = sides(r.s1 + eps);
        const onL = ctx.netAt(la, ref.layer, exclude) === before && ctx.netAt(lb, ref.layer, exclude) === before;
        [pa, pb] = onL ? [la, lb] : [ra, rb];
      }
      stats.detours++;
      const info = { nodes: 0 };
      const det = yield* geodesicSteps(lc.byNet.get(before!)!, pa, pb, { minHoleArea: opts.minHoleArea, window: 5, maxNodes: opts.maxDetourNodes, info });
      stats.detourNodes = Math.max(stats.detourNodes, info.nodes);
      const directLength = r.s1 - r.s0 + 2 * eps;
      if (det === TOO_COMPLEX) {
        stats.detoursTooComplex++;
        findings.push({
          severity: 'warn',
          kind: 'slot-crossing',
          message: `${where}: crosses a ${(r.s1 - r.s0).toFixed(2)} mm gap in ${before}; the copper around it is too complex to trace the detour (over ${opts.maxDetourNodes} corners)`,
          at: mid,
        });
        gaps.push(gap);
        continue;
      }
      if (det) {
        const direct = line.slice(r.s0 - eps, r.s1 + eps);
        const loop = [...direct, ...[...det.path].reverse()];
        // A coplanar detour starts beside the trace and can come out shorter than the centreline.
        gap.detour = { ...det, directLength, extraLength: Math.max(0, det.length - directLength), loopArea: enclosedArea(loop), loop };
        gap.drawn = drawnGeodesic(lc.byNet.get(before!)!, pa, pb, opts.maxDetourNodes)?.path;
        if (gap.detour.extraLength < opts.slotDetour.ignore) {
          minorGaps.push(gap);
          continue;
        }
      }
      // Through the other layer: down a via of the reference net on one side of the gap, back up on the other.
      yield { phase: 'gaps' };
      const other = ref.coplanar ? adjacent?.layer : chain.layer;
      const cost = routeCost(ctx, chain, ref);
      const round = gap.detour ? pathInductance(gap.drawn ?? gap.detour.path, cost.signal, cost.halfWidth, cost.hRef) : Infinity;
      const route = other === undefined ? null : viaRoute(ctx, before!, ref.layer, other, pa, pb, cost, round);
      const nH = (x: number) => `${x.toFixed(1)} nH`;
      if (route) {
        gap.detour = undefined;
        gap.viaRoute = route;
        const extra = Math.max(0, route.length - directLength);
        const at = (p: Pt) => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`;
        findings.push({
          severity: extra < opts.slotDetour.warn ? 'warn' : 'error',
          kind: 'slot-crossing',
          message: `${where}: crosses a ${(r.s1 - r.s0).toFixed(2)} mm gap in ${before}; the return goes through the ${before} vias at ${at(route.vias[0])} and ${at(route.vias[1])} and the ${before} copper on ${layerName(other!)}, +${extra.toFixed(1)} mm, ${nH(route.inductance)}${gap.detour ? ` (round the gap in ${layerName(ref.layer)} copper: ${nH(round)})` : ''}`,
          at: mid,
        });
      } else if (gap.detour) {
        const via = other === undefined ? '' : `; no way through ${before} vias adds less inductance`;
        findings.push({
          severity: gap.detour.extraLength < opts.slotDetour.warn ? 'warn' : 'error',
          kind: 'slot-crossing',
          message: `${where}: crosses a ${(r.s1 - r.s0).toFixed(2)} mm gap in ${before}; return detours +${gap.detour.extraLength.toFixed(1)} mm, adds ${gap.detour.loopArea.toFixed(1)} mm² loop area, ${nH(round)}${via}`,
          at: mid,
        });
      } else {
        gap.bridge = nearestBridge(board, mid, before!, before!, opts);
        findings.push({ severity: 'error', kind: 'isolated-copper', message: `${where}: crosses between unconnected ${before} islands; no in-plane return path, and no ${before} vias nearby join them through another layer`, at: mid });
      }
    } else if (kind === 'split') {
      gap.bridge = nearestBridge(board, mid, before!, after!, opts);
      const br = gap.bridge ? `nearest bridging cap ${gap.bridge.component.designator} at ${gap.bridge.distance.toFixed(1)} mm` : 'no bridging cap found';
      // A nearby stitching cap gives the return a bridge, but the crossing remains a weak spot.
      const severity: Severity = gap.bridge?.severity === 'ok' ? 'warn' : 'error';
      findings.push({ severity, kind: 'split-crossing', message: `${where}: crosses split ${before} → ${after}; ${br}`, at: mid });
    } else if (kind === 'off-reference') {
      const what = ref.coplanar ? 'has no coplanar pour beside it' : 'has no reference copper underneath';
      findings.push({ severity: 'error', kind: 'off-reference', message: `${where}: ${(r.s1 - r.s0).toFixed(2)} mm of trace ${what}`, at: mid });
    }
    gaps.push(gap);
  }

  // Consecutive thin segments make one finding, placed on the worst of them.
  let low: typeof coverage = [];
  const thin: ChainResult['thin'] = [];
  const flush = () => {
    if (!low.length) return;
    thin.push(...low.map(({ a, b, ratio }) => ({ a, b, ratio })));
    const worst = low.reduce((w, c) => (c.ratio < w.ratio ? c : w));
    const length = low.reduce((s, c) => s + dist(c.a, c.b), 0);
    const [a, b] = [low[0].a, low[low.length - 1].b];
    const pct = `${(worst.ratio * 100).toFixed(0)}%`;
    const what = ref.coplanar
      ? `the pour beside it covers as little as ${pct} of the coplanar band on its better side (${(halfBand - inner).toFixed(2)} mm beyond the trace clearance)`
      : `copper under it carries as little as ${pct} of the return current's spread (±3h = ±${halfBand.toFixed(2)} mm, weighted towards the trace)`;
    const span = low.length > 1 ? `${low.length} segments, ${length.toFixed(1)} mm` : `${length.toFixed(1)} mm`;
    findings.push({
      severity: 'warn',
      kind: 'band-coverage',
      message: `${layerName(chain.layer)} (${a.x.toFixed(1)}, ${a.y.toFixed(1)})→(${b.x.toFixed(1)}, ${b.y.toFixed(1)}), ${span}: ${what}`,
      at: { x: (worst.a.x + worst.b.x) / 2, y: (worst.a.y + worst.b.y) / 2 },
    });
    low = [];
  };
  // Beside a coplanar piece shorter than the trace keepout, the keepout of the neighbouring pieces fills the band.
  const minPiece = ref.coplanar ? Math.max(0.1, inner) : 0.1;
  for (const c of coverage) {
    if (dist(c.a, c.b) < minPiece) continue;
    const onSeg = (p: Pt) => distPointSeg(p, c.a, c.b) < 1e-6;
    if (c.ratio >= opts.minBandCoverage || [...gaps, ...minorGaps].some((g) => g.kind !== 'via-antipad' && (onSeg(g.a) || onSeg(g.b)))) {
      flush();
      continue;
    }
    low.push(c);
  }
  flush();

  const refNets = [...new Set(runs.map((r) => r.net).filter((x): x is string => !!x))];
  return { chain, ref, refNets, band, bandUncovered, coverage, thin, gaps, quietGaps: minorGaps };
}

/**
 * Share of the return current that finds copper beside a segment over a plane. Under a trace at
 * height h the current density falls as 1/(1 + (x/h)²), so the bands ±0.5h, 0.5–1h and 1–3h carry
 * shares in proportion to atan(x/h); a gap at the band edge matters less than one under the trace.
 */
function planeCoverage(a: Pt, b: Pt, h: number, antipads: Paths, bandCopper: Paths): number {
  let prev = { total: 0, covered: 0, x: 0 };
  let sum = 0;
  let weights = 0;
  for (const x of [0.5, 1, 3]) {
    const band = difference(strokePath([a, b], 2 * x * h, true), antipads);
    const cur = { total: area(band), covered: area(intersect(band, bandCopper)), x };
    const w = Math.atan(x) - Math.atan(prev.x);
    const ring = cur.total - prev.total;
    sum += w * (ring > 1e-9 ? (cur.covered - prev.covered) / ring : 1);
    weights += w;
    prev = cur;
  }
  return Math.max(0, Math.min(1, sum / weights));
}

/** Coplanar return: the better side of the trace (one side of pour carries it). */
function coplanarCoverage(a: Pt, b: Pt, halfBand: number, antipads: Paths, keepout: Paths, bandCopper: Paths): number {
  const band = difference(difference(strokePath([a, b], 2 * halfBand, true), antipads), keepout);
  const len = dist(a, b);
  if (len < 1e-9) return 1;
  const n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
  let best = 0;
  for (const k of [1, -1]) {
    const o = mul(n, k * (halfBand + 0.01));
    const side = intersect(band, [[a, b, add(b, o), add(a, o)]]);
    const total = Math.abs(area(side));
    if (total > 1e-9) best = Math.max(best, Math.abs(area(intersect(side, bandCopper))) / total);
  }
  return best;
}

/** Reference for a via transition: adjacent plane, else coplanar pour on the layer itself. */
function viaReference(ctx: Context, layer: number, net: string): Reference | null {
  const adj = referenceFor(ctx.board, layer, ctx.refCopper);
  if (adj) return adj;
  return ctx.index(layer).some(([n]) => n !== net) ? { layer, h: 0, coplanar: true } : null;
}

/** Net of the reference copper nearest to p, within maxDist. */
function nearestRefNet(lc: LayerCopper, p: Pt, maxDist: number, exclude?: string): string | null {
  let best: string | null = null;
  let bestD = maxDist;
  for (const [net, paths] of lc.byNet) {
    if (net === exclude) continue;
    const d = distToPaths(p, paths);
    if (d <= bestD) {
      bestD = d;
      best = net;
    }
  }
  return best;
}

function severityFor(d: number, t: { good: number; warn: number }): Severity {
  return d <= t.good ? 'ok' : d <= t.warn ? 'warn' : 'error';
}

/** Nearest two-terminal part with one pad on each of the two nets (decoupling / stitching cap). */
export function nearestBridge(board: Board, p: Pt, netA: string, netB: string, opts: AnalyzeOptions): Bridge | null {
  const pads = new Map(board.pads.map((x) => [x.id, x]));
  let best: Bridge | null = null;
  for (const c of board.components) {
    const cp = c.padIds.map((id) => pads.get(id)!).filter(Boolean);
    if (cp.length !== 2) continue;
    const nets = cp.map((x) => x.net);
    if (netA === netB || !(nets.includes(netA) && nets.includes(netB))) continue;
    const at = { x: (cp[0].at.x + cp[1].at.x) / 2, y: (cp[0].at.y + cp[1].at.y) / 2 };
    const d = dist(p, at);
    if (!best || d < best.distance) best = { component: c, at, distance: d, severity: severityFor(d, opts.decap) };
  }
  return best;
}

function analyzeVia(ctx: Context, via: Via, netTracks: Track[], chains: ChainResult[], findings: Finding[]): ViaResult {
  const { board, refCopper, opts } = ctx;
  const stack = board.stackup.copper;
  const idx = (id: number) => stack.findIndex((l) => l.id === id);
  const layerName = (id: number) => stack.find((l) => l.id === id)?.name ?? `L${id}`;
  const r = via.diameter / 2 + 0.01;
  const layers = [
    ...new Set(netTracks.filter((t) => dist(t.a, via.at) <= r || dist(t.b, via.at) <= r).map((t) => t.layer)),
  ].sort((a, b) => idx(a) - idx(b));

  // The reference the chain through the via found (a coplanar pour beside it, say), else the adjacent plane.
  const chainRef = (layer: number) =>
    chains.find((c) => c.ref && c.chain.layer === layer && c.chain.pts.slice(1).some((p, k) => distPointSeg(via.at, c.chain.pts[k], p) <= r))?.ref ?? null;
  const transitions: ViaTransition[] = [];
  for (let i = 1; i < layers.length; i++) {
    const fromLayer = layers[i - 1];
    const toLayer = layers[i];
    const fromRef = chainRef(fromLayer) ?? viaReference(ctx, fromLayer, via.net);
    const toRef = chainRef(toLayer) ?? viaReference(ctx, toLayer, via.net);
    const look = (ref: Reference | null) =>
      ref ? nearestRefNet(refCopper.get(ref.layer)!, via.at, via.diameter / 2 + opts.clearance + (ref.coplanar ? 1 : 3 * ref.h), ref.coplanar ? via.net : undefined) : null;
    const fromNet = look(fromRef);
    const toNet = look(toRef);
    const t: ViaTransition = { fromLayer, toLayer, fromRef, toRef, fromNet, toNet, kind: 'no-reference', severity: 'error' };
    const label = `via at (${via.at.x.toFixed(1)}, ${via.at.y.toFixed(1)}) ${layerName(fromLayer)}→${layerName(toLayer)}`;

    if (!fromRef || !toRef || !fromNet || !toNet) {
      findings.push({ severity: 'error', kind: 'via-no-reference', message: `${label}: no reference plane on one side`, at: via.at });
    } else if (fromRef.layer === toRef.layer) {
      Object.assign(t, { kind: 'shared-plane', severity: 'ok' });
    } else {
      const dz = Math.abs(stack[idx(fromRef.layer)].z - stack[idx(toRef.layer)].z);
      if (fromNet === toNet) {
        let best: { id: string; label: string; at: Pt; d: number } | null = null;
        for (const v of board.vias) {
          if (v.net !== fromNet || v.id === via.id) continue;
          const d = dist(v.at, via.at);
          if (!best || d < best.d) best = { id: v.id, label: `${fromNet} via at (${v.at.x.toFixed(1)}, ${v.at.y.toFixed(1)})`, at: v.at, d };
        }
        for (const p of board.pads) {
          if (p.net !== fromNet || p.layer !== MULTI_LAYER) continue;
          const d = dist(p.at, via.at);
          if (!best || d < best.d) {
            const part = board.components.find((c) => c.id === p.componentId)?.designator;
            best = { id: p.id, label: part ? `${fromNet} pad ${part}.${p.number}` : `${fromNet} THT pad at (${p.at.x.toFixed(1)}, ${p.at.y.toFixed(1)})`, at: p.at, d };
          }
        }
        if (best) {
          Object.assign(t, {
            kind: 'stitching-via',
            target: { id: best.id, label: best.label, at: best.at },
            distance: best.d,
            loopArea: best.d * dz,
            severity: severityFor(best.d, opts.returnVia),
          });
          findings.push({
            severity: t.severity,
            kind: 'via-return',
            message: `${label}: reference ${fromNet}→${toNet}, nearest ${best.label}, ${best.d.toFixed(2)} mm away (vertical loop ≈ ${(best.d * dz).toFixed(2)} mm²)`,
            at: via.at,
          });
        } else {
          findings.push({ severity: 'error', kind: 'via-return', message: `${label}: no ${fromNet} stitching via found`, at: via.at });
        }
      } else {
        const br = nearestBridge(board, via.at, fromNet, toNet, opts);
        if (br) {
          Object.assign(t, {
            kind: 'decap',
            target: { id: br.component.id, label: br.component.designator, at: br.at },
            distance: br.distance,
            loopArea: br.distance * dz,
            severity: br.severity,
          });
          findings.push({
            severity: br.severity,
            kind: 'via-return',
            message: `${label}: reference changes ${fromNet}→${toNet}; return through decap ${br.component.designator} at ${br.distance.toFixed(2)} mm (vertical loop ≈ ${(br.distance * dz).toFixed(2)} mm²)`,
            at: via.at,
          });
        } else {
          findings.push({ severity: 'error', kind: 'via-return', message: `${label}: reference changes ${fromNet}→${toNet} and no bridging cap found`, at: via.at });
        }
      }
    }
    transitions.push(t);
  }
  return { via, transitions };
}
