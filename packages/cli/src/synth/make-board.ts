// Synthetic EasyEDA Pro test boards (no real export was available).
//
// 4 layers: Top (signal) / Inner1 (GND plane) / Inner2 (GND | 3V3 split plane) / Bottom (signal).
// Net CLK runs U1 → Top → V1 → Bottom → V2 → Top → U2:
//   - Top segment crosses a 1.5 mm slot (keepout REGION) in the Inner1 GND plane.
//   - V1 changes reference GND(In1) → GND(In2): needs a nearby GND stitching via.
//   - Bottom segment crosses the GND | 3V3 split on Inner2.
//   - V2 changes reference 3V3(In2) → GND(In1): needs a nearby decap.
//   - Last Top segment runs close to a plane cut-out (partial ±3h coverage).
// The "fixed" variant shortens the slot, moves the stitching via and decap closer, removes the
// cut-out and adds a stitching cap across the split.
//
// Usage: tsx src/synth/make-board.ts [outDir]

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { ARRAY_FIELDS } from '../easyeda/records.js';
import { MIL } from '../easyeda/parse.js';

export type Payload = Record<string, unknown>;
export interface Line {
  type: string;
  id: string | number;
  payload: Payload;
}

export const m = (mm: number) => Math.round((mm / MIL) * 1000) / 1000;
export const rectPoly = (x0: number, y0: number, x1: number, y1: number) => [m(x0), m(y0), 'L', m(x1), m(y0), m(x1), m(y1), m(x0), m(y1)];

export function serialize(lines: Line[], form: 'object' | 'array', docType: string): string {
  if (form === 'object') {
    const head = `{"type":"DOCHEAD"}||${JSON.stringify({ docType, client: 'synthetic' })}|`;
    return [head, ...lines.map((l) => `${JSON.stringify({ type: l.type, id: l.id, ticket: 1 })}||${JSON.stringify(l.payload)}|`)].join('\n') + '\n';
  }
  const out = [JSON.stringify(['DOCTYPE', docType, '1.1']), JSON.stringify(['HEAD', { editorVersion: 'synthetic' }])];
  for (const l of lines) {
    if (l.type === 'ATTR') {
      const p = l.payload;
      out.push(JSON.stringify(['ATTR', l.id, 0, p.parentId, p.layerId, null, null, p.key, p.value, 0, 0]));
      continue;
    }
    const fields = ARRAY_FIELDS[l.type];
    if (!fields) continue;
    out.push(JSON.stringify([l.type, ...fields.map((f) => (f === 'id' ? l.id : (l.payload[f] ?? null)))]));
  }
  return out.join('\n') + '\n';
}

export interface FootprintPad {
  num: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Plated hole diameter, mm: a round through-hole pad on the multi-layer. */
  hole?: number;
}

export function footprint(uuid: string, pads: FootprintPad[], form: 'object' | 'array'): string {
  const lines: Line[] = pads.map((p, i) => ({
    type: 'PAD',
    id: `e${i + 1}`,
    payload: p.hole
      ? { groupId: 0, netName: '', layerId: 12, num: p.num, centerX: m(p.x), centerY: m(p.y), padAngle: 0, hole: ['ROUND', m(p.hole), m(p.hole)], defaultPad: ['ELLIPSE', m(p.w), m(p.h)], specialPad: [], padOffsetX: 0, padOffsetY: 0, relativeAngle: 0, plated: 1 }
      : { groupId: 0, netName: '', layerId: 1, num: p.num, centerX: m(p.x), centerY: m(p.y), padAngle: 0, hole: null, defaultPad: ['RECT', m(p.w), m(p.h), 0], specialPad: [], padOffsetX: 0, padOffsetY: 0, relativeAngle: 0, plated: 1 },
  }));
  return serialize(lines, form, 'FOOTPRINT').replace('"docType":"FOOTPRINT"', `"docType":"FOOTPRINT","uuid":"${uuid}"`);
}

