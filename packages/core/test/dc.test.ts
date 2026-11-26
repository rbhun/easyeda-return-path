import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDcSetup,
  densityBin,
  densityContours,
  guessRails,
  loadsFor,
  isGroundNet,
  looksLikePowerNet,
  pairGround,
  parseCurrents,
  railVoltage,
  rect,
  returnPads,
  solveDc,
  traceStreamlines,
  DRAWN_STREAMS,
  distPointSeg,
  type Board,
  type Component,
  type DcSetup,
  type Pad,
  type Paths,
} from '../src/index.js';

const SHEET = 5.8e4 * 0.035;

function board(layers: number, parts: Partial<Board>): Board {
  const copper = Array.from({ length: layers }, (_, i) => ({ id: i + 1, name: `L${i + 1}`, index: i, z: i * 1.0, thicknessMm: 0.035 }));
  return {
    outline: [],
    stackup: { copper, dielectrics: copper.slice(1).map(() => ({ name: 'd', thicknessMm: 1.0 })) },
    nets: [],
    tracks: [],
    vias: [],
    pads: [],
    components: [],
    pours: [],
    keepouts: [],
    warnings: [],
    ...parts,
  };
}

const pad = (id: string, net: string, layer: number, x: number, y: number, w: number, h: number, componentId?: string, pinName?: string): Pad => ({
  id,
  net,
  layer,
  number: id,
  at: { x, y },
  shape: [rect(x, y, w, h)],
  holeDiameter: 0,
  componentId,
  pinName,
});

const pour = (net: string, layer: number, shape: Paths) => ({ id: `${net}-${layer}`, net, layer, name: net, priority: 0, outline: shape, poured: shape });

function terminalSetup(src: Pad, load: Pad, net: string): DcSetup {
  return {
    rail: net,
    ground: 'GND',
    source: { componentId: 's', designator: 'S', railPads: [src], groundPads: [], current: 0 },
    loads: [{ componentId: 'l', designator: 'L', railPads: [load], groundPads: [], current: 1 }],
    normalised: true,
    warnings: [],
  };
}

test('DC solve: a copper strip has R = L / (σ t W)', () => {
  const cell = 0.1;
  const src = pad('a', 'P', 1, 0.05, 1, 0.1, 2);
  const load = pad('b', 'P', 1, 19.95, 1, 0.1, 2);
  const b = board(1, { pours: [pour('P', 1, [rect(10, 1, 20, 2)])], pads: [src, load] });
  const res = solveDc(b, terminalSetup(src, load, 'P'), { cell });
  const expected = 19.9 / (SHEET * 2);
  assert.ok(Math.abs(res.supply.drop - expected) / expected < 0.02, `drop ${res.supply.drop} vs ${expected}`);
  const mid = res.supply.layers[0];
  const c = Math.floor((1 - res.grid.y0) / cell) * res.grid.nx + Math.floor((10 - res.grid.x0) / cell);
  assert.ok(Math.abs(mid.j[c] - 0.5) < 0.01, `J ${mid.j[c]} A/mm in a 2 mm strip at 1 A`);
});

test('DC solve: a track narrower than a cell keeps its resistance per length', () => {
  const src = pad('a', 'P', 1, 0, 0, 0.1, 0.1);
  const load = pad('b', 'P', 1, 10, 0, 0.1, 0.1);
  const b = board(1, { tracks: [{ id: 't', net: 'P', layer: 1, a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, width: 0.15 }], pads: [src, load] });
  const res = solveDc(b, terminalSetup(src, load, 'P'), { cell: 0.25 });
  const expected = 10 / (SHEET * 0.15);
  assert.ok(Math.abs(res.supply.drop - expected) / expected < 0.15, `drop ${res.supply.drop} vs ${expected}`);
});

