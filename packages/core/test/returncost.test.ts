import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeNet, difference, dist, rect, strokePath, type Board, type Pad, type Path, type Track } from '../src/index.js';

// Two-layer, h = 1.6 mm. The return is the least loop area, so it follows the trace instead of
// shortcutting, snaps a small gap back onto the trace, and does not change layer through a via
// that has no ground copper on one side.
const TOP = 1;
const BOT = 2;

const pad = (id: string, net: string, at: { x: number; y: number }, comp: string, pin: string, num: string): Pad => ({
  id,
  net,
  layer: TOP,
  number: num,
  at,
  shape: [rect(at.x, at.y, 0.8, 0.8)],
  holeDiameter: 0,
  componentId: comp,
  pinName: pin,
});

function board(tracks: Track[], poured: Path[], pads: Pad[], vias: Board['vias'] = []): Board {
  return {
    outline: [rect(16, 10, 40, 24)],
    stackup: {
      copper: [
        { id: TOP, name: 'Top', index: 0, z: 0, thicknessMm: 0.035 },
        { id: BOT, name: 'Bottom', index: 1, z: 1.6, thicknessMm: 0.035 },
      ],
      dielectrics: [{ name: 'core', thicknessMm: 1.6 }],
    },
    nets: ['SIG', 'GND'],
    tracks,
    vias: [{ id: 'g0', net: 'GND', at: { x: 1, y: 8 }, drill: 0.3, diameter: 0.6, stitching: true }, ...vias],
    pads,
    components: [
      { id: 'u1', designator: 'U1', at: { x: 2, y: 5 }, rotation: 0, layer: TOP, padIds: ['s1', 'g1'] },
      { id: 'u2', designator: 'U2', at: { x: 28, y: 5 }, rotation: 0, layer: TOP, padIds: ['s2'] },
    ],
    pours: [{ id: 'pb', net: 'GND', layer: BOT, name: 'GND', priority: 1, outline: [rect(16, 10, 36, 22)], poured }],
    keepouts: [],
    warnings: [],
  };
}

const ends = [
  pad('s1', 'SIG', { x: 2, y: 5 }, 'u1', 'CS', '1'),
  pad('g1', 'GND', { x: 1, y: 8 }, 'u1', 'GND', '2'),
  pad('s2', 'SIG', { x: 28, y: 5 }, 'u2', 'CS', '1'),
];

const pour = [rect(16, 10, 36, 22)];

test('the return follows a U instead of cutting across its mouth', () => {
  const pts: [number, number][] = [[2, 5], [2, 15], [12, 15], [12, 5], [28, 5]];
  const tracks: Track[] = pts.slice(1).map((p, i) => ({ id: `t${i}`, net: 'SIG', layer: TOP, a: { x: pts[i][0], y: pts[i][1] }, b: { x: p[0], y: p[1] }, width: 0.2 }));
  const an = analyzeNet(board(tracks, pour, ends), 'SIG', { drivers: ['U1'] });
  const line = an.returnPath.traces.flatMap((t) => t.pts);
  assert.ok(line.some((p) => p.y > 14), 'follows the top of the U');
  const len = an.returnPath.length;
  assert.ok(len > 30, `the long way round, not the 26 mm shortcut: ${len.toFixed(1)} mm`);
  assert.ok(an.returnPath.traces.every((t) => t.layer === BOT), 'on the ground pour under the trace');
});

test('a small gap is drawn back on the trace with a minor-cut mark', () => {
  const tracks: Track[] = [{ id: 't', net: 'SIG', layer: TOP, a: { x: 2, y: 10 }, b: { x: 28, y: 10 }, width: 0.2 }];
  const hole = rect(15, 10, 0.4, 1.0);
  const an = analyzeNet(board(tracks, difference(pour, [hole]), ends.map((p) => (p.id === 's1' ? { ...p, at: { x: 2, y: 10 } } : p.id === 's2' ? { ...p, at: { x: 28, y: 10 } } : p))), 'SIG', { drivers: ['U1'] });
  const minor = an.returnPath.marks.filter((m) => m.kind === 'minor');
  assert.ok(minor.length === 1, `one minor cut, got ${an.returnPath.marks.map((m) => m.kind).join(',')}`);
  assert.ok(Math.abs(minor[0].at.x - 15) < 1.5, `mark at the gap, x=${minor[0].at.x}`);
  assert.ok(minor[0].area < 1.6 * 1.6, `area ${minor[0].area} is under h²`);
  const near = an.returnPath.traces.flatMap((t) => t.pts).filter((p) => Math.abs(p.x - 15) < 0.8);
  assert.ok(near.length && near.every((p) => Math.abs(p.y - 10) < 0.2), 'drawn on the trace through the gap');
});

test('a short hop on the other layer does not pull the return through an unconnected via', () => {
  const tracks: Track[] = [
    { id: 'a', net: 'SIG', layer: TOP, a: { x: 2, y: 10 }, b: { x: 10, y: 10 }, width: 0.2 },
    { id: 'b', net: 'SIG', layer: BOT, a: { x: 10, y: 10 }, b: { x: 16, y: 10 }, width: 0.2 },
    { id: 'c', net: 'SIG', layer: TOP, a: { x: 16, y: 10 }, b: { x: 28, y: 10 }, width: 0.2 },
  ];
  // The bottom hop clears its own track. A ground via beside it touches the bottom pour and nothing on top.
  const poured = difference(pour, strokePath([{ x: 10, y: 10 }, { x: 16, y: 10 }], 0.5));
  const via = { id: 'gx', net: 'GND', at: { x: 13, y: 13 }, drill: 0.3, diameter: 0.6, stitching: true };
  const an = analyzeNet(
    board(tracks, poured, ends.map((p) => (p.id === 's1' ? { ...p, at: { x: 2, y: 10 } } : p.id === 's2' ? { ...p, at: { x: 28, y: 10 } } : p)), [via]),
    'SIG',
    { drivers: ['U1'] },
  );
  assert.deepEqual(
    an.returnPath.transitions.map((v) => [v.fromLayer, v.toLayer]),
    [[TOP, BOT]],
    'only the drop from the driver ground pad; the hop does not add one',
  );
  assert.ok(an.returnPath.transitions[0].at.x < 3, 'that via is the driver ground via, not the one beside the hop');
  assert.ok(an.returnPath.traces.filter((t) => t.layer === BOT).length >= 1);
  const xs = an.returnPath.traces.flatMap((t) => t.pts.map((p) => p.x));
  assert.ok(Math.min(...xs) < 4 && Math.max(...xs) > 24, 'one line along the whole trace');
  assert.ok(!an.returnPath.traces.some((t) => t.pts.some((p) => dist(p, via.at) < 0.4)), 'does not dive into the unconnected via');
});
