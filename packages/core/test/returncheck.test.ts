import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { analyzeNet, assignChokes, checkReturn, guessDrive, guessEdge, rect, viewOf, withProps, worseEnd, type Analysis, type Board, type NetCheck, type Pad, type Path } from '../src/index.js';

const TOP = 1;
const BOT = 2;

function bare(forward: Path, ret: Path, h = 1.6): { board: Board; analysis: Analysis } {
  const board: Board = {
    outline: [rect(20, 0, 50, 20)],
    stackup: {
      copper: [
        { id: TOP, name: 'Top', index: 0, z: 0, thicknessMm: 0.035 },
        { id: BOT, name: 'Bottom', index: 1, z: h, thicknessMm: 0.035 },
      ],
      dielectrics: [{ name: 'core', thicknessMm: h }],
    },
    nets: ['SIG', 'GND', 'OTHER'],
    tracks: [
      { id: 't', net: 'SIG', layer: TOP, a: forward[0], b: forward[forward.length - 1], width: 0.2 },
      { id: 'o', net: 'OTHER', layer: BOT, a: { x: 14, y: 1.2 }, b: { x: 16, y: 1.2 }, width: 0.2 },
    ],
    vias: [],
    pads: [],
    components: [],
    pours: [],
    keepouts: [],
    warnings: [],
  };
  const analysis = {
    net: 'SIG',
    chains: [{
      chain: { net: 'SIG', layer: TOP, pts: forward, trackIds: ['t'] },
      ref: { layer: BOT, h },
      refNets: ['GND'],
      band: [],
      bandUncovered: [],
      half: [],
      coverage: [],
      thin: [],
      gaps: [],
      quietGaps: [],
    }],
    returnPath: {
      traces: [{ layer: BOT, signalLayer: TOP, pts: ret }],
      jumps: [],
      drivers: [],
      marks: [],
      transitions: [],
      length: 0,
    },
  } as unknown as Analysis;
  return { board, analysis };
}

test('edge class and drive type are guessed from the name', () => {
  assert.equal(guessEdge('SCK'), 'fast');
  assert.equal(guessEdge('BCLK'), 'fast');
  assert.equal(guessEdge('WCLK'), 'fast');
  assert.equal(guessEdge('CS'), 'normal');
  assert.equal(guessEdge('MOSI'), 'normal');
  assert.equal(guessEdge('RAD_RX'), 'slow');
  assert.equal(guessEdge('SCL'), 'slow');
  assert.equal(guessEdge('nRESET'), 'slow');
  const board = bare([{ x: 0, y: 0 }, { x: 10, y: 0 }], [{ x: 0, y: 0 }, { x: 10, y: 0 }]).board;
  board.components = [{ id: 'r1', designator: 'R1', at: { x: 1, y: 1 }, rotation: 0, layer: TOP, padIds: ['a', 'b'] }];
  const pad = (id: string, net: string, x: number): Pad => ({ id, net, layer: TOP, number: '1', at: { x, y: 1 }, shape: [], holeDiameter: 0, componentId: 'r1' });
  board.pads = [pad('a', 'INT', 0), pad('b', '3V3', 2)];
  assert.equal(guessDrive(board, 'INT'), 'open-drain');
  assert.equal(guessDrive(board, 'CS'), 'push-pull');
  board.pads = [pad('a', 'GPIO1', 0), pad('b', '3V3', 2)];
  assert.equal(guessDrive(board, 'GPIO1'), 'open-drain');
});

