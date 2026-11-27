import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { analyzeNet, bbox, buildDcSetup, hfApplicability, hfCandidates, solveDc, solveDcAsync, type Board, type Pad } from '@returnpath/core';
import { runDc } from '../src/dc.js';
import { foldRows, renderOverlay } from '../src/render/svg.js';
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
const halfTop = board('half-top');
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
  assert.deepEqual(kinds(coplanar, 'CLK'), ['loop-closure', 'loop-closure', 'return-detour', 'return-length', 'slot-crossing']);
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
  assert.deepEqual(kinds(coplanar, 'DATA'), ['loop-closure', 'loop-closure', 'return-length', 'slot-crossing', 'via-return', 'via-return']);
});

test('2-layer without a Top pour: CLK references the Bottom pour 1.5 mm below and crosses its slot', () => {
  const an = analyzeNet(bottomOnly, 'CLK');
  const ref = an.chains[0].ref!;
  assert.equal(ref.layer, BOTTOM);
  assert.ok(!ref.coplanar);
  assert.equal(ref.h, 1.5);
  assert.deepEqual(kinds(bottomOnly, 'CLK'), ['loop-closure', 'loop-closure', 'return-detour', 'return-length', 'slot-crossing']);
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

test('net names differ only in case: one net, as in EasyEDA, for the board, the HF check and the DC solve', () => {
  const files = unzipSync(buildTwoLayerEpro('coplanar'));
  const footprints = new Map<string, string>();
  let pcb = '';
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('.epcb')) pcb = strFromU8(data);
    if (name.endsWith('.efoo')) footprints.set(name.split('/').pop()!.split('.')[0], strFromU8(data));
  }
  let k = 0;
  const mixedPcb = pcb.replace(/"GND"/g, (m) => (k++ % 3 === 1 ? '"gnd"' : m)).replace(/"3V3"/g, (m) => (k++ % 4 === 2 ? '"3v3"' : m));
  assert.ok(mixedPcb.includes('"gnd"') && mixedPcb.includes('"3v3"'));
  const mixed = parseEasyEdaPcb({ pcb: mixedPcb, footprints });
  assert.deepEqual(mixed.nets, coplanar.nets);
  assert.ok(!mixed.tracks.some((t) => t.net === 'gnd' || t.net === '3v3') && !mixed.pads.some((p) => p.net === 'gnd' || p.net === '3v3'));
  assert.ok(mixed.warnings.some((w) => /GND and gnd differ only in letter case.*analysed as GND/.test(w)), mixed.warnings.join('\n'));

  assert.deepEqual(kinds(mixed, 'clk'), kinds(coplanar, 'CLK'));
  assert.equal(analyzeNet(mixed, 'clk').net, 'CLK');
  assert.equal(hfApplicability(mixed, 'gnd').kind, 'ground');

  const want = runDc(coplanar, { rail: '3V3' }).result;
  const got = runDc(mixed, { rail: '3v3', ground: 'Gnd' }).result;
  assert.equal(got.setup.rail, '3V3');
  assert.equal(got.setup.ground, 'GND');
  assert.deepEqual(got.setup.loads.map((l) => l.designator), want.setup.loads.map((l) => l.designator));
  assert.ok(Math.abs(got.supply.drop - want.supply.drop) < 1e-9 && Math.abs(got.ret!.drop - want.ret!.drop) < 1e-9);
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

test('2-layer half pour: CLK is coplanar while the Top pour runs beside it, then references the Bottom pour through the GND via', () => {
  const an = analyzeNet(halfTop, 'CLK');
  assert.deepEqual(an.chains.map((c) => [c.chain.refMode, c.ref?.layer, !!c.ref?.coplanar]), [
    ['coplanar', TOP, true],
    ['plane', BOTTOM, false],
  ]);
  const split = an.chains[0].chain.pts.at(-1)!;
  assert.ok(split.x > 29 && split.x < 30.5, `split at the pour edge, x = ${split.x}`);
  assert.equal(an.chains[1].chain.cutVia?.net, 'GND');
  const past = an.returnPath.traces.filter((t) => t.pts.some((p) => p.x > split.x + 1));
  assert.ok(past.length && past.every((t) => t.layer === BOTTOM), 'past the top pour the return is on the bottom');
  // No via of the pour's net at the split: the return cannot change layers there, so the whole run keeps one reference.
  const noVia = { ...halfTop, vias: halfTop.vias.filter((v) => !(v.net === 'GND' && Math.abs(v.at.x - 29.5) < 0.01)) };
  const one = analyzeNet(noVia, 'CLK');
  assert.equal(one.chains.length, 1);
  assert.equal(one.chains[0].ref?.layer, BOTTOM);
});

test('2-layer: a net with no tracks is a clean finding, not an exception', () => {
  const an = analyzeNet({ ...coplanar, tracks: coplanar.tracks.filter((t) => t.net !== 'CLK') }, 'CLK');
  assert.deepEqual(an.findings.map((f) => [f.severity, f.kind]), [['warn', 'no-tracks']]);
  assert.match(an.findings[0].message, /CLK has no tracks/);
  assert.deepEqual(an.chains, []);
});

test('2-layer: a pin tied only through a resistor or capacitor to a rail is a bias net, not a signal', () => {
  const u4 = coplanar.components.find((c) => c.designator === 'U4')!;
  const pad = (id: string, net: string, number: string): Pad => ({ id, net, number, layer: TOP, at: { x: 12, y: 8 }, shape: [], holeDiameter: 0, componentId: 'r9' });
  const withBias = (other: string): Board => ({
    ...coplanar,
    pads: [...coplanar.pads.map((p) => (p.componentId === u4.id && p.net === 'CLK' ? { ...p, net: 'IREF' } : p)), pad('r9a', 'IREF', '1'), pad('r9b', other, '2')],
    components: [...coplanar.components, { id: 'r9', designator: 'R9', at: { x: 12, y: 8 }, rotation: 0, layer: TOP, padIds: ['r9a', 'r9b'] }],
  });
  const scope = hfApplicability(withBias('GND'), 'IREF');
  assert.equal(scope.kind, 'bias');
  assert.match(scope.message!, /IREF joins only U4 to R9, tied to GND/);
  assert.equal(hfApplicability(withBias('DATA'), 'IREF').ok, true, 'a resistor to another signal is a real path');
});

test('2-layer: slot detours are graded by the length they add', () => {
  const slot = (o: { ignore: number; warn: number }) => analyzeNet(bottomOnly, 'CLK', { slotDetour: o }).findings.filter((f) => f.kind === 'slot-crossing');
  assert.equal(slot({ ignore: 1, warn: 5 })[0].severity, 'error', '+7.8 mm is an error by default');
  assert.equal(slot({ ignore: 1, warn: 20 })[0].severity, 'warn');
  assert.deepEqual(slot({ ignore: 20, warn: 30 }), []);
});

test('2-layer: via findings name the nearest return via by position', () => {
  const msgs = analyzeNet(coplanar, 'DATA').findings.filter((f) => f.kind === 'via-return').map((f) => f.message);
  assert.ok(msgs.length && msgs.every((m) => /nearest GND via at \(-?\d+\.\d, -?\d+\.\d\)/.test(m)), msgs.join('\n'));
});

test('overview: a long thin board is folded into rows; a normal one is not', () => {
  assert.equal(foldRows(60, 40), 1);
  assert.ok(foldRows(350, 12) >= 3, `${foldRows(350, 12)} rows for the rack board`);
  const r = (b: Board) => renderOverlay(b, analyzeNet(b, 'CLK'), { title: 'CLK' });
  assert.ok(!r(coplanar).includes('clip-path'));
  const strip = { ...coplanar, outline: [[{ x: 0, y: 8 }, { x: 60, y: 8 }, { x: 60, y: 12 }, { x: 0, y: 12 }]] };
  const svg = r(strip);
  assert.equal(svg.match(/clip-path="url\(#row\d\)"/g)?.length, foldRows(60, 4));
  const [w, h] = svg.match(/width="([\d.]+)" height="([\d.]+)"/)!.slice(1).map(Number);
  assert.ok(w / h < 4, `picture ${w} × ${h} keeps a readable shape`);
});

test('2-layer: the overlay marks thin stretches along the trace, and the band stays on the board', () => {
  const an = analyzeNet(bottomOnly, 'DATA');
  const thin = an.chains.flatMap((c) => c.thin);
  assert.equal(thin.length, an.findings.filter((f) => f.kind === 'band-coverage').length, 'one thin segment per single-segment finding here');
  assert.ok(thin.every((t) => an.chains.some((c) => c.chain.pts.some((p) => p.x === t.a.x && p.y === t.a.y))), 'thin stretches lie on the trace');
  for (const c of an.chains) {
    const bb = bbox(c.band);
    assert.ok(bb.minX >= -1e-6 && bb.minY >= -1e-6 && bb.maxX <= 60 + 1e-6 && bb.maxY <= 40 + 1e-6, 'band clipped to the 60 × 40 mm outline');
  }
});

test('2-layer: the HF check lists recognised data lines first', () => {
  assert.deepEqual(hfCandidates(coplanar).map((c) => [c.net, c.kind?.label]), [['CLK', 'clock'], ['DATA', undefined]]);
});
