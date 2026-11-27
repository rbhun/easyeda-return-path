import {
  arcPoints,
  area,
  assumedDielectricsMm,
  bbox,
  decodeComplex,
  decodeRings,
  dist,
  dropNarrow,
  intersect,
  isGroundNet,
  looksLikePowerNet,
  netKey,
  pointInPaths,
  pouredScale,
  scalePaths,
  splitIslands,
  strokePath,
  union,
  MULTI_LAYER,
  type CopperLayer,
  type Dielectric,
  type Paths,
  type Pt,
  type Stackup,
  type Track,
  type Via,
} from '@returnpath/core';
import { round3, type CheckBoardInput, type CheckPad } from './checker.js';
import type { NetSummary, StackupEntry } from './types.js';

export const MIL = 0.0254;
const PCB_DOCUMENT_TYPE = 3;
const LAYER_MULTI = 12;
const INNER_LAYER_START = 15;
const MIN_COPPER_WIDTH_MM = 0.1;
const CACHE_TTL_MS = 5_000;
const POURED_FETCH_BUDGET_MS = 8_000;
const POURED_SINGLE_TIMEOUT_MS = 2_500;

const conv = (x: number, y: number): Pt => ({ x: x * MIL, y: y * MIL });

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function unitToMm(unit: string | undefined): number {
  switch ((unit ?? 'mm').toLowerCase()) {
    case 'mil':
      return MIL;
    case 'inch':
    case 'in':
      return 25.4;
    case 'um':
    case 'μm':
      return 0.001;
    default:
      return 1;
  }
}

function withTimeout<T>(promise: Promise<T> | T, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface FocusedPcbInfo {
  uuid: string;
  tabId?: string;
}

/** Verifies a PCB document is currently focused and returns its identity. */
export async function requireFocusedPcb(): Promise<FocusedPcbInfo> {
  const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
  if (!doc || doc.documentType !== PCB_DOCUMENT_TYPE) {
    throw new Error('Focus a PCB document first.');
  }
  return {
    uuid: String(doc.uuid ?? ''),
    tabId: typeof (doc as { tabId?: unknown }).tabId === 'string' ? (doc as { tabId: string }).tabId : undefined,
  };
}

export interface StackupReadResult {
  stackup: Stackup;
  entries: StackupEntry[];
  warnings: string[];
}

function parsePhysicalStackingConfig(
  cfg: IPCB_PhysicalStackingConfiguration | undefined,
): { copper: CopperLayer[]; dielectrics: Dielectric[]; entries: StackupEntry[] } | undefined {
  if (!cfg || !Array.isArray(cfg.list) || cfg.list.length < 2) return undefined;
  const copper: CopperLayer[] = [];
  const dielectrics: Dielectric[] = [];
  const entries: StackupEntry[] = [];
  let z = 0;
  let pending: Dielectric | undefined;

  for (const raw of cfg.list) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    const layerId = Number(rec.layerId ?? rec.id ?? -1);
    const name = String(rec.layerName ?? rec.name ?? (layerId >= 0 ? `Layer ${layerId}` : 'Layer'));
    const kindRaw = String(rec.kind ?? rec.type ?? rec.layerType ?? '').toLowerCase();
    const thicknessRaw = Number(rec.thicknessMm ?? rec.thickness ?? NaN);
    const unit = typeof rec.unit === 'string' ? rec.unit : 'mm';
    const thicknessMm = Number.isFinite(thicknessRaw) && thicknessRaw > 0 ? round3(thicknessRaw * unitToMm(unit)) : null;

    const isCopper =
      kindRaw === 'copper' ||
      kindRaw === 'signal' ||
      kindRaw === 'plane' ||
      (layerId >= 1 && (layerId === 1 || layerId === 2 || layerId >= INNER_LAYER_START));
    const isDielectric =
      !isCopper &&
      (kindRaw === 'dielectric' || kindRaw === 'core' || kindRaw === 'prepreg' || kindRaw === 'pp' || kindRaw === 'substrate');

    if (isCopper && layerId > 0) {
      if (copper.length) {
        dielectrics.push(pending ?? { name: 'dielectric', thicknessMm: 0.2 });
      }
      copper.push({
        id: layerId,
        name,
        index: copper.length,
        z,
        thicknessMm: thicknessMm ?? undefined,
      });
      entries.push({ layerId, name, type: 'copper', thicknessMm });
      pending = undefined;
    } else if (isDielectric && copper.length) {
      const t = thicknessMm ?? 0.2;
      z += t;
      pending = pending
        ? { name: `${pending.name}+${name}`, thicknessMm: pending.thicknessMm + t }
        : { name, thicknessMm: t };
      entries.push({ layerId: layerId > 0 ? layerId : 0, name, type: 'dielectric', thicknessMm: round3(t) });
    }
  }

  if (copper.length < 2) return undefined;
  return { copper, dielectrics, entries };
}

