import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { analyzeNet, buildDcSetup, hfApplicability, solveDc, solveDcAsync, type Board } from '@returnpath/core';
import { runDc } from '../src/dc.js';
import { parseEasyEdaPcb } from '../src/easyeda/parse.js';
import { buildTwoLayerEpro, type TwoLayerVariant } from '../src/synth/make-2layer-board.js';

function board(v: TwoLayerVariant): Board {
  const files = unzipSync(buildTwoLayerEpro(v));
  const footprints = new Map<string, string>();
  let pcb = '';
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('.epcb')) pcb = strFromU8(data);
    if (name.endsWith('.efoo')) footprints.set(name.split('/').pop()!.split('.')[0], strFromU8(data));
  }
  return parseEasyEdaPcb({ pcb, footprints });
}

const coplanar = board('coplanar');
const bottomOnly = board('bottom-only');
const TOP = 1;
const BOTTOM = 2;
const kinds = (b: Board, net: string) => analyzeNet(b, net).findings.map((f) => f.kind).sort();

test('2-layer: stackup is one 1.5 mm core between two copper layers', () => {
  assert.deepEqual(coplanar.stackup.copper.map((l) => l.id), [TOP, BOTTOM]);
  assert.deepEqual(coplanar.stackup.dielectrics.map((d) => d.thicknessMm), [1.5]);
});

test('2-layer coplanar: CLK returns in the Top pour beside it and detours around the break', () => {
  const an = analyzeNet(coplanar, 'CLK');
  assert.equal(an.chains.length, 1);
  const ref = an.chains[0].ref!;
  assert.equal(ref.layer, TOP);
  assert.equal(ref.coplanar, true);
  assert.ok(ref.h > 0.2 && ref.h < 0.35, `trace-to-pour gap ${ref.h}`);
  assert.deepEqual(kinds(coplanar, 'CLK'), ['slot-crossing']);
  const gap = an.chains[0].gaps.find((g) => g.kind === 'slot')!;
  assert.ok(gap.a.x > 29.5 && gap.b.x < 32, 'gap at the Top pour break');
  // CLK's own clearance splits the pour into halves above and below it; the return goes round an end of the break.
  assert.ok(gap.detour!.path.some((p) => p.y < 7.2 || p.y > 15.8), 'detour passes an end of the break');
});

test('2-layer coplanar: DATA on Bottom is coplanar too; its vias need GND stitching between the two pours', () => {
  const an = analyzeNet(coplanar, 'DATA');
  const bottom = an.chains.find((c) => c.chain.layer === BOTTOM)!;
  assert.equal(bottom.ref?.layer, BOTTOM);
  assert.equal(bottom.ref?.coplanar, true);
  assert.ok(bottom.gaps.some((g) => g.kind === 'slot' && g.a.x > 39.5 && g.b.x < 41.7), 'crosses the Bottom slot');
  for (const v of an.vias) {
    assert.equal(v.transitions[0].kind, 'stitching-via');
    assert.ok(v.transitions[0].loopArea! > v.transitions[0].distance! * 1.4, 'vertical loop spans the full 1.5 mm core');
  }
  assert.deepEqual(kinds(coplanar, 'DATA'), ['slot-crossing', 'via-return', 'via-return']);
});

test('2-layer without a Top pour: CLK references the Bottom pour 1.5 mm below and crosses its slot', () => {
  const an = analyzeNet(bottomOnly, 'CLK');
  const ref = an.chains[0].ref!;
  assert.equal(ref.layer, BOTTOM);
  assert.ok(!ref.coplanar);
  assert.equal(ref.h, 1.5);
  assert.deepEqual(kinds(bottomOnly, 'CLK'), ['slot-crossing']);
  const gap = an.chains[0].gaps[0];
  assert.ok(gap.a.x > 39.5 && gap.b.x < 41.7);
  assert.ok(gap.detour!.path.some((p) => p.y > 13.8), 'detour passes the upper end of the slot');
  // DATA's Top stubs reference the Bottom pour; its Bottom run returns in that pour beside it.
  const data = analyzeNet(bottomOnly, 'DATA');
  for (const c of data.chains) assert.equal(c.ref?.layer, BOTTOM);
  assert.equal(data.vias[0].transitions[0].kind, 'shared-plane');
});

test('2-layer: power and ground nets are kept out of the high-frequency check', () => {
  for (const net of ['3V3', 'VBUS', 'GND']) assert.equal(hfApplicability(coplanar, net).ok, false, net);
  assert.equal(hfApplicability(coplanar, 'CLK').ok, true);
});

test('2-layer DC: the GND return follows the pours that exist', () => {
  for (const [b, mainReturn] of [
    [coplanar, TOP],
    [bottomOnly, BOTTOM],
  ] as const) {
    const run = runDc(b, { rail: '3V3' });
    const { supply, ret } = run.result;
    assert.equal(run.result.setup.source.designator, 'U1');
    assert.deepEqual(run.result.setup.loads.map((l) => l.designator), ['U2', 'U3']);
    assert.ok(ret, 'return half solved');
    assert.deepEqual([...supply.unconnected, ...ret!.unconnected], []);
    const flow = (layer: number) => ret!.layers.find((l) => l.layer === layer)!.flow;
    assert.ok(flow(mainReturn) > flow(mainReturn === TOP ? BOTTOM : TOP), `GND returns mainly on layer ${mainReturn}`);
    assert.ok(supply.drop > 0.01 && supply.drop < 0.05, `3V3 track drop ${supply.drop} V/A`);
  }
});

test('DC solve in time slices yields to the host and gives the same answer', async () => {
  const setup = buildDcSetup(bottomOnly, { rail: '3V3', ground: 'GND', source: 'U1' });
  const sync = solveDc(bottomOnly, setup);
  let yields = 0;
  const phases = new Set<string>();
  const res = await solveDcAsync(bottomOnly, setup, {}, { sliceMs: 5, yieldFn: async () => void yields++, onPhase: (p) => phases.add(p) });
  assert.ok(yields > 3, `${yields} yields`);
  for (const p of ['reference copper', 'raster 3V3', 'solve 3V3', 'solve GND']) assert.ok(phases.has(p), p);
  assert.equal(res.supply.drop, sync.supply.drop);
  assert.equal(res.ret!.drop, sync.ret!.drop);
});
