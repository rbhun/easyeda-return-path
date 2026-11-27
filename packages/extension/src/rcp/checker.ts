import {
  bbox,
  buildReferenceCopper,
  dist,
  distPointSeg,
  isGroundNet,
  netKey,
  Polyline,
  splitIslands,
  MULTI_LAYER,
  type BBox,
  type Board,
  type CopperLayer,
  type Path,
  type Paths,
  type Pt,
  type Stackup,
  type Track,
  type Via,
} from '@returnpath/core';
import {
  DEFAULT_CHECK_RULES,
  type CheckNetSummary,
  type CheckRules,
  type Finding,
  type FindingKind,
  type FindingSeverity,
  type PartialCheckRules,
} from './types.js';

export interface CheckPad {
  id: string;
  net: string;
  layer: number;
  at: Pt;
  holeDiameter: number;
}

export interface CheckBoardInput {
  stackup: Stackup;
  tracks: Track[];
  vias: Via[];
  pads?: CheckPad[];
  /** Copper polygons by copper layer id, then net name. */
  copperByLayer: Map<number, Map<string, Paths>>;
  warnings?: string[];
}

export interface CheckNetResult {
  net: string;
  skipped?: boolean;
  reason?: string;
  segmentsChecked: number;
  viasChecked: number;
  referenceNetsUsed: string[];
  rulesApplied: CheckRules;
  summary: CheckNetSummary;
  findings: Finding[];
  warnings: string[];
}

interface IndexedIsland {
  id: string;
  layerId: number;
  net: string;
  isReference: boolean;
  outer: Path;
  holes: Path[];
  bbox: BBox;
  holeBBoxes: BBox[];
}

interface AdjacentLayerInfo {
  layerId: number;
  layerName: string;
  dielectricMm: number;
  refIslands: IndexedIsland[];
  allIslands: IndexedIsland[];
}

interface ChainSegment {
  id: string;
  a: Pt;
  b: Pt;
  width: number;
  s0: number;
  s1: number;
}

interface TraceChain {
  layerId: number;
  segments: ChainSegment[];
  polyline: Polyline;
  totalLengthMm: number;
}

type SampleStatus = 'ref_covered' | 'ref_hole' | 'other_pour' | 'uncovered';

interface SampleState {
  s0: number;
  s1: number;
  mid: Pt;
  segId: string;
  status: SampleStatus;
  refLayerId: number;
  islandId?: string;
  net?: string;
  nearEdge: boolean;
  distToEdgeMm: number;
  edgeThresholdMm: number;
}

interface SampleRun {
  s0: number;
  s1: number;
  lengthMm: number;
  status: SampleStatus;
  refLayerId: number;
  islandId?: string;
  net?: string;
  segIds: string[];
}

interface RawFinding extends Finding {
  startPt?: Pt;
  endPt?: Pt;
}

const ENDPOINT_SNAP_MM = 0.025;
const MAX_SPLIT_GAP_MM = 5.0;
const MERGE_DISTANCE_MM = 0.5;
const MICRO_SLIVER_MM = 0.04;
const MAX_SAMPLES_PER_CHAIN = 4000;

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function resolveRules(input?: PartialCheckRules | null): CheckRules {
  const refNets =
    Array.isArray(input?.referenceNets) && input.referenceNets.length > 0
      ? input.referenceNets.map((n) => String(n).trim()).filter(Boolean)
      : null;

  const returnViaRadiusMm =
    typeof input?.returnViaRadiusMm === 'number' && Number.isFinite(input.returnViaRadiusMm) && input.returnViaRadiusMm > 0
      ? input.returnViaRadiusMm
      : DEFAULT_CHECK_RULES.returnViaRadiusMm;

  const planeEdgeClearanceFactor =
    typeof input?.planeEdgeClearanceFactor === 'number' && Number.isFinite(input.planeEdgeClearanceFactor) && input.planeEdgeClearanceFactor >= 0
      ? input.planeEdgeClearanceFactor
      : DEFAULT_CHECK_RULES.planeEdgeClearanceFactor;

  const minSegmentLengthMm =
    typeof input?.minSegmentLengthMm === 'number' && Number.isFinite(input.minSegmentLengthMm) && input.minSegmentLengthMm >= 0
      ? input.minSegmentLengthMm
      : DEFAULT_CHECK_RULES.minSegmentLengthMm;

  const skipNets = Array.isArray(input?.skipNets)
    ? input.skipNets.map((n) => String(n).trim()).filter(Boolean)
    : [];

  return {
    referenceNets: refNets,
    returnViaRadiusMm,
    planeEdgeClearanceFactor,
    minSegmentLengthMm,
    skipNets,
  };
}

/** Builds a copperByLayer map from a core Board model (useful for offline tests and CLI fixtures). */
export function buildCopperByLayerFromBoard(board: Board, clearanceMm = 0.2): Map<number, Map<string, Paths>> {
  const ref = buildReferenceCopper(board, { clearance: clearanceMm });
  const out = new Map<number, Map<string, Paths>>();
  for (const [layerId, lc] of ref) {
    out.set(layerId, lc.byNet);
  }
  return out;
}

