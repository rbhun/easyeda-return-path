import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arcPoints, difference, geodesic, rect } from '../src/index.js';

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
