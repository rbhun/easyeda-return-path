import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeNet, circle, difference, distPointSeg, pointInPaths, rect, strokePath, union, type Board, type Track } from '../src/index.js';

// 2-layer, 40 × 20 mm. SIG runs on Bottom through a GND pour with 0.3 mm clearance, except around a
// meander (x 15–16.5), where the pour keeps 0.85 mm or more away; a Top GND pour (x < 29.5) lies under the meander,
// with a GND via beside it. SIG ends on a via at x = 38 and goes on as a short Top track, over no Top pour.
function meanderBoard(): Board {
  const TOP = 1;
  const BOTTOM = 2;
  const path: [number, number][] = [[2, 10], [15, 10], [15, 10.6], [15.5, 10.6], [15.5, 10], [16, 10], [16, 10.6], [16.5, 10.6], [16.5, 10], [38, 10]];
  const tracks: Track[] = path.slice(1).map((p, i) => ({ id: `b${i}`, net: 'SIG', layer: BOTTOM, a: { x: path[i][0], y: path[i][1] }, b: { x: p[0], y: p[1] }, width: 0.2 }));
  tracks.push({ id: 't0', net: 'SIG', layer: TOP, a: { x: 38, y: 10 }, b: { x: 38, y: 16 }, width: 0.2 });
  const pts = path.map(([x, y]) => ({ x, y }));
  const bottomPour = difference([rect(20, 10, 39.4, 19.4)], union(strokePath(pts, 2 * (0.1 + 0.3)), [rect(15.75, 10.3, 3.2, 2.4)], [circle({ x: 38, y: 10 }, 0.6)]));
  return {
    outline: [rect(20, 10, 40, 20)],
    stackup: {
      copper: [
        { id: TOP, name: 'Top Layer', index: 0, z: 0, thicknessMm: 0.035 },
        { id: BOTTOM, name: 'Bottom Layer', index: 1, z: 1.5, thicknessMm: 0.035 },
      ],
      dielectrics: [{ name: 'core', thicknessMm: 1.5 }],
    },
    nets: ['SIG', 'GND'],
    tracks,
    vias: [
      { id: 'v1', net: 'SIG', at: { x: 38, y: 10 }, drill: 0.3, diameter: 0.6, stitching: false },
      { id: 'g1', net: 'GND', at: { x: 15.75, y: 12.3 }, drill: 0.3, diameter: 0.6, stitching: true },
    ],
    pads: [],
    components: [],
    pours: [
      { id: 'pb', net: 'GND', layer: BOTTOM, name: 'Bottom GND', priority: 1, outline: [rect(20, 10, 39.4, 19.4)], poured: bottomPour },
      { id: 'pt', net: 'GND', layer: TOP, name: 'Top GND', priority: 1, outline: [rect(15, 10, 29, 19.4)], poured: [rect(15, 10, 29, 19.4)] },
    ],
    keepouts: [],
    warnings: [],
  };
}

test('a short meander is followed, and a layer change can only be the ground via beside it', () => {
  const an = analyzeNet(meanderBoard(), 'SIG');
  const bottom = an.chains.filter((c) => c.chain.layer === 2);
  assert.deepEqual(bottom.map((c) => [c.ref?.layer, !!c.ref?.coplanar]), [[2, true], [1, false], [2, true]], 'pour beside, Top plane under the meander, pour beside');
  const meander = bottom[1];
  assert.ok(meander.chain.pts.every((p) => p.x > 14 && p.x < 17.5), 'the plane stretch is the meander');
  // The bumps are 0.6 mm on a 1.5 mm board. Following them costs less than cutting across, and less than a
  // via up to the plane and back, so the return stays on one layer and takes the meander's course.
  const pts = an.returnPath.traces.flatMap((t) => t.pts);
  const xs = pts.map((p) => p.x);
  assert.ok(Math.min(...xs) < 5 && Math.max(...xs) > 35, 'one return along the whole trace');
  assert.ok(pts.some((p) => p.x > 15 && p.x < 16.5 && p.y > 10.4), 'follows the meander instead of cutting across it');
  for (const v of an.returnPath.transitions)
    assert.ok(Math.hypot(v.at.x - 15.75, v.at.y - 12.3) < 1, `a layer change is the ground via beside the meander, not (${v.at.x.toFixed(2)}, ${v.at.y.toFixed(2)})`);
});

test('a via between a coplanar stretch and a stretch over the same pour is no change of reference', () => {
  const an = analyzeNet(meanderBoard(), 'SIG');
  const top = an.chains.find((c) => c.chain.layer === 1)!;
  assert.equal(top.ref?.layer, 2, 'the Top track returns in the Bottom pour under it');
  assert.ok(!an.findings.some((f) => f.kind === 'via-return'), an.findings.map((f) => f.message).join('\n'));
  assert.equal(an.vias[0].transitions[0].kind, 'shared-plane');
});

