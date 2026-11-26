import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  focusInput,
  buildDcSetup,
  densityBin,
  densityContours,
  guessRails,
  loadsFor,
  isGroundNet,
  looksLikePowerNet,
  pairGround,
  parseCurrents,
  guessRailGroup,
  railBridges,
  railLabel,
  railNeighbours,
  railVoltage,
  rect,
  returnPads,
  solveDc,
  traceStreamlines,
  DRAWN_STREAMS,
  difference,
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

test('a trace narrower than a cell still cuts the pour: the line goes round it', () => {
  const cell = 1;
  // Centres land on the integers. The slot sits between x = -1 and x = 0, narrower than the cell,
  // and stops short of the pour so the copper joins again above and below it.
  const slot = rect(-0.5, 6, 0.4, 8);
  const src = pad('a', 'P', 1, -2, 6, 0.4, 0.4);
  const load = pad('b', 'P', 1, 3, 6, 0.4, 0.4);
  const b = board(1, { pours: [pour('P', 1, difference([rect(7.5, 6, 25, 16)], [slot]))], pads: [src, load] });
  const res = solveDc(b, terminalSetup(src, load, 'P'), { cell });
  const [sl] = traceStreamlines(res.grid, res.supply, { perLoad: 1, merge: false, smooth: true });
  assert.ok(sl.complete, 'the way round the trace reaches the load');
  const pts = sl.segments.flatMap((s) => s.pts);
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const q = pts[k];
    if ((a.x + 0.5) * (q.x + 0.5) >= 0) continue;
    const y = a.y + ((-0.5 - a.x) * (q.y - a.y)) / (q.x - a.x);
    assert.ok(y <= 2.3 || y >= 9.7, `the line crosses the trace at y = ${y.toFixed(2)}`);
  }
});

test('via holes between cell centres do not split the pour when copper still crosses the cell boundary', () => {
  const cell = 1;
  // One hole on every line of centres, each too short to cover the shared edge. Cutting the line
  // of centres would separate the two sides; the copper above and below each hole must still conduct.
  const holes = Array.from({ length: 15 }, (_, k) => rect(0.5, k - 1, 0.4, 0.3));
  const src = pad('a', 'P', 1, -2, 6, 0.4, 0.4);
  const load = pad('b', 'P', 1, 3, 6, 0.4, 0.4);
  const b = board(1, { pours: [pour('P', 1, difference([rect(7.5, 6, 25, 16)], holes))], pads: [src, load] });
  const res = solveDc(b, terminalSetup(src, load, 'P'), { cell });
  assert.deepEqual(res.supply.unconnected, []);
  assert.ok(res.supply.iterations > 0);
  assert.ok(res.supply.drop < 0.01, `drop ${res.supply.drop}`);
});