/** Reads physical stackup using getStackup(), getCurrentPhysicalStackingConfiguration(), or active copper layers. */
export async function readStackup(): Promise<StackupReadResult> {
  const warnings: string[] = [];
  const copper: CopperLayer[] = [];
  const dielectrics: Dielectric[] = [];
  const entries: StackupEntry[] = [];

  // 1. Try eda.pcb_Layer.getStackup()
  if (typeof eda.pcb_Layer?.getStackup === 'function') {
    try {
      const s = await eda.pcb_Layer.getStackup();
      if (s?.layers?.length) {
        const k = unitToMm(s.unit);
        let z = 0;
        let pending: Dielectric | undefined;
        for (const l of [...s.layers].sort((a, b) => a.zIndex - b.zIndex)) {
          if (l.kind === 'copper') {
            if (copper.length) {
              dielectrics.push(pending ?? { name: 'unknown', thicknessMm: 0.2 });
            }
            const t = l.thickness > 0 ? round3(l.thickness * k) : null;
            const plausible = t !== null && t >= 0.005 && t <= 0.21 ? t : null;
            copper.push({
              id: l.layerId,
              name: l.layerName,
              index: copper.length,
              z,
              thicknessMm: plausible ?? undefined,
            });
            entries.push({ layerId: l.layerId, name: l.layerName, type: 'copper', thicknessMm: plausible });
            pending = undefined;
          } else if (l.kind === 'dielectric' && copper.length) {
            const t = l.thickness > 0 ? l.thickness * k : 0.2;
            z += t;
            pending = pending
              ? { name: `${pending.name}+${l.layerName}`, thicknessMm: pending.thicknessMm + t, er: l.permittivity }
              : { name: l.layerName, thicknessMm: t, er: l.permittivity, lossTangent: l.lossTangent };
            entries.push({
              layerId: l.layerId ?? 0,
              name: l.layerName,
              type: 'dielectric',
              thicknessMm: round3(t),
            });
          }
        }
      }
    } catch {
      // Fall through to next API.
    }
  }

  // 2. Try eda.pcb_Layer.getCurrentPhysicalStackingConfiguration()
  if (copper.length < 2 && typeof eda.pcb_Layer?.getCurrentPhysicalStackingConfiguration === 'function') {
    try {
      const cfg = await eda.pcb_Layer.getCurrentPhysicalStackingConfiguration();
      const parsed = parsePhysicalStackingConfig(cfg);
      if (parsed) {
        return {
          stackup: { copper: parsed.copper, dielectrics: parsed.dielectrics },
          entries: parsed.entries,
          warnings,
        };
      }
    } catch {
      // Fall through to layer list fallback.
    }
  }

  // 3. Fallback to getAllLayers() + getTheNumberOfCopperLayers() + standard 1.6 mm stack assumption.
  if (copper.length < 2) {
    copper.length = 0;
    dielectrics.length = 0;
    entries.length = 0;

    const rawLayers = await eda.pcb_Layer.getAllLayers();
    const all = rawLayers.filter((l) => {
      const t = typeof l.type === 'string' ? l.type.toUpperCase() : '';
      if (t) return t === 'SIGNAL' || t === 'PLANE' || t === 'COPPER';
      return l.id === 1 || l.id === 2 || (l.id >= INNER_LAYER_START && l.id <= 46);
    });
    let count: number | undefined;
    if (typeof eda.pcb_Layer.getTheNumberOfCopperLayers === 'function') {
      try {
        count = await eda.pcb_Layer.getTheNumberOfCopperLayers();
      } catch {
        // Ignore; filter by layerStatus.
      }
    }

    const active = all.filter(
      (l) =>
        (l.layerStatus as number | undefined) !== 0 &&
        (!count || l.id === 1 || l.id === 2 || (l.id >= INNER_LAYER_START && l.id < INNER_LAYER_START + count - 2)),
    );
    const order = (id: number) => (id === 1 ? -1 : id === 2 ? 1000 : id);
    active.sort((a, b) => order(a.id) - order(b.id));

    const gaps = assumedDielectricsMm(active.length);
    let z = 0;
    active.forEach((l, i) => {
      if (i > 0) {
        const g = gaps[i - 1] ?? 0.2;
        z += g;
        dielectrics.push({ name: `Dielectric ${i}`, thicknessMm: g });
        entries.push({ layerId: 0, name: `Dielectric ${i}`, type: 'dielectric', thicknessMm: round3(g), assumed: true });
      }
      copper.push({ id: l.id, name: l.name, index: i, z });
      entries.push({ layerId: l.id, name: l.name, type: 'copper', thicknessMm: null, assumed: true });
    });

    warnings.push(
      `Physical stackup unavailable from EasyEDA API; assuming 1.6 mm board dielectrics (${gaps.map((g) => `${g} mm`).join(', ')}).`,
    );
  }

  return { stackup: { copper, dielectrics }, entries, warnings };
}

