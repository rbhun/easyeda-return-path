import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';
import { analyzeNet, area, buildReferenceCopper, dist, guessDrivers, pinRole } from '@returnpath/core';
import { parseEasyEdaPcb } from '../src/easyeda/parse.js';
import { buildEpro } from '../src/synth/make-board.js';

function boardFrom(variant: 'demo' | 'fixed', form: 'object' | 'array') {
  const files = unzipSync(buildEpro(variant, form));
  const footprints = new Map<string, string>();
  let pcb = '';
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('.epcb')) pcb = strFromU8(data);
    if (name.endsWith('.efoo')) footprints.set(name.split('/').pop()!.split('.')[0], strFromU8(data));
  }
  return parseEasyEdaPcb({ pcb, footprints });
}

test('parser: stackup, footprints and both line encodings', () => {
  const b = boardFrom('demo', 'object');
  assert.deepEqual(b.stackup.copper.map((l) => l.name), ['Top Layer', 'Inner1', 'Inner2', 'Bottom Layer']);
  assert.ok(Math.abs(b.stackup.dielectrics[0].thicknessMm - 0.2104) < 1e-9);
  const u2 = b.components.find((c) => c.designator === 'U2')!;
  const pin1 = b.pads.find((p) => p.componentId === u2.id && p.number === '1')!;
  assert.equal(pin1.net, 'CLK');
  assert.ok(dist(pin1.at, { x: 50.5, y: 20 }) < 1e-3);
  const a = boardFrom('demo', 'array');
  assert.equal(a.tracks.length, b.tracks.length);
  assert.equal(a.pads.length, b.pads.length);
  assert.deepEqual(
    analyzeNet(a, 'CLK').findings.map((f) => f.message),
    analyzeNet(b, 'CLK').findings.map((f) => f.message),
  );
});

test('POURED fill is used as-is', () => {
  const pcb = [
    '["DOCTYPE","PCB","1.1"]',
    '["LAYER",1,"TOP","Top Layer",3]',
    '["LAYER",2,"BOTTOM","Bottom Layer",3]',
    '["LAYER_PHYS",50,"FR4",59,4.5,0.02]',
    '["LAYER",50,"SUBSTRATE","Core",3]',
    '["POUR","p1",0,"GND",2,10,"g",1,[0,0,"L",1000,0,1000,1000,0,1000],["SOLID",0],0]',
    '["POURED","f1","p1",0,1,[[0,0,"L",1000,0,1000,1000,0,1000],[400,400,"L",600,400,600,600,400,600]]]',
  ].join('\n');
  const b = parseEasyEdaPcb({ pcb });
  assert.ok(Math.abs(b.stackup.dielectrics[0].thicknessMm - 59 * 0.0254) < 1e-9, 'mil thickness');
  const rc = buildReferenceCopper(b, { clearance: 0.2 });
  const gnd = rc.get(2)!.byNet.get('GND')!;
  const mm = 25.4;
  assert.ok(Math.abs(area(gnd) - (mm * mm - (mm / 5) ** 2)) < 0.01);
});

test('demo board: slot, split, coverage and via findings', () => {
  const an = analyzeNet(boardFrom('demo', 'object'), 'CLK');
  const kinds = an.findings.map((f) => `${f.severity}:${f.kind}`);
  assert.deepEqual(kinds, ['error:slot-crossing', 'warn:band-coverage', 'error:split-crossing', 'warn:via-return', 'warn:via-return', 'ok:loop-closure', 'ok:loop-closure']);
  const slot = an.chains.flatMap((c) => c.gaps).find((g) => g.kind === 'slot')!;
  assert.ok(Math.abs(slot.detour!.extraLength - 15.8) < 0.2);
  assert.ok(Math.abs(slot.detour!.loopArea - 12.8) < 0.3);
  const [v1, v2] = an.vias;
  assert.equal(v1.transitions[0].kind, 'stitching-via');
  assert.equal(v2.transitions[0].kind, 'decap');
  assert.equal(v2.transitions[0].target!.label, 'C2');
});

test('fixed board: only the bridged split remains', () => {
  const an = analyzeNet(boardFrom('fixed', 'object'), 'CLK');
  assert.deepEqual(
    an.findings.map((f) => `${f.severity}:${f.kind}`),
    ['warn:split-crossing', 'ok:via-return', 'ok:via-return', 'ok:loop-closure', 'ok:loop-closure'],
  );
});

