import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arcPoints, area, decodeComplex, difference, dropNarrow, geodesic, leastInductancePath, pathInductance, pointInPaths, Polyline, runSync, viaInductance, isGroundNet, pairGround, pouredScale, rect, scalePaths, splitIslands, union } from '../src/index.js';

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

test('dropNarrow removes a hairline strip between two pads of copper and keeps the rest', () => {
  const region = union([rect(0, 0, 4, 4), rect(6, 0, 4, 4), rect(3, -1.9925, 4, 0.015)]);
  assert.equal(splitIslands(region).length, 1);
  const kept = dropNarrow(region, 0.1);
  assert.equal(splitIslands(kept).length, 2);
  assert.ok(Math.abs(area(kept) - 32) < 0.01, `area ${area(kept)}`);
});

test('geodesic with an inset keeps inside the copper; ends at the copper edge step straight in', () => {
  const plane = difference([rect(0, 0, 20, 20)], [rect(0, 4, 1, 12)]); // slot x∈[-0.5,0.5], y∈[-2,10]
  const a = { x: -0.5, y: 5 };
  const b = { x: 0.5, y: 5 };
  const det = geodesic(plane, a, b, { minHoleArea: 0.1, window: 3, inset: 0.1, snapEnds: 0.2 })!;
  assert.ok(det);
  assert.deepEqual(det.path[0], a);
  assert.deepEqual(det.path.at(-1), b);
  const toSlot = (p: { x: number; y: number }) => Math.hypot(Math.max(0, Math.abs(p.x) - 0.5), Math.max(0, -2 - p.y, p.y - 10));
  for (const p of det.path.slice(2, -2)) assert.ok(toSlot(p) >= 0.095, `(${p.x}, ${p.y}) hugs the slot`);
  assert.equal(geodesic(plane, a, b, { minHoleArea: 0.1, window: 3, inset: 0.1 }), null, 'without snapping, ends on the edge have no path');
});

test('the return keeps to copper that carries on: a nearer strip that ends gets no line', () => {
  // Trace along y = 0 from x 0 to 10. Above it a strip 0.3 mm away ends at x 7; below, one 0.4 mm away runs the whole length.
  // The two join only round the start of the trace.
  const inCopper = (p: { x: number; y: number }) =>
    (p.y >= 0.3 && p.y <= 0.8 && p.x >= -1 && p.x <= 7) || (p.y <= -0.4 && p.y >= -0.9 && p.x >= -1 && p.x <= 11) || (p.x >= -1 && p.x <= -0.5 && p.y >= -0.9 && p.y <= 0.8);
  const line = new Polyline([
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ]);
  const path = runSync(leastInductancePath({ inCopper, line, s0: 0, s1: 10, halfWidth: 0.1, h: 0, corridor: 1.5, from: null, to: null }))!;
  assert.ok(path);
  assert.ok(path[path.length - 1].x > 9.5, 'reaches the far end');
  assert.ok(path.filter((p) => p.x > 1).every((p) => p.y < 0), `runs in the strip that carries on: ${JSON.stringify(path)}`);
});

test('loop inductance: a via through a 1.6 mm board is about 1.3 nH; a return further from the trace adds more', () => {
  assert.ok(Math.abs(viaInductance(1.6, 0.3) - 1.3) < 0.05, `${viaInductance(1.6, 0.3)}`);
  const line = new Polyline([
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ]);
  const at = (y: number) => pathInductance([{ x: 0, y }, { x: 10, y }], line, 0.1, 0);
  assert.ok(at(0.3) < at(1) && at(1) < at(3));
  assert.ok(Math.abs(pathInductance([{ x: 0, y: 0 }, { x: 10, y: 0 }], line, 0.1, 1.5) - 10 * 0.2 * Math.log(1 + 225)) < 1e-6);
});

/** EasyEDA single polygon: x y L x y ... closed. Coordinates are already in the test's unit. */
function ringSrc(ring: { x: number; y: number }[]): unknown[] {
  const [first, ...rest] = ring;
  return [first.x, first.y, 'L', ...rest.flatMap((p) => [p.x, p.y]), first.x, first.y];
}

const ident = (x: number, y: number) => ({ x, y });

function sameRegion(a: ReturnType<typeof union>, b: ReturnType<typeof union>, label: string) {
  const sym = area(union(difference(a, b), difference(b, a)));
  assert.ok(sym < 1e-6, `${label} symmetric difference ${sym}`);
}

test('a copper island inside a pour hole stays copper', () => {
  const outline = rect(5, 5, 10, 10);
  const hole = rect(5, 5, 6, 6);
  const island = [...rect(5, 5, 2, 2)].reverse();
  const decoded = decodeComplex([ringSrc(outline), ringSrc(hole), ringSrc(island)], ident, 1);
  assert.ok(pointInPaths({ x: 5, y: 5 }, decoded), 'the island is copper');
  assert.ok(!pointInPaths({ x: 3, y: 5 }, decoded), 'the hole around the island is empty');
  assert.ok(pointInPaths({ x: 1, y: 1 }, decoded), 'the outline is copper');
  assert.ok(Math.abs(area(decoded) - (100 - 36 + 4)) < 1e-4, `area ${area(decoded)}`);
});

test('an outline with two disjoint holes decodes as outline minus those holes', () => {
  const outline = rect(5, 5, 10, 10);
  const holeA = rect(2, 2, 2, 2);
  const holeB = [...rect(8, 8, 2, 2)].reverse();
  const src = [ringSrc(outline), ringSrc(holeA), ringSrc(holeB)];
  const decoded = decodeComplex(src, ident, 1);
  const asHoles = difference(union([outline]), union([holeA, holeB]));
  sameRegion(decoded, asHoles, 'two holes');
  assert.ok(!pointInPaths({ x: 2, y: 2 }, decoded));
  assert.ok(!pointInPaths({ x: 8, y: 8 }, decoded));
  assert.ok(pointInPaths({ x: 5, y: 5 }, decoded));
});

test('a single ring decodes as that ring filled', () => {
  const outline = rect(5, 5, 10, 10);
  const one = decodeComplex(ringSrc(outline), ident, 1);
  const wrapped = decodeComplex([ringSrc(outline)], ident, 1);
  sameRegion(one, union([outline]), 'bare ring');
  sameRegion(wrapped, union([outline]), 'one-ring complex');
});