type PouredLike = {
  getState_PrimitiveId(): string;
  getState_Layer(): number | undefined;
  getState_PourPrimitiveId(): string | undefined;
  getState_PourFills(): Array<{ fill?: boolean; path?: unknown; lineWidth?: number; strokeWidth?: number }>;
};

function asPoured(x: unknown): PouredLike | undefined {
  const o = (Array.isArray(x) ? x[0] : x) as Record<string, unknown> | undefined;
  if (!o || typeof o !== 'object') return undefined;
  if (typeof o.getState_PourFills === 'function') {
    return {
      getState_PrimitiveId: () => String((o.getState_PrimitiveId as (() => unknown) | undefined)?.() ?? o.primitiveId ?? ''),
      getState_Layer: () => {
        const v = (o.getState_Layer as (() => unknown) | undefined)?.() ?? o.layer;
        return typeof v === 'number' ? v : undefined;
      },
      getState_PourPrimitiveId: () => {
        const v = (o.getState_PourPrimitiveId as (() => unknown) | undefined)?.() ?? o.pourPrimitiveId;
        return typeof v === 'string' && v ? v : undefined;
      },
      getState_PourFills: () => {
        const v = (o.getState_PourFills as () => unknown)();
        return Array.isArray(v) ? (v as PouredLike['getState_PourFills'] extends () => infer R ? R : never) : [];
      },
    };
  }
  const fills = o.pourFills ?? o.PourFills;
  if (!Array.isArray(fills)) return undefined;
  return {
    getState_PrimitiveId: () => String(o.primitiveId ?? o.PrimitiveId ?? ''),
    getState_Layer: () => (typeof o.layer === 'number' ? o.layer : typeof o.Layer === 'number' ? o.Layer : undefined),
    getState_PourPrimitiveId: () => {
      const v = o.pourPrimitiveId ?? o.PourPrimitiveId;
      return typeof v === 'string' && v ? v : undefined;
    },
    getState_PourFills: () => fills as ReturnType<PouredLike['getState_PourFills']>,
  };
}

function fillSource(f: { path?: unknown }): unknown {
  const path = f.path as { getSource?: () => unknown; source?: unknown } | unknown[] | undefined;
  if (Array.isArray(path)) return path;
  return typeof path?.getSource === 'function' ? path.getSource() : path?.source;
}

type PlanePartition = { net: string; layer: number; shape: Paths };