test('demo board: the return path runs under the trace, around the slot, and hops off the plane', () => {
  const b = boardFrom('demo', 'object');
  const an = analyzeNet(b, 'CLK');
  const rp = an.returnPath;
  const layer = (n: string) => b.stackup.copper.find((l) => l.name === n)!.id;
  // Inner planes under the trace, and the top layer where the ground pad's own trace reaches its via.
  assert.deepEqual([...new Set(rp.traces.map((t) => t.layer))].sort(), [layer('Top Layer'), layer('Inner1'), layer('Inner2')].sort());
  const detour = rp.traces.find((t) => t.detour)!;
  assert.equal(detour.layer, layer('Inner1'));
  assert.ok(Math.min(...detour.pts.map((p) => p.y)) < 13, 'detour goes round the slot end, well below the trace at y = 20');
  // The plane runs and the detour together cover the trace on Inner1 except the slot itself.
  const len = (pts: { x: number; y: number }[]) => pts.reduce((s, p, i) => (i ? s + dist(p, pts[i - 1]) : 0), 0);
  const plane1 = rp.traces.filter((t) => t.layer === layer('Inner1') && !t.detour).reduce((s, t) => s + len(t.pts), 0);
  assert.ok(plane1 > 20 && plane1 < 55, `Inner1 plane runs ${plane1}`);
  const kinds = rp.jumps.map((j) => `${j.kind}:${j.kind === 'via' ? j.label.replace(/ via .*/, ' via') : j.label}`).sort();
  // U2's ground via sits on inner copper that does not join the copper under the trace, so no line is drawn across to it.
  assert.deepEqual(kinds, ['bridge:C2', 'bridge:C2', 'decap:C2', 'pin:U1.2', 'via:GND via', 'via:GND via'].sort());
  for (const j of rp.jumps.filter((x) => x.kind === 'pin')) assert.ok(Math.abs(j.distance - 3.16) < 0.01);
});

test('2-layer coplanar return: drawn beside the trace; parts without a ground pad are reported', async () => {
  const { buildTwoLayerEpro } = await import('../src/synth/make-2layer-board.js');
  const files = unzipSync(buildTwoLayerEpro('coplanar'));
  let pcb = '';
  const footprints = new Map<string, string>();
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('.epcb')) pcb = strFromU8(data);
    if (name.endsWith('.efoo')) footprints.set(name.split('/').pop()!.split('.')[0], strFromU8(data));
  }
  const b = parseEasyEdaPcb({ pcb, footprints });
  const an = analyzeNet(b, 'CLK');
  const plane = an.returnPath.traces.filter((t) => !t.detour);
  assert.ok(plane.length >= 2);
  // CLK runs along y = 10 from x = 9 to 53, in a pour on both sides; its return is one line along the nearer pour edge.
  const ys = plane.flatMap((t) => t.pts.filter((p) => p.x > 15 && p.x < 50).map((p) => p.y - 10));
  assert.ok(ys.length && (ys.every((d) => d > 0.2 && d < 0.6) || ys.every((d) => d < -0.2 && d > -0.6)), `coplanar return beside the trace, on one side: ${ys}`);
  // Unbroken: the pieces (the detour round the break in the pour included) meet end to end.
  const pieces = an.returnPath.traces.filter((t) => t.signalLayer === plane[0].signalLayer);
  const ends = pieces.flatMap((t) => [t.pts[0], t.pts[t.pts.length - 1]]);
  const loose = ends.filter((e) => ends.filter((f) => Math.hypot(e.x - f.x, e.y - f.y) < 0.05).length < 2);
  assert.equal(loose.length, 2, `one line with two ends: ${JSON.stringify(loose)}`);
  assert.ok(Math.min(...loose.map((e) => e.x)) < 15 && Math.max(...loose.map((e) => e.x)) > 50, 'from end to end of the trace');
  assert.deepEqual(an.findings.filter((f) => f.kind === 'loop-closure').map((f) => f.severity), ['warn', 'warn']);
});

test('driver loop: the rising edge returns through the nearest decap into the driver supply pin', () => {
  const b = boardFrom('demo', 'object');
  const an = analyzeNet(b, 'CLK', { drivers: ['U1'] });
  const f = an.findings.filter((x) => x.kind === 'driver-loop');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'warn', 'between the 4 mm and 10 mm thresholds');
  assert.match(f[0].message, /into U1 pad 2 \(GND\); the rising edge through decap C1 into U1 pad 3 \(3V3\), 8\.55 mm/);
  const supply = an.returnPath!.jumps.filter((j) => j.kind === 'supply');
  assert.equal(supply.length, 2, 'ground pin → decap, decap → supply pin');
  assert.deepEqual(an.returnPath!.drivers.map((d) => d.decap?.component.designator), ['C1']);
  const strict = analyzeNet(b, 'CLK', { drivers: ['U1'], driverDecap: { good: 4, warn: 6 } });
  assert.equal(strict.findings.find((x) => x.message.startsWith('U1 (driver)'))!.severity, 'error');
  assert.ok(!analyzeNet(b, 'CLK').findings.some((x) => x.message.includes('(driver)')), 'no driver, no driver loop');
});

test('driver guess from pin names: a named output wins, a bus driven from either end stays a question', () => {
  const b = boardFrom('demo', 'object');
  const ic = (d: string) => b.components.find((c) => c.designator === d)!.id;
  const sig = (d: string) => b.pads.find((p) => p.net === 'CLK' && p.componentId === ic(d))!;
  const none = guessDrivers(b, 'CLK');
  assert.deepEqual([none.candidates.map((c) => c.designator), none.confident], [['U1', 'U2'], false], 'no pin names');
  sig('U1').pinName = 'USART1_TX';
  sig('U2').pinName = 'RXD';
  assert.deepEqual([guessDrivers(b, 'CLK').drivers, guessDrivers(b, 'CLK').confident], [['U1'], true]);
  assert.equal(pinRole('SDA/MOSI').role, 'bidirectional', 'a shared pin is not taken as a driver');
  for (const x of [...b.pads, ...b.tracks]) if (x.net === 'CLK') x.net = 'I2C_SDA';
  assert.equal(guessDrivers(b, 'I2C_SDA').confident, false, 'an I2C net is driven from either end whatever the pins say');
});
