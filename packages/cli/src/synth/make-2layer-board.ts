// Synthetic 2-layer test boards: no inner plane, so the return path is either the opposite outer
// layer's pour or a pour on the trace's own layer (coplanar return).
//
// 60 × 40 mm, 1.5 mm FR-4 core, 1 oz copper both sides.
//   J1  USB power input (THT): VBUS, GND.   U1  AMS1117-3.3 → 3V3 on a Top track to U2 and U3.
//   U4 → U5  CLK on Top (y = 10 mm); DATA on Bottom (y = 3.5 mm) through two vias.
//   Bottom: GND pour with a slot (x 40–41.2 mm, from the lower edge to y = 14 mm).
// Variants:
//   coplanar     Top GND pour too, with a keepout break (x 30–31.5, y 7–16) across CLK: CLK and DATA
//                return in the pour beside them; CLK's return detours around the break, DATA's around the slot.
//   bottom-only  No Top pour: CLK returns in the Bottom pour 1.5 mm below and crosses the slot.
//   half-top     Top GND pour only left of x = 30, with a GND via at its edge beside CLK: CLK returns
//                in that pour, then drops through the via to the Bottom pour for the rest of its run.
//
// Usage: tsx src/synth/make-2layer-board.ts [outDir]

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { m, packEpro, rectPoly, serialize, type FootprintPad, type Line, type Payload } from './make-board.js';

export type TwoLayerVariant = 'coplanar' | 'bottom-only' | 'half-top';

