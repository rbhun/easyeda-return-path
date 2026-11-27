// EasyEDA's internal plane (layer type PLANE) is a negative sheet: copper everywhere inside
// the board, removed where a keepout, a split line or another net's clearance is. It is not a
// POUR. The editor API has no plane-zone primitive, so the zone net and its outline are read
// from the board document (a FILL on that layer). Rebuilt copper, when the file has it, is a
// POURED record whose target is that fill.
import { arcPoints, decodeComplex, decodeRings, pouredScale, scalePaths, strokePath, union, MULTI_LAYER, type Keepout, type Paths, type Pour } from '@returnpath/core';
import { parseRecords, type Rec } from './records.js';

const MIL = 0.0254;
const LAYER_OUTLINE = 11;
const LAYER_MULTI = 12;
/** REGION prohibit types that take copper off a plane: deprecated pour+plane, no pour, no plane. */
const PLANE_PROHIBIT = new Set([4, 7, 8]);

const conv = (x: number, y: number) => ({ x: x * MIL, y: y * MIL });
const num = (v: unknown, d = 0) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && isFinite(+v) ? +v : d);
const str = (v: unknown) => (v == null ? '' : String(v));

export function planeLayerIds(recs: Rec[]): Set<number> {
  const ids = new Set<number>();
  for (const r of recs) {
    if (r.type !== 'LAYER' || r.layerType !== 'PLANE') continue;
    if ((num(r.status, 1) & 1) === 0) continue;
    ids.add(num(r.id));
  }
  return ids;
}

function pouredPaths(r: Rec): Paths | undefined {
  const sw = num(r.strokeWidth) * MIL;
  if (typeof r.fill === 'boolean' ? r.fill : num(r.fill, 1)) return decodeComplex(r.path, conv, MIL);
  if (sw > 0) return union(...decodeRings(r.path, conv, MIL).filter((ring) => ring.length >= 2).map((ring) => strokePath(ring.length > 2 ? [...ring, ring[0]] : ring, sw)));
  return undefined;
}

export interface PlaneRecords {
  /** One pour per plane zone. `poured` is set only when the file stored rebuilt copper. */
  pours: Pour[];
  /** Lines drawn on the plane. On a negative layer they remove copper, they are not traces. */
  cuts: Keepout[];
}

/** Zones and negative-film cuts for the given plane layers. Does not read REGION keepouts. */
export function readPlaneRecords(recs: Rec[], planeLayers: Set<number>): PlaneRecords {
  const pours: Pour[] = [];
  const cuts: Keepout[] = [];
  if (!planeLayers.size) return { pours, cuts };
  for (const r of recs) {
    const layer = num(r.layerId);
    if (!planeLayers.has(layer)) continue;
    if (r.type === 'LINE' || r.type === 'ARC') {
      const a = conv(num(r.startX), num(r.startY));
      const b = conv(num(r.endX), num(r.endY));
      const width = Math.max(num(r.width) * MIL, 0.05);
      const pts = r.type === 'ARC' ? [a, ...arcPoints(a, b, num(r.angle))] : [a, b];
      for (let i = 1; i < pts.length; i++) {
        const outline = strokePath([pts[i - 1], pts[i]], width);
        if (outline.length) cuts.push({ id: `${r.id}#${i}-cut`, layer, outline });
      }
    } else if (r.type === 'POLY') {
      const width = Math.max(num(r.width) * MIL, 0.05);
      let n = 0;
      for (const ring of decodeRings(r.path, conv, MIL)) {
        if (ring.length < 2) continue;
        const closed = ring.length > 2 ? [...ring, ring[0]] : ring;
        const outline = strokePath(closed, width);
        if (outline.length) cuts.push({ id: `${r.id}#${n++}-cut`, layer, outline });
      }
    } else if (r.type === 'FILL') {
      const net = str(r.netName || r.net);
      if (!net) continue;
      pours.push({ id: r.id, net, layer, name: 'plane', priority: 0, outline: decodeComplex(r.path, conv, MIL) });
    }
  }
  const pouredByZone = new Map<string, Paths[]>();
  for (const r of recs) {
    if (r.type !== 'POURED') continue;
    const paths = pouredPaths(r);
    if (!paths?.length) continue;
    const target = str(r.targetId);
    if (!pours.some((p) => p.id === target)) continue;
    pouredByZone.set(target, [...(pouredByZone.get(target) ?? []), paths]);
  }
  for (const p of pours) {
    const fills = pouredByZone.get(p.id);
    if (!fills) continue;
    const merged = union(...fills);
    p.poured = scalePaths(merged, pouredScale(p.outline.length ? p.outline : merged, merged));
  }
  return { pours, cuts };
}

export interface PlaneDocument extends PlaneRecords {
  planeLayers: number[];
  /** Keepouts that remove plane copper, from REGION records. */
  keepouts: Keepout[];
  /** Board outline from POLY records on the outline layer. */
  outline: Paths;
}

/** Plane zones, cuts, keepouts and the board outline from a PCB document (`getDocumentSource()`). */
export function planeFromDocument(text: string, extraLayers: number[] = []): PlaneDocument {
  const recs = parseRecords(text);
  const ids = planeLayerIds(recs);
  for (const id of extraLayers) ids.add(id);
  const { pours, cuts } = readPlaneRecords(recs, ids);
  const keepouts: Keepout[] = [];
  for (const r of recs) {
    if (r.type !== 'REGION') continue;
    const types = Array.isArray(r.prohibitType) ? (r.prohibitType as unknown[]).map((x) => num(x)) : [];
    if (!types.some((t) => PLANE_PROHIBIT.has(t))) continue;
    const layer = num(r.layerId);
    const outline = decodeComplex(r.path, conv, MIL);
    if (!outline.length) continue;
    keepouts.push({ id: r.id, layer: layer === LAYER_MULTI ? MULTI_LAYER : layer, outline });
  }
  const rings: Paths = [];
  for (const r of recs) {
    if (r.type === 'POLY' && num(r.layerId) === LAYER_OUTLINE)
      rings.push(...decodeRings(r.path, conv, MIL).filter((ring) => ring.length >= 3));
  }
  const outline = union(rings);
  for (const p of pours) if (!p.outline.length && outline.length) p.outline = outline;
  return { planeLayers: [...ids], pours, cuts, keepouts, outline };
}