test('DC solve: current crosses layers through the via barrel', () => {
  const src = pad('a', 'P', 1, 0.1, 1, 0.2, 2);
  const load = pad('b', 'P', 2, 19.9, 1, 0.2, 2);
  const b = board(2, {
    pours: [pour('P', 1, [rect(5.25, 1, 10.5, 2)]), pour('P', 2, [rect(14.75, 1, 10.5, 2)])],
    vias: [{ id: 'v', net: 'P', at: { x: 10, y: 1 }, drill: 0.3, diameter: 0.6, stitching: false }],
    pads: [src, load],
  });
  const res = solveDc(b, terminalSetup(src, load, 'P'), { cell: 0.1 });
  assert.equal(res.supply.vias.length, 1);
  assert.ok(Math.abs(res.supply.vias[0].current - 1) < 1e-3, `via current ${res.supply.vias[0].current}`);
  const strips = 19.6 / (SHEET * 2);
  const barrel = 1.035 / (5.8e4 * Math.PI * (0.15 ** 2 - 0.125 ** 2));
  assert.ok(res.supply.drop > strips + barrel, 'drop includes both strips, the barrel and the crowding at the via');
  assert.ok(res.supply.drop < 1.5 * (strips + barrel), `drop ${res.supply.drop}`);
  const [sl] = traceStreamlines(res.grid, res.supply, { perLoad: 1 });
  assert.ok(sl.complete);
  assert.deepEqual(sl.segments.map((s) => s.layer), [1, 2], 'source on L1 → via → load on L2');
  const cont = densityContours(res.grid, res.supply.layers[0], res.supply.layers[0].peak!.j);
  assert.equal(cont.length, 4);
  assert.ok(cont.some((lv) => lv.length > 0));
  assert.equal(densityBin(0.01, 1), 0);
  assert.equal(densityBin(0.5, 1), 3);
  assert.equal(densityBin(2, 1), 4);
});

test('net-name rules', () => {
  for (const n of ['GND', 'AGND', 'PGND', 'GND_ISO', 'VSS', '/GND']) assert.ok(isGroundNet(n), n);
  for (const n of ['3V3', '+5V', '1V8', 'VCC', 'VDD_IO', 'VBUS', 'VBAT', 'VIN', 'P3V3', 'AVDD', '+3.3V', 'MCU_3V3']) assert.ok(looksLikePowerNet(n), n);
  for (const n of ['SDA', 'CLK', 'GND', 'USB_D+', 'NRST']) assert.ok(!looksLikePowerNet(n), n);
  assert.equal(railVoltage('3V3'), 3.3);
  assert.equal(railVoltage('+5V'), 5);
  assert.equal(railVoltage('1.8V'), 1.8);
  assert.equal(railVoltage('VBUS'), 5);
  assert.equal(railVoltage('VCC'), undefined);
  assert.deepEqual(parseCurrents('U2=0.15, U3=20mA'), { U2: 0.15, U3: 0.02 });
  assert.equal(parseCurrents(' '), undefined);
  assert.throws(() => parseCurrents('U2=lots'));
});

function partsBoard(spec: [string, string | undefined, [string, string, string?][]][]): Board {
  const pads: Pad[] = [];
  const components: Component[] = [];
  spec.forEach(([des, name, pins], k) => {
    const id = `c${k}`;
    const own = pins.map(([num, net, pinName], i) => pad(`${id}.${num}`, net, 1, k * 5 + i, 0, 0.5, 0.5, id, pinName));
    pads.push(...own);
    components.push({ id, designator: des, name, at: { x: k * 5, y: 0 }, rotation: 0, layer: 1, padIds: own.map((p) => p.id) });
  });
  return board(2, { pads, components, nets: [...new Set(pads.map((p) => p.net))] });
}

test('source guess: regulator output wins, connectors on its rail are loads, decaps are left out', () => {
  const b = partsBoard([
    ['J1', 'USB-C', [['1', 'VBUS'], ['2', 'GND']]],
    ['U1', undefined, [['1', 'GND', 'GND'], ['2', '1V8', 'VOUT'], ['3', 'VBUS', 'VIN']]],
    ['U2', 'MCU', [['1', '1V8'], ['2', 'GND']]],
    ['J3', 'Header', [['1', '1V8'], ['2', 'GND']]],
    ['C1', '1uF', [['1', '1V8'], ['2', 'GND']]],
  ]);
  const g = guessRails(b);
  const r18 = g.rails.find((r) => r.net === '1V8')!;
  assert.equal(r18.source?.designator, 'U1', 'pin name VOUT marks the regulator output');
  assert.equal(r18.rule, 'regulator');
  assert.deepEqual(r18.loads.map((l) => `${l.designator}${l.connector ? '*' : ''}`), ['U2', 'J3*']);
  assert.deepEqual(r18.excluded.map((e) => e.designator), ['C1']);
  const vbus = g.rails.find((r) => r.net === 'VBUS')!;
  assert.equal(vbus.source?.designator, 'J1');
  assert.equal(vbus.rule, 'connector');
  assert.deepEqual(vbus.loads.map((l) => l.designator), ['U1'], 'the regulator input is a load');
});