export function buildTwoLayerBoard(variant: TwoLayerVariant): { pcb: Line[]; fps: Record<string, FootprintPad[]> } {
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
    [50, 'SUBSTRATE', 'Dielectric1'],
  ];
  for (const [lid, type, name] of layers) push('LAYER', { layerType: type, layerName: name, status: 3 }, lid);
  for (const lid of [1, 2]) push('LAYER_PHYS', { material: 'COPPER', thickness: 1, permittivity: 0, lossTangent: 0 }, lid);
  push('LAYER_PHYS', { material: 'CORE', thickness: 1.5, permittivity: 4.5, lossTangent: 0.02 }, 50);

  for (const net of ['VBUS', '3V3', 'GND']) push('NET', { netType: 'Power' }, net);
  for (const net of ['CLK', 'DATA']) push('NET', { netType: 'Signal' }, net);
  push('POLY', { groupId: 0, netName: '', layerId: 11, width: m(0.15), path: rectPoly(0, 0, 60, 40) });

  const via = (net: string, x: number, y: number, stitching = 0) =>
    push('VIA', { groupId: 0, netName: net, ruleName: '', centerX: m(x), centerY: m(y), holeDiameter: m(0.3), viaDiameter: m(0.6), viaType: stitching });
  push('POUR', { groupId: 0, netName: 'GND', layerId: 2, width: m(0.25), name: 'Bottom GND', order: 1, path: [rectPoly(0.3, 0.3, 59.7, 39.7)], pourType: ['SOLID', 0], keepIsland: 0 });
  push('REGION', { groupId: 0, layerId: 2, width: 0, prohibitType: [7], path: [rectPoly(40, 0, 41.2, 14)], name: 'bottom slot' });
  if (variant === 'coplanar') {
    push('POUR', { groupId: 0, netName: 'GND', layerId: 1, width: m(0.25), name: 'Top GND', order: 1, path: [rectPoly(0.3, 0.3, 59.7, 39.7)], pourType: ['SOLID', 0], keepIsland: 0 });
    push('REGION', { groupId: 0, layerId: 1, width: 0, prohibitType: [7], path: [rectPoly(30, 7, 31.5, 16)], name: 'top break' });
  }
  if (variant === 'half-top') {
    push('POUR', { groupId: 0, netName: 'GND', layerId: 1, width: m(0.25), name: 'Top GND', order: 1, path: [rectPoly(0.3, 0.3, 30, 39.7)], pourType: ['SOLID', 0], keepIsland: 0 });
    via('GND', 29.5, 11.2, 1);
  }

  const comps: [string, string, string, number, number, Record<string, string>][] = [
    ['J1', 'fp-hdr2', 'USB power input', 4, 22, { '1': 'VBUS', '2': 'GND' }],
    ['U1', 'fp-sot223', 'AMS1117-3.3', 14, 22, { '1': 'GND', '2': '3V3', '3': 'VBUS' }],
    ['U2', 'fp-load2', 'STM32F103C8T6', 30, 32, { '1': '3V3', '2': 'GND' }],
    ['U3', 'fp-load2', 'W25Q32', 50, 32, { '1': '3V3', '2': 'GND' }],
    ['U4', 'fp-load2', 'Driver', 10, 6, { '1': 'CLK', '2': 'DATA' }],
    ['U5', 'fp-load2', 'Receiver', 54, 6, { '1': 'CLK', '2': 'DATA' }],
  ];
  for (const [des, fp, name, x, y, nets] of comps) {
    const cid = id();
    push('COMPONENT', { groupId: 0, layerId: 1, positionX: m(x), positionY: m(y), angle: 0, attrs: {} }, cid);
    push('ATTR', { parentId: cid, layerId: 3, key: 'Designator', value: des });
    push('ATTR', { parentId: cid, layerId: 3, key: 'Footprint', value: fp });
    push('ATTR', { parentId: cid, layerId: 3, key: 'Name', value: name });
    for (const [num, net] of Object.entries(nets)) push('PAD_NET', { padNum: num, padNet: net, padId: '' }, cid);
  }

  const track = (net: string, layer: number, pts: [number, number][], w: number) => {
    for (let i = 1; i < pts.length; i++)
      push('LINE', { groupId: 0, netName: net, layerId: layer, startX: m(pts[i - 1][0]), startY: m(pts[i - 1][1]), endX: m(pts[i][0]), endY: m(pts[i][1]), width: m(w) });
  };

  track('VBUS', 1, [[4, 23.27], [6, 26], [16.3, 26], [16.3, 22]], 0.8);
  track('3V3', 1, [[14, 22], [14, 18], [22, 18], [29, 25], [29, 32]], 0.8);
  track('3V3', 1, [[29, 28], [49, 28], [49, 32]], 0.8);
  // GND pads fan out to the Bottom pour.
  for (const [pad, v] of [
    [[11.7, 22], [11.7, 19]],
    [[31, 32], [31, 35]],
    [[51, 32], [51, 35]],
  ] as [number, number][][]) {
    track('GND', 1, [pad as [number, number], v as [number, number]], 0.5);
    via('GND', v[0], v[1]);
  }
  for (const [x, y] of [[3, 3], [3, 37], [20, 37], [57, 37], [57, 20], [36, 20], [20, 13]] as [number, number][]) via('GND', x, y, 1);

  track('CLK', 1, [[9, 6], [9, 10], [53, 10], [53, 6]], 0.25);
  track('DATA', 1, [[11, 6], [11, 3.5]], 0.25);
  via('DATA', 11, 3.5);
  track('DATA', 2, [[11, 3.5], [55, 3.5]], 0.25);
  via('DATA', 55, 3.5);
  track('DATA', 1, [[55, 3.5], [55, 6]], 0.25);

  return {
    pcb: L,
    fps: {
      'fp-hdr2': [
        { num: '1', x: 0, y: 1.27, w: 1.7, h: 1.7, hole: 1.0 },
        { num: '2', x: 0, y: -1.27, w: 1.7, h: 1.7, hole: 1.0 },
      ],
      'fp-sot223': [
        { num: '1', x: -2.3, y: 0, w: 1.0, h: 2.0 },
        { num: '2', x: 0, y: 0, w: 1.0, h: 2.0 },
        { num: '3', x: 2.3, y: 0, w: 1.0, h: 2.0 },
      ],
      'fp-load2': [
        { num: '1', x: -1, y: 0, w: 1.0, h: 1.0 },
        { num: '2', x: 1, y: 0, w: 1.0, h: 1.0 },
      ],
    },
  };
}

export function buildTwoLayerEpro(variant: TwoLayerVariant, form: 'object' | 'array' = 'object'): Uint8Array {
  const { pcb, fps } = buildTwoLayerBoard(variant);
  return packEpro(`2-layer ${variant}`, pcb, fps, form);
}

if (process.argv[1]?.endsWith('make-2layer-board.ts')) {
  const out = process.argv[2] ?? 'examples';
  mkdirSync(out, { recursive: true });
  for (const v of ['coplanar', 'bottom-only', 'half-top'] as const) {
    writeFileSync(join(out, `2layer-${v}.epro`), buildTwoLayerEpro(v));
    writeFileSync(join(out, `2layer-${v}.epcb`), serialize(buildTwoLayerBoard(v).pcb, 'object', 'PCB'));
    console.log(`wrote ${join(out, `2layer-${v}.epro`)} and .epcb`);
  }
}
