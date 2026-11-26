// Synthetic DC test board for the DC return-current milestone (design decision D7).
//
// 4 layers, 50 × 34 mm: Top (rails as tracks) / Inner1 (GND plane) / Inner2 (3V3 plane) / Bottom (GND, right half).
//   J1  USB power input (THT): VBUS, GND.
//   U1  AMS1117-3.3: VBUS in, 3V3 out, GND. Source of 3V3; load of VBUS.
//   U2, U3  3V3 loads with fan-out vias; J2 a 2-pin THT header breaking out 3V3 (a connector acting as a load).
//   C1, C2  decaps across 3V3/GND (block DC, left out of the solve).
// A slot in the Inner1 GND plane (x 22–23 mm, y > 6 mm) leaves a ~5 mm neck at the board's lower edge, so the
// return current from the loads must crowd through it on its way back to U1 and J1: the expected bottleneck.
//
// Usage: tsx src/synth/make-dc-board.ts [outDir]

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { m, packEpro, rectPoly, serialize, type FootprintPad, type Line, type Payload } from './make-board.js';

export function buildDcBoard(): { pcb: Line[]; fps: Record<string, FootprintPad[]> } {
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
    [15, 'SIGNAL', 'Inner1'],
    [51, 'SUBSTRATE', 'Dielectric2'],
    [16, 'SIGNAL', 'Inner2'],
    [52, 'SUBSTRATE', 'Dielectric3'],
  ];
  for (const [lid, type, name] of layers) push('LAYER', { layerType: type, layerName: name, status: 3 }, lid);
  // Copper in oz: 1 oz outer, 0.5 oz inner.
  for (const [lid, oz] of [[1, 1], [15, 0.5], [16, 0.5], [2, 1]]) push('LAYER_PHYS', { material: 'COPPER', thickness: oz, permittivity: 0, lossTangent: 0 }, lid);
  push('LAYER_PHYS', { material: 'PP', thickness: 0.2104, permittivity: 4.4, lossTangent: 0.02 }, 50);
  push('LAYER_PHYS', { material: 'CORE', thickness: 1.065, permittivity: 4.6, lossTangent: 0.02 }, 51);
  push('LAYER_PHYS', { material: 'PP', thickness: 0.2104, permittivity: 4.4, lossTangent: 0.02 }, 52);

  for (const net of ['VBUS', '3V3', 'GND']) push('NET', { netType: 'Power' }, net);
  push('POLY', { groupId: 0, netName: '', layerId: 11, width: m(0.15), path: rectPoly(0, 0, 50, 34) });

  push('POUR', { groupId: 0, netName: 'GND', layerId: 15, width: m(0.25), name: 'In1 GND', order: 1, path: [rectPoly(0.3, 0.3, 49.7, 33.7)], pourType: ['SOLID', 0], keepIsland: 0 });
  push('REGION', { groupId: 0, layerId: 15, width: 0, prohibitType: [7], path: [rectPoly(22, 6, 23, 34)], name: 'slot' });
  push('POUR', { groupId: 0, netName: '3V3', layerId: 16, width: m(0.25), name: 'In2 3V3', order: 1, path: [rectPoly(15, 2, 48, 32)], pourType: ['SOLID', 0], keepIsland: 0 });
  push('POUR', { groupId: 0, netName: 'GND', layerId: 2, width: m(0.25), name: 'Bottom GND', order: 1, path: [rectPoly(24, 0.3, 49.7, 33.7)], pourType: ['SOLID', 0], keepIsland: 0 });

  const comps: [string, string, string, number, number, Record<string, string>][] = [
    ['J1', 'fp-hdr2', 'USB power input', 3, 17, { '1': 'VBUS', '2': 'GND' }],
    ['U1', 'fp-sot223', 'AMS1117-3.3', 12, 17, { '1': 'GND', '2': '3V3', '3': 'VBUS' }],
    ['C1', 'fp-c0402', '10uF', 9, 11, { '1': '3V3', '2': 'GND' }],
    ['U2', 'fp-load2', 'STM32F103C8T6', 30, 9, { '1': '3V3', '2': 'GND' }],
    ['C2', 'fp-c0402', '100nF', 30, 6.5, { '1': '3V3', '2': 'GND' }],
    ['U3', 'fp-load2', 'BME280', 40, 27, { '1': '3V3', '2': 'GND' }],
    ['J2', 'fp-hdr2', 'Header 2P', 46, 10, { '1': '3V3', '2': 'GND' }],
  ];
  for (const [des, fp, name, x, y, nets] of comps) {
    const cid = id();
    push('COMPONENT', { groupId: 0, layerId: 1, positionX: m(x), positionY: m(y), angle: 0, attrs: {} }, cid);
    push('ATTR', { parentId: cid, layerId: 3, key: 'Designator', value: des });
    push('ATTR', { parentId: cid, layerId: 3, key: 'Footprint', value: fp });
    push('ATTR', { parentId: cid, layerId: 3, key: 'Name', value: name });
    for (const [num, net] of Object.entries(nets)) push('PAD_NET', { padNum: num, padNet: net, padId: '' }, cid);
  }

  const via = (net: string, x: number, y: number, stitching = 0) =>
    push('VIA', { groupId: 0, netName: net, ruleName: '', centerX: m(x), centerY: m(y), holeDiameter: m(0.3), viaDiameter: m(0.6), viaType: stitching });
  const track = (net: string, layer: number, pts: [number, number][], w: number) => {
    for (let i = 1; i < pts.length; i++)
      push('LINE', { groupId: 0, netName: net, layerId: layer, startX: m(pts[i - 1][0]), startY: m(pts[i - 1][1]), endX: m(pts[i][0]), endY: m(pts[i][1]), width: m(w) });
  };

  // VBUS: J1.1 → U1.3 on Top.
  track('VBUS', 1, [[3, 18.27], [5, 21], [14.3, 21], [14.3, 17]], 0.6);
  // 3V3: U1.2 → via into the Inner2 plane.
  track('3V3', 1, [[12, 17], [12, 13], [16, 13]], 0.6);
  via('3V3', 16, 13);
  via('3V3', 16.8, 13.6);
  // Fan-outs.
  const fanout: [string, [number, number], [number, number]][] = [
    ['GND', [9.7, 17], [9.7, 14.5]],
    ['3V3', [29, 9], [29, 11]],
    ['GND', [31, 9], [31, 11]],
    ['3V3', [39, 27], [39, 25]],
    ['GND', [41, 27], [41, 25]],
  ];
  for (const [net, pad, v] of fanout) {
    track(net, 1, [pad, v], 0.4);
    via(net, v[0], v[1]);
  }
  // GND stitching.
  for (const [x, y] of [[5, 5], [5, 30], [18, 3], [26, 3], [45, 3], [26, 31], [45, 31], [35, 18]] as [number, number][]) via('GND', x, y, 1);

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
      'fp-c0402': [
        { num: '1', x: -0.5, y: 0, w: 0.6, h: 0.6 },
        { num: '2', x: 0.5, y: 0, w: 0.6, h: 0.6 },
      ],
    },
  };
}

export function buildDcEpro(form: 'object' | 'array' = 'object'): Uint8Array {
  const { pcb, fps } = buildDcBoard();
  return packEpro('dc 4-layer', pcb, fps, form);
}

if (process.argv[1]?.endsWith('make-dc-board.ts')) {
  const out = process.argv[2] ?? 'examples';
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'dc-4layer.epro'), buildDcEpro());
  console.log(`wrote ${join(out, 'dc-4layer.epro')}`);
  writeFileSync(join(out, 'dc-4layer.epcb'), serialize(buildDcBoard().pcb, 'object', 'PCB'));
  console.log(`wrote ${join(out, 'dc-4layer.epcb')} (PCB document only, readable)`);
}
