import { AnalysisAborted, runAsync, runSync, type RunOptions, type Steps } from './budget.js';
import { isGroundNet, looksLikePowerNet } from './dc/rails.js';
import { DEFAULT_MAX_DETOUR_NODES, geodesicSteps, TOO_COMPLEX, type Detour } from './detour.js';
import { add, circle, difference, dist, distPointSeg, distToPaths, enclosedArea, inflate, intersect, area, mul, Polyline, strokePath, union } from './geom.js';
import { allCopper, buildReferenceCopperSteps, vertexCount, type LayerCopper } from './refcopper.js';
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
  trackIds: string[];
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
}

export interface ChainResult {
  chain: Chain;
  ref: Reference | null;
  refNets: string[];
  band: Paths;
  bandUncovered: Paths;
  coverage: { trackId: string; a: Pt; b: Pt; ratio: number }[];
  gaps: Gap[];
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
  findings: Finding[];
  stats: AnalysisStats;
}

export interface HfScope {
  ok: boolean;
  kind?: 'ground' | 'power' | 'plane';
  message?: string;
}

/**
 * Whether the high-frequency return-path check applies to a net. Ground, supply and plane nets are
 * the return path (or carry DC), and their many segments over large pours make the check slow
 * and meaningless; the DC return-current view is the right tool for them.
 */
export function hfApplicability(board: Board, net: string): HfScope {
  const dc = 'Use "DC Return Current..." to see how supply current flows and returns.';
  if (isGroundNet(net))
    return { ok: false, kind: 'ground', message: `${net} is a ground net: it is the return path, not a signal. Select a signal net routed over it. ${dc}` };
  if (looksLikePowerNet(net)) return { ok: false, kind: 'power', message: `${net} looks like a power rail. The high-frequency return-path check is for signal nets. ${dc}` };
  if (board.pours.some((p) => p.net === net))
    return { ok: false, kind: 'plane', message: `${net} owns copper pours (a plane net). The high-frequency return-path check is for signal traces. ${dc}` };
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
  const opts = { ...defaultOptions, ...options };
  const tracks = board.tracks.filter((t) => t.net === net);
  if (!tracks.length) throw new Error(`net "${net}" has no tracks`);
  if (tracks.length > opts.maxSegments)
    throw new AnalysisAborted('complexity', `Net ${net} has ${tracks.length} track segments (limit ${opts.maxSegments}). That is a power or plane-sized net, not a signal trace.`, 'start');
  yield { phase: 'reference copper', fraction: 0 };
  const refCopper = yield* buildReferenceCopperSteps(board, { clearance: opts.clearance });
  const refVertices = vertexCount([...refCopper.values()].flatMap((lc) => [...lc.byNet.values()]));
  if (refVertices > opts.maxRefVertices)
    throw new AnalysisAborted('complexity', `Reference copper has ${refVertices} polygon vertices (limit ${opts.maxRefVertices}).`, 'reference copper');
  const ownVias = board.vias.filter((v) => v.net === net);
  const findings: Finding[] = [];
  const chains = buildChains(tracks);
  const totalLength = chains.reduce((s, c) => s + new Polyline(c.pts).length, 0);
  const stats: AnalysisStats = {
    segments: tracks.length,
    chains: chains.length,
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
  const results: ChainResult[] = [];
  for (const [i, chain] of chains.entries()) {
    yield { phase: 'chains', fraction: i / chains.length, steps: chains.length };
    results.push(yield* analyzeChain(ctx, chain, ownVias, findings));
  }
  const vias: ViaResult[] = [];
  for (const [i, via] of ownVias.entries()) {
    yield { phase: 'vias', fraction: i / ownVias.length };
    vias.push(analyzeVia(ctx, via, tracks, findings));
  }
  return { net, refCopper, chains: results, vias, findings, stats };
}

/** Per-analysis caches: spatial indexes of each layer's reference nets and merged copper. */
class Context {
  private readonly indexes = new Map<number, [string, EdgeGrid][]>();
  private readonly merged = new Map<string, Paths>();
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

  /** Net of the reference copper at p (optionally ignoring one net). */
  netAt(p: Pt, layer: number, exclude?: string): string | null {
    for (const [net, g] of this.index(layer)) if (net !== exclude && g.contains(p)) return net;
    return null;
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
    for (let d = step; d <= ctx.opts.maxCoplanarGap + 1e-9; d += step) {
      const o = halfWidth + d;
      if (ctx.netAt(add(p, mul(n, o)), chain.layer, chain.net) || ctx.netAt(add(p, mul(n, -o)), chain.layer, chain.net)) {
        gaps.push(d);
        break;
      }
    }
  }
  if (gaps.length < k / 3) return null;
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1];
}

