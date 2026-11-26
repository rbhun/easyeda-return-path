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

test('a meander in a wider pour clearance returns in the plane under it, through the GND via beside it', () => {
  const an = analyzeNet(meanderBoard(), 'SIG');
  const bottom = an.chains.filter((c) => c.chain.layer === 2);
  assert.deepEqual(bottom.map((c) => [c.ref?.layer, !!c.ref?.coplanar]), [[2, true], [1, false], [2, true]], 'pour beside, Top plane under the meander, pour beside');
  const meander = bottom[1];
  assert.ok(meander.chain.pts.every((p) => p.x > 14 && p.x < 17.5), 'the plane stretch is the meander');
  const hops = an.returnPath.jumps.filter((j) => j.kind === 'via');
  assert.equal(hops.length, 2, 'into the plane and back out');
  assert.ok(hops.every((j) => j.to.x === 15.75 && j.to.y === 12.3), 'through the GND via beside the meander');
  // Every return is tagged with its signal trace's layer; on the plane it runs on the trace, in the pour beside it.
  assert.ok(an.returnPath.traces.every((t) => t.signalLayer === (t.pts.every((p) => p.x > 37.5) ? 1 : 2)));
  const onPlane = an.returnPath.traces.filter((t) => t.layer === 1);
  assert.ok(onPlane.length > 0 && onPlane.every((t) => t.pts.every((p) => tracksDist(p) < 0.01)), 'the plane return lies on the meander');
  const beside = an.returnPath.traces.filter((t) => t.layer === 2 && t.pts.every((p) => p.x < 37));
  assert.ok(beside.length > 0 && beside.every((t) => t.pts.every((p) => tracksDist(p) > 0.2)), 'the coplanar return lies beside the trace');
});

test('a via between a coplanar stretch and a stretch over the same pour is no change of reference', () => {
  const an = analyzeNet(meanderBoard(), 'SIG');
  const top = an.chains.find((c) => c.chain.layer === 1)!;
  assert.equal(top.ref?.layer, 2, 'the Top track returns in the Bottom pour under it');
  assert.ok(!an.findings.some((f) => f.kind === 'via-return'), an.findings.map((f) => f.message).join('\n'));
  assert.equal(an.vias[0].transitions[0].kind, 'shared-plane');
});

function tracksDist(p: { x: number; y: number }): number {
  return Math.min(
    ...meanderBoard()
      .tracks.filter((t) => t.layer === 2)
      .map((t) => {
        const [dx, dy] = [t.b.x - t.a.x, t.b.y - t.a.y];
        const k = Math.max(0, Math.min(1, ((p.x - t.a.x) * dx + (p.y - t.a.y) * dy) / (dx * dx + dy * dy)));
        return Math.hypot(p.x - t.a.x - k * dx, p.y - t.a.y - k * dy);
      }),
  );
}

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

test('a pour beyond a neighbouring trace is not a coplanar reference: the return stays in the plane under the trace', () => {
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
  assert.deepEqual(an.chains.map((c) => [c.ref?.layer, !!c.ref?.coplanar]), [[1, false]]);
  assert.ok(an.returnPath.traces.every((t) => t.layer === 1 && t.pts.every((p) => Math.abs(p.y - 10) < 1e-6)), 'drawn under the trace');
});
