import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shapeReturns, smoothLine } from '../src/lineshape.js';
import type { Path } from '../src/types.js';

function finish<T extends { layer: number; pts: Path }>(traces: T[]) {
  const g = shapeReturns(traces, () => true);
  let n = g.next();
  while (!n.done) n = g.next();
  return n.value;
}

const everywhere = () => true;

/** Turn, degrees, between the directions 0.25 mm before and after each point of a 0.05 mm resampling. */
function turns(pts: Path): number[] {
  const even: { x: number; y: number }[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 0.05));
    for (let m = 1; m <= n; m++) even.push({ x: a.x + ((b.x - a.x) * m) / n, y: a.y + ((b.y - a.y) * m) / n });
  }
  return even.slice(10, -5).map((m, i) => {
    const [a, c] = [even[i + 5], even[i + 15]];
    const t = Math.atan2(c.y - m.y, c.x - m.x) - Math.atan2(m.y - a.y, m.x - a.x);
    return Math.abs(Math.atan2(Math.sin(t), Math.cos(t))) * (180 / Math.PI);
  });
}

test('smoothing keeps the ends and turns a corner into a bend', () => {
  const pts: Path = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ];
  const s = smoothLine(pts, everywhere, 0.05);
  assert.deepEqual(s[0], pts[0]);
  assert.deepEqual(s[s.length - 1], pts[pts.length - 1]);
  const sharp = Math.max(...turns(s));
  assert.ok(sharp < 45, `sharpest turn ${sharp.toFixed(0)}° over 0.25 mm`);
});

test('a point the smoothing would move off the copper stays on it', () => {
  const pts: Path = [
    { x: 0, y: 0 },
    { x: 5, y: 0 },
    { x: 5, y: 5 },
  ];
  // Copper is the two arms only; the rounding of the corner would cut across y > 0 and x < 5.
  const on = (q: { x: number; y: number }) => q.y <= 0.02 || q.x >= 4.98;
  const s = smoothLine(pts, on, 0.05);
  assert.ok(s.every(on), 'every smoothed point stays on the copper');
  assert.deepEqual(s[0], pts[0]);
  assert.deepEqual(s[s.length - 1], pts[pts.length - 1]);
});

test('two returns that run together are drawn once, and the one that leaves curves on', () => {
  const trunk = { layer: 1, pts: [{ x: 0, y: 0 }, { x: 30, y: 0 }] as Path };
  const branch = { layer: 1, pts: [{ x: 0, y: 0.2 }, { x: 15, y: 0.2 }, { x: 15, y: 8 }] as Path };
  const drawn = finish([branch, trunk]);
  assert.equal(drawn.length, 2);
  const main = drawn.find((t) => t.pts[t.pts.length - 1].x > 25)!;
  const side = drawn.find((t) => t !== main)!;
  assert.ok(Math.abs(main.pts[0].y) < 0.05 && Math.abs(main.pts[main.pts.length - 1].x - 30) < 0.05, 'the longer line is kept whole');
  const start = side.pts[0];
  const gap = Math.abs(start.y);
  assert.ok(gap < 0.25, `the other starts on it (${gap.toFixed(3)} mm off)`);
  const step = side.pts.find((q) => Math.hypot(q.x - start.x, q.y - start.y) > 0.12)!;
  const away = { x: step.x - start.x, y: step.y - start.y };
  const angle = (Math.acos(Math.min(1, Math.abs(away.x) / Math.hypot(away.x, away.y))) * 180) / Math.PI;
  assert.ok(angle < 25, `the first step leaves at ${angle.toFixed(0)}° to the line it joins`);
  assert.ok(Math.max(...turns(side.pts)) < 45, 'the joint is a bend, not a corner');
  assert.ok(side.pts.some((p) => p.y > 7), 'and still reaches its own end');
});

test('two returns that only meet at a point stay separate', () => {
  const a = { layer: 1, pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }] as Path };
  const b = { layer: 1, pts: [{ x: 10, y: 0 }, { x: 10, y: 10 }] as Path };
  const drawn = finish([a, b]);
  assert.equal(drawn.length, 2);
  assert.ok(drawn.some((t) => t.pts[0].x === 0 && t.pts[t.pts.length - 1].x === 10 && t.pts[t.pts.length - 1].y === 0));
  assert.ok(drawn.some((t) => t.pts[0].x === 10 && t.pts[0].y === 0 && t.pts[t.pts.length - 1].y === 10));
});
