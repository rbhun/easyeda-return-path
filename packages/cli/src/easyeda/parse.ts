import { add, arcPoints, bbox, circle, decodeComplex, decodeRings, inflate, MULTI_LAYER, rect, rotate, strokePath, union, type Board, type Component, type CopperLayer, type Dielectric, type Keepout, type Pad, type Paths, type Pour, type Pt, type Track, type Via } from '@returnpath/core';
import { parseRecords, type Rec } from './records.js';

/** EasyEDA Pro PCB data is in mil. */
export const MIL = 0.0254;

const LAYER_TOP = 1;
const LAYER_BOTTOM = 2;
const LAYER_OUTLINE = 11;
const LAYER_MULTI = 12;
/** REGION prohibit types that keep pour / plane copper out. */
const NO_POUR = new Set([4, 7, 8]);

export interface ParseOptions {
  /** Unit of LAYER_PHYS dielectric thickness. 'auto': mm if any value < 1, else mil. */
  physUnit?: 'auto' | 'mil' | 'mm';
  /** Dielectric thickness used when the stackup gives none, mm. */
  defaultDielectricMm?: number;
}

export interface Sources {
  /** The PCB document text (.epcb / getDocumentSource()). */
  pcb: string;
  /** Footprint documents (.efoo) keyed by footprint uuid. */
  footprints?: Map<string, string>;
  /** Extra POURED documents (.ecop). */
  poured?: string[];
}

const conv = (x: number, y: number): Pt => ({ x: x * MIL, y: y * MIL });
const num = (v: unknown, d = 0) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && isFinite(+v) ? +v : d);
const str = (v: unknown) => (v == null ? '' : String(v));