test('drawn lines do not join across a trace that separates them', () => {
  const cell = 0.5;
  // One cell wide, so the pour is gone there, and the two paths run within a join of each other.
  const slot = rect(5.25, 4, 0.5, 8);
  const src = pad('s', 'P', 1, 5.25, 9.5, 0.4, 0.4);
  const left = pad('l', 'P', 1, 4.75, 2, 0.3, 0.3);
  const right = pad('r', 'P', 1, 6.25, 2, 0.3, 0.3);
  const b = board(1, { pours: [pour('P', 1, difference([rect(6, 5, 12, 10)], [slot]))], pads: [src, left, right] });
  const setup: DcSetup = {
    rail: 'P',
    ground: 'GND',
    source: { componentId: 's', designator: 'S', railPads: [src], groundPads: [], current: 0 },
    loads: [
      { componentId: 'l', designator: 'L', railPads: [left], groundPads: [], current: 1 },
      { componentId: 'r', designator: 'R', railPads: [right], groundPads: [], current: 1 },
    ],
    normalised: true,
    warnings: [],
  };
  const res = solveDc(b, setup, { cell });
  const g = res.grid;
  const ix = Math.floor((5.25 - g.x0) / g.cell);
  const iy = Math.floor((2 - g.y0) / g.cell);
  const w = res.supply.layers[0].weight;
  assert.equal(w[iy * g.nx + ix], 0, 'the trace clears the cell between the paths');
  assert.ok(w[iy * g.nx + ix - 1] > 0 && w[iy * g.nx + ix + 1] > 0);
  const lines = traceStreamlines(g, res.supply, DRAWN_STREAMS);
  for (const sl of lines) {
    assert.ok(sl.complete, sl.load);
    const pts = sl.segments.flatMap((s) => s.pts);
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1];
      const q = pts[k];
      if ((a.x - 5.25) * (q.x - 5.25) >= 0) continue;
      const y = a.y + ((5.25 - a.x) * (q.y - a.y)) / (q.x - a.x);
      assert.ok(y >= 7.7, `${sl.load} joins across the trace at y = ${y.toFixed(2)}`);
    }
  }
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
    ['U8', 'LED', [['5', '3V3', 'VCC'], ['6', 'GND', 'NC'], ['7', 'GND', 'NC'], ['8', 'GND'], ['11', 'GND', 'GND']]],
  ]);
  const setup = buildDcSetup(b, { rail: 'SDA', ground: 'GND', source: 'CN1', loads: ['U1', 'U2', 'U3', 'U8'] });
  const [u1, u2, u3, u8] = setup.loads;
  assert.deepEqual(u1.groundPads.map((p) => p.pinName), ['GND']);
  assert.equal(u2.groundPads.length, 3, 'no pin names: every GND pad');
  assert.deepEqual(u3.groundPads.map((p) => p.pinName), ['GND', 'EP']);
  assert.deepEqual(u8.groundPads.map((p) => p.pinName), ['GND'], 'an NC pad, and a ground pad with no name, do not start a return once a GND pin is known');
  assert.ok(setup.warnings.some((w) => /U8: NC, NC, pad c4\.8 are tied to GND but carry no supply current; the return starts at GND/.test(w)), setup.warnings.join('\n'));
  assert.ok(setup.warnings.some((w) => /U1: A0, A1, A2 are tied to GND but carry no supply current; the return starts at GND/.test(w)), setup.warnings.join('\n'));
  assert.ok(setup.warnings.some((w) => /SDA does not look like a power rail/.test(w)));
  assert.deepEqual(returnPads(b.pads.filter((p) => p.componentId === 'c0'), 'GND').pads.map((p) => p.number), ['c0.2', 'c0.4']);
});