/** Every drawn return point lies in reference copper of its layer and on no track of another net there. */
function assertInCopper(board: Board, net: string) {
  const an = analyzeNet(board, net);
  assert.ok(an.returnPath.traces.length > 0, 'a return is drawn');
  for (const t of an.returnPath.traces) {
    const copper = [...an.refCopper.get(t.layer)!.byNet.values()];
    for (const [i, b] of t.pts.entries()) {
      const a = t.pts[Math.max(0, i - 1)];
      for (const f of [0.25, 0.5, 0.75, 1]) {
        const p = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
        assert.ok(copper.some((c) => pointInPaths(p, c)), `return point (${p.x.toFixed(2)}, ${p.y.toFixed(2)}) on layer ${t.layer} is outside reference copper`);
        const on = board.tracks.find((tr) => tr.layer === t.layer && tr.net !== 'GND' && distPointSeg(p, tr.a, tr.b) <= tr.width / 2);
        assert.ok(!on, `return point (${p.x.toFixed(2)}, ${p.y.toFixed(2)}) lies on ${on?.net}`);
      }
    }
  }
  return an;
}

test('the drawn return stays in reference copper and off other traces', () => {
  assertInCopper(meanderBoard(), 'SIG');
});

test('a pour beyond a neighbouring trace is still the nearest return copper: the return runs in it, beyond the neighbour', () => {
  // SIG on Bottom at y = 10 with NEIGH 0.35 mm beside it; the Bottom GND pour starts past NEIGH, within
  // the coplanar distance of SIG but behind NEIGH. A Top GND plane covers the board.
  const board = meanderBoard();
  board.tracks = [
    { id: 's', net: 'SIG', layer: 2, a: { x: 2, y: 10 }, b: { x: 38, y: 10 }, width: 0.2 },
    { id: 'n', net: 'NEIGH', layer: 2, a: { x: 1, y: 10.35 }, b: { x: 39, y: 10.35 }, width: 0.2 },
  ];
  board.vias = [];
  board.nets = ['SIG', 'NEIGH', 'GND'];
  const pour = rect(20, 15.3, 39.4, 9.4);
  board.pours = [
    { id: 'pb', net: 'GND', layer: 2, name: 'Bottom GND', priority: 1, outline: [pour], poured: [pour] },
    { id: 'pt', net: 'GND', layer: 1, name: 'Top GND', priority: 1, outline: [rect(20, 10, 39.4, 19.4)], poured: [rect(20, 10, 39.4, 19.4)] },
  ];
  const an = assertInCopper(board, 'SIG');
  assert.deepEqual(an.chains.map((c) => [c.ref?.layer, !!c.ref?.coplanar]), [[2, true]]);
  // The solid plane under the trace is a nearer return than the pour behind NEIGH, and it needs no via.
  assert.ok(an.returnPath.traces.length && an.returnPath.traces.every((t) => t.layer === 1 && t.pts.every((p) => Math.abs(p.y - 10) < 0.5)), 'drawn on the plane under the trace');
});

test('a connector pin the trace passes through closes the loop through its own ground pin', () => {
  // SIG runs through J1 pad 1 at x = 10 on its way to the via (a pull-up beyond the pin, say); J1 pad 2 is GND.
  const board = meanderBoard();
  board.components = [{ id: 'j1', designator: 'J1', at: { x: 10, y: 11 }, rotation: 0, layer: 2, padIds: ['p1', 'p2'] }];
  board.pads = [
    { id: 'p1', net: 'SIG', layer: 2, number: '1', at: { x: 10, y: 10 }, shape: [rect(10, 10, 0.6, 0.6)], holeDiameter: 0, componentId: 'j1' },
    { id: 'p2', net: 'GND', layer: 2, number: '2', at: { x: 10, y: 12 }, shape: [rect(10, 12, 0.6, 0.6)], holeDiameter: 0, componentId: 'j1' },
  ];
  const an = analyzeNet(board, 'SIG', { drivers: ['J1'] });
  const pin = an.returnPath.jumps.find((j) => j.kind === 'pin' && j.label === 'J1.2');
  assert.ok(pin, an.returnPath.jumps.map((j) => `${j.kind} ${j.label}`).join(', '));
  assert.deepEqual([pin.from, pin.to], [{ x: 10, y: 12 }, { x: 10, y: 12 }], 'the return runs into the ground pin: only the pin is marked');
  const nearPin = (p: { x: number; y: number }) => Math.hypot(p.x - 10, p.y - 12) < 0.4;
  assert.ok(an.returnPath.traces.some((t) => t.pts.some(nearPin)), 'the return runs into the ground pin');
  const xs = an.returnPath.traces.flatMap((t) => t.pts.map((p) => p.x));
  assert.ok(Math.min(...xs) < 8 || Math.max(...xs) > 12, 'and follows the trace away from the pin');
  assert.ok(!an.findings.some((f) => f.kind === 'driver-loop' && /not at an end/.test(f.message)), 'J1 can be the driver');
});