test('pull-ups and LEDs to a GPIO are not loads: their current does not return through ground', () => {
  const b = partsBoard([
    ['J2', 'Header', [['1', '3V3'], ['2', 'GND']]],
    ['U1', 'TCA9548', [['1', '3V3', 'VCC'], ['2', 'GND', 'GND'], ['3', 'SDA', 'SDA']]],
    ['R1', '4k7', [['1', '3V3'], ['2', 'SDA']]],
    ['D1', 'LED', [['1', '3V3'], ['2', 'LED_K']]],
  ]);
  const r = guessRails(b).rails.find((x) => x.net === '3V3')!;
  const { loads, excluded } = loadsFor(b, '3V3', b.components[0].id, [b.components[0].id]);
  assert.deepEqual(loads.map((l) => l.designator), ['U1']);
  assert.deepEqual(excluded, [{ designator: 'R1', why: 'no ground pad' }, { designator: 'D1', why: 'no ground pad' }]);
  assert.ok(r.excluded.some((e) => e.designator === 'R1'));
  const s = buildDcSetup(b, { rail: '3V3', ground: 'GND', source: 'J2' });
  assert.deepEqual(s.loads.map((l) => l.designator), ['U1']);
  assert.equal(s.loads[0].current, 1, 'the whole default amp goes to the part that returns it');
});

test('source guess: several candidates or conflicting rules → ask; the solve keeps one active source', () => {
  const b = partsBoard([
    ['J1', 'USB', [['1', 'VBUS'], ['2', 'GND']]],
    ['J2', 'DC jack', [['1', 'VBUS'], ['2', 'GND']]],
    ['U1', 'TP4056 charger', [['1', 'VBAT', 'BAT'], ['2', 'GND']]],
    ['BT1', 'Li-ion', [['1', 'VBAT'], ['2', 'GND']]],
    ['U2', 'MCP1700-3302', [['1', 'VBAT'], ['2', '3V3'], ['3', 'GND']]],
    ['J3', 'Header', [['1', '5V'], ['2', 'GND']]],
    ['U3', 'Load', [['1', '5V'], ['2', 'GND']]],
  ]);
  const g = guessRails(b);
  const vbus = g.rails.find((r) => r.net === 'VBUS')!;
  assert.equal(vbus.rule, 'ask');
  assert.equal(vbus.source, undefined);
  assert.deepEqual(vbus.candidates.map((c) => c.designator), ['J1', 'J2']);
  assert.match(vbus.askReason!, /pick the active source/);
  const setup = buildDcSetup(b, { rail: 'VBUS', ground: 'GND', source: 'J1' });
  assert.deepEqual(setup.loads.map((l) => l.designator), [], 'J2 (the other candidate) is left out, not a load');
  const vbat = g.rails.find((r) => r.net === 'VBAT')!;
  assert.equal(vbat.source?.designator, 'BT1', 'no regulator output on VBAT: the battery');
  assert.deepEqual(vbat.loads.map((l) => l.designator).sort(), ['U1', 'U2']);
  assert.equal(g.rails.find((r) => r.net === '3V3')!.source?.designator, 'U2', 'regulator by part name and rail voltages');
  const v5 = g.rails.find((r) => r.net === '5V')!;
  assert.equal(v5.rule, 'ask', 'connector on a rail that is not VIN/VBUS/VBAT: ask');
  assert.deepEqual(v5.candidates.map((c) => c.designator), ['J3']);
});

