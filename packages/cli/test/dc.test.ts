import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { guessRails } from '@returnpath/core';
import { dcReport, dcViews, runDc } from '../src/dc.js';
import { parseEasyEdaPcb } from '../src/easyeda/parse.js';
import { buildDcEpro } from '../src/synth/make-dc-board.js';

function dcBoard() {
  const files = unzipSync(buildDcEpro());
  const footprints = new Map<string, string>();
  let pcb = '';
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('.epcb')) pcb = strFromU8(data);
    if (name.endsWith('.efoo')) footprints.set(name.split('/').pop()!.split('.')[0], strFromU8(data));
  }
  return parseEasyEdaPcb({ pcb, footprints });
}

const board = dcBoard();
const IN1 = board.stackup.copper.find((l) => l.name === 'Inner1')!.id;
const IN2 = board.stackup.copper.find((l) => l.name === 'Inner2')!.id;

test('DC board: parser reads copper thickness and part names; wizard guess', () => {
  assert.deepEqual(board.stackup.copper.map((l) => l.thicknessMm), [0.035, 0.0175, 0.0175, 0.035]);
  assert.equal(board.components.find((c) => c.designator === 'U1')!.name, 'AMS1117-3.3');
  const g = guessRails(board);
  assert.deepEqual(g.grounds, ['GND']);
  const r = Object.fromEntries(g.rails.map((x) => [x.net, x]));
  assert.deepEqual(Object.keys(r).sort(), ['3V3', 'VBUS']);
  assert.equal(r['3V3'].source?.designator, 'U1');
  assert.deepEqual(r['3V3'].loads.map((l) => l.designator), ['U2', 'U3', 'J2']);
  assert.ok(r['3V3'].loads.find((l) => l.designator === 'J2')!.connector, 'header on a regulated rail is a load');
  assert.deepEqual(r['3V3'].excluded.map((e) => e.designator), ['C1', 'C2']);
  assert.equal(r.VBUS.source?.designator, 'J1');
  assert.deepEqual(r.VBUS.loads.map((l) => l.designator), ['U1']);
});

const run = runDc(board, { rail: '3V3' });

test('DC board: both halves of the 3V3 loop', () => {
  const { supply, ret } = run.result;
  assert.ok(ret, 'return half solved');
  assert.deepEqual(run.result.warnings, []);
  const share = (n: typeof supply, layer: number) => n.layers.find((l) => l.layer === layer)!.flow / n.layers.reduce((a, l) => a + l.flow, 0);
  assert.ok(share(supply, IN2) > 0.6, '3V3 flows mainly in the Inner2 plane');
  assert.ok(share(ret!, IN1) > 0.6, 'GND returns mainly in the Inner1 plane');
  assert.ok(supply.drop > 0.005 && supply.drop < 0.02, `3V3 drop ${supply.drop} V/A`);
  assert.ok(ret!.drop > 0.002 && ret!.drop < 0.015, `GND drop ${ret!.drop} V/A`);
  assert.deepEqual([...supply.unconnected, ...ret!.unconnected], []);
  const in1 = ret!.layers.find((l) => l.layer === IN1)!;
  assert.ok(in1.peak!.at.x > 20 && in1.peak!.at.x < 25 && in1.peak!.at.y < 8, `Inner1 peak at the neck below the slot: ${JSON.stringify(in1.peak)}`);
});

test('DC board: streamlines reach the source, and the GND return of U3 goes round the slot', () => {
  for (const [name, lines] of [['3V3', run.streamlines.supply], ['GND', run.streamlines.ret]] as const)
    for (const load of ['U2', 'U3', 'J2']) assert.ok(lines.some((l) => l.load === load && l.complete), `${name}: a complete streamline from ${load}`);
  const u3 = run.streamlines.ret.filter((l) => l.load === 'U3' && l.complete);
  for (const l of u3) {
    const pts = l.segments.filter((s) => s.layer === IN1).flatMap((s) => s.pts);
    assert.ok(pts.some((p) => p.x > 21.5 && p.x < 23.5 && p.y < 6), 'crosses x = 22.5 through the neck (y < 6 mm)');
    assert.ok(!pts.some((p) => p.x > 22 && p.x < 23 && p.y > 6.2), 'never through the slot');
  }
  const sup = run.streamlines.supply.find((l) => l.complete)!;
  const first = sup.segments[0].pts[0];
  const u1 = board.components.find((c) => c.designator === 'U1')!;
  assert.ok(Math.hypot(first.x - u1.at.x, first.y - u1.at.y) < 1.5, 'supply streamlines start at the source');
});

test('DC renders and report', () => {
  const views = dcViews(board, run, 'dc-4layer.epro');
  assert.deepEqual(views.map((v) => v.suffix), ['overview', '3v3-toplayer', '3v3-inner2', 'gnd-toplayer', 'gnd-inner1', 'gnd-bottomlayer']);
  for (const v of views) assert.match(v.svg, /^<svg[\s\S]*<\/svg>$/);
  assert.match(views[0].svg, /#e879f9/, 'return streamlines');
  assert.match(views[0].svg, /#fbbf24/, 'supply streamlines');
  const rep = dcReport(board, run);
  assert.equal(rep.source, 'U1');
  assert.equal(rep.normalised, true);
  assert.ok(Math.abs(rep.loads.reduce((a, l) => a + l.currentA, 0) - 1) < 0.005);
});

test('DC: given currents, a source override and an unclear rail', () => {
  const r = runDc(board, { rail: 'VBUS', currents: 'U1=200mA' });
  assert.equal(r.result.setup.normalised, false);
  assert.ok(Math.abs(r.result.supply.drop - 0.2 * runDc(board, { rail: 'VBUS' }).result.supply.drop) < 1e-6, 'linear in the load current');
  assert.throws(() => runDc(board, { rail: '3V3', source: 'U9' }), /not found/);
});