export function parseEasyEdaPcb(src: Sources, opts: ParseOptions = {}): Board {
  const recs = parseRecords(src.pcb);
  for (const extra of src.poured ?? []) recs.push(...parseRecords(extra).filter((r) => r.type === 'POURED'));
  const warnings: string[] = [];

  const stackup = buildStackup(recs, opts, warnings);
  const copperIds = new Set(stackup.copper.map((l) => l.id));

  const nets = new Set<string>();
  const tracks: Track[] = [];
  const vias: Via[] = [];
  const pads: Pad[] = [];
  const pours: Pour[] = [];
  const keepouts: Keepout[] = [];
  const outlineRings: Paths = [];
  const outlineSegs: Track[] = [];
  const pouredByPour = new Map<string, Paths[]>();

  for (const r of recs) {
    switch (r.type) {
      case 'NET':
        nets.add(r.id);
        break;
      case 'LINE':
      case 'ARC': {
        const layer = num(r.layerId);
        const a = conv(num(r.startX), num(r.startY));
        const b = conv(num(r.endX), num(r.endY));
        const width = num(r.width) * MIL;
        const pts = r.type === 'ARC' ? [a, ...arcPoints(a, b, num(r.angle))] : [a, b];
        const target = layer === LAYER_OUTLINE ? outlineSegs : copperIds.has(layer) ? tracks : null;
        if (!target) break;
        for (let i = 1; i < pts.length; i++)
          target.push({ id: pts.length > 2 ? `${r.id}#${i}` : r.id, net: str(r.netName), layer, a: pts[i - 1], b: pts[i], width });
        break;
      }
      case 'VIA':
        vias.push({
          id: r.id,
          net: str(r.netName),
          at: conv(num(r.centerX), num(r.centerY)),
          drill: num(r.holeDiameter) * MIL,
          diameter: num(r.viaDiameter) * MIL,
          stitching: num(r.viaType) === 1,
        });
        break;
      case 'PAD':
        pads.push(buildPad(r, { at: { x: 0, y: 0 }, angle: 0, mirror: false }, str(r.netName), copperIds));
        break;
      case 'POUR':
        pours.push({
          id: r.id,
          net: str(r.netName),
          layer: num(r.layerId),
          name: str(r.name),
          priority: num(r.order),
          outline: decodeComplex(r.path, conv, MIL),
        });
        break;
      case 'FILL': {
        const layer = num(r.layerId);
        if (!copperIds.has(layer)) break;
        // Solid copper fills act like a pre-poured pour of their net.
        const fill = decodeComplex(r.path, conv, MIL);
        pours.push({ id: r.id, net: str(r.netName), layer, name: 'FILL', priority: -1, outline: fill, poured: fill });
        break;
      }
      case 'POURED': {
        const target = str(r.targetId);
        const sw = num(r.strokeWidth) * MIL;
        let paths: Paths;
        if (num(r.fill, 1)) paths = decodeComplex(r.path, conv, MIL);
        else if (sw > 0) paths = union(...decodeRings(r.path, conv, MIL).map((ring) => strokePath([...ring, ring[0]], sw)));
        else break;
        pouredByPour.set(target, [...(pouredByPour.get(target) ?? []), paths]);
        break;
      }
      case 'REGION': {
        const types = Array.isArray(r.prohibitType) ? (r.prohibitType as unknown[]).map((x) => num(x)) : [];
        if (!types.some((t) => NO_POUR.has(t))) break;
        const layer = num(r.layerId);
        keepouts.push({ id: r.id, layer: layer === LAYER_MULTI ? MULTI_LAYER : layer, outline: decodeComplex(r.path, conv, MIL) });
        break;
      }
      case 'POLY':
        if (num(r.layerId) === LAYER_OUTLINE) outlineRings.push(...decodeRings(r.path, conv, MIL));
        break;
    }
  }

  for (const p of pours) {
    const fills = pouredByPour.get(p.id);
    if (fills) p.poured = union(...fills);
  }
  if (pours.some((p) => !p.poured))
    warnings.push('Some pours have no stored fill (POURED); their copper was recomputed from outlines with a uniform clearance.');

  const components = buildComponents(recs, src.footprints ?? new Map(), copperIds, pads, warnings);
  for (const t of tracks) nets.add(t.net);
  for (const p of pads) if (p.net) nets.add(p.net);

  let outline: Paths = union(outlineRings.filter((r) => r.length >= 3));
  if (!outline.length && outlineSegs.length) {
    const b = bbox(outlineSegs.map((s) => [s.a, s.b]));
    outline = [rect((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.maxX - b.minX, b.maxY - b.minY)];
    warnings.push('Board outline built from line segments; using their bounding box.');
  }
  if (!outline.length) {
    const b = bbox([...tracks.map((t) => [t.a, t.b]), ...pours.flatMap((p) => p.outline)]);
    outline = inflate([rect((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.maxX - b.minX, b.maxY - b.minY)], 1);
    warnings.push('No board outline found; using the copper bounding box.');
  }

  nets.delete('');
  return { outline, stackup, nets: [...nets].sort(), tracks, vias, pads, components, pours, keepouts, warnings };
}

function buildStackup(recs: Rec[], opts: ParseOptions, warnings: string[]): Board['stackup'] {
  const layers = recs.filter((r) => r.type === 'LAYER' && num(r.status, 1) & 1);
  const phys = new Map(recs.filter((r) => r.type === 'LAYER_PHYS').map((r) => [num(r.id), r]));
  const top = layers.find((l) => l.layerType === 'TOP');
  const bottom = layers.find((l) => l.layerType === 'BOTTOM');
  // TOP first, then SIGNAL/PLANE/SUBSTRATE in file order, then BOTTOM.
  const middle = layers.filter((l) => l.layerType === 'SIGNAL' || l.layerType === 'PLANE' || l.layerType === 'SUBSTRATE');
  const seq = [top ?? { type: 'LAYER', id: String(LAYER_TOP), layerType: 'TOP', layerName: 'Top Layer' }, ...middle, bottom ?? { type: 'LAYER', id: String(LAYER_BOTTOM), layerType: 'BOTTOM', layerName: 'Bottom Layer' }];

  const subThk = middle.filter((l) => l.layerType === 'SUBSTRATE').map((l) => num(phys.get(num(l.id))?.thickness, NaN)).filter(isFinite);
  let unit = opts.physUnit ?? 'auto';
  if (unit === 'auto') unit = subThk.some((t) => t < 1) ? 'mm' : 'mil';
  const toMm = (v: number) => (unit === 'mm' ? v : v * MIL);
  const dflt = opts.defaultDielectricMm ?? 0.2;

  const copper: CopperLayer[] = [];
  const dielectrics: Dielectric[] = [];
  let pending: Dielectric[] = [];
  let z = 0;
  for (const l of seq) {
    const id = num(l.id);
    if (l.layerType === 'SUBSTRATE') {
      const p = phys.get(id);
      const t = num(p?.thickness, NaN);
      pending.push({ name: str(l.layerName), thicknessMm: isFinite(t) && t > 0 ? toMm(t) : dflt, er: num(p?.permittivity, NaN) || undefined, lossTangent: num(p?.lossTangent, NaN) || undefined });
      continue;
    }
    if (copper.length) {
      if (!pending.length) {
        warnings.push(`No dielectric between ${copper[copper.length - 1].name} and ${str(l.layerName)}; assuming ${dflt} mm.`);
        pending = [{ name: 'assumed', thicknessMm: dflt }];
      }
      const thk = pending.reduce((s, d) => s + d.thicknessMm, 0);
      dielectrics.push({ name: pending.map((d) => d.name).join('+'), thicknessMm: thk, er: pending[0].er, lossTangent: pending[0].lossTangent });
      z += thk;
    }
    pending = [];
    copper.push({ id, name: str(l.layerName) || `L${id}`, index: copper.length, z, thicknessMm: copperThicknessMm(num(phys.get(id)?.thickness, NaN)) });
  }
  if (subThk.length) warnings.push(`LAYER_PHYS dielectric thickness read as ${unit}.`);
  if (copper.some((c) => c.thicknessMm)) warnings.push('LAYER_PHYS copper thickness read as oz (0.25–6), mm (< 0.25) or µm (> 6); unverified against a real export.');
  return { copper, dielectrics };
}

/** Copper LAYER_PHYS thickness: the unit is undocumented, so guess it from the magnitude. */
function copperThicknessMm(t: number): number | undefined {
  if (!isFinite(t) || t <= 0) return undefined;
  if (t < 0.25) return t;
  if (t <= 6) return t * 0.035;
  return t / 1000;
}

interface Xform {
  at: Pt;
  angle: number;
  mirror: boolean;
}

function buildPad(r: Rec, xf: Xform, net: string, copperIds: Set<number>, idPrefix = ''): Pad {
  let layer = num(r.layerId);
  if (xf.mirror && (layer === LAYER_TOP || layer === LAYER_BOTTOM)) layer = layer === LAYER_TOP ? LAYER_BOTTOM : LAYER_TOP;
  if (layer === LAYER_MULTI || !copperIds.has(layer)) layer = MULTI_LAYER;
  const local = conv(num(r.centerX), num(r.centerY));
  const place = (p: Pt): Pt => add(rotate(xf.mirror ? { x: -p.x, y: p.y } : p, xf.angle), xf.at);
  const at = place(local);
  const padAngle = num(r.padAngle);
  const shape = Array.isArray(r.defaultPad) ? (r.defaultPad as unknown[]) : ['ROUND', 0, 0];
  const kind = str(shape[0]);
  const w = num(shape[1]) * MIL;
  const h = num(shape[2], num(shape[1])) * MIL;
  let outline: Paths;
  const toWorld = (pts: Pt[]) => pts.map((p) => place(add(rotate(p, padAngle), local)));
  if (kind === 'RECT') outline = [toWorld(rect(0, 0, w, h))];
  else if (kind === 'NGON') {
    const n = Math.max(3, num(shape[2], 6));
    outline = [toWorld(circle({ x: 0, y: 0 }, w / 2, n))];
  } else if (kind === 'POLY' || kind === 'POLYGON') {
    outline = decodeComplex(shape[1], (x, y) => conv(x, y), MIL).map(toWorld);
  } else {
    // ROUND / ELLIPSE / OVAL: stadium of w × h.
    const r0 = Math.min(w, h) / 2;
    const dx = w > h ? (w - h) / 2 : 0;
    const dy = h > w ? (h - w) / 2 : 0;
    outline = strokePath([{ x: -dx, y: -dy }, { x: dx, y: dy }], 2 * r0).map(toWorld);
    if (!dx && !dy) outline = [toWorld(circle({ x: 0, y: 0 }, r0))];
  }
  const hole = Array.isArray(r.hole) ? (r.hole as unknown[]) : null;
  return {
    id: idPrefix + r.id,
    net,
    layer,
    number: str(r.num),
    at,
    shape: union(outline),
    holeDiameter: hole ? num(hole[1]) * MIL : 0,
  };
}

function buildComponents(recs: Rec[], footprints: Map<string, string>, copperIds: Set<number>, pads: Pad[], warnings: string[]): Component[] {
  const attrs = new Map<string, Map<string, string>>();
  for (const r of recs) {
    if (r.type !== 'ATTR') continue;
    const parent = str(r.parentId);
    if (!attrs.has(parent)) attrs.set(parent, new Map());
    attrs.get(parent)!.set(str(r.key).toLowerCase(), str(r.value));
  }
  const padNets = new Map<string, Map<string, string>>();
  for (const r of recs) {
    if (r.type !== 'PAD_NET') continue;
    if (!padNets.has(r.id)) padNets.set(r.id, new Map());
    padNets.get(r.id)!.set(str(r.padNum), str(r.padNet));
  }
  const fpCache = new Map<string, Rec[]>();
  const comps: Component[] = [];
  let missing = 0;
  for (const r of recs) {
    if (r.type !== 'COMPONENT') continue;
    const a = attrs.get(r.id) ?? new Map<string, string>();
    const attrMap = (r.attrs ?? {}) as Record<string, unknown>;
    const fpId = a.get('footprint') ?? str(attrMap['Footprint']);
    const layer = num(r.layerId, LAYER_TOP);
    const xf: Xform = { at: conv(num(r.positionX), num(r.positionY)), angle: num(r.angle), mirror: layer === LAYER_BOTTOM };
    const name = a.get('name') || str(attrMap['Name']) || a.get('manufacturer part') || undefined;
    const comp: Component = { id: r.id, designator: a.get('designator') || str(attrMap['Designator']) || r.id, name, at: xf.at, rotation: xf.angle, layer, padIds: [] };
    const fpText = footprints.get(fpId);
    if (!fpText) {
      missing++;
      comps.push(comp);
      continue;
    }
    if (!fpCache.has(fpId)) fpCache.set(fpId, parseRecords(fpText).filter((x) => x.type === 'PAD'));
    const nets = padNets.get(r.id) ?? new Map<string, string>();
    for (const pr of fpCache.get(fpId)!) {
      const pad = buildPad(pr, xf, nets.get(str(pr.num)) ?? str(pr.netName), copperIds, r.id);
      pad.componentId = r.id;
      pads.push(pad);
      comp.padIds.push(pad.id);
    }
    comps.push(comp);
  }
  if (missing) warnings.push(`${missing} component(s) without footprint data: their pads (and decap candidates) are missing. Load the .epro to include footprints.`);
  return comps;
}