function pointInBBox(p: Pt, b: BBox, margin = 0): boolean {
  return p.x >= b.minX - margin && p.x <= b.maxX + margin && p.y >= b.minY - margin && p.y <= b.maxY + margin;
}

function pointInRing(p: Pt, ring: Path): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInIsland(p: Pt, isl: IndexedIsland): 'inside' | 'in_hole' | 'outside' {
  if (!pointInBBox(p, isl.bbox)) return 'outside';
  if (!pointInRing(p, isl.outer)) return 'outside';
  for (let i = 0; i < isl.holes.length; i++) {
    if (pointInBBox(p, isl.holeBBoxes[i]) && pointInRing(p, isl.holes[i])) {
      return 'in_hole';
    }
  }
  return 'inside';
}

function distToRing(p: Pt, ring: Path, maxDist: number): number {
  let best = maxDist;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j];
    const b = ring[i];
    const minX = a.x < b.x ? a.x : b.x;
    const maxX = a.x > b.x ? a.x : b.x;
    if (p.x < minX - best || p.x > maxX + best) continue;
    const minY = a.y < b.y ? a.y : b.y;
    const maxY = a.y > b.y ? a.y : b.y;
    if (p.y < minY - best || p.y > maxY + best) continue;
    const d = distPointSeg(p, a, b);
    if (d < best) best = d;
  }
  return best < maxDist ? best : Infinity;
}

function indexLayerIslands(
  layerId: number,
  byNet: Map<string, Paths> | undefined,
  refNetKeys: Set<string>,
): IndexedIsland[] {
  if (!byNet) return [];
  const out: IndexedIsland[] = [];
  for (const [net, paths] of byNet) {
    if (!paths.length) continue;
    const isRef = refNetKeys.has(netKey(net));
    const islands = splitIslands(paths);
    for (let idx = 0; idx < islands.length; idx++) {
      const group = islands[idx];
      const outer = group[0];
      if (!outer || outer.length < 3) continue;
      const holes = group.slice(1).filter((h) => h.length >= 3);
      out.push({
        id: `${layerId}:${net}:${idx}`,
        layerId,
        net,
        isReference: isRef,
        outer,
        holes,
        bbox: bbox([outer]),
        holeBBoxes: holes.map((h) => bbox([h])),
      });
    }
  }
  return out;
}

function adjacentLayersFor(
  stackup: Stackup,
  signalLayerId: number,
  islandsByLayer: Map<number, IndexedIsland[]>,
): AdjacentLayerInfo[] {
  const idx = stackup.copper.findIndex((c) => c.id === signalLayerId);
  if (idx < 0) return [];
  const candidates: AdjacentLayerInfo[] = [];
  const addNeighbor = (nIdx: number, dielectricIdx: number) => {
    const layer = stackup.copper[nIdx];
    const d = stackup.dielectrics[dielectricIdx]?.thicknessMm ?? 0.2;
    const allIslands = islandsByLayer.get(layer.id) ?? [];
    candidates.push({
      layerId: layer.id,
      layerName: layer.name,
      dielectricMm: d > 0 ? d : 0.2,
      refIslands: allIslands.filter((isl) => isl.isReference),
      allIslands,
    });
  };
  if (idx > 0) addNeighbor(idx - 1, idx - 1);
  if (idx < stackup.copper.length - 1) addNeighbor(idx + 1, idx);
  // Closest adjacent layer first; break ties preferring one that has reference copper.
  candidates.sort((a, b) => {
    const aHas = a.refIslands.length > 0 ? 0 : 1;
    const bHas = b.refIslands.length > 0 ? 0 : 1;
    if (aHas !== bHas) return aHas - bHas;
    return a.dielectricMm - b.dielectricMm;
  });
  return candidates;
}

/** Chains connected track segments on a single copper layer into ordered polylines. */
function buildChainsForLayer(layerId: number, tracks: Track[]): TraceChain[] {
  const usable = tracks.filter((t) => t.layer === layerId && dist(t.a, t.b) > 1e-6);
  if (!usable.length) return [];

  // Cluster endpoints within ENDPOINT_SNAP_MM into graph nodes.
  const nodes: Pt[] = [];
  const adj: Array<Array<{ trackIdx: number; otherNode: number; reversed: boolean }>> = [];

  const getNode = (p: Pt): number => {
    for (let i = 0; i < nodes.length; i++) {
      if (dist(nodes[i], p) <= ENDPOINT_SNAP_MM) return i;
    }
    const id = nodes.length;
    nodes.push(p);
    adj.push([]);
    return id;
  };

  for (let i = 0; i < usable.length; i++) {
    const t = usable[i];
    const u = getNode(t.a);
    const v = getNode(t.b);
    adj[u].push({ trackIdx: i, otherNode: v, reversed: false });
    adj[v].push({ trackIdx: i, otherNode: u, reversed: true });
  }

  const visited = new Uint8Array(usable.length);
  const chains: TraceChain[] = [];

  const walk = (startNode: number, firstEdge: { trackIdx: number; otherNode: number; reversed: boolean }) => {
    const segs: ChainSegment[] = [];
    let curNode = startNode;
    let edge: { trackIdx: number; otherNode: number; reversed: boolean } | undefined = firstEdge;
    let s = 0;

    while (edge && !visited[edge.trackIdx]) {
      visited[edge.trackIdx] = 1;
      const t = usable[edge.trackIdx];
      const a = edge.reversed ? t.b : t.a;
      const b = edge.reversed ? t.a : t.b;
      const len = dist(a, b);
      segs.push({ id: basePrimitiveId(t.id), a, b, width: t.width, s0: s, s1: s + len });
      s += len;
      curNode = edge.otherNode;
      if (adj[curNode].length !== 2) break;
      edge = adj[curNode].find((e) => !visited[e.trackIdx]);
    }

    if (segs.length) {
      const pts: Pt[] = [segs[0].a, ...segs.map((sg) => sg.b)];
      chains.push({
        layerId,
        segments: segs,
        polyline: new Polyline(pts),
        totalLengthMm: s,
      });
    }
  };

  // Start from non-degree-2 nodes first (endpoints & junctions).
  for (let u = 0; u < nodes.length; u++) {
    if (adj[u].length === 2) continue;
    for (const e of adj[u]) {
      if (!visited[e.trackIdx]) walk(u, e);
    }
  }
  // Remaining tracks form closed loops.
  for (let u = 0; u < nodes.length; u++) {
    for (const e of adj[u]) {
      if (!visited[e.trackIdx]) walk(u, e);
    }
  }

  return chains;
}