test('only ground pins start a return: address pins tied to GND do not; without pin names every GND pad does', () => {
  const b = partsBoard([
    ['CN1', 'Header', [['1', '12V'], ['2', 'GND'], ['3', 'SDA'], ['4', 'GND']]],
    ['U1', 'TCA9548APWR', [['1', 'GND', 'A0'], ['2', 'GND', 'A1'], ['12', 'GND', 'GND'], ['21', 'GND', 'A2'], ['23', 'SDA', 'SDA'], ['24', '3V3', 'VCC']]],
    ['U2', 'TCA9548APWR', [['1', 'GND'], ['2', 'GND'], ['12', 'GND'], ['23', 'SDA']]],
    ['U3', 'QFN', [['1', 'SDA', 'SDA'], ['2', 'GND', 'GND'], ['17', 'GND', 'EP']]],
  ]);
  const setup = buildDcSetup(b, { rail: 'SDA', ground: 'GND', source: 'CN1', loads: ['U1', 'U2', 'U3'] });
  const [u1, u2, u3] = setup.loads;
  assert.deepEqual(u1.groundPads.map((p) => p.pinName), ['GND']);
  assert.equal(u2.groundPads.length, 3, 'no pin names: every GND pad');
  assert.deepEqual(u3.groundPads.map((p) => p.pinName), ['GND', 'EP']);
  assert.ok(setup.warnings.some((w) => /U1: A0, A1, A2 are tied to GND but carry no supply current; the return starts at GND/.test(w)), setup.warnings.join('\n'));
  assert.ok(setup.warnings.some((w) => /SDA does not look like a power rail/.test(w)));
  assert.deepEqual(returnPads(b.pads.filter((p) => p.componentId === 'c0'), 'GND').pads.map((p) => p.number), ['c0.2', 'c0.4']);
});

test('ground pairing by name', () => {
  const b = partsBoard([['U1', 'x', [['1', 'GND'], ['2', 'AGND'], ['3', 'AVDD'], ['4', '3V3']]]]);
  assert.equal(pairGround(b, 'AVDD', ['AGND', 'GND']), 'AGND');
  assert.equal(pairGround(b, '3V3', ['AGND', 'GND']), 'GND');
  assert.equal(pairGround(b, 'VDD_ISO', ['GND', 'GND_ISO']), 'GND_ISO');
});

test('a source without a ground pad: the return ends at the nearest part on its other net, and the setup says so', () => {
  const b = partsBoard([
    ['J1', 'Jumper', [['1', '9V'], ['2', 'VIN']]],
    ['C7', 'Cap', [['1', 'VIN'], ['2', 'GND']]],
    ['OLED1', 'Display', [['1', '9V'], ['2', 'GND']]],
  ]);
  const setup = buildDcSetup(b, { rail: '9V', ground: 'GND', source: 'J1', loads: ['OLED1'] });
  assert.deepEqual(setup.source.groundPads.map((p) => p.net), ['GND']);
  assert.ok(setup.warnings.includes('Source J1 has no GND pad; the return ends at the GND pads of C7, the nearest part on VIN.'));
});

test('drawn streamlines: one per load, later ones end where they meet an earlier one, smoothing keeps the ends', () => {
  // A narrow neck from the source on the left to a wide area with two loads, one above the other.
  const src = pad('s', 'P', 1, 0.2, 2, 0.4, 0.6);
  const l1 = pad('l1', 'P', 1, 19.8, 3.5, 0.4, 1);
  const l2 = pad('l2', 'P', 1, 19.8, 0.5, 0.4, 1);
  const b = board(1, { pours: [pour('P', 1, [rect(5, 2, 10, 0.6)]), pour('P', 1, [rect(15, 2, 10, 4)])], pads: [src, l1, l2] });
  const setup: DcSetup = {
    ...terminalSetup(src, l1, 'P'),
    loads: [l1, l2].map((p) => ({ componentId: p.id, designator: p.id.toUpperCase(), railPads: [p], groundPads: [], current: 0.5 })),
  };
  const res = solveDc(b, setup, { cell: 0.2 });
  const all = traceStreamlines(res.grid, res.supply);
  const drawn = traceStreamlines(res.grid, res.supply, DRAWN_STREAMS);
  assert.ok(all.length > 2, 'three per load by default');
  assert.deepEqual(drawn.map((l) => l.load), ['L1', 'L2']);
  assert.ok(drawn.every((l) => l.complete));
  const pts = (i: number) => drawn[i].segments.flatMap((s) => s.pts);
  const first = pts(0);
  const second = pts(1);
  assert.ok(Math.abs(first[0].x - 0.2) < 0.5, 'the first streamline starts at the source');
  assert.ok(second[0].x > 1, 'the second starts on the first, not at the source');
  const gap = Math.min(...first.slice(1).map((q, i) => distPointSeg(second[0], first[i], q)));
  assert.ok(gap < 0.2, `on the first (${gap.toFixed(3)} mm away)`);
  assert.ok(Math.abs(second.at(-1)!.x - 19.8) < 0.3, 'and ends at its load');
});