function matchPlanePartition(
  island: Paths,
  layer: number,
  planes: PlanePartition[],
  boxes: ReturnType<typeof bbox>[],
): PlanePartition | undefined {
  const b = bbox(island);
  const near = planes.filter(
    (p, i) =>
      p.layer === layer &&
      boxes[i].minX <= b.maxX &&
      boxes[i].maxX >= b.minX &&
      boxes[i].minY <= b.maxY &&
      boxes[i].maxY >= b.minY,
  );
  if (near.length <= 1) return near[0];
  const probe = island[0]?.[0];
  if (probe) {
    const inside = near.filter((p) => pointInPaths(probe, p.shape));
    if (inside.length === 1) return inside[0];
  }
  let best: PlanePartition | undefined;
  let bestArea = 0;
  for (const p of near) {
    const overlap = area(intersect(island, p.shape));
    if (overlap > bestArea) {
      bestArea = overlap;
      best = p;
    }
  }
  return best;
}

async function readPouredPrimitives(warnings: string[]): Promise<PouredLike[]> {
  const api = eda.pcb_PrimitivePoured;
  if (!api) return [];
  const out: PouredLike[] = [];
  try {
    if (typeof api.getAllPrimitiveId === 'function' && typeof api.get === 'function') {
      const ids = (await withTimeout(api.getAllPrimitiveId(), POURED_FETCH_BUDGET_MS, 'pcb_PrimitivePoured.getAllPrimitiveId')) ?? [];
      const t0 = nowMs();
      for (const id of ids) {
        if (nowMs() - t0 > POURED_FETCH_BUDGET_MS) {
          warnings.push('Fetching computed pour fills exceeded time budget; remaining pours use outlines.');
          break;
        }
        try {
          const raw = await withTimeout(api.get(id), POURED_SINGLE_TIMEOUT_MS, `pcb_PrimitivePoured.get(${id})`);
          const parsed = asPoured(raw);
          if (parsed) out.push(parsed);
        } catch (err) {
          warnings.push(
            `Pour fill ${id} could not be fetched (${err instanceof Error ? err.message : String(err)}); falling back to pour outline.`,
          );
        }
      }
      return out;
    }
    if (typeof api.getAll === 'function') {
      const all = (await withTimeout(api.getAll(), POURED_FETCH_BUDGET_MS, 'pcb_PrimitivePoured.getAll')) ?? [];
      for (const item of all) {
        const parsed = asPoured(item);
        if (parsed) out.push(parsed);
      }
    }
  } catch (err) {
    warnings.push(
      `Computed pour fills unavailable (${err instanceof Error ? err.message : String(err)}); falling back to pour outlines.`,
    );
  }
  return out;
}