export function buildBoard(variant: 'demo' | 'fixed'): { pcb: Line[]; fps: Record<string, FootprintPad[]> } {
  const L: Line[] = [];
  let n = 0;
  const id = () => `e${++n}`;
  const push = (type: string, payload: Payload, rid: string | number = id()) => L.push({ type, id: rid, payload });

  push('CANVAS', { originX: 0, originY: 0, unit: 'mm' }, '');
  const layers: [number, string, string][] = [
    [1, 'TOP', 'Top Layer'],
    [2, 'BOTTOM', 'Bottom Layer'],
    [3, 'TOP_SILK', 'Top Silkscreen Layer'],
    [11, 'OUTLINE', 'Board Outline Layer'],
    [12, 'MULTI', 'Multi-Layer'],
    [13, 'DOCUMENT', 'Document Layer'],
    [50, 'SUBSTRATE', 'Dielectric1'],
    [15, 'SIGNAL', 'Inner1'],
    [51, 'SUBSTRATE', 'Dielectric2'],
    [16, 'SIGNAL', 'Inner2'],
    [52, 'SUBSTRATE', 'Dielectric3'],
  ];
  for (const [lid, type, name] of layers) push('LAYER', { layerType: type, layerName: name, status: 3 }, lid);
  // JLC04161H-7628-like stack, thickness in mm.
  for (const lid of [1, 15, 16, 2]) push('LAYER_PHYS', { material: 'COPPER', thickness: 1, permittivity: 0, lossTangent: 0 }, lid);
  push('LAYER_PHYS', { material: 'PP', thickness: 0.2104, permittivity: 4.4, lossTangent: 0.02 }, 50);
  push('LAYER_PHYS', { material: 'CORE', thickness: 1.065, permittivity: 4.6, lossTangent: 0.02 }, 51);
  push('LAYER_PHYS', { material: 'PP', thickness: 0.2104, permittivity: 4.4, lossTangent: 0.02 }, 52);

  push('NET', { netType: 'High Speed' }, 'CLK');
  push('NET', { netType: 'Power' }, 'GND');
  push('NET', { netType: 'Power' }, '3V3');

  push('POLY', { groupId: 0, netName: '', layerId: 11, width: m(0.15), path: rectPoly(0, 0, 60, 40) });

  // Planes.
  push('POUR', { groupId: 0, netName: 'GND', layerId: 15, width: m(0.25), name: 'In1 GND', order: 1, path: [rectPoly(0.3, 0.3, 59.7, 39.7)], pourType: ['SOLID', 0], keepIsland: 0 });
  const slotBottom = variant === 'demo' ? 12 : 24;
  push('REGION', { groupId: 0, layerId: 15, width: 0, prohibitType: [7], path: [rectPoly(20, slotBottom, 21.5, 40)], name: 'slot' });
  if (variant === 'demo') push('REGION', { groupId: 0, layerId: 15, width: 0, prohibitType: [7], path: [rectPoly(45, 20.35, 56, 26)], name: 'cut-out' });
  push('POUR', { groupId: 0, netName: 'GND', layerId: 16, width: m(0.25), name: 'In2 GND', order: 1, path: [rectPoly(0.3, 0.3, 33.75, 39.7)], pourType: ['SOLID', 0], keepIsland: 0 });
  push('POUR', { groupId: 0, netName: '3V3', layerId: 16, width: m(0.25), name: 'In2 3V3', order: 2, path: [rectPoly(34.25, 0.3, 59.7, 39.7)], pourType: ['SOLID', 0], keepIsland: 0 });

  // Components (footprint uuid in the Footprint attribute, pad nets in PAD_NET).
  const comps: [string, string, number, number, number, Record<string, string>][] = [
    ['U1', 'fp-ic3', 8, 20, 0, { '1': 'CLK', '2': 'GND', '3': '3V3' }],
    ['U2', 'fp-ic3', 52, 20, 180, { '1': 'CLK', '2': 'GND', '3': '3V3' }],
    ['C1', 'fp-c0402', 8, 24, 0, { '1': '3V3', '2': 'GND' }],
    variant === 'demo' ? ['C2', 'fp-c0402', 47.5, 4.5, 0, { '1': '3V3', '2': 'GND' }] : ['C2', 'fp-c0402', 45.6, 9.2, 0, { '1': '3V3', '2': 'GND' }],
  ];
  if (variant === 'fixed') comps.push(['C3', 'fp-c0402', 34, 10.2, 180, { '1': '3V3', '2': 'GND' }]);
  for (const [des, fp, x, y, angle, nets] of comps) {
    const cid = id();
    push('COMPONENT', { groupId: 0, layerId: 1, positionX: m(x), positionY: m(y), angle, attrs: {} }, cid);
    push('ATTR', { parentId: cid, layerId: 3, key: 'Designator', value: des });
    push('ATTR', { parentId: cid, layerId: 3, key: 'Footprint', value: fp });
    for (const [num, net] of Object.entries(nets)) push('PAD_NET', { padNum: num, padNet: net, padId: '' }, cid);
  }

  const via = (net: string, x: number, y: number, stitching = 0) =>
    push('VIA', { groupId: 0, netName: net, ruleName: '', centerX: m(x), centerY: m(y), holeDiameter: m(0.3), viaDiameter: m(0.6), viaType: stitching });
  const track = (net: string, layer: number, pts: [number, number][], w = 0.2) => {
    for (let i = 1; i < pts.length; i++)
      push('LINE', { groupId: 0, netName: net, layerId: layer, startX: m(pts[i - 1][0]), startY: m(pts[i - 1][1]), endX: m(pts[i][0]), endY: m(pts[i][1]), width: m(w) });
  };

  // CLK.
  track('CLK', 1, [[9.5, 20], [30, 20]]);
  via('CLK', 30, 20);
  track('CLK', 2, [[30, 20], [30, 8], [44, 8]]);
  via('CLK', 44, 8);
  track('CLK', 1, [[44, 8], [44, 20], [50.5, 20]]);

  // Power fan-out vias next to SMD pads.
  const fanout: [string, [number, number], [number, number]][] = [
    ['GND', [6.5, 19], [5.2, 19]],
    ['3V3', [6.5, 21], [5.2, 21]],
    ['GND', [53.5, 21], [54.8, 21]],
    ['3V3', [53.5, 19], [54.8, 19]],
    ['3V3', [7.5, 24], [7.5, 25.2]],
    ['GND', [8.5, 24], [8.5, 25.2]],
  ];
  if (variant === 'demo') fanout.push(['3V3', [47, 4.5], [47, 3.3]], ['GND', [48, 4.5], [48, 3.3]]);
  else fanout.push(['3V3', [45.1, 9.2], [45.1, 10.4]], ['GND', [46.1, 9.2], [46.1, 10.4]], ['3V3', [34.5, 10.2], [34.5, 11.4]], ['GND', [33.5, 10.2], [33.5, 11.4]]);
  for (const [net, pad, v] of fanout) {
    track(net, 1, [pad, v], 0.3);
    via(net, v[0], v[1]);
  }

  // GND stitching.
  const stitch: [number, number][] = [[3, 3], [57, 3], [3, 37], [57, 37], [25, 35], [15, 5]];
  stitch.push(variant === 'demo' ? [32.2, 21.5] : [30.9, 20.7]);
  for (const [x, y] of stitch) via('GND', x, y, 1);

  return {
    pcb: L,
    fps: {
      'fp-ic3': [
        { num: '1', x: 1.5, y: 0, w: 1.0, h: 0.6 },
        { num: '2', x: -1.5, y: -1, w: 1.0, h: 0.6 },
        { num: '3', x: -1.5, y: 1, w: 1.0, h: 0.6 },
      ],
      'fp-c0402': [
        { num: '1', x: -0.5, y: 0, w: 0.6, h: 0.6 },
        { num: '2', x: 0.5, y: 0, w: 0.6, h: 0.6 },
      ],
    },
  };
}