test('SD tied to ground draws no return; the sink is GND, EP, -Vo or VSS, and a header pin that is only a number still does', () => {
  const b = partsBoard([
    ['J1', 'Header', [['1', '5V', '1'], ['2', 'GND', '2'], ['3', 'GND', '3']]],
    ['U8', 'LED driver', [['5', '6V', 'VCC'], ['7', 'GND', 'SD'], ['11', 'GND', 'GND']]],
    ['U1', 'isolated', [['6', '12V', '+Vo'], ['7', 'GND', '-Vo'], ['8', 'GND', 'SD']]],
    ['U2', 'LDO', [['2', '3V3', 'VOUT'], ['3', 'GND', 'VSS'], ['4', 'GND', 'EN']]],
    ['U3', 'QFN', [['1', '3V3', 'VDD'], ['17', 'GND', 'EP'], ['18', 'GND', 'SD']]],
    ['U4', 'MCU', [['1', '3V3', 'VDD'], ['2', 'GND', 'IOVSS'], ['3', 'GND', 'DVSS'], ['4', 'GND', 'AVSS'], ['5', 'GND', 'NRST']]],
  ]);
  const setup = buildDcSetup(b, { rail: '5V', ground: 'GND', source: 'J1', loads: ['U8', 'U1', 'U2', 'U3', 'U4'] });
  const by = (des: string) => setup.loads.find((l) => l.designator === des)!;
  assert.deepEqual(by('U8').groundPads.map((p) => p.pinName), ['GND']);
  assert.deepEqual(by('U1').groundPads.map((p) => p.pinName), ['-Vo']);
  assert.deepEqual(by('U2').groundPads.map((p) => p.pinName), ['VSS']);
  assert.deepEqual(by('U3').groundPads.map((p) => p.pinName), ['EP']);
  assert.deepEqual(by('U4').groundPads.map((p) => p.pinName), ['IOVSS', 'DVSS', 'AVSS']);
  assert.deepEqual(setup.source.groundPads.map((p) => p.pinName), ['2', '3'], 'a header whose pins are only numbers still returns through each ground pin');
  const warnings = setup.warnings.join('\n');
  assert.match(warnings, /U8: SD is tied to GND but carries no supply current; the return starts at GND/);
  assert.match(warnings, /U1: SD is tied to GND but carries no supply current; the return starts at -Vo/);
  assert.match(warnings, /U2: EN is tied to GND but carries no supply current; the return starts at VSS/);
  assert.match(warnings, /U4: NRST is tied to GND but carries no supply current; the return starts at IOVSS, DVSS, AVSS/);
  assert.doesNotMatch(warnings, /^J1:/m);
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
  // It leaves the first along it, not at a corner.
  const k = first.slice(1).reduce((best, q, i) => (distPointSeg(second[0], first[i], q) < distPointSeg(second[0], first[best], first[best + 1]) ? i : best), 0);
  const along = { x: first[k + 1].x - first[k].x, y: first[k + 1].y - first[k].y };
  const off = second.find((q) => Math.hypot(q.x - second[0].x, q.y - second[0].y) > 0.3)!;
  const away = { x: off.x - second[0].x, y: off.y - second[0].y };
  const angle = (Math.acos((along.x * away.x + along.y * away.y) / Math.hypot(along.x, along.y) / Math.hypot(away.x, away.y)) * 180) / Math.PI;
  assert.ok(angle < 30, `joins at ${angle.toFixed(0)}° to the first`);
  // The joining line bends; it has no copper corner to turn around (the first turns at the neck's).
  // Direction change over 0.25 mm before and after each point, so it does not depend on how the points are thinned
  // (a bend of 0.5 mm radius turns about 30° over that length, a corner its whole angle).
  const even: { x: number; y: number }[] = [second[0]];
  for (let i = 1; i < second.length; i++) {
    const [a, b] = [second[i - 1], second[i]];
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 0.05));
    for (let m = 1; m <= n; m++) even.push({ x: a.x + ((b.x - a.x) * m) / n, y: a.y + ((b.y - a.y) * m) / n });
  }
  const turns = even.slice(10, -5).map((m, i) => {
    const [a, c] = [even[i + 5], even[i + 15]];
    const t = Math.atan2(c.y - m.y, c.x - m.x) - Math.atan2(m.y - a.y, m.x - a.x);
    return Math.abs(Math.atan2(Math.sin(t), Math.cos(t))) * (180 / Math.PI);
  });
  assert.ok(Math.max(...turns) < 40, `sharpest turn ${Math.max(...turns).toFixed(0)}° over 0.25 mm`);
});