function basePrimitiveId(id: string): string {
  const hash = id.indexOf('#');
  return hash >= 0 ? id.slice(0, hash) : id;
}

function dedupeIds(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

function sampleChain(chain: TraceChain, adjLayers: AdjacentLayerInfo[], rules: CheckRules): SampleState[] {
  const primaryAdj = adjLayers[0];
  if (!primaryAdj) return [];

  const desiredStep = Math.min(0.2, Math.max(0.05, rules.minSegmentLengthMm > 0 ? rules.minSegmentLengthMm / 2 : 0.1));
  const stepMm = Math.max(desiredStep, chain.totalLengthMm / MAX_SAMPLES_PER_CHAIN);
  const samples: SampleState[] = [];

  for (const seg of chain.segments) {
    const segLen = seg.s1 - seg.s0;
    const count = Math.max(1, Math.ceil(segLen / stepMm));
    for (let k = 0; k < count; k++) {
      const s0 = seg.s0 + (segLen * k) / count;
      const s1 = seg.s0 + (segLen * (k + 1)) / count;
      const mid = chain.polyline.at((s0 + s1) / 2);

      // 1. Check reference-net coverage across adjacent layers.
      let coveredAdj: AdjacentLayerInfo | undefined;
      let coveredIsl: IndexedIsland | undefined;
      let bestEdgeDist = Infinity;
      let bestEdgeThresh = 0;

      for (const adj of adjLayers) {
        for (const isl of adj.refIslands) {
          if (pointInIsland(mid, isl) === 'inside') {
            const thresh = rules.planeEdgeClearanceFactor * adj.dielectricMm;
            const dEdge = thresh > 0 ? distToRing(mid, isl.outer, thresh) : Infinity;
            if (!coveredIsl) {
              coveredAdj = adj;
              coveredIsl = isl;
              bestEdgeDist = dEdge;
              bestEdgeThresh = thresh;
            } else if (dEdge > bestEdgeDist) {
              // If another adjacent reference layer provides better edge margin, prefer it.
              coveredAdj = adj;
              coveredIsl = isl;
              bestEdgeDist = dEdge;
              bestEdgeThresh = thresh;
            }
            break;
          }
        }
      }

      if (coveredIsl && coveredAdj) {
        samples.push({
          s0,
          s1,
          mid,
          segId: seg.id,
          status: 'ref_covered',
          refLayerId: coveredAdj.layerId,
          islandId: coveredIsl.id,
          net: coveredIsl.net,
          nearEdge: bestEdgeThresh > 0 && bestEdgeDist < bestEdgeThresh,
          distToEdgeMm: bestEdgeDist,
          edgeThresholdMm: bestEdgeThresh,
        });
        continue;
      }

      // 2. Check if inside a hole/void of a reference-net island.
      let holeAdj: AdjacentLayerInfo | undefined;
      let holeIsl: IndexedIsland | undefined;
      for (const adj of adjLayers) {
        for (const isl of adj.refIslands) {
          if (pointInIsland(mid, isl) === 'in_hole') {
            holeAdj = adj;
            holeIsl = isl;
            break;
          }
        }
        if (holeIsl) break;
      }

      if (holeIsl && holeAdj) {
        samples.push({
          s0,
          s1,
          mid,
          segId: seg.id,
          status: 'ref_hole',
          refLayerId: holeAdj.layerId,
          islandId: holeIsl.id,
          net: holeIsl.net,
          nearEdge: false,
          distToEdgeMm: Infinity,
          edgeThresholdMm: 0,
        });
        continue;
      }

      // 3. Check if over a non-reference pour (e.g. 3V3 or +12V plane).
      let otherAdj: AdjacentLayerInfo | undefined;
      let otherIsl: IndexedIsland | undefined;
      for (const adj of adjLayers) {
        for (const isl of adj.allIslands) {
          if (isl.isReference) continue;
          if (pointInIsland(mid, isl) === 'inside') {
            otherAdj = adj;
            otherIsl = isl;
            break;
          }
        }
        if (otherIsl) break;
      }

      if (otherIsl && otherAdj) {
        samples.push({
          s0,
          s1,
          mid,
          segId: seg.id,
          status: 'other_pour',
          refLayerId: otherAdj.layerId,
          islandId: otherIsl.id,
          net: otherIsl.net,
          nearEdge: false,
          distToEdgeMm: Infinity,
          edgeThresholdMm: 0,
        });
        continue;
      }

      // 4. Completely uncovered on all adjacent layers.
      samples.push({
        s0,
        s1,
        mid,
        segId: seg.id,
        status: 'uncovered',
        refLayerId: primaryAdj.layerId,
        nearEdge: false,
        distToEdgeMm: Infinity,
        edgeThresholdMm: 0,
      });
    }
  }

  return samples;
}

function buildRuns(samples: SampleState[]): SampleRun[] {
  const runs: SampleRun[] = [];
  for (const sm of samples) {
    const prev = runs[runs.length - 1];
    if (
      prev &&
      prev.status === sm.status &&
      prev.refLayerId === sm.refLayerId &&
      prev.islandId === sm.islandId &&
      prev.net === sm.net
    ) {
      prev.s1 = sm.s1;
      prev.lengthMm = prev.s1 - prev.s0;
      prev.segIds.push(sm.segId);
    } else {
      runs.push({
        s0: sm.s0,
        s1: sm.s1,
        lengthMm: sm.s1 - sm.s0,
        status: sm.status,
        refLayerId: sm.refLayerId,
        islandId: sm.islandId,
        net: sm.net,
        segIds: [sm.segId],
      });
    }
  }

  // Filter microscopic vertex-grazing slivers between identical covered islands.
  const cleaned: SampleRun[] = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const prev = cleaned[cleaned.length - 1];
    const next = runs[i + 1];
    if (
      r.status === 'uncovered' &&
      r.lengthMm < MICRO_SLIVER_MM &&
      prev &&
      next &&
      prev.status === next.status &&
      prev.islandId &&
      prev.islandId === next.islandId
    ) {
      prev.s1 = r.s1;
      prev.lengthMm = prev.s1 - prev.s0;
      prev.segIds.push(...r.segIds);
      continue;
    }
    if (
      prev &&
      prev.status === r.status &&
      prev.refLayerId === r.refLayerId &&
      prev.islandId === r.islandId &&
      prev.net === r.net
    ) {
      prev.s1 = r.s1;
      prev.lengthMm = prev.s1 - prev.s0;
      prev.segIds.push(...r.segIds);
    } else {
      cleaned.push(r);
    }
  }

  return cleaned;
}