export function buildEpro(variant: 'demo' | 'fixed', form: 'object' | 'array'): Uint8Array {
  const { pcb, fps } = buildBoard(variant);
  return packEpro(`${variant} 4-layer`, pcb, fps, form);
}

export function packEpro(title: string, pcb: Line[], fps: Record<string, FootprintPad[]>, form: 'object' | 'array'): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'project.json': strToU8(JSON.stringify({ pcbs: { 'pcb-1': { title } }, footprints: Object.fromEntries(Object.keys(fps).map((k) => [k, { title: k }])) }, null, 2)),
    'PCB/pcb-1.epcb': strToU8(serialize(pcb, form, 'PCB')),
  };
  for (const [uuid, pads] of Object.entries(fps)) files[`FOOTPRINT/${uuid}.efoo`] = strToU8(footprint(uuid, pads, form));
  return zipSync(files);
}

if (process.argv[1]?.endsWith('make-board.ts')) {
  const out = process.argv[2] ?? 'examples';
  mkdirSync(out, { recursive: true });
  const write = (name: string, data: Uint8Array) => {
    writeFileSync(join(out, name), data);
    console.log(`wrote ${join(out, name)}`);
  };
  write('demo-4layer.epro', buildEpro('demo', 'object'));
  write('demo-4layer-array.epro', buildEpro('demo', 'array'));
  write('fixed-4layer.epro', buildEpro('fixed', 'object'));
  writeFileSync(join(out, 'demo-4layer.epcb'), serialize(buildBoard('demo').pcb, 'object', 'PCB'));
  console.log(`wrote ${join(out, 'demo-4layer.epcb')} (PCB document only, readable)`);
}