test('an offset of a few millimetres is a note, and a small one is only a tick', () => {
  const forward: Path = [{ x: 0, y: 0 }, { x: 40, y: 0 }];
  const noted: Path = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 1.2 }, { x: 20, y: 1.2 }, { x: 20, y: 0 }, { x: 40, y: 0 }];
  const { board, analysis } = bare(forward, noted);
  const check = checkReturn(board, analysis, { edge: 'normal', drive: 'push-pull' });
  assert.equal(check.excursions.length, 1);
  assert.equal(check.excursions[0].grade, 'note');
  assert.ok(check.excursions[0].dA > 8 && check.excursions[0].dA < 20, `dA ${check.excursions[0].dA}`);
  assert.equal(check.excursions[0].blocker, 'OTHER');
  assert.ok(check.rW < 0.25, `r_w ${check.rW}`);
  assert.equal(check.score, Math.round(100 / (1 + check.rW)));
  assert.ok(check.kept.some((t) => t.pts.some((p) => p.y > 1)), 'a note keeps its detour');

  const minor: Path = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0.5 }, { x: 12, y: 0.5 }, { x: 12, y: 0 }, { x: 40, y: 0 }];
  const small = bare(forward, minor);
  const m = checkReturn(small.board, small.analysis, { edge: 'normal', drive: 'open-drain' });
  assert.equal(m.excursions.length, 1);
  assert.equal(m.excursions[0].grade, 'minor');
  assert.ok(m.excursions[0].tick, 'a tick on the forward trace');
  assert.ok(m.kept.every((t) => t.pts.every((p) => p.y < 0.2)), 'the minor detour is not drawn');
});

test('a return via far from the signal via is a missing via, and a long ground lead is flagged', () => {
  const forward: Path = [{ x: 0, y: 0 }, { x: 30, y: 0 }];
  const ret: Path = [{ x: 0, y: -8 }, { x: 0, y: 0 }, { x: 30, y: 0 }];
  const { board, analysis } = bare(forward, ret);
  board.components = [
    { id: 'u1', designator: 'U1', at: { x: 0, y: 0 }, rotation: 0, layer: TOP, padIds: ['s', 'g', 'v'] },
  ];
  const pad = (id: string, net: string, at: { x: number; y: number }, pin: string): Pad => ({
    id, net, layer: TOP, number: pin, at, shape: [rect(at.x, at.y, 0.5, 0.5)], holeDiameter: 0, componentId: 'u1', pinName: pin,
  });
  board.pads = [pad('s', 'SIG', { x: 0, y: 0 }, 'OUT'), pad('g', 'GND', { x: 0, y: -8 }, 'GND'), pad('v', '3V3', { x: 2, y: 0 }, 'VDD')];
  board.vias = [
    { id: 'sv', net: 'SIG', at: { x: 15, y: 3.2 }, drill: 0.3, diameter: 0.6, stitching: false },
    { id: 'gv', net: 'GND', at: { x: 15, y: 6 }, drill: 0.3, diameter: 0.6, stitching: true },
  ];
  analysis.returnPath.transitions = [{ at: { x: 15, y: 6 }, fromLayer: TOP, toLayer: BOT, distance: 6 }];
  const check = checkReturn(board, analysis, { driver: 'U1', edge: 'normal', drive: 'open-drain' });
  const hop = check.hops[0];
  assert.equal(check.hops.length, 1);
  assert.ok(hop.distance > check.h && hop.distance <= 3 * check.h, `via distance ${hop.distance}`);
  assert.equal(hop.grade, 'note');
  assert.equal(hop.fromSignalVia, true);
  assert.match(check.terms.find((t) => t.kind === 'transition')!.fix, /within ~4\.8 mm/);
  board.vias = board.vias.filter((v) => v.net !== 'SIG');
  const far = checkReturn(board, analysis, { driver: 'U1', edge: 'normal', drive: 'open-drain' });
  assert.equal(far.hops.length, 0, 'no signal via, so the return via is not a layer transition');
  const gnd = check.closures.find((c) => c.kind === 'gnd');
  assert.ok(gnd && gnd.grade === 'flag' && /no ground via/.test(gnd.text), JSON.stringify(gnd));
  assert.ok(check.closures.some((c) => c.kind === 'vdd' && c.grade === 'flag'), 'the missing decap is recorded');
  const pushed = withProps(check, { drive: 'push-pull' });
  assert.ok(pushed.score < check.score, 'open-drain does not pay for the supply loop; push-pull does');
});