test('a load\'s streamline follows its own current across an open pour, not the sum of the other loads', () => {
  // Source at the left, U4 straight across from it, and a second load well below. On one solid pour
  // U4's own current goes straight; the combined flow bends down towards the other load.
  const src = pad('s', 'GND', 1, 2, 10, 1.2, 1.2);
  const u4 = pad('u4', 'GND', 1, 38, 10, 1.2, 1.2);
  const other = pad('c', 'GND', 1, 20, 2, 1.2, 1.2);
  const b = board(1, { pours: [pour('GND', 1, [rect(20, 10, 40, 20)])], pads: [src, u4, other] });
  const setup: DcSetup = {
    rail: 'V',
    ground: 'GND',
    normalised: false,
    warnings: [],
    source: { componentId: 's', designator: 'S', railPads: [], groundPads: [src], current: 0 },
    loads: [
      { componentId: 'u4', designator: 'U4', railPads: [], groundPads: [u4], current: 0.1 },
      { componentId: 'c', designator: 'C23', railPads: [], groundPads: [other], current: 0.1 },
    ],
  };
  const res = solveDc(b, setup, { cell: 0.5 });
  assert.ok(res.ret!.loadCells.every((l) => l.own), 'each load solved on its own');
  const bow = (pts: { x: number; y: number }[]) => {
    const [a, c] = [pts[0], pts[pts.length - 1]];
    const dx = c.x - a.x;
    const dy = c.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    return Math.max(...pts.map((p) => Math.abs(dx * (p.y - a.y) - dy * (p.x - a.x)) / l));
  };
  const lines = traceStreamlines(res.grid, res.ret!, { perLoad: 1, merge: false, smooth: false });
  const u = lines.find((l) => l.load === 'U4')!;
  const off = bow(u.segments.flatMap((s) => s.pts));
  assert.ok(off < 3, `U4 bows ${off.toFixed(1)} mm off the straight line to the source`);
});

test('a rail of two nets joined by a fuse: solved as one, the line runs through the fuse to the load beyond it', () => {
  // VBUS_R from the connector to the fuse, VBUS_RAW from the fuse to the load; the copper of the two nets does not touch.
  const comp = (id: string, designator: string, pads: Pad[]): Component => ({ id, designator, at: pads[0].at, rotation: 0, layer: 1, padIds: pads.map((p) => p.id) });
  const j1 = [pad('j1.1', 'VBUS_R', 1, 0.6, 2, 0.8, 0.8, 'j1'), pad('j1.2', 'GND', 1, 0.6, 4.5, 0.8, 0.8, 'j1')];
  const f1 = [pad('f1.1', 'VBUS_R', 1, 9.4, 2, 0.8, 0.8, 'f1'), pad('f1.2', 'VBUS_RAW', 1, 11.1, 2, 0.8, 0.8, 'f1')];
  const u1 = [pad('u1.1', 'VBUS_RAW', 1, 19.4, 2, 0.8, 0.8, 'u1'), pad('u1.2', 'GND', 1, 19.4, 4.5, 0.8, 0.8, 'u1')];
  const b = board(1, {
    pads: [...j1, ...f1, ...u1],
    components: [comp('j1', 'J1', j1), comp('f1', 'F1', f1), comp('u1', 'U1', u1)],
    pours: [pour('VBUS_R', 1, [rect(5, 2, 10, 3)]), pour('VBUS_RAW', 1, [rect(15.25, 2, 9.5, 3)]), pour('GND', 1, [rect(10, 4.5, 20, 1)])],
    nets: ['VBUS_R', 'VBUS_RAW', 'GND'],
  });
  assert.deepEqual(railNeighbours(b, 'VBUS_R'), [{ net: 'VBUS_RAW', via: 'F1' }]);
  assert.deepEqual(buildDcSetup(b, { rail: 'VBUS_R', ground: 'GND', source: 'J1' }).loads.map((l) => l.designator), [], 'VBUS_R alone: the load is beyond the fuse');

  const setup = buildDcSetup(b, { rail: 'VBUS_R', railNets: ['VBUS_RAW'], ground: 'GND', source: 'J1' });
  assert.equal(railLabel(setup), 'VBUS_R + VBUS_RAW');
  assert.deepEqual(setup.loads.map((l) => l.designator), ['U1'], 'the fuse joins the nets; it is no load');
  assert.deepEqual(railBridges(b, setup.railNets!).map((x) => x.designator), ['F1']);
  assert.ok(setup.warnings.some((w) => /F1 joins VBUS_R \+ VBUS_RAW, taken as a short/.test(w)));

  assert.deepEqual(railNeighbours(b, 'vbus_r'), [{ net: 'VBUS_RAW', via: 'F1' }], 'a net name in any case is the board net');
  const lower = buildDcSetup(b, { rail: 'vbus_r', railNets: ['Vbus_Raw', 'VBUS_r'], ground: 'gnd', source: 'J1' });
  assert.deepEqual([lower.rail, lower.railNets, lower.ground], ['VBUS_R', ['VBUS_R', 'VBUS_RAW'], 'GND']);
  assert.deepEqual(lower.loads.map((l) => [l.designator, l.railPads.length, l.groundPads.length]), [['U1', 1, 1]]);
  assert.deepEqual(guessRailGroup(b, ['vbus_r', 'VBUS_RAW']).source?.designator, guessRailGroup(b, ['VBUS_R', 'VBUS_RAW']).source?.designator);
  const res = solveDc(b, setup, { cell: 0.2 });
  assert.equal(res.supply.net, 'VBUS_R + VBUS_RAW');
  assert.deepEqual(res.supply.unconnected, []);
  // Copper only: 9 mm + 8.6 mm of 3 mm wide 35 µm copper at 1 A, about 3 mΩ.
  assert.ok(res.supply.drop > 0.002 && res.supply.drop < 0.005, `drop ${(res.supply.drop * 1000).toFixed(2)} mV`);
  const [line] = traceStreamlines(res.grid, res.supply, DRAWN_STREAMS);
  assert.ok(line.complete, 'the line reaches the connector');
  const pts = line.segments.flatMap((sg) => sg.pts);
  for (const fp of f1) assert.ok(pts.some((q) => Math.hypot(q.x - fp.at.x, q.y - fp.at.y) < 0.3), `through F1 pad ${fp.id}`);
  assert.ok(Math.hypot(pts[0].x - 0.6, pts[0].y - 2) < 0.6 && Math.hypot(pts.at(-1)!.x - 19.4, pts.at(-1)!.y - 2) < 0.6, 'from the connector to the load');
});

