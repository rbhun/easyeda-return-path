import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';
import { analyzeNet, area, buildReferenceCopper, dist } from '@returnpath/core';
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
  assert.deepEqual(kinds, ['error:slot-crossing', 'warn:band-coverage', 'error:split-crossing', 'warn:via-return', 'warn:via-return']);
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
    ['warn:split-crossing', 'ok:via-return', 'ok:via-return'],
  );
});