test('a via on the closure lead is not also a layer transition', () => {
  const forward: Path = [{ x: 0, y: 0 }, { x: 30, y: 0 }];
  const ret: Path = [{ x: 0, y: -6 }, { x: 0, y: 0 }, { x: 30, y: 0 }];
  const { board, analysis } = bare(forward, ret, 0.2);
  board.components = [{ id: 'u1', designator: 'U1', at: { x: 0, y: 0 }, rotation: 0, layer: TOP, padIds: ['s', 'g', 'v'] }];
  const pad = (id: string, net: string, at: { x: number; y: number }, pin: string): Pad => ({
    id, net, layer: TOP, number: pin, at, shape: [], holeDiameter: 0, componentId: 'u1', pinName: pin,
  });
  const gndPad = pad('g', 'GND', { x: 0, y: -6 }, 'GND');
  gndPad.shape = [rect(0, -4.5, 2, 4)];
  board.pads = [pad('s', 'SIG', { x: 0, y: 0 }, 'OUT'), gndPad, pad('v', '3V3', { x: 1, y: 0 }, 'VDD')];
  board.vias = [
    { id: 'sv', net: 'SIG', at: { x: 15, y: 0 }, drill: 0.3, diameter: 0.6, stitching: false },
    { id: 'rv', net: 'GND', at: { x: 15, y: 1.5 }, drill: 0.3, diameter: 0.6, stitching: true },
    { id: 'cv', net: 'GND', at: { x: 0, y: -3 }, drill: 0.3, diameter: 0.6, stitching: true },
  ];
  analysis.returnPath.transitions = [
    { at: { x: 0, y: -3 }, fromLayer: TOP, toLayer: BOT, distance: 0 },
    { at: { x: 15, y: 1.5 }, fromLayer: TOP, toLayer: BOT, distance: 1.5 },
  ];
  const check = checkReturn(board, analysis, { driver: 'U1', edge: 'fast', drive: 'open-drain' });
  assert.equal(check.hops.length, 1);
  assert.ok(Math.abs(check.hops[0].at.x - 15) < 0.01, `hop at ${check.hops[0].at.x}`);
  assert.match(check.terms.find((t) => t.kind === 'transition')!.fix, /within ~1\.0 mm/);
  const gnd = check.closures.find((c) => c.kind === 'gnd');
  assert.ok(gnd && gnd.length < 4 && gnd.grade === 'ok', JSON.stringify(gnd));
});

test('the ground via in the exposed pad closes the loop, graded against the trace length', () => {
  const forward: Path = [{ x: 0, y: 0 }, { x: 40, y: 0 }];
  const ret: Path = [{ x: 0, y: -8 }, { x: 0, y: 0 }, { x: 40, y: 0 }];
  const { board, analysis } = bare(forward, ret, 0.2);
  board.components = [{ id: 'u1', designator: 'U1', at: { x: 0, y: 0 }, rotation: 0, layer: TOP, padIds: ['s', 'g', 'e', 'v'] }];
  const pad = (id: string, net: string, at: { x: number; y: number }, pin: string): Pad => ({
    id, net, layer: TOP, number: pin, at, shape: [], holeDiameter: 0, componentId: 'u1', pinName: pin,
  });
  const ep = pad('e', 'GND', { x: 1.5, y: -1 }, 'EP');
  ep.shape = [rect(1.5, -1, 3, 3)];
  board.pads = [pad('s', 'SIG', { x: 0, y: 0 }, 'OUT'), pad('g', 'GND', { x: 0, y: -8 }, 'GND'), ep, pad('v', '3V3', { x: 0.4, y: 0.5 }, 'VDD')];
  board.vias = [
    { id: 'ep', net: 'GND', at: { x: 1.2, y: -0.6 }, drill: 0.3, diameter: 0.6, stitching: false },
    { id: 'far', net: 'GND', at: { x: 0, y: -7.5 }, drill: 0.3, diameter: 0.6, stitching: true },
  ];
  const check = checkReturn(board, analysis, { driver: 'U1', edge: 'fast', drive: 'push-pull' });
  const gnd = check.closures.find((c) => c.kind === 'gnd');
  assert.ok(gnd && gnd.length < 2.5, `closure followed the far pad: ${gnd?.length}`);
  assert.equal(gnd!.grade, 'ok');
  assert.equal(check.closures.find((c) => c.kind === 'vdd')?.grade, 'flag');
});