function analyzeChain(
  net: string,
  chain: TraceChain,
  adjLayers: AdjacentLayerInfo[],
  layerNames: Map<number, string>,
  referenceNetsUsed: string[],
  rules: CheckRules,
): RawFinding[] {
  const out: RawFinding[] = [];
  const layerLabel = (id: number) => layerNames.get(id) ?? `Layer ${id}`;

  if (!adjLayers.length) return out;

  const hasAnyRefCopper = adjLayers.some((a) => a.refIslands.length > 0);
  const hasAnyPourCopper = adjLayers.some((a) => a.allIslands.length > 0);
  if (!hasAnyRefCopper && !hasAnyPourCopper) {
    if (chain.totalLengthMm >= rules.minSegmentLengthMm) {
      const mid = chain.polyline.at(chain.totalLengthMm / 2);
      const refLayer = adjLayers[0];
      out.push({
        severity: 'error',
        kind: 'no_reference_plane',
        net,
        layerId: chain.layerId,
        referenceLayerId: refLayer.layerId,
        at: { x: round3(mid.x), y: round3(mid.y) },
        lengthMm: round3(chain.totalLengthMm),
        detail: `No reference plane copper found on adjacent ${layerLabel(refLayer.layerId)} under ${round3(chain.totalLengthMm)} mm of ${net} on ${layerLabel(chain.layerId)}.`,
        primitiveIds: dedupeIds(chain.segments.map((s) => s.id)),
        startPt: chain.polyline.at(0),
        endPt: chain.polyline.at(chain.totalLengthMm),
      });
    }
    return out;
  }

  const samples = sampleChain(chain, adjLayers, rules);
  const runs = buildRuns(samples);

  const isPlaneRun = (r: SampleRun | undefined): r is SampleRun =>
    !!r && (r.status === 'ref_covered' || r.status === 'other_pour');

  // 1. Analyze uncovered, hole, and non-reference-pour runs.
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const mid = chain.polyline.at((r.s0 + r.s1) / 2);
    const startPt = chain.polyline.at(r.s0);
    const endPt = chain.polyline.at(r.s1);
    const ids = dedupeIds(r.segIds);

    if (r.status === 'ref_hole') {
      if (r.lengthMm >= rules.minSegmentLengthMm) {
        out.push({
          severity: r.lengthMm >= 1.5 ? 'error' : 'warning',
          kind: 'plane_void',
          net,
          layerId: chain.layerId,
          referenceLayerId: r.refLayerId,
          at: { x: round3(mid.x), y: round3(mid.y) },
          lengthMm: round3(r.lengthMm),
          detail: `Trace runs ${round3(r.lengthMm)} mm over a void/cutout in the ${r.net ?? 'reference'} plane on ${layerLabel(r.refLayerId)}.`,
          primitiveIds: ids,
          startPt,
          endPt,
        });
      }
      continue;
    }

    if (r.status === 'other_pour') {
      if (r.lengthMm >= rules.minSegmentLengthMm) {
        const refList = referenceNetsUsed.length ? referenceNetsUsed.join(', ') : 'none';
        out.push({
          severity: 'error',
          kind: 'no_reference_plane',
          net,
          layerId: chain.layerId,
          referenceLayerId: r.refLayerId,
          at: { x: round3(mid.x), y: round3(mid.y) },
          lengthMm: round3(r.lengthMm),
          detail: `Trace runs ${round3(r.lengthMm)} mm over non-reference pour ${r.net} on ${layerLabel(r.refLayerId)} (configured reference nets: ${refList}).`,
          primitiveIds: ids,
          startPt,
          endPt,
        });
      }
      continue;
    }

    if (r.status === 'uncovered') {
      const prev = runs[i - 1];
      const next = runs[i + 1];

      if (isPlaneRun(prev) && isPlaneRun(next)) {
        const differentNet = prev.net !== next.net;
        const differentIsland = prev.islandId !== next.islandId;
        const isSplit = differentNet || r.lengthMm <= MAX_SPLIT_GAP_MM;
        if (isSplit) {
          const between =
            differentNet
              ? `between ${prev.net} and ${next.net} pours`
              : differentIsland
                ? `between disconnected ${prev.net} copper islands`
                : `across a slot in the ${prev.net} plane`;
          out.push({
            severity: 'error',
            kind: 'plane_split_crossing',
            net,
            layerId: chain.layerId,
            referenceLayerId: r.refLayerId,
            at: { x: round3(mid.x), y: round3(mid.y) },
            lengthMm: round3(r.lengthMm),
            detail: `Trace crosses a ${round3(r.lengthMm)} mm split ${between} on ${layerLabel(r.refLayerId)}.`,
            primitiveIds: ids,
            startPt,
            endPt,
          });
          continue;
        }
      }

      if (r.lengthMm >= rules.minSegmentLengthMm) {
        out.push({
          severity: 'error',
          kind: 'no_reference_plane',
          net,
          layerId: chain.layerId,
          referenceLayerId: r.refLayerId,
          at: { x: round3(mid.x), y: round3(mid.y) },
          lengthMm: round3(r.lengthMm),
          detail: `Trace runs ${round3(r.lengthMm)} mm with no reference plane copper on ${layerLabel(r.refLayerId)}.`,
          primitiveIds: ids,
          startPt,
          endPt,
        });
      }
    }
  }

  // 2. Detect reference net changes along the route (e.g. GND -> 3V3 or GND -> 48V_PGND).
  let lastPlaneRun: SampleRun | undefined;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (!isPlaneRun(r) || !r.net) continue;
    if (r.lengthMm < 0.08) continue;
    if (lastPlaneRun && lastPlaneRun.net && netKey(lastPlaneRun.net) !== netKey(r.net)) {
      const transitionS = (lastPlaneRun.s1 + r.s0) / 2;
      const at = chain.polyline.at(transitionS);
      const ids = dedupeIds([
        lastPlaneRun.segIds[lastPlaneRun.segIds.length - 1],
        r.segIds[0],
      ]);
      out.push({
        severity: 'warning',
        kind: 'reference_net_change',
        net,
        layerId: chain.layerId,
        referenceLayerId: r.refLayerId,
        at: { x: round3(at.x), y: round3(at.y) },
        detail: `Reference plane changes net from ${lastPlaneRun.net} to ${r.net} along ${net} on ${layerLabel(r.refLayerId)}.`,
        primitiveIds: ids,
      });
    }
    lastPlaneRun = r;
  }

  // 3. Detect near_plane_edge stretches along reference-covered segments.
  if (rules.planeEdgeClearanceFactor > 0) {
    interface EdgeStretch {
      s0: number;
      s1: number;
      refLayerId: number;
      minDistMm: number;
      thresholdMm: number;
      worstPt: Pt;
      segIds: string[];
    }
    const stretches: EdgeStretch[] = [];
    for (const sm of samples) {
      if (sm.status !== 'ref_covered' || !sm.nearEdge) continue;
      const prev = stretches[stretches.length - 1];
      if (prev && prev.refLayerId === sm.refLayerId && sm.s0 - prev.s1 <= 0.15) {
        prev.s1 = sm.s1;
        prev.segIds.push(sm.segId);
        if (sm.distToEdgeMm < prev.minDistMm) {
          prev.minDistMm = sm.distToEdgeMm;
          prev.worstPt = sm.mid;
          prev.thresholdMm = sm.edgeThresholdMm;
        }
      } else {
        stretches.push({
          s0: sm.s0,
          s1: sm.s1,
          refLayerId: sm.refLayerId,
          minDistMm: sm.distToEdgeMm,
          thresholdMm: sm.edgeThresholdMm,
          worstPt: sm.mid,
          segIds: [sm.segId],
        });
      }
    }

    for (const st of stretches) {
      const lengthMm = st.s1 - st.s0;
      if (lengthMm < rules.minSegmentLengthMm) continue;
      out.push({
        severity: 'warning',
        kind: 'near_plane_edge',
        net,
        layerId: chain.layerId,
        referenceLayerId: st.refLayerId,
        at: { x: round3(st.worstPt.x), y: round3(st.worstPt.y) },
        lengthMm: round3(lengthMm),
        detail: `Trace runs ${round3(lengthMm)} mm within ${round3(st.minDistMm)} mm of the ${layerLabel(st.refLayerId)} plane edge (threshold ${round3(st.thresholdMm)} mm = ${rules.planeEdgeClearanceFactor}×h).`,
        primitiveIds: dedupeIds(st.segIds),
        startPt: chain.polyline.at(st.s0),
        endPt: chain.polyline.at(st.s1),
      });
    }
  }

  return out;
}

