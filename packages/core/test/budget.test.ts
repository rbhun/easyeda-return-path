import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalysisAborted, analyzeNet, analyzeNetAsync, hfApplicability, runAsync, type RunOptions } from '../src/index.js';
import { largeBoard } from './large-board.js';

// Longest the host may be blocked between two yields. One slice is 30 ms; single Clipper calls on
// the 100 × 80 mm plane take a few tens of ms, CI machines are slower.
const MAX_BLOCK_MS = 400;

function recorder() {
  const gaps: number[] = [];
  let last = performance.now();
  const opts: RunOptions = {
    sliceMs: 30,
    now: () => performance.now(),
    yieldFn: async () => {
      const t = performance.now();
      gaps.push(t - last);
      await new Promise<void>((r) => setImmediate(r));
      last = performance.now();
    },
  };
  return { gaps, opts, final: () => gaps.push(performance.now() - last) };
}

test('large net: the analysis yields to the host in short slices and finishes', async () => {
  const board = largeBoard('BIGNET', 600);
  const rec = recorder();
  const phases: string[] = [];
  const t0 = performance.now();
  const an = await analyzeNetAsync(board, 'BIGNET', {}, { ...rec.opts, timeBudgetMs: 60_000, onPhase: (p) => phases.push(p) });
  rec.final();
  const total = performance.now() - t0;
  assert.ok(an.stats.segments > 500, `${an.stats.segments} segments`);
  assert.ok(an.findings.some((f) => f.kind === 'slot-crossing'));
  assert.ok(rec.gaps.length > 10, `${rec.gaps.length} yields in ${total.toFixed(0)} ms`);
  const worst = Math.max(...rec.gaps);
  assert.ok(worst < MAX_BLOCK_MS, `blocked the host for ${worst.toFixed(0)} ms`);
  for (const p of ['reference copper', 'chains', 'band coverage', 'sampling', 'detour', 'vias', 'done']) assert.ok(phases.includes(p), `phase ${p}`);
  assert.ok(an.stats.samples <= 40_000 + an.stats.chains * 2);
});

test('large net: the time budget stops the run promptly', async () => {
  const board = largeBoard('BIGNET', 600);
  const rec = recorder();
  const budget = 300;
  const t0 = performance.now();
  await assert.rejects(analyzeNetAsync(board, 'BIGNET', {}, { ...rec.opts, timeBudgetMs: budget }), (e: unknown) => e instanceof AnalysisAborted && e.reason === 'time');
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < budget + MAX_BLOCK_MS, `stopped after ${elapsed.toFixed(0)} ms`);
});

test('large net: cancelling stops at the next slice', async () => {
  const board = largeBoard('BIGNET', 600);
  const signal = { aborted: false };
  const rec = recorder();
  let cancelledAt = 0;
  const run = analyzeNetAsync(board, 'BIGNET', {}, {
    ...rec.opts,
    signal,
    onProgress: (t) => {
      if (t.phase === 'sampling' && !signal.aborted) {
        signal.aborted = true;
        cancelledAt = performance.now();
      }
    },
  });
  await assert.rejects(run, (e: unknown) => e instanceof AnalysisAborted && e.reason === 'cancelled');
  assert.ok(performance.now() - cancelledAt < MAX_BLOCK_MS);
});

test('complexity limits refuse oversized nets before doing any work', () => {
  const board = largeBoard('BIGNET', 600);
  assert.throws(() => analyzeNet(board, 'BIGNET', { maxSegments: 100 }), (e: unknown) => e instanceof AnalysisAborted && e.reason === 'complexity' && /track segments/.test(e.message));
  assert.throws(() => analyzeNet(board, 'BIGNET', { maxRefVertices: 1000 }), (e: unknown) => e instanceof AnalysisAborted && e.reason === 'complexity');
  const an = analyzeNet(largeBoard('BIGNET', 40), 'BIGNET', { maxDetourNodes: 10 });
  assert.ok(an.stats.detoursTooComplex > 0);
  assert.ok(an.findings.some((f) => f.severity === 'warn' && /too complex/.test(f.message)));
});

test('high-frequency check: power, ground and plane nets are refused with a hint', () => {
  const board = largeBoard('3V3', 20);
  for (const net of ['GND', 'AGND', '3V3', '+5V', 'VBUS']) {
    const s = hfApplicability(board, net);
    assert.equal(s.ok, false, net);
    assert.match(s.message!, /DC Return Current/);
  }
  assert.equal(hfApplicability({ ...board, pours: [{ ...board.pours[0], net: 'SHIELD' }] }, 'SHIELD').kind, 'plane');
  assert.equal(hfApplicability(board, 'CLK').ok, true);
});

test('runAsync without a host yield function still completes', async () => {
  function* steps() {
    for (let i = 0; i < 5; i++) yield { phase: 'x' };
    return 42;
  }
  assert.equal(await runAsync(steps(), { sliceMs: 0 }), 42);
});