test('the decap is measured from the supply pin nearest the signal pin', () => {
  const forward: Path = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
  const ret: Path = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
  const { board, analysis } = bare(forward, ret, 0.2);
  board.components = [
    { id: 'u1', designator: 'U1', at: { x: 0, y: 0 }, rotation: 0, layer: TOP, padIds: ['s', 'g', 'va', 'vb'] },
    { id: 'c1', designator: 'C1', at: { x: 9, y: 0 }, rotation: 0, layer: TOP, padIds: ['ca', 'cb'] },
  ];
  const pad = (id: string, net: string, at: { x: number; y: number }, pin: string, comp: string): Pad => ({
    id, net, layer: TOP, number: pin, at, shape: [], holeDiameter: 0, componentId: comp, pinName: pin,
  });
  board.pads = [
    pad('s', 'SIG', { x: 0, y: 0 }, 'SCK', 'u1'),
    pad('g', 'GND', { x: 0, y: -1 }, 'GND', 'u1'),
    pad('va', '3V3', { x: 0.3, y: 0.3 }, 'VDD', 'u1'),
    pad('vb', '3V3', { x: 8, y: 0 }, 'VDD', 'u1'),
    pad('ca', '3V3', { x: 8.4, y: 0.4 }, '1', 'c1'),
    pad('cb', 'GND', { x: 9.2, y: 0.4 }, '2', 'c1'),
  ];
  board.vias = [{ id: 'gv', net: 'GND', at: { x: 0, y: -0.8 }, drill: 0.2, diameter: 0.4, stitching: true }];
  const check = checkReturn(board, analysis, { driver: 'U1', edge: 'normal', drive: 'push-pull' });
  const vdd = check.closures.find((c) => c.kind === 'vdd');
  assert.ok(vdd && vdd.length > 6, `decap length ${vdd?.length}`);
  assert.equal(vdd!.grade, 'flag');
});

test('closure and decap between a quarter and a half of the trace are a note', () => {
  const forward: Path = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
  const ret: Path = [{ x: 0, y: -3 }, { x: 0, y: 0 }, { x: 10, y: 0 }];
  const { board, analysis } = bare(forward, ret, 0.2);
  board.components = [
    { id: 'u1', designator: 'U1', at: { x: 0, y: 0 }, rotation: 0, layer: TOP, padIds: ['s', 'g', 'v'] },
    { id: 'c1', designator: 'C1', at: { x: 3, y: 1 }, rotation: 0, layer: TOP, padIds: ['ca', 'cb'] },
  ];
  const pad = (id: string, net: string, at: { x: number; y: number }, pin: string, comp: string): Pad => ({
    id, net, layer: TOP, number: pin, at, shape: [], holeDiameter: 0, componentId: comp, pinName: pin,
  });
  const gndPad = pad('g', 'GND', { x: 0, y: -6 }, 'GND', 'u1');
  gndPad.shape = [rect(0, -4.5, 2, 4)];
  board.pads = [
    pad('s', 'SIG', { x: 0, y: 0 }, 'OUT', 'u1'),
    gndPad,
    pad('v', '3V3', { x: 0.2, y: 0.2 }, 'VDD', 'u1'),
    pad('ca', '3V3', { x: 3, y: 0.5 }, '1', 'c1'),
    pad('cb', 'GND', { x: 3, y: 1.2 }, '2', 'c1'),
  ];
  board.vias = [{ id: 'gv', net: 'GND', at: { x: 0, y: -3 }, drill: 0.3, diameter: 0.6, stitching: true }];
  const check = checkReturn(board, analysis, { driver: 'U1', edge: 'normal', drive: 'push-pull' });
  const gnd = check.closures.find((c) => c.kind === 'gnd');
  const vdd = check.closures.find((c) => c.kind === 'vdd');
  assert.equal(gnd?.grade, 'note', JSON.stringify(gnd));
  assert.equal(vdd?.grade, 'note', JSON.stringify(vdd));
});