test('a converter behind a shunt and a jumper: the chain to it is offered, it is the source, the sense IC is no load and no short', () => {
  // U1 +Vo → $1N261 → R7 (shunt) → $1N260 → J3 (jumper) → +12V; U19 senses across R7; U5 bucks 12 V to 3V3 through L4.
  const b = partsBoard([
    ['U1', 'isolated DC-DC', [['2', '48V', 'Vin'], ['1', '48V_PGND', 'GND'], ['6', '$1N261', '+Vo'], ['7', 'GND', '-Vo']]],
    ['R7', '10m', [['1', '$1N261'], ['2', '$1N260']]],
    ['J3', 'jumper', [['1', '+12V'], ['2', '$1N260']]],
    ['U19', 'INA219', [['10', '$1N261', 'VIN+'], ['9', '$1N260', 'VIN-'], ['7', 'GND', 'GND'], ['6', '3V3', 'VS+'], ['4', 'SDA', 'SDA']]],
    ['U4', 'buck', [['3', '+12V', 'VIN'], ['1', 'GND', 'GND'], ['2', '$SWA', 'SW']]],
    ['L4', '10uH', [['1', '$SWA'], ['2', '3V3']]],
    ['U2', 'MCU', [['1', '3V3', 'VDD'], ['2', 'GND', 'GND']]],
  ]);
  assert.deepEqual(railNeighbours(b, '+12V'), [{ net: '$1N260', via: 'J3' }, { net: '$1N261', via: 'R7' }], 'the unnamed nets count because the chain ends at a converter output');
  assert.deepEqual(railNeighbours(b, '3V3'), [], 'not through an output inductor onto a switch node');
  const nets = ['+12V', '$1N260', '$1N261'];
  const g = guessRailGroup(b, nets);
  assert.equal(g.source?.designator, 'U1', '+Vo is a converter output');
  assert.deepEqual(g.loads.map((l) => l.designator), ['U4']);
  assert.ok(g.excluded.some((e) => e.designator === 'U19' && /sits across/.test(e.why)));
  assert.deepEqual(railBridges(b, nets).map((x) => x.designator), ['R7', 'J3'], 'U19 has pads elsewhere: not a short between the nets');
  const alone = buildDcSetup(b, { rail: '+12V', ground: 'GND', source: 'J3' });
  assert.deepEqual(alone.source.groundPads.map((p) => p.pinName), ['-Vo'], 'J3 alone: the return still ends at the converter, not at the sense IC beside it');
  assert.ok(alone.warnings.some((w) => /the supply behind it on \$1N261/.test(w)));
});