test('an enable pin tied to ground does not take the return; the named ground pin does', () => {
  // SD sits closer to the signal pad than GND. The return still enters GND, and says so.
  const board = meanderBoard();
  board.components = [{ id: 'u1', designator: 'U1', at: { x: 10, y: 11 }, rotation: 0, layer: 2, padIds: ['p1', 'sd', 'gnd'] }];
  board.pads = [
    { id: 'p1', net: 'SIG', layer: 2, number: '1', pinName: 'SD0', at: { x: 10, y: 10 }, shape: [rect(10, 10, 0.6, 0.6)], holeDiameter: 0, componentId: 'u1' },
    { id: 'sd', net: 'GND', layer: 2, number: '7', pinName: 'SD', at: { x: 10, y: 11.2 }, shape: [rect(10, 11.2, 0.6, 0.6)], holeDiameter: 0, componentId: 'u1' },
    { id: 'gnd', net: 'GND', layer: 2, number: '11', pinName: 'GND', at: { x: 10, y: 13.2 }, shape: [rect(10, 13.2, 0.6, 0.6)], holeDiameter: 0, componentId: 'u1' },
  ];
  const an = analyzeNet(board, 'SIG');
  const pin = an.returnPath.jumps.find((j) => j.kind === 'pin');
  assert.equal(pin?.label, 'U1.11', an.returnPath.jumps.map((j) => `${j.kind} ${j.label}`).join(', '));
  assert.ok(an.returnPath.traces.some((t) => t.pts.some((p) => Math.hypot(p.x - 10, p.y - 13.2) < 0.45)), 'the return runs into the GND pin');
  assert.ok(!an.returnPath.traces.some((t) => t.pts.some((p) => Math.hypot(p.x - 10, p.y - 11.2) < 0.3)), 'the return does not enter the SD pin');
  assert.ok(an.findings.some((f) => /SD is tied to GND but does not take the return/.test(f.message)), an.findings.map((f) => f.message).join('\n'));
});

test('a ground pad with a trace across the way in is reached through the copper around that trace', () => {
  // J1's ground pad sits off the trace, and WALL crosses the straight line to it. The pour is open past
  // either end of WALL, so the return goes around WALL and still ends on the pad.
  const board = meanderBoard();
  const wall = rect(10, 11.1, 8, 0.5);
  const bottom = board.pours.find((p) => p.id === 'pb')!;
  bottom.poured = difference(bottom.poured!, [wall]);
  board.tracks.push({ id: 'w', net: 'WALL', layer: 2, a: { x: 6, y: 11.1 }, b: { x: 14, y: 11.1 }, width: 0.4 });
  board.nets = ['SIG', 'WALL', 'GND'];
  board.components = [{ id: 'j1', designator: 'J1', at: { x: 10, y: 11 }, rotation: 0, layer: 2, padIds: ['p1', 'p2'] }];
  board.pads = [
    { id: 'p1', net: 'SIG', layer: 2, number: '1', at: { x: 10, y: 10 }, shape: [rect(10, 10, 0.6, 0.6)], holeDiameter: 0, componentId: 'j1' },
    { id: 'p2', net: 'GND', layer: 2, number: '2', at: { x: 10, y: 12.4 }, shape: [rect(10, 12.4, 0.6, 0.6)], holeDiameter: 0, componentId: 'j1' },
  ];
  const an = analyzeNet(board, 'SIG');
  const pin = an.returnPath.jumps.find((j) => j.kind === 'pin');
  assert.ok(pin && pin.from.x === pin.to.x && pin.from.y === pin.to.y, 'no line through the air to the ground pad');
  const onPad = an.returnPath.traces.some((t) => t.pts.some((p) => Math.hypot(p.x - 10, p.y - 12.4) < 0.45));
  assert.ok(onPad, 'the return runs into the ground pad');
  const wallHit = an.returnPath.traces.some((t) => t.layer === 2 && t.pts.some((p) => Math.abs(p.y - 11.1) <= 0.2 && p.x > 6 && p.x < 14));
  assert.ok(!wallHit, 'the return does not cross WALL');
});