async function readCopperByLayer(copperIds: Set<number>, warnings: string[]): Promise<Map<number, Map<string, Paths>>> {
  const byLayer = new Map<number, Map<string, Paths>>();
  const addCopper = (layer: number, net: string, paths: Paths) => {
    if (!paths.length || !net || !copperIds.has(layer)) return;
    let map = byLayer.get(layer);
    if (!map) {
      map = new Map<string, Paths>();
      byLayer.set(layer, map);
    }
    const existing = map.get(net);
    map.set(net, existing ? union(existing, paths) : union(paths));
  };

  // 1. Read solid fills and plane-layer partitions (mode 2 = INNER_ELECTRICAL_LAYER).
  const planePartitions: PlanePartition[] = [];
  if (typeof eda.pcb_PrimitiveFill?.getAll === 'function') {
    for (const f of (await eda.pcb_PrimitiveFill.getAll()) ?? []) {
      const layer = f.getState_Layer() as number;
      const net = f.getState_Net();
      if (!copperIds.has(layer) || !net) continue;
      const shape = decodeComplex(f.getState_ComplexPolygon().getSource(), conv, MIL);
      if ((f.getState_FillMode() as number | undefined) === 2) {
        planePartitions.push({ net, layer, shape });
      } else {
        addCopper(layer, net, dropNarrow(shape, MIN_COPPER_WIDTH_MM));
      }
    }
  }

  // 2. Read computed poured copper fills (PCB_PrimitivePoured).
  const ringsByPour = new Map<string, Paths>();
  const islandsByPlane = new Map<string, { plane: PlanePartition; islands: Paths }>();
  const planeBoxes = planePartitions.map((p) => bbox(p.shape));

  const pouredAll = await readPouredPrimitives(warnings);
  for (const poured of pouredAll) {
    const rings: Paths = [];
    for (const f of poured.getState_PourFills()) {
      const src = fillSource(f);
      if (!src) continue;
      const strokeW = Number(f.lineWidth ?? f.strokeWidth) * MIL;
      const decoded = f.fill
        ? decodeComplex(src, conv, MIL)
        : strokeW > 0
          ? union(
              ...decodeRings(src, conv, MIL)
                .filter((r) => r.length >= 2)
                .map((r) => strokePath(r.length > 2 ? [...r, r[0]] : r, strokeW)),
            )
          : [];
      for (const r of decoded) {
        if (r.length >= 3 && r.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y))) {
          rings.push(r);
        }
      }
    }
    if (!rings.length) continue;

    const pourId = poured.getState_PourPrimitiveId();
    if (pourId) {
      const existing = ringsByPour.get(pourId) ?? [];
      for (const r of rings) existing.push(r);
      ringsByPour.set(pourId, existing);
      continue;
    }

    const layer = poured.getState_Layer();
    if (layer === undefined || !copperIds.has(layer)) continue;
    for (const island of splitIslands(rings)) {
      const plane = matchPlanePartition(island, layer, planePartitions, planeBoxes);
      if (!plane) continue;
      const key = `${layer}:${plane.net}`;
      const entry = islandsByPlane.get(key) ?? { plane, islands: [] };
      for (const r of island) entry.islands.push(r);
      islandsByPlane.set(key, entry);
    }
  }

  for (const { plane, islands } of islandsByPlane.values()) {
    addCopper(plane.layer, plane.net, dropNarrow(union(islands), MIN_COPPER_WIDTH_MM));
  }
  for (const plane of planePartitions) {
    if (!islandsByPlane.has(`${plane.layer}:${plane.net}`)) {
      warnings.push(`Plane ${plane.net} on layer ${plane.layer} has no computed copper; using its outline.`);
      addCopper(plane.layer, plane.net, dropNarrow(plane.shape, MIN_COPPER_WIDTH_MM));
    }
  }

  // 3. Read pours (PCB_PrimitivePour) and pair with computed fills (with 10-mil scaling fix).
  if (typeof eda.pcb_PrimitivePour?.getAll === 'function') {
    for (const p of (await eda.pcb_PrimitivePour.getAll()) ?? []) {
      const id = p.getState_PrimitiveId();
      const layer = p.getState_Layer() as number;
      const net = p.getState_Net();
      if (!copperIds.has(layer) || !net) continue;
      const outline = decodeComplex(p.getState_ComplexPolygon().getSource(), conv, MIL);
      const rawRings = ringsByPour.get(id);
      let fill: Paths | undefined;
      if (rawRings?.length) {
        const merged = union(rawRings);
        const k = pouredScale(outline, merged);
        fill = scalePaths(merged, k);
        if (!(Math.abs(area(fill)) > 0)) fill = undefined;
      }
      if (!fill) {
        warnings.push(`Pour "${p.getState_PourName() || id}" (${net}) on layer ${layer} has no computed fill; using outline.`);
        fill = outline;
      }
      addCopper(layer, net, dropNarrow(fill, MIN_COPPER_WIDTH_MM));
    }
  }

  return byLayer;
}

function canonicalizeNetNames(names: string[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const n of names) {
    if (!n) continue;
    const k = netKey(n);
    const m = counts.get(k) ?? new Map<string, number>();
    m.set(n, (m.get(n) ?? 0) + 1);
    counts.set(k, m);
  }
  const canon = new Map<string, string>();
  for (const [k, m] of counts) {
    let best = '';
    let bestCount = -1;
    for (const [spelling, count] of m) {
      if (count > bestCount) {
        best = spelling;
        bestCount = count;
      }
    }
    if (best) canon.set(k, best);
  }
  return canon;
}