/** Finds which reference layers/nets serve a signal layer at a via location (tolerating the via's antipad). */
function referencePlanesAtVia(
  viaAt: Pt,
  signalLayerId: number,
  stackup: Stackup,
  islandsByLayer: Map<number, IndexedIsland[]>,
): Array<{ layerId: number; net: string }> {
  const adjs = adjacentLayersFor(stackup, signalLayerId, islandsByLayer);
  const hits: Array<{ layerId: number; net: string }> = [];
  for (const adj of adjs) {
    // Check inside outer ring (tolerating the signal via's own antipad hole) first, then within 0.6 mm.
    for (const isl of adj.refIslands) {
      if (pointInBBox(viaAt, isl.bbox, 0.05) && pointInRing(viaAt, isl.outer)) {
        hits.push({ layerId: adj.layerId, net: isl.net });
        break;
      }
    }
    if (!hits.some((h) => h.layerId === adj.layerId)) {
      for (const isl of adj.refIslands) {
        if (pointInBBox(viaAt, isl.bbox, 0.6) && distToRing(viaAt, isl.outer, 0.6) < 0.6) {
          hits.push({ layerId: adj.layerId, net: isl.net });
          break;
        }
      }
    }
  }
  return hits;
}

function viaTouchesLayerCopper(at: Pt, radiusMm: number, layerId: number, net: string, islandsByLayer: Map<number, IndexedIsland[]>): boolean {
  const islands = islandsByLayer.get(layerId) ?? [];
  const k = netKey(net);
  const tol = Math.max(0.25, radiusMm + 0.15);
  for (const isl of islands) {
    if (netKey(isl.net) !== k) continue;
    if (!pointInBBox(at, isl.bbox, tol)) continue;
    if (pointInIsland(at, isl) === 'inside') return true;
    if (distToRing(at, isl.outer, tol) <= tol) return true;
  }
  return false;
}