test('an eFuse with other pins still joins its input net to its output net, so the far side carries the current', () => {
  const comp = (id: string, designator: string, pads: Pad[]): Component => ({ id, designator, at: pads[0].at, rotation: 0, layer: 1, padIds: pads.map((p) => p.id) });
  const j1 = [pad('j1.1', 'VBUS', 1, 0, 0, 0.6, 0.6, 'j1'), pad('j1.2', 'GND', 1, 0, 3, 0.6, 0.6, 'j1')];
  const e1 = [
    pad('e1.in', 'VBUS', 1, 8, 0, 0.6, 0.6, 'e1', 'IN'),
    pad('e1.out', '48V', 1, 12, 0, 0.6, 0.6, 'e1', 'OUT'),
    pad('e1.gnd', 'GND', 1, 10, 2, 0.6, 0.6, 'e1', 'GND'),
    pad('e1.uv', '$UV', 1, 10, 3, 0.4, 0.4, 'e1', 'UVLO'),
  ];
  const c6 = [pad('c6.1', '48V', 1, 20, 0, 0.6, 0.6, 'c6'), pad('c6.2', 'GND', 1, 20, 3, 0.6, 0.6, 'c6')];
  const b = board(1, {
    pads: [...j1, ...e1, ...c6],
    components: [comp('j1', 'J1', j1), comp('e1', 'E1', e1), comp('c6', 'C6', c6)],
    tracks: [
      { id: 't1', net: 'VBUS', layer: 1, a: { x: 0, y: 0 }, b: { x: 8, y: 0 }, width: 0.5 },
      { id: 't2', net: '48V', layer: 1, a: { x: 12, y: 0 }, b: { x: 20, y: 0 }, width: 0.5 },
      { id: 'tg', net: 'GND', layer: 1, a: { x: 0, y: 3 }, b: { x: 20, y: 3 }, width: 0.5 },
    ],
  });
  const setup = buildDcSetup(b, { rail: '48V', railNets: ['VBUS'], ground: 'GND', source: 'J1', loads: ['C6'], currents: { C6: 0.1 } });
  assert.deepEqual(setup.bridges?.map((x) => x.designator), ['E1']);
  assert.ok(setup.warnings.some((w) => /E1 joins 48V \+ VBUS, taken as a short/.test(w)));
  assert.ok(!setup.warnings.some((w) => /No part joins/.test(w)));
  const res = solveDc(b, setup, { cell: 0.25 });
  assert.deepEqual(res.supply.unconnected, [], 'C6 on 48V is reached from J1 on VBUS through E1');
  const line = traceStreamlines(res.grid, res.supply, { perLoad: 1, merge: false, smooth: false }).find((l) => l.load === 'C6');
  assert.ok(line?.complete, 'the forward line runs along the 48V track');
  const pts = line!.segments.flatMap((s) => s.pts);
  assert.ok(pts.some((p) => p.x <= 8) && pts.some((p) => p.x >= 19), 'the line crosses E1 onto the 48V track and reaches C6');
});