/** Reads per-net summaries (trackCount, viaCount, layers, power/ground flags) from the focused PCB. */
export async function readNetSummaries(): Promise<{ pcbUuid: string; nets: NetSummary[] }> {
  const pcb = await requireFocusedPcb();
  const { stackup } = await readStackup();
  const copperIds = new Set(stackup.copper.map((c) => c.id));

  const [allNetNames, lines, arcs, vias, pours, fills] = await Promise.all([
    typeof eda.pcb_Net?.getAllNetsName === 'function' ? eda.pcb_Net.getAllNetsName() : Promise.resolve([]),
    typeof eda.pcb_PrimitiveLine?.getAll === 'function' ? eda.pcb_PrimitiveLine.getAll() : Promise.resolve([]),
    typeof eda.pcb_PrimitiveArc?.getAll === 'function' ? eda.pcb_PrimitiveArc.getAll() : Promise.resolve([]),
    typeof eda.pcb_PrimitiveVia?.getAll === 'function' ? eda.pcb_PrimitiveVia.getAll() : Promise.resolve([]),
    typeof eda.pcb_PrimitivePour?.getAll === 'function' ? eda.pcb_PrimitivePour.getAll() : Promise.resolve([]),
    typeof eda.pcb_PrimitiveFill?.getAll === 'function' ? eda.pcb_PrimitiveFill.getAll() : Promise.resolve([]),
  ]);

  const rawNames: string[] = [...(allNetNames ?? [])];
  for (const l of lines ?? []) {
    const n = l.getState_Net();
    if (n) rawNames.push(n);
  }
  for (const a of arcs ?? []) {
    const n = a.getState_Net();
    if (n) rawNames.push(n);
  }
  for (const v of vias ?? []) {
    const n = v.getState_Net();
    if (n) rawNames.push(n);
  }
  for (const p of pours ?? []) {
    const n = p.getState_Net();
    if (n) rawNames.push(n);
  }
  for (const f of fills ?? []) {
    const n = f.getState_Net();
    if (n) rawNames.push(n);
  }

  const canon = canonicalizeNetNames(rawNames);
  const acc = new Map<
    string,
    { name: string; trackCount: number; viaCount: number; layers: Set<number>; totalLengthMm: number; hasPour: boolean }
  >();

  const ensure = (rawNet: string | undefined) => {
    if (!rawNet) return undefined;
    const k = netKey(rawNet);
    let entry = acc.get(k);
    if (!entry) {
      entry = { name: canon.get(k) ?? rawNet, trackCount: 0, viaCount: 0, layers: new Set(), totalLengthMm: 0, hasPour: false };
      acc.set(k, entry);
    }
    return entry;
  };

  for (const name of allNetNames ?? []) ensure(name);

  for (const l of lines ?? []) {
    const layer = l.getState_Layer() as number;
    if (!copperIds.has(layer)) continue;
    const e = ensure(l.getState_Net());
    if (!e) continue;
    e.trackCount += 1;
    e.layers.add(layer);
    const a = conv(l.getState_StartX(), l.getState_StartY());
    const b = conv(l.getState_EndX(), l.getState_EndY());
    e.totalLengthMm += dist(a, b);
  }

  for (const a of arcs ?? []) {
    const layer = a.getState_Layer() as number;
    if (!copperIds.has(layer)) continue;
    const e = ensure(a.getState_Net());
    if (!e) continue;
    e.trackCount += 1;
    e.layers.add(layer);
    const start = conv(a.getState_StartX(), a.getState_StartY());
    const end = conv(a.getState_EndX(), a.getState_EndY());
    const pts = [start, ...arcPoints(start, end, a.getState_ArcAngle())];
    for (let i = 1; i < pts.length; i++) e.totalLengthMm += dist(pts[i - 1], pts[i]);
  }

  for (const v of vias ?? []) {
    const e = ensure(v.getState_Net());
    if (!e) continue;
    e.viaCount += 1;
  }

  for (const p of pours ?? []) {
    const layer = p.getState_Layer() as number;
    if (!copperIds.has(layer)) continue;
    const e = ensure(p.getState_Net());
    if (!e) continue;
    e.hasPour = true;
    e.layers.add(layer);
  }

  for (const f of fills ?? []) {
    const layer = f.getState_Layer() as number;
    if (!copperIds.has(layer)) continue;
    const e = ensure(f.getState_Net());
    if (!e) continue;
    e.hasPour = true;
    e.layers.add(layer);
  }

  const nets: NetSummary[] = [...acc.values()]
    .map((e) => ({
      name: e.name,
      trackCount: e.trackCount,
      viaCount: e.viaCount,
      layers: [...e.layers].sort((a, b) => a - b),
      totalLengthMm: round3(e.totalLengthMm),
      isPower: looksLikePowerNet(e.name),
      isGround: isGroundNet(e.name),
      hasPour: e.hasPour,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { pcbUuid: pcb.uuid, nets };
}

interface CachedBoardSnapshot {
  pcbUuid: string;
  fetchedAt: number;
  knownNets: Map<string, string>;
  stackup: Stackup;
  tracks: Track[];
  vias: Via[];
  pads: CheckPad[];
  copperByLayer: Map<number, Map<string, Paths>>;
  warnings: string[];
}

let boardCache: CachedBoardSnapshot | undefined;

export function clearBoardCache(): void {
  boardCache = undefined;
}

/** Reads board geometry needed by checkNet, using a short-lived cache for rapid multi-net agent loops. */
export async function readBoardForCheck(refresh = false): Promise<CachedBoardSnapshot> {
  const pcb = await requireFocusedPcb();
  if (!refresh && boardCache && boardCache.pcbUuid === pcb.uuid && nowMs() - boardCache.fetchedAt < CACHE_TTL_MS) {
    return boardCache;
  }

  const { stackup, warnings } = await readStackup();
  const copperIds = new Set(stackup.copper.map((c) => c.id));

  const [allNetNames, rawLines, rawArcs, rawVias, rawPads] = await Promise.all([
    typeof eda.pcb_Net?.getAllNetsName === 'function' ? eda.pcb_Net.getAllNetsName() : Promise.resolve([]),
    typeof eda.pcb_PrimitiveLine?.getAll === 'function' ? eda.pcb_PrimitiveLine.getAll() : Promise.resolve([]),
    typeof eda.pcb_PrimitiveArc?.getAll === 'function' ? eda.pcb_PrimitiveArc.getAll() : Promise.resolve([]),
    typeof eda.pcb_PrimitiveVia?.getAll === 'function' ? eda.pcb_PrimitiveVia.getAll() : Promise.resolve([]),
    typeof eda.pcb_PrimitivePad?.getAll === 'function' ? eda.pcb_PrimitivePad.getAll() : Promise.resolve([]),
  ]);

  const rawNames: string[] = [...(allNetNames ?? [])];
  const tracks: Track[] = [];
  for (const l of rawLines ?? []) {
    const layer = l.getState_Layer() as number;
    if (!copperIds.has(layer)) continue;
    const net = l.getState_Net() ?? '';
    if (net) rawNames.push(net);
    tracks.push({
      id: l.getState_PrimitiveId(),
      net,
      layer,
      a: conv(l.getState_StartX(), l.getState_StartY()),
      b: conv(l.getState_EndX(), l.getState_EndY()),
      width: l.getState_LineWidth() * MIL,
    });
  }

  for (const arc of rawArcs ?? []) {
    const layer = arc.getState_Layer() as number;
    if (!copperIds.has(layer)) continue;
    const net = arc.getState_Net() ?? '';
    if (net) rawNames.push(net);
    const start = conv(arc.getState_StartX(), arc.getState_StartY());
    const end = conv(arc.getState_EndX(), arc.getState_EndY());
    const pts = [start, ...arcPoints(start, end, arc.getState_ArcAngle())];
    for (let i = 1; i < pts.length; i++) {
      tracks.push({
        id: `${arc.getState_PrimitiveId()}#${i}`,
        net,
        layer,
        a: pts[i - 1],
        b: pts[i],
        width: arc.getState_LineWidth() * MIL,
      });
    }
  }

  const vias: Via[] = (rawVias ?? []).map((v) => {
    const net = v.getState_Net() ?? '';
    if (net) rawNames.push(net);
    return {
      id: v.getState_PrimitiveId(),
      net,
      at: conv(v.getState_X(), v.getState_Y()),
      drill: v.getState_HoleDiameter() * MIL,
      diameter: v.getState_Diameter() * MIL,
      stitching: (v.getState_ViaType() as number) === 1,
    };
  });

  const pads: CheckPad[] = (rawPads ?? []).map((p) => {
    const net = p.getState_Net() ?? '';
    if (net) rawNames.push(net);
    const layer = p.getState_Layer() as number;
    const hole = p.getState_Hole();
    return {
      id: p.getState_PrimitiveId(),
      net,
      layer: layer === LAYER_MULTI ? MULTI_LAYER : layer,
      at: conv(p.getState_X(), p.getState_Y()),
      holeDiameter: hole ? Number(hole[1] ?? 0) * MIL : 0,
    };
  });

  const copperByLayer = await readCopperByLayer(copperIds, warnings);
  for (const map of copperByLayer.values()) {
    for (const net of map.keys()) rawNames.push(net);
  }

  const knownNets = canonicalizeNetNames(rawNames);
  const fixNet = (n: string) => (n ? knownNets.get(netKey(n)) ?? n : n);
  for (const t of tracks) t.net = fixNet(t.net);
  for (const v of vias) v.net = fixNet(v.net);
  for (const p of pads) p.net = fixNet(p.net);
  for (const [layerId, byNet] of copperByLayer) {
    const unified = new Map<string, Paths>();
    for (const [net, paths] of byNet) {
      const cname = fixNet(net);
      const prev = unified.get(cname);
      unified.set(cname, prev ? union(prev, paths) : paths);
    }
    copperByLayer.set(layerId, unified);
  }

  // Warm canvasOrigin while PCB is definitely focused.
  await readCanvasOrigin();

  boardCache = {
    pcbUuid: pcb.uuid,
    fetchedAt: nowMs(),
    knownNets,
    stackup,
    tracks,
    vias,
    pads,
    copperByLayer,
    warnings,
  };
  return boardCache;
}

export function snapshotToCheckInput(snap: CachedBoardSnapshot): CheckBoardInput {
  return {
    stackup: snap.stackup,
    tracks: snap.tracks,
    vias: snap.vias,
    pads: snap.pads,
    copperByLayer: snap.copperByLayer,
    warnings: snap.warnings,
  };
}

let cachedOrigin: { api: unknown; pt: Pt } | undefined;

/** Returns data origin (0, 0) in canvas coordinates (mil), gracefully handling EasyEDA 3.2/4.x quirks. */
export async function readCanvasOrigin(): Promise<Pt> {
  const isPt = (p: unknown): p is Pt =>
    !!p && typeof p === 'object' && Number.isFinite((p as Pt).x) && Number.isFinite((p as Pt).y);

  try {
    if (typeof eda.pcb_Document?.convertDataOriginToCanvasOrigin === 'function') {
      const p = await eda.pcb_Document.convertDataOriginToCanvasOrigin(0, 0);
      if (isPt(p)) {
        cachedOrigin = { api: eda, pt: { x: p.x, y: p.y } };
        return cachedOrigin.pt;
      }
    }
  } catch {
    // Try inverse conversion next.
  }

  try {
    if (typeof eda.pcb_Document?.convertCanvasOriginToDataOrigin === 'function') {
      const d = await eda.pcb_Document.convertCanvasOriginToDataOrigin(0, 0);
      if (isPt(d)) {
        cachedOrigin = { api: eda, pt: { x: -d.x, y: -d.y } };
        return cachedOrigin.pt;
      }
    }
  } catch {
    // Fall back to cached origin or (0, 0).
  }

  return cachedOrigin?.api === eda ? cachedOrigin.pt : { x: 0, y: 0 };
}