function checkLayerChangeVias(
  net: string,
  netTracks: Track[],
  netVias: Via[],
  allVias: Via[],
  allPads: CheckPad[],
  stackup: Stackup,
  islandsByLayer: Map<number, IndexedIsland[]>,
  layerNames: Map<number, string>,
  refNetKeys: Set<string>,
  rules: CheckRules,
): Finding[] {
  const out: Finding[] = [];
  const layerLabel = (id: number) => layerNames.get(id) ?? `Layer ${id}`;

  // Build candidate return vias: all vias + through-hole pads on any reference net.
  const returnCandidates: Array<{ id: string; net: string; at: Pt; radiusMm: number }> = [];
  for (const v of allVias) {
    if (refNetKeys.has(netKey(v.net))) {
      returnCandidates.push({ id: v.id, net: v.net, at: v.at, radiusMm: v.diameter / 2 });
    }
  }
  for (const p of allPads) {
    if (p.layer === MULTI_LAYER && p.holeDiameter > 0 && refNetKeys.has(netKey(p.net))) {
      returnCandidates.push({ id: p.id, net: p.net, at: p.at, radiusMm: p.holeDiameter / 2 + 0.15 });
    }
  }

  for (const v of netVias) {
    const reach = v.diameter / 2 + 0.15;
    const connectedLayers = new Set<number>();
    for (const t of netTracks) {
      if (distPointSeg(v.at, t.a, t.b) <= reach + t.width / 2) {
        connectedLayers.add(t.layer);
      }
    }
    if (connectedLayers.size < 2) continue;

    const layers = [...connectedLayers].sort((a, b) => a - b);
    const refsPerLayer = layers.map((lid) => ({
      layerId: lid,
      refs: referencePlanesAtVia(v.at, lid, stackup, islandsByLayer),
    }));

    // Check if all connected layers share a common (refLayerId, refNet).
    const firstRefs = refsPerLayer[0].refs;
    const shared = firstRefs.find((r0) =>
      refsPerLayer.every((entry) => entry.refs.some((r) => r.layerId === r0.layerId && netKey(r.net) === netKey(r0.net))),
    );
    if (shared) continue;

    // Collect distinct reference layers and nets involved in the transition.
    const primaryRefs = refsPerLayer
      .map((e) => e.refs[0])
      .filter((r): r is { layerId: number; net: string } => !!r);

    const requiredLayers = [...new Set(primaryRefs.map((r) => r.layerId))];
    const distinctRefNets = [...new Set(primaryRefs.map((r) => netKey(r.net)))];
    const refNetName = primaryRefs[0]?.net;

    // If the two sides reference different nets (e.g. GND vs 48V_PGND), a single stitching via cannot bridge them.
    if (distinctRefNets.length > 1) {
      const names = [...new Set(primaryRefs.map((r) => `${r.net} on ${layerLabel(r.layerId)}`))];
      out.push({
        severity: 'error',
        kind: 'layer_change_no_return',
        net,
        layerId: layers[0],
        referenceLayerId: requiredLayers[0],
        at: { x: round3(v.at.x), y: round3(v.at.y) },
        detail: `Signal via changes layer (${layers.map(layerLabel).join(' → ')}) across different reference nets (${names.join(' → ')}); a stitching capacitor is needed nearby.`,
        primitiveIds: [v.id],
      });
      continue;
    }

    // Look for a return/stitching via within returnViaRadiusMm that connects the reference layers.
    let nearestAnyDist = Infinity;
    let foundWithinRadius = false;

    for (const rv of returnCandidates) {
      if (refNetName && netKey(rv.net) !== netKey(refNetName)) continue;
      // Require the return via to actually touch copper on each required reference layer (when copper exists).
      if (requiredLayers.length >= 2) {
        const touchesAll = requiredLayers.every((rl) =>
          viaTouchesLayerCopper(rv.at, rv.radiusMm, rl, rv.net, islandsByLayer),
        );
        if (!touchesAll) continue;
      }
      const d = dist(v.at, rv.at);
      if (d < nearestAnyDist) nearestAnyDist = d;
      if (d <= rules.returnViaRadiusMm) {
        foundWithinRadius = true;
        break;
      }
    }

    if (!foundWithinRadius) {
      const refDesc =
        requiredLayers.length >= 2
          ? ` (reference ${requiredLayers.map(layerLabel).join(' → ')}${refNetName ? ` on ${refNetName}` : ''})`
          : requiredLayers.length === 1
            ? ` (reference ${layerLabel(requiredLayers[0])}${refNetName ? ` on ${refNetName}` : ''})`
            : '';
      const nearestNote = Number.isFinite(nearestAnyDist)
        ? `nearest return via is ${round3(nearestAnyDist)} mm away`
        : 'no matching return via found on the board';
      out.push({
        severity: 'error',
        kind: 'layer_change_no_return',
        net,
        layerId: layers[0],
        referenceLayerId: requiredLayers[0],
        at: { x: round3(v.at.x), y: round3(v.at.y) },
        detail: `Signal via changes layer (${layers.map(layerLabel).join(' → ')})${refDesc} with no return/stitching via within ${round3(rules.returnViaRadiusMm)} mm (${nearestNote}).`,
        primitiveIds: [v.id],
      });
    }
  }

  return out;
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { error: 0, warning: 1, info: 2 };

function mergeAdjacentFindings(raw: RawFinding[]): Finding[] {
  const mergeableKinds = new Set<FindingKind>([
    'no_reference_plane',
    'plane_split_crossing',
    'plane_void',
    'near_plane_edge',
  ]);

  const groups: RawFinding[] = [];
  for (const item of raw) {
    if (!mergeableKinds.has(item.kind)) {
      groups.push(item);
      continue;
    }

    const match = groups.find((g) => {
      if (g.kind !== item.kind || g.layerId !== item.layerId || g.referenceLayerId !== item.referenceLayerId) {
        return false;
      }
      const sharedId =
        g.primitiveIds && item.primitiveIds && item.primitiveIds.some((id) => g.primitiveIds!.includes(id));
      const ptsA = [g.at, g.startPt, g.endPt].filter((p): p is Pt => !!p);
      const ptsB = [item.at, item.startPt, item.endPt].filter((p): p is Pt => !!p);
      const close = ptsA.some((a) => ptsB.some((b) => dist(a, b) <= MERGE_DISTANCE_MM));
      return Boolean(sharedId || close);
    });

    if (!match) {
      groups.push({ ...item, primitiveIds: item.primitiveIds ? [...item.primitiveIds] : undefined });
      continue;
    }

    const totalLen = (match.lengthMm ?? 0) + (item.lengthMm ?? 0);
    if (totalLen > 0) {
      const wA = match.lengthMm ?? 0.5;
      const wB = item.lengthMm ?? 0.5;
      match.at = {
        x: round3((match.at.x * wA + item.at.x * wB) / (wA + wB)),
        y: round3((match.at.y * wA + item.at.y * wB) / (wA + wB)),
      };
      match.lengthMm = round3(totalLen);
    }
    if (SEVERITY_RANK[item.severity] < SEVERITY_RANK[match.severity]) {
      match.severity = item.severity;
    }
    match.primitiveIds = dedupeIds([...(match.primitiveIds ?? []), ...(item.primitiveIds ?? [])]);
    if (item.endPt) match.endPt = item.endPt;
    if (match.lengthMm !== undefined) {
      match.detail = match.detail.replace(/\b\d+(?:\.\d+)? mm\b/, `${match.lengthMm} mm`);
    }
  }

  // Strip internal merge endpoints and sort most severe / longest first.
  const final: Finding[] = groups.map(({ startPt: _s, endPt: _e, ...rest }) => ({
    ...rest,
    ...(rest.primitiveIds?.length ? { primitiveIds: dedupeIds(rest.primitiveIds) } : {}),
  }));

  final.sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return (b.lengthMm ?? 0) - (a.lengthMm ?? 0);
  });

  return final;
}