test('focusInput: one part of the rail, with its own current when one was given', () => {
  const input = { rail: '3V3', ground: 'GND', source: 'U1', loads: ['U2', 'U3'], currents: { U2: 0.15, U3: 0.02 } };
  assert.deepEqual(focusInput(input, 'U3'), { rail: '3V3', ground: 'GND', source: 'U1', loads: ['U3'], currents: { U3: 0.02 } });
  assert.deepEqual(focusInput({ ...input, currents: undefined }, 'U2'), { rail: '3V3', ground: 'GND', source: 'U1', loads: ['U2'] }, 'none given: per amp');
});

/** Length over chord of each drawn piece, and the layers in order. */
function pieces(res: ReturnType<typeof solveDc>) {
  const [sl] = traceStreamlines(res.grid, res.supply, DRAWN_STREAMS);
  assert.ok(sl.complete);
  return {
    layers: sl.segments.map((s) => s.layer),
    segments: sl.segments.map((s) => {
      let len = 0;
      for (let i = 1; i < s.pts.length; i++) len += Math.hypot(s.pts[i].x - s.pts[i - 1].x, s.pts[i].y - s.pts[i - 1].y);
      const a = s.pts[0];
      const b = s.pts.at(-1)!;
      return { layer: s.layer, pts: s.pts, len, chord: Math.hypot(b.x - a.x, b.y - a.y) };
    }),
  };
}

test('drawn streamline: two stitched planes carry the flow together; the line stays on the layer of its pads', () => {
  // Both layers are full planes of the net, stitched by vias on and beside the straight path; the
  // pads are on L1. Each via hands over only a small part of the flow, so the line has no reason to
  // visit L2 between them.
  const src = pad('s', 'P', 1, 0.5, 3, 0.6, 0.6);
  const load = pad('l', 'P', 1, 29.5, 3, 0.6, 0.6);
  const vias = [3, 5.5, 8, 10.5, 13, 15.5, 18, 20.5, 23, 25.5].flatMap((x) => [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5].map((y) => ({ id: `v${x}-${y}`, net: 'P', at: { x, y }, drill: 0.3, diameter: 0.6, stitching: true })));
  const b = board(2, { pours: [pour('P', 1, [rect(15, 3, 30, 6)]), pour('P', 2, [rect(15, 3, 30, 6)])], vias, pads: [src, load] });
  const res = solveDc(b, terminalSetup(src, load, 'P'), { cell: 0.25 });
  assert.ok(res.supply.layers[1].flow > 0.3 * res.supply.layers[0].flow, 'L2 carries a real share of the flow');
  const { layers } = pieces(res);
  assert.deepEqual(layers, [1]);
});

test('drawn streamline: from a via into a plane to a via out of it, the line takes the straight path', () => {
  // L2 tracks bring the current to via A and take it from via B; between them it crosses an L1 plane
  // that extends far to one side. Its densest path is the straight line between the vias.
  const src = pad('s', 'P', 2, 2, 8, 0.6, 0.6);
  const load = pad('l', 'P', 2, 28, 8, 0.6, 0.6);
  const b = board(2, {
    pours: [pour('P', 1, [rect(10, 5, 20, 10)])],
    tracks: [
      { id: 'ta', net: 'P', layer: 2, a: { x: 2, y: 8 }, b: { x: 12, y: 8 }, width: 0.5 },
      { id: 'tb', net: 'P', layer: 2, a: { x: 17, y: 8 }, b: { x: 28, y: 8 }, width: 0.5 },
    ],
    vias: [
      { id: 'a', net: 'P', at: { x: 12, y: 8 }, drill: 0.3, diameter: 0.6, stitching: false },
      { id: 'b', net: 'P', at: { x: 17, y: 8 }, drill: 0.3, diameter: 0.6, stitching: false },
    ],
    pads: [src, load],
  });
  const res = solveDc(b, terminalSetup(src, load, 'P'), { cell: 0.2 });
  const { layers, segments } = pieces(res);
  assert.deepEqual(layers, [2, 1, 2]);
  const plane = segments[1];
  assert.ok(plane.len < 1.1 * plane.chord, `through the plane: ${plane.len.toFixed(2)} mm for ${plane.chord.toFixed(2)} mm between the vias`);
  assert.ok(plane.pts.every((p) => Math.abs(p.y - 8) < 0.25), `off the straight line by ${Math.max(...plane.pts.map((p) => Math.abs(p.y - 8))).toFixed(2)} mm`);
});

