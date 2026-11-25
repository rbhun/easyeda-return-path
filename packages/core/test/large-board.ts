// A power-net-sized synthetic board in the core model, as the EasyEDA API serves it (computed fills):
// 100 × 80 mm, 4 layers, a GND plane on Inner1 riddled with antipads and cut by slots, and a net
// with hundreds of track segments and vias meandering over it.
import { circle, difference, rect, type Board, type Pad, type Track, type Via } from '../src/index.js';

export function largeBoard(net = 'BIGNET', segments = 600): Board {
  const W = 100;
  const H = 80;
  const copper = [
    { id: 1, name: 'Top', index: 0, z: 0, thicknessMm: 0.035 },
    { id: 15, name: 'Inner1', index: 1, z: 0.2, thicknessMm: 0.0175 },
    { id: 16, name: 'Inner2', index: 2, z: 1.3, thicknessMm: 0.0175 },
    { id: 2, name: 'Bottom', index: 3, z: 1.5, thicknessMm: 0.035 },
  ];
  const dielectrics = [{ name: 'pp', thicknessMm: 0.2 }, { name: 'core', thicknessMm: 1.1 }, { name: 'pp', thicknessMm: 0.2 }];

  const vias: Via[] = [];
  const tracks: Track[] = [];
  // Meander: rows across the board, joined at the ends.
  const rows = Math.max(2, Math.round(Math.sqrt(segments / 4)));
  const perRow = Math.max(1, Math.floor(segments / rows));
  let k = 0;
  for (let r = 0; r < rows; r++) {
    const y = 4 + ((H - 8) * r) / (rows - 1);
    for (let i = 0; i < perRow; i++) {
      const x0 = 4 + ((W - 8) * i) / perRow;
      const x1 = 4 + ((W - 8) * (i + 1)) / perRow;
      const [a, b] = r % 2 ? [x1, x0] : [x0, x1];
      tracks.push({ id: `t${k++}`, net, layer: 1, a: { x: a, y }, b: { x: b, y }, width: 0.3 });
    }
    if (r + 1 < rows) {
      const x = r % 2 ? 4 : W - 4;
      tracks.push({ id: `t${k++}`, net, layer: 1, a: { x, y }, b: { x, y: 4 + ((H - 8) * (r + 1)) / (rows - 1) }, width: 0.3 });
    }
  }
  for (let i = 0; i < 120; i++) vias.push({ id: `v${i}`, net, at: { x: 6 + ((i * 37) % 88), y: 6 + ((i * 53) % 68) }, drill: 0.3, diameter: 0.6, stitching: false });
  for (let i = 0; i < 300; i++) vias.push({ id: `g${i}`, net: 'GND', at: { x: 3 + ((i * 41) % 94), y: 3 + ((i * 29) % 74) + 0.5 }, drill: 0.3, diameter: 0.6, stitching: true });

  // Plane: board minus antipads (other-net vias and THT pins) minus slots.
  const holes = [
    ...vias.filter((v) => v.net !== 'GND').map((v) => circle(v.at, 0.6, 24)),
    ...Array.from({ length: 160 }, (_, i) => circle({ x: 5 + ((i * 13) % 90) + 0.3, y: 5 + ((i * 7) % 70) + 0.3 }, 0.9, 32)),
  ];
  const slots = Array.from({ length: 8 }, (_, i) => rect(10 + i * 11, i % 2 ? 50 : 30, 1.2, 50));
  const plane = difference([rect(W / 2, H / 2, W - 0.6, H - 0.6)], [...holes, ...slots]);
  const pads: Pad[] = [];
  return {
    outline: [rect(W / 2, H / 2, W, H)],
    stackup: { copper, dielectrics },
    nets: [net, 'GND'],
    tracks,
    vias,
    pads,
    components: [],
    pours: [{ id: 'gnd', net: 'GND', layer: 15, name: 'GND', priority: 0, outline: [rect(W / 2, H / 2, W, H)], poured: plane }],
    keepouts: [],
    warnings: [],
  };
}