export function summarizeFindings(findings: Finding[]): CheckNetSummary {
  const byKind: Record<FindingKind, number> = {
    no_reference_plane: 0,
    plane_split_crossing: 0,
    plane_void: 0,
    near_plane_edge: 0,
    layer_change_no_return: 0,
    reference_net_change: 0,
  };
  let errors = 0;
  let warnings = 0;
  let info = 0;
  for (const f of findings) {
    byKind[f.kind] += 1;
    if (f.severity === 'error') errors += 1;
    else if (f.severity === 'warning') warnings += 1;
    else info += 1;
  }
  return { total: findings.length, errors, warnings, info, byKind };
}

/** Runs return-current-path checks for a single net against the board's reference copper and vias. */
export function checkNetGeometry(
  input: CheckBoardInput,
  requestedNet: string,
  partialRules?: PartialCheckRules | null,
): CheckNetResult {
  const rules = resolveRules(partialRules);
  const warnings = [...(input.warnings ?? [])];

  // Resolve canonical spelling case-insensitively from board tracks/vias.
  const targetKey = netKey(requestedNet);
  const netTracks = input.tracks.filter((t) => t.net && netKey(t.net) === targetKey);
  const netVias = input.vias.filter((v) => v.net && netKey(v.net) === targetKey);
  const canonicalNet = netTracks[0]?.net ?? netVias[0]?.net ?? requestedNet;

  if (rules.skipNets.some((n) => netKey(n) === targetKey)) {
    return {
      net: canonicalNet,
      skipped: true,
      reason: 'Net is listed in rules.skipNets.',
      segmentsChecked: 0,
      viasChecked: 0,
      referenceNetsUsed: [],
      rulesApplied: rules,
      summary: summarizeFindings([]),
      findings: [],
      warnings,
    };
  }

  // Determine which copper pour/plane nets count as valid reference planes.
  const allPourNets = new Map<string, string>();
  for (const byNet of input.copperByLayer.values()) {
    for (const [n, paths] of byNet) {
      if (paths.length && !allPourNets.has(netKey(n))) {
        allPourNets.set(netKey(n), n);
      }
    }
  }

  const refNetKeys = new Set<string>();
  const referenceNetsUsed: string[] = [];
  if (rules.referenceNets && rules.referenceNets.length > 0) {
    for (const rn of rules.referenceNets) {
      const k = netKey(rn);
      if (!refNetKeys.has(k)) {
        refNetKeys.add(k);
        referenceNetsUsed.push(allPourNets.get(k) ?? rn);
      }
    }
  } else {
    for (const [k, name] of allPourNets) {
      if (isGroundNet(name)) {
        refNetKeys.add(k);
        referenceNetsUsed.push(name);
      }
    }
    referenceNetsUsed.sort();
  }

  // Index islands per copper layer.
  const layerNames = new Map<number, string>(input.stackup.copper.map((c: CopperLayer) => [c.id, c.name]));
  const islandsByLayer = new Map<number, IndexedIsland[]>();
  for (const layer of input.stackup.copper) {
    islandsByLayer.set(layer.id, indexLayerIslands(layer.id, input.copperByLayer.get(layer.id), refNetKeys));
  }

  // Analyze trace chains per signal layer.
  const rawFindings: RawFinding[] = [];
  const usedLayers = [...new Set(netTracks.map((t) => t.layer))];
  for (const layerId of usedLayers) {
    const adjLayers = adjacentLayersFor(input.stackup, layerId, islandsByLayer);
    const chains = buildChainsForLayer(layerId, netTracks);
    for (const chain of chains) {
      rawFindings.push(
        ...analyzeChain(canonicalNet, chain, adjLayers, layerNames, referenceNetsUsed, rules),
      );
    }
  }

  // Analyze signal layer-change vias.
  const viaFindings = checkLayerChangeVias(
    canonicalNet,
    netTracks,
    netVias,
    input.vias,
    input.pads ?? [],
    input.stackup,
    islandsByLayer,
    layerNames,
    refNetKeys,
    rules,
  );
  rawFindings.push(...viaFindings);

  const findings = mergeAdjacentFindings(rawFindings);
  return {
    net: canonicalNet,
    segmentsChecked: netTracks.length,
    viasChecked: netVias.length,
    referenceNetsUsed,
    rulesApplied: rules,
    summary: summarizeFindings(findings),
    findings,
    warnings,
  };
}
