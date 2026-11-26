import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arcPoints, area, difference, geodesic, isGroundNet, pairGround, pouredScale, rect, scalePaths, splitIslands, union } from '../src/index.js';

test('arc discretisation keeps radius', () => {
  const pts = arcPoints({ x: 1, y: 0 }, { x: 0, y: 1 }, 90);
  for (const p of pts) assert.ok(Math.abs(Math.hypot(p.x, p.y) - 1) < 1e-9);
  const cw = arcPoints({ x: 1, y: 0 }, { x: 0, y: -1 }, -90);
  assert.ok(cw.every((p) => p.y <= 1e-9));
});

test('geodesic detour goes around the slot end', () => {
  const plane = difference([rect(0, 0, 20, 20)], [rect(0, 4, 1, 12)]); // slot x∈[-0.5,0.5], y∈[-2,10]
  const det = geodesic(plane, { x: -1, y: 5 }, { x: 1, y: 5 }, { minHoleArea: 0.1, window: 3 })!;
  assert.ok(det);
  const expected = Math.hypot(0.5, 7) * 2 + 1;
  assert.ok(Math.abs(det.length - expected) < 0.05, `length ${det.length} vs ${expected}`);
  assert.ok(det.path.every((p) => p.y >= -2.01));

  // Closed slot larger than the initial search window.
  const holed = difference([rect(0, 0, 20, 20)], [rect(0, 0, 1, 8)]);
  const d2 = geodesic(holed, { x: -1, y: 0 }, { x: 1, y: 0 }, { minHoleArea: 0.1, window: 1 })!;
  assert.ok(Math.abs(d2.length - (2 * Math.hypot(0.5, 4) + 1)) < 0.05, `length ${d2.length}`);
});

test('splitIslands puts each hole in its tightest island and stays fast on plane-sized input', () => {
  const sq = (x: number, y: number, s: number, hole = false) => {
    const r = [
      { x, y },
      { x: x + s, y },
      { x: x + s, y: y + s },
      { x, y: y + s },
    ];
    return hole ? r.reverse() : r;
  };
  const paths = [sq(-1, -1, 1000)];
  for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) {
    paths.push(sq(i * 40, j * 40, 30));
    for (let k = 0; k < 9; k++) paths.push(sq(i * 40 + 2 + (k % 3) * 9, j * 40 + 2 + Math.floor(k / 3) * 9, 4, true));
    paths.push(sq(i * 40 + 31, j * 40 + 31, 4, true));
  }
  const t0 = performance.now();
  const groups = splitIslands(paths);
  const ms = performance.now() - t0;
  assert.equal(groups.length, 401);
  assert.equal(groups[0].length, 1 + 400, 'holes between islands belong to the big outline');
  assert.ok(groups.slice(1).every((g) => g.length === 10));
  assert.ok(ms < 500, `${ms} ms`);
});

test('union keeps 0.1 µm precision, like difference and intersect', () => {
  // The two-argument Clipper overload rounded to 0.01 mm; a real pour fill rounded that coarsely made Clipper loop forever.
  const thin = [rect(0, 0, 1, 0.004)];
  assert.ok(Math.abs(area(union(thin)) - 0.004) < 1e-4, String(area(union(thin))));
});

test('pour fills stored in 10 mil units are scaled onto their pour outline', () => {
  const outline = [rect(60, -40, 100, 60)];
  const fill = [rect(60, -40, 98, 58)];
  assert.equal(pouredScale(outline, fill), 1);
  assert.equal(pouredScale(outline, scalePaths(fill, 0.1)), 10);
  assert.equal(pouredScale([], fill), 1);
});

test('nets with a prefix before GND are grounds, and pair with the rail they are named after', () => {
  for (const n of ['48V_PGND', 'ISO_GND', 'GND_ISO', 'AGND', 'GND']) assert.ok(isGroundNet(n), n);
  for (const n of ['48V', '+12V', 'VBUS_RAW']) assert.ok(!isGroundNet(n), n);
  assert.equal(pairGround({ pads: [], pours: [] } as never, '48V', ['GND', '48V_PGND']), '48V_PGND');
  assert.equal(pairGround({ pads: [], pours: [] } as never, '+12V', ['GND', '48V_PGND']), 'GND');
});

test('geodesic: ends on separate islands get no detour; within one island the path is found', () => {
  const region = union([rect(0, 0, 10, 4)], [rect(0, 10, 10, 4)]);
  assert.equal(geodesic(region, { x: 0, y: 1 }, { x: 0, y: 9 }, { minHoleArea: 0.05, window: 5 }), null);
  assert.ok(geodesic(region, { x: -4, y: 1 }, { x: 4, y: -1 }, { minHoleArea: 0.05, window: 5 }), 'within one island the path is found');
});