test('one via antipad under the trace is minor whatever its area', () => {
  const forward: Path = [{ x: 0, y: 0 }, { x: 40, y: 0 }];
  const ret: Path = [{ x: 0, y: 0 }, { x: 19, y: 0 }, { x: 20, y: 0.8 }, { x: 21, y: 0 }, { x: 40, y: 0 }];
  const { board, analysis } = bare(forward, ret, 0.2);
  board.vias = [{ id: 'v', net: 'GND', at: { x: 20, y: 0 }, drill: 0.3, diameter: 0.6, stitching: true }];
  const check = checkReturn(board, analysis, { edge: 'fast', drive: 'push-pull' });
  assert.equal(check.excursions.length, 1);
  assert.equal(check.excursions[0].antipad, true);
  assert.equal(check.excursions[0].grade, 'minor');
  assert.ok(check.r < 0.01, `r ${check.r}`);
  assert.ok(check.score >= 90, `score ${check.score}`);
  const wide: Path = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 12, y: 3 }, { x: 22, y: 3 }, { x: 24, y: 0 }, { x: 40, y: 0 }];
  const big = bare(forward, wide, 0.2);
  big.board.vias = [{ id: 'v', net: 'GND', at: { x: 16, y: 0 }, drill: 0.3, diameter: 0.6, stitching: true }];
  const flagged = checkReturn(big.board, big.analysis, { edge: 'fast', drive: 'push-pull' });
  assert.ok(flagged.excursions.some((e) => e.grade === 'flag' && !e.antipad), flagged.excursions.map((e) => e.grade).join(','));
});

test('a stretch outside ±h that never rejoins the trace is a solver error', () => {
  const forward: Path = [{ x: 0, y: 0 }, { x: 20, y: 0 }];
  const ret: Path = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 16, y: 4 }];
  const { board, analysis } = bare(forward, ret);
  const check = checkReturn(board, analysis, { edge: 'slow', drive: 'push-pull' });
  assert.equal(check.excursions.length, 0);
  assert.ok(check.errors.length === 1, `errors ${check.errors.length}`);
  assert.ok(check.kept.every((t) => t.pts.every((p) => p.y < 2)), 'the stray end is not drawn in the layer colour');
});

test('two excursions through a neck narrower than h are one choke point', () => {
  const neck = [rect(12, 3, 6, 0.4)];
  const make = (net: string, y0: number): NetCheck => {
    const forward: Path = [{ x: 0, y: y0 }, { x: 30, y: y0 }];
    const ret: Path = [{ x: 0, y: y0 }, { x: 8, y: y0 }, { x: 10, y: 3 }, { x: 14, y: 3 }, { x: 16, y: y0 }, { x: 30, y: y0 }];
    const { board, analysis } = bare(forward, ret);
    analysis.net = net;
    analysis.chains[0].chain.net = net;
    return checkReturn(board, analysis, { edge: 'normal', drive: 'open-drain' });
  };
  const a = make('A', 0);
  const b = make('B', 6);
  assert.ok(a.excursions.length === 1 && b.excursions.length === 1);
  const board = bare([{ x: 0, y: 0 }, { x: 1, y: 0 }], [{ x: 0, y: 0 }, { x: 1, y: 0 }]).board;
  board.pours = [{ id: 'n', net: 'GND', layer: BOT, name: 'GND', priority: 1, outline: neck, poured: neck }];
  const [ca, cb] = assignChokes(board, [a, b]);
  assert.equal(ca.chokes.length, 1);
  assert.deepEqual(ca.chokes[0].nets.sort(), ['A', 'B']);
  assert.ok(ca.chokes[0].width < ca.h, `width ${ca.chokes[0].width}`);
  assert.ok(ca.score < a.score && cb.score < b.score, 'each net pays for the choke');
  const view = viewOf([ca, cb]);
  assert.match(view.header, /^Return paths: \d+\/100 — (Good|Fair|Needs work)\. Worst: /);
});

