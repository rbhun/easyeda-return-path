import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeNet, difference, dist, distPointSeg, pointInPaths, rect, strokePath, type Board, type Pad, type Path, type Pt, type Track } from '../src/index.js';
import { collapseTightHairpins, HAIRPIN_SPAN_MM } from '../src/returncost.js';

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

/** True when a polyline reverses heading within `spanMm` of path length. */
function hasTightHairpin(pts: Pt[], spanMm = HAIRPIN_SPAN_MM): boolean {
  const reverse = -0.5;
  const step = (a: Pt, b: Pt) => {
    const L = dist(a, b);
    return L > 1e-12 ? { x: (b.x - a.x) / L, y: (b.y - a.y) / L } : null;
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const hi = step(pts[i], pts[i + 1]);
    if (!hi) continue;
    let arc = 0;
    for (let j = i + 1; j < pts.length - 1; j++) {
      arc += dist(pts[j], pts[j + 1]);
      if (arc > spanMm) break;
      if (j < i + 2) continue;
      const hj = step(pts[j], pts[j + 1]);
      if (hj && hi.x * hj.x + hi.y * hj.y <= reverse) return true;
    }
  }
  return false;
}

test('collapseTightHairpins removes a 180° spur under 25 mil', () => {
  // Go east, hairpin within ~20 mil, go west a touch, then continue east — different cells in vs out.
  const mil = 0.0254;
  const hairpin: Pt[] = [
    { x: 0, y: 0 },
    { x: 5, y: 0 },
    { x: 5.1, y: 0 },
    { x: 5.1, y: 10 * mil },
    { x: 5.0, y: 10 * mil },
    { x: 4.9, y: 10 * mil },
    { x: 4.9, y: 0 },
    { x: 5.2, y: 0 },
    { x: 10, y: 0 },
  ];
  assert.ok(hasTightHairpin(hairpin), 'fixture itself is a tight hairpin');
  const out = collapseTightHairpins(hairpin);
  assert.ok(!hasTightHairpin(out), 'collapsed path has no tight 180°');
  assert.ok(out[0].x === 0 && out[out.length - 1].x === 10, 'ends preserved');
  assert.ok(out.length < hairpin.length, 'points were dropped');
});

test('collapseTightHairpins keeps a 90° corner and a large U', () => {
  const corner: Pt[] = [
    { x: 0, y: 0 },
    { x: 5, y: 0 },
    { x: 5, y: 5 },
  ];
  assert.equal(collapseTightHairpins(corner).length, corner.length, '90° corner kept');
  const bigU: Pt[] = [
    { x: 0, y: 0 },
    { x: 0, y: 10 },
    { x: 10, y: 10 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
  ];
  const kept = collapseTightHairpins(bigU);
  assert.ok(kept.some((p) => p.y > 9), 'large U top kept');
  assert.equal(kept.length, bigU.length, 'large U not collapsed');
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

test('the return goes around a via hole instead of across it', () => {
  const tracks: Track[] = [{ id: 't', net: 'SIG', layer: TOP, a: { x: 2, y: 10 }, b: { x: 28, y: 10 }, width: 0.2 }];
  const hole = { id: 'hole', net: '3V3', at: { x: 15, y: 10 }, drill: 0.6, diameter: 1.0, stitching: false };
  const an = analyzeNet(
    board(tracks, pour, ends.map((p) => (p.id === 's1' ? { ...p, at: { x: 2, y: 10 } } : p.id === 's2' ? { ...p, at: { x: 28, y: 10 } } : p)), [hole]),
    'SIG',
    { drivers: ['U1'] },
  );
  const pts = an.returnPath.traces.flatMap((t) => t.pts);
  assert.ok(pts.length > 2, 'a return is drawn');
  for (const t of an.returnPath.traces)
    for (let i = 1; i < t.pts.length; i++) {
      const d = distPointSeg(hole.at, t.pts[i - 1], t.pts[i]);
      assert.ok(d >= hole.diameter / 2 - 0.02, `segment passes ${d.toFixed(3)} mm from the via centre`);
    }
});

test('an outline that misses the trace still draws the return', () => {
  const tracks: Track[] = [{ id: 't', net: 'SIG', layer: TOP, a: { x: 2, y: 10 }, b: { x: 28, y: 10 }, width: 0.2 }];
  const b = board(tracks, pour, ends.map((p) => (p.id === 's1' ? { ...p, at: { x: 2, y: 10 } } : p.id === 's2' ? { ...p, at: { x: 28, y: 10 } } : p)));
  // A footprint shape on the outline layer, far from the trace. The real pour is unchanged.
  b.outline = [rect(0, 0, 2, 2)];
  const an = analyzeNet(b, 'SIG', { drivers: ['U1'] });
  assert.ok(an.returnPath.length > 20, `return drawn along the trace, got ${an.returnPath.length.toFixed(1)} mm`);
  assert.ok(!an.findings.some((f) => f.kind === 'return-path'), 'no "ground copper does not join" error');
  const ratios = an.chains.flatMap((c) => c.coverage.map((x) => x.ratio));
  assert.ok(ratios.some((r) => r > 0.5), `coverage measured on the pour, got ${ratios.map((r) => r.toFixed(2)).join(',')}`);
  const h = 1.6;
  assert.ok(pointInPaths({ x: 15, y: 10 + 0.5 * h }, an.chains.flatMap((c) => c.half)), 'the ±h band is not clipped away');
});

test('half the return current is the strip ±h around the trace', () => {
  const tracks: Track[] = [{ id: 't', net: 'SIG', layer: TOP, a: { x: 2, y: 10 }, b: { x: 28, y: 10 }, width: 0.2 }];
  const an = analyzeNet(board(tracks, pour, ends.map((p) => (p.id === 's1' ? { ...p, at: { x: 2, y: 10 } } : p.id === 's2' ? { ...p, at: { x: 28, y: 10 } } : p))), 'SIG', { drivers: ['U1'] });
  const h = 1.6;
  const half = an.chains.flatMap((c) => c.half);
  assert.ok(pointInPaths({ x: 15, y: 10 + 0.5 * h }, half), 'inside ±h');
  assert.ok(!pointInPaths({ x: 15, y: 10 + 1.3 * h }, half), 'outside ±h');
  assert.ok(pointInPaths({ x: 15, y: 10 + 1.3 * h }, an.chains.flatMap((c) => c.band)), 'the ±3h band still reaches there');
});