function* analyzeChain(ctx: Context, chain: Chain, ownVias: Via[], findings: Finding[]): Steps<ChainResult> {
  const { board, opts, stats } = ctx;
  const line = new Polyline(chain.pts);
  const trackById = new Map(board.tracks.map((t) => [t.id, t]));
  const halfWidth = (trackById.get(chain.trackIds[0])?.width ?? 0.2) / 2;
  const adjacent = referenceFor(board, chain.layer, ctx.refCopper);
  const gap = coplanarGap(ctx, chain, line, halfWidth);
  let ref = adjacent;
  if (gap !== null && (!adjacent || gap <= opts.coplanarRatio * adjacent.h)) ref = { layer: chain.layer, h: gap, coplanar: true };
  const layerName = (id: number) => ctx.layerName(id);
  if (!ref) {
    findings.push({
      severity: 'error',
      kind: 'no-reference',
      message: `${layerName(chain.layer)} trace has no reference copper: no pour on an adjacent layer and no coplanar pour beside it`,
      at: line.at(line.length / 2),
    });
    return { chain, ref: null, refNets: [], band: [], bandUncovered: [], coverage: [], gaps: [] };
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

  const band = difference(strokePath(chain.pts, 2 * halfBand, true), keepout);
  const bandCopper = intersect(band, copper);
  const bandUncovered = difference(difference(band, bandCopper), antipads);

  // ±band coverage per track segment (own-net via antipads excluded: handled in step 4).
  const coverage: ChainResult['coverage'] = [];
  for (const [i, id] of chain.trackIds.entries()) {
    yield { phase: 'band coverage', fraction: i / chain.trackIds.length };
    const t = trackById.get(id)!;
    const segBand = difference(difference(strokePath([t.a, t.b], 2 * halfBand, true), antipads), keepout);
    const total = area(segBand);
    coverage.push({ trackId: id, a: t.a, b: t.b, ratio: total > 0 ? area(intersect(segBand, bandCopper)) / total : 1 });
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
  const where = ref.coplanar ? `${layerName(chain.layer)} (coplanar return)` : `${layerName(chain.layer)} over ${layerName(ref.layer)}`;
  for (const [i, r] of runs.entries()) {
    if (r.net !== null) continue;
    yield { phase: 'gaps', fraction: i / runs.length };
    const before = runs[i - 1]?.net ?? null;
    const after = runs[i + 1]?.net ?? null;
    const a = line.at(r.s0);
    const b = line.at(r.s1);
    const atEnd = r.s0 <= 1e-9 || r.s1 >= L - 1e-9;
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
      if (det === TOO_COMPLEX) {
        stats.detoursTooComplex++;
        findings.push({
          severity: 'warn',
          kind: 'slot-crossing',
          message: `${where}: crosses a ${(r.s1 - r.s0).toFixed(2)} mm gap in ${before}; the copper around it is too complex to trace the detour (over ${opts.maxDetourNodes} corners)`,
          at: mid,
        });
      } else if (det) {
        const direct = line.slice(r.s0 - eps, r.s1 + eps);
        const directLength = r.s1 - r.s0 + 2 * eps;
        const loop = [...direct, ...[...det.path].reverse()];
        gap.detour = { ...det, directLength, extraLength: det.length - directLength, loopArea: enclosedArea(loop), loop };
        findings.push({
          severity: 'error',
          kind: 'slot-crossing',
          message: `${where}: crosses a ${(r.s1 - r.s0).toFixed(2)} mm gap in ${before}; return detours +${gap.detour.extraLength.toFixed(1)} mm, adds ${gap.detour.loopArea.toFixed(1)} mm² loop area`,
          at: mid,
        });
      } else {
        gap.bridge = nearestBridge(board, mid, before!, before!, opts);
        findings.push({ severity: 'error', kind: 'isolated-copper', message: `${where}: crosses between unconnected ${before} islands; no in-plane return path`, at: mid });
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

  for (const c of coverage) {
    if (c.ratio >= opts.minBandCoverage) continue;
    const onSeg = (p: Pt) => distPointSeg(p, c.a, c.b) < 1e-6;
    if (gaps.some((g) => g.kind !== 'via-antipad' && (onSeg(g.a) || onSeg(g.b)))) continue;
    const bandText = ref.coplanar ? `coplanar band (${(halfBand - inner).toFixed(2)} mm beside the trace clearance)` : `±3h band (±${halfBand.toFixed(2)} mm)`;
    findings.push({
      severity: 'warn',
      kind: 'band-coverage',
      message: `${layerName(chain.layer)} segment (${c.a.x.toFixed(1)}, ${c.a.y.toFixed(1)})→(${c.b.x.toFixed(1)}, ${c.b.y.toFixed(1)}): only ${(c.ratio * 100).toFixed(0)}% of the ${bandText} has reference copper`,
      at: { x: (c.a.x + c.b.x) / 2, y: (c.a.y + c.b.y) / 2 },
    });
  }

  const refNets = [...new Set(runs.map((r) => r.net).filter((x): x is string => !!x))];
  return { chain, ref, refNets, band, bandUncovered, coverage, gaps };
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

function analyzeVia(ctx: Context, via: Via, netTracks: Track[], findings: Finding[]): ViaResult {
  const { board, refCopper, opts } = ctx;
  const stack = board.stackup.copper;
  const idx = (id: number) => stack.findIndex((l) => l.id === id);
  const layerName = (id: number) => stack.find((l) => l.id === id)?.name ?? `L${id}`;
  const r = via.diameter / 2 + 0.01;
  const layers = [
    ...new Set(netTracks.filter((t) => dist(t.a, via.at) <= r || dist(t.b, via.at) <= r).map((t) => t.layer)),
  ].sort((a, b) => idx(a) - idx(b));

  const transitions: ViaTransition[] = [];
  for (let i = 1; i < layers.length; i++) {
    const fromLayer = layers[i - 1];
    const toLayer = layers[i];
    const fromRef = viaReference(ctx, fromLayer, via.net);
    const toRef = viaReference(ctx, toLayer, via.net);
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
          if (!best || d < best.d) best = { id: v.id, label: `${fromNet} via ${v.id}`, at: v.at, d };
        }
        for (const p of board.pads) {
          if (p.net !== fromNet || p.layer !== MULTI_LAYER) continue;
          const d = dist(p.at, via.at);
          if (!best || d < best.d) best = { id: p.id, label: `${fromNet} THT pad`, at: p.at, d };
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
            message: `${label}: reference ${fromNet}→${toNet}, nearest ${best.label.replace(/ e\d+$/, '')} at ${best.d.toFixed(2)} mm (vertical loop ≈ ${(best.d * dz).toFixed(2)} mm²)`,
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