test('the worse driver end is the net score', () => {
  const low = { score: 70, driver: 'U1', net: 'N' } as NetCheck;
  const high = { score: 95, driver: 'U2', net: 'N' } as NetCheck;
  const w = worseEnd([high, low]);
  assert.equal(w.score, 70);
  assert.deepEqual(w.also, [{ driver: 'U2', score: 95 }]);
});

const DONGLE = '/cursor/stores/bc-01a2143d-9758-74db-861f-6707c9e39ded/internal/boards/R-Com_dongle_2026-11-25-22-41_5690.epro2';

test('dongle CS and RAD_RX match the check', { skip: !existsSync(DONGLE) }, async () => {
  const { loadBoard } = await import('../../cli/src/easyeda/load.js');
  const board = loadBoard(DONGLE);
  // The drawn CS return keeps three loops the solver already reports (about 4, 8 and 8 mm²).
  // Each is a note (h² ≤ dA < 9h²). Together r is about 0.4. Closure and the return vias no longer
  // add a second penalty, so the score sits just over 70 and stays out of the 90s.
  const cs = checkReturn(board, analyzeNet(board, 'CS', { drivers: ['U12'] }), { driver: 'U12', edge: 'normal', drive: 'push-pull' });
  assert.equal(cs.driver, 'U12');
  assert.ok(!cs.excursions.some((e) => e.grade === 'flag'), cs.excursions.map((e) => `${e.grade} ${e.dA.toFixed(1)}`).join(', '));
  const notes = cs.excursions.filter((e) => e.grade === 'note');
  assert.equal(notes.length, 3, notes.map((e) => e.dA.toFixed(1)).join(', '));
  assert.ok(notes.every((e) => e.dA > 2 && e.dA < 12));
  assert.ok(cs.r > 0.3 && cs.r < 0.55, `CS r ${cs.r}`);
  assert.ok(cs.hops.every((h) => h.grade !== 'flag'), cs.hops.map((h) => `${h.grade} ${h.distance.toFixed(2)}`).join(', '));
  assert.ok(cs.score >= 70 && cs.score < 90, `CS score ${cs.score}`);
  assert.equal(cs.status, 'Fair');

  // RAD_RX leaves the trace at U16 and only rejoins near the far end, so the one loop is about 100 mm²
  // (a flag). The ground via on that lead is the closure, not a second layer-transition flag.
  const rx = checkReturn(board, analyzeNet(board, 'RAD_RX', { drivers: ['U16'] }), { driver: 'U16', edge: 'slow', drive: 'push-pull' });
  const flagged = rx.excursions.filter((e) => e.grade === 'flag');
  assert.equal(flagged.length, 1, rx.excursions.map((e) => `${e.grade} ${e.dA.toFixed(1)}`).join(', '));
  assert.ok(flagged[0].dA > 60 && flagged[0].dA < 140, `RAD_RX dA ${flagged[0].dA}`);
  assert.ok(rx.r > 1.2 && rx.r < 3, `RAD_RX r ${rx.r}`);
  assert.ok(rx.hops.every((h) => h.fromSignalVia), rx.hops.map((h) => h.grade).join(', '));
  assert.ok(rx.score < 70, `RAD_RX score ${rx.score}`);
  const gnd = rx.closures.find((c) => c.kind === 'gnd');
  assert.ok(gnd && rx.driver === 'U16', JSON.stringify(gnd));
  assert.ok(!/U12/.test(gnd!.text));
});