test('voltage drop is reported at each load, and a track, a pour neck or a via too narrow for its current is named', () => {
  const src = pad('a', 'P', 1, 0, 0, 0.4, 0.4);
  const load = pad('b', 'P', 1, 20, 0, 0.4, 0.4);
  const thin = board(1, { tracks: [{ id: 't', net: 'P', layer: 1, a: { x: 0, y: 0 }, b: { x: 20, y: 0 }, width: 0.15 }], pads: [src, load] });
  const thinRes = solveDc(thin, terminalSetup(src, load, 'P'), { cell: 0.25 });
  assert.equal(thinRes.supply.loadDrops.length, 1);
  assert.ok(Math.abs(thinRes.supply.drop - thinRes.supply.loadDrops[0].drop) < 1e-6, 'the net drop is the drop at the load');
  assert.ok(thinRes.warnings.some((w) => /0\.15 mm track on L1 carries/.test(w) && /IPC-2221/.test(w) && /10°C/.test(w)), thinRes.warnings.join('\n'));
  assert.ok(!thinRes.warnings.some((w) => /choke/.test(w)), 'the track is the choke; it is not reported twice');

  const wide = board(1, { pours: [pour('P', 1, [rect(10, 0, 20, 2)])], pads: [src, load] });
  const wideRes = solveDc(wide, terminalSetup(src, load, 'P'), { cell: 0.2 });
  assert.ok(!wideRes.warnings.some((w) => /IPC-2221/.test(w)), wideRes.warnings.join('\n'));

  const neckSrc = pad('ns', 'P', 1, 1, 0, 0.6, 0.6);
  const neckLoad = pad('nl', 'P', 1, 19, 0, 0.6, 0.6);
  const neck = board(1, { pours: [pour('P', 1, [rect(10, 0, 20, 0.25)])], pads: [neckSrc, neckLoad] });
  const neckRes = solveDc(neck, terminalSetup(neckSrc, neckLoad, 'P'), { cell: 0.1 });
  assert.ok(neckRes.warnings.some((w) => /choke at /.test(w) && /IPC-2221/.test(w)), neckRes.warnings.join('\n'));

  const viaBoard = (drill: number) => board(2, {
    pours: [pour('P', 1, [rect(5, 1, 10, 2)]), pour('P', 2, [rect(15, 1, 10, 2)])],
    vias: [{ id: 'v', net: 'P', at: { x: 10, y: 1 }, drill, diameter: drill * 2, stitching: false }],
    pads: [pad('a', 'P', 1, 0.5, 1, 0.4, 0.4), pad('b', 'P', 2, 19.5, 1, 0.4, 0.4)],
  });
  const small = solveDc(viaBoard(0.12), terminalSetup(pad('a', 'P', 1, 0.5, 1, 0.4, 0.4), pad('b', 'P', 2, 19.5, 1, 0.4, 0.4), 'P'), { cell: 0.2 });
  assert.ok(small.warnings.some((w) => /via at \(10\.0, 1\.0\) mm/.test(w) && /0\.12 mm drill/.test(w)), small.warnings.join('\n'));
  const ordinary = solveDc(viaBoard(0.3), terminalSetup(pad('a', 'P', 1, 0.5, 1, 0.4, 0.4), pad('b', 'P', 2, 19.5, 1, 0.4, 0.4), 'P'), { cell: 0.2 });
  assert.ok(!ordinary.warnings.some((w) => /via at/.test(w)), ordinary.warnings.join('\n'));
});
