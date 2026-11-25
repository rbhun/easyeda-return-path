import { geodesic, type Detour } from './detour.js';
import { circle, difference, dist, distPointSeg, distToPaths, enclosedArea, intersect, area, pointInPaths, Polyline, strokePath, union } from './geom.js';
import { allCopper, buildReferenceCopper, type LayerCopper } from './refcopper.js';
import { MULTI_LAYER, type Board, type Component, type Path, type Paths, type Pt, type Track, type Via } from './types.js';

export interface AnalyzeOptions {
  clearance: number;
  /** Centreline sampling step, mm. */
  sampleStep: number;
  /** Segments whose ±3h band is less covered than this get flagged. */
  minBandCoverage: number;
  minHoleArea: number;
  returnVia: { good: number; warn: number };
  decap: { good: number; warn: number };
}

export const defaultOptions: AnalyzeOptions = {
  clearance: 0.25,
  sampleStep: 0.02,
  minBandCoverage: 0.95,
  minHoleArea: 1.0,
  returnVia: { good: 1.5, warn: 4 },
  decap: { good: 3, warn: 8 },
};

export type Severity = 'error' | 'warn' | 'ok';

export interface Reference {
  layer: number;
  /** Trace-to-plane dielectric height, mm. */
  h: number;
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

export interface Analysis {
  net: string;
  refCopper: Map<number, LayerCopper>;
  chains: ChainResult[];
  vias: ViaResult[];
  findings: Finding[];
}

/** Pipeline steps 1–4 for one net. Pure: no I/O. */
export function analyzeNet(board: Board, net: string, options: Partial<AnalyzeOptions> = {}): Analysis {
  const opts = { ...defaultOptions, ...options };
  const refCopper = buildReferenceCopper(board, { clearance: opts.clearance });
  const tracks = board.tracks.filter((t) => t.net === net);
  if (!tracks.length) throw new Error(`net "${net}" has no tracks`);
  const ownVias = board.vias.filter((v) => v.net === net);
  const findings: Finding[] = [];

  const chains = buildChains(tracks).map((chain) => analyzeChain(board, chain, refCopper, ownVias, opts, findings));
  const vias = ownVias.map((via) => analyzeVia(board, via, tracks, refCopper, opts, findings));
  return { net, refCopper, chains, vias, findings };
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

function netAt(p: Pt, lc: LayerCopper): string | null {
  for (const [net, paths] of lc.byNet) if (pointInPaths(p, paths)) return net;
  return null;
}

function analyzeChain(
  board: Board,
  chain: Chain,
  refCopper: Map<number, LayerCopper>,
  ownVias: Via[],
  opts: AnalyzeOptions,
  findings: Finding[],
): ChainResult {
  const line = new Polyline(chain.pts);
  const ref = referenceFor(board, chain.layer, refCopper);
  const layerName = (id: number) => board.stackup.copper.find((l) => l.id === id)?.name ?? `L${id}`;
  if (!ref) {
    findings.push({ severity: 'error', kind: 'no-reference', message: `${layerName(chain.layer)} trace has no adjacent reference plane`, at: line.at(line.length / 2) });
    return { chain, ref: null, refNets: [], band: [], bandUncovered: [], coverage: [], gaps: [] };
  }
  const lc = refCopper.get(ref.layer)!;
  const copper = allCopper(lc);
  const halfBand = 3 * ref.h;
  const antipads = union(ownVias.map((v) => circle(v.at, v.diameter / 2 + opts.clearance + 0.05)));

  // ±3h band coverage per track segment (own-net via antipads excluded: handled in step 4).
  const tracks = new Map(board.tracks.map((t) => [t.id, t]));
  const coverage = chain.trackIds.map((id) => {
    const t = tracks.get(id)!;
    const band = difference(strokePath([t.a, t.b], 2 * halfBand, true), antipads);
    const total = area(band);
    return { trackId: id, a: t.a, b: t.b, ratio: total > 0 ? area(intersect(band, copper)) / total : 1 };
  });
  const band = strokePath(chain.pts, 2 * halfBand, true);
  const bandUncovered = difference(difference(band, copper), antipads);

  // Classify the centreline by the reference net underneath, then refine run boundaries.
  const L = line.length;
  const n = Math.max(2, Math.ceil(L / opts.sampleStep));
  const cls: (string | null)[] = [];
  for (let i = 0; i <= n; i++) cls.push(netAt(line.at((L * i) / n), lc));
  const refine = (s0: number, s1: number, c0: string | null) => {
    for (let k = 0; k < 20; k++) {
      const m = (s0 + s1) / 2;
      if (netAt(line.at(m), lc) === c0) s0 = m;
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
  runs.forEach((r, i) => {
    if (r.net !== null) return;
    const before = runs[i - 1]?.net ?? null;
    const after = runs[i + 1]?.net ?? null;
    const a = line.at(r.s0);
    const b = line.at(r.s1);
    const atEnd = r.s0 <= 1e-9 || r.s1 >= L - 1e-9;
    const endPt = r.s0 <= 1e-9 ? chain.pts[0] : chain.pts[chain.pts.length - 1];
    let kind: GapKind;
    if (atEnd) kind = ownVias.some((v) => dist(v.at, endPt) < v.diameter / 2 + opts.clearance + 0.1) && r.s1 - r.s0 < 3 * halfBand ? 'via-antipad' : 'off-reference';
    else kind = before === after ? 'slot' : 'split';
    const gap: Gap = { kind, s0: r.s0, s1: r.s1, a, b, netBefore: before, netAfter: after };
    const mid = line.at((r.s0 + r.s1) / 2);
    const where = `${layerName(chain.layer)} over ${layerName(ref.layer)}`;

    if (kind === 'slot') {
      const eps = Math.min(0.1, (runs[i - 1].s1 - runs[i - 1].s0) / 2, (runs[i + 1].s1 - runs[i + 1].s0) / 2);
      const pa = line.at(r.s0 - eps);
      const pb = line.at(r.s1 + eps);
      const det = geodesic(lc.byNet.get(before!)!, pa, pb, { minHoleArea: opts.minHoleArea, window: 5 });
      if (det) {
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
      findings.push({ severity: 'error', kind: 'off-reference', message: `${where}: ${(r.s1 - r.s0).toFixed(2)} mm of trace has no reference copper underneath`, at: mid });
    }
    gaps.push(gap);
  });

  for (const c of coverage) {
    if (c.ratio >= opts.minBandCoverage) continue;
    const onSeg = (p: Pt) => distPointSeg(p, c.a, c.b) < 1e-6;
    if (gaps.some((g) => g.kind !== 'via-antipad' && (onSeg(g.a) || onSeg(g.b)))) continue;
    findings.push({
      severity: 'warn',
      kind: 'band-coverage',
      message: `${layerName(chain.layer)} segment (${c.a.x.toFixed(1)}, ${c.a.y.toFixed(1)})→(${c.b.x.toFixed(1)}, ${c.b.y.toFixed(1)}): only ${(c.ratio * 100).toFixed(0)}% of the ±3h band (±${halfBand.toFixed(2)} mm) has reference copper`,
      at: { x: (c.a.x + c.b.x) / 2, y: (c.a.y + c.b.y) / 2 },
    });
  }

  const refNets = [...new Set(runs.map((r) => r.net).filter((x): x is string => !!x))];
  return { chain, ref, refNets, band, bandUncovered, coverage, gaps };
}

/** Net of the reference copper nearest to p, within maxDist. */
function nearestRefNet(lc: LayerCopper, p: Pt, maxDist: number): string | null {
  let best: string | null = null;
  let bestD = maxDist;
  for (const [net, paths] of lc.byNet) {
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

function analyzeVia(
  board: Board,
  via: Via,
  netTracks: Track[],
  refCopper: Map<number, LayerCopper>,
  opts: AnalyzeOptions,
  findings: Finding[],
): ViaResult {
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
    const fromRef = referenceFor(board, fromLayer, refCopper);
    const toRef = referenceFor(board, toLayer, refCopper);
    const look = (ref: Reference | null) => (ref ? nearestRefNet(refCopper.get(ref.layer)!, via.at, via.diameter / 2 + opts.clearance + 3 * ref.h) : null);
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
