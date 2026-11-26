import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEasyEdaPcb } from '@returnpath/cli/parse';
import { buildDcEpro } from '@returnpath/cli/synth-dc';
import { strFromU8, unzipSync } from 'fflate';
import { createMockEda, type DialogCall } from './mock-eda.ts';

function dcBoard() {
	const files = unzipSync(buildDcEpro());
	const footprints = new Map<string, string>();
	let pcb = '';
	for (const [name, data] of Object.entries(files)) {
		if (name.endsWith('.epcb'))
			pcb = strFromU8(data);
		if (name.endsWith('.efoo'))
			footprints.set(name.split('/').pop()!.split('.')[0], strFromU8(data));
	}
	return parseEasyEdaPcb({ pcb, footprints });
}

const board = dcBoard();
const ext = await import('../src/index.ts');
const { DC_COLORS } = await import('../src/dc-overlay.ts');

async function run(selected: string, answer?: (d: DialogCall) => unknown) {
	const mock = createMockEda(board, selected, [], answer);
	(globalThis as Record<string, unknown>).eda = mock.eda;
	await ext.showDcReturn();
	return mock;
}

test('wizard step 1 with the guessed defaults, then the DC overlay', async () => {
	const mock = await run('3V3');
	const kinds = mock.dialogs.map(d => d.kind);
	assert.deepEqual(kinds, ['multi', 'select', 'select', 'multi', 'input'], 'rails, rail to solve, source, loads, currents (one ground: no pairing dialog)');
	assert.deepEqual(mock.dialogs[0].dflt, ['3V3', 'VBUS']);
	assert.equal(mock.dialogs[1].dflt, '3V3', 'the selected net is preselected');
	const u1 = board.components.find(c => c.designator === 'U1')!.id;
	assert.equal(mock.dialogs[2].dflt, u1, 'U1 guessed as the source');
	assert.equal(mock.dialogs[2].options[0], u1, 'candidates first');
	assert.match(mock.dialogs[2].prompt, /Other candidate sources are left out/);
	const des = (id: string) => board.components.find(c => c.id === id)!.designator;
	assert.deepEqual((mock.dialogs[3].dflt as string[]).map(des), ['U2', 'U3', 'J2']);

	assert.equal(mock.messages.length, 1);
	const msg = mock.messages[0];
	assert.match(msg, /^3V3 \/ GND: source U1, loads U2, U3, J2\./);
	assert.match(msg, /3V3: drop \d+\.\d+ mV\/A/);
	assert.match(msg, /GND: drop \d+\.\d+ mV\/A/);
	assert.doesNotMatch(msg, /Contours drawn/);
	assert.match(msg, /Streamlines: 3V3 supply thin yellow; GND return thick, magenta on Top Layer and cyan on other layers, with a circle where it changes layer\./);
	const colors = new Set(mock.markers.map(m => JSON.stringify(m.color)));
	assert.deepEqual(colors, new Set([DC_COLORS.supply, DC_COLORS.return, DC_COLORS.returnOther, DC_COLORS.bottleneck].map(c => JSON.stringify(c))));
	assert.ok(mock.markers.every(m => ['r', 'g', 'b'].every(k => [0, 255].includes((m.color as Record<string, number>)[k]))), 'channels only 0 or 255: EasyEDA Pro 3.2 clips colours to a 0–1 scale');
	assert.ok(mock.markers.every(m => m.shape.type === 'line' || m.shape.type === 'circle'));
	const of = (c: unknown) => mock.markers.filter(m => JSON.stringify(m.color) === JSON.stringify(c));
	assert.ok(of(DC_COLORS.supply).every(m => m.width === 2) && [...of(DC_COLORS.return), ...of(DC_COLORS.returnOther)].every(m => m.width === 5), 'supply thin, return thick');
	assert.ok(of(DC_COLORS.returnOther).some(m => m.shape.type === 'circle'), 'GND changes layer at vias on this board, marked with circles');
	assert.ok(of(DC_COLORS.returnOther).some(m => m.shape.type === 'line'), 'and runs on Inner1');

	await ext.clearReturnPath();
	assert.equal(mock.markers.length, 0);
});

test('wizard: user picks another source and gives currents', async () => {
	const j2 = board.components.find(c => c.designator === 'J2')!.id;
	const mock = await run('', (d) => {
		if (d.kind === 'select' && /active source/.test(d.prompt))
			return j2;
		if (d.kind === 'input')
			return 'U2=150mA, U3=0.02';
		return d.dflt;
	});
	const msg = mock.messages[0];
	assert.match(msg, /^3V3 \/ GND: source J2, loads U2, U3\./, 'U1 is a candidate source, so it is left out once J2 is active');
	assert.doesNotMatch(msg, /per amp/);
	assert.match(msg, /3V3: drop \d+\.\d+ mV,/);
});

test('wizard: cancelling draws nothing', async () => {
	const mock = await run('3V3', d => (d.kind === 'multi' ? undefined : d.dflt));
	assert.equal(mock.messages.length, 0);
	assert.equal(mock.markers.length, 0);
});

test('wizard: with several grounds, the ground is asked once, for the rail being solved', async () => {
	const mock = createMockEda({ ...board, vias: [...board.vias, { ...board.vias[0], id: 'pgnd-via', net: 'VBUS_PGND' }] }, '3V3');
	(globalThis as Record<string, unknown>).eda = mock.eda;
	await ext.showDcReturn();
	assert.deepEqual(mock.dialogs.map(d => d.kind), ['multi', 'select', 'select', 'select', 'multi', 'input']);
	assert.match(mock.dialogs[1].prompt, /Step 2\/5: rail to solve/);
	assert.match(mock.dialogs[2].prompt, /Step 3\/5: ground that carries the return current of 3V3/);
	assert.equal(mock.dialogs[2].dflt, 'GND');
	assert.ok(mock.markers.length > 0);
});

test('pin names from the netlist: a load returns only through its GND pin, not through an address pin tied to GND', async () => {
	const u2 = board.components.find(c => c.designator === 'U2')!;
	const gnd = board.pads.find(p => p.componentId === u2.id && p.net === 'GND')!;
	const a0 = { ...gnd, id: `${gnd.id}-a0`, number: '99', at: { x: gnd.at.x + 0.6, y: gnd.at.y }, shape: gnd.shape.map(r => r.map(q => ({ x: q.x + 0.6, y: q.y }))), pinName: 'A0' };
	const pads = board.pads.map(p => (p.componentId === u2.id ? { ...p, pinName: p.net === 'GND' ? 'GND' : 'VCC' } : p));
	const named = { ...board, pads: [...pads, a0], components: board.components.map(c => (c.id === u2.id ? { ...c, padIds: [...c.padIds, a0.id] } : c)) };
	const mock = createMockEda(named, '3V3');
	(globalThis as Record<string, unknown>).eda = mock.eda;
	await ext.showDcReturn();
	assert.match(mock.messages.at(-1)!, /U2: A0 is tied to GND but carries no supply current; the return starts at GND\./);
	assert.ok(mock.logs.some(l => /pin names: \d+ of \d+ component pads named from the netlist/.test(l.message)));
	assert.ok(mock.logs.some(l => /DC setup:/.test(l.message)));
});

test('hide/show keeps the overlay; rerun repeats the last DC analysis on the changed board without the wizard, after a restart too', async () => {
	const storage = new Map<string, unknown>();
	const fresh = createMockEda(board, '3V3', [], undefined, { storage });
	(globalThis as Record<string, unknown>).eda = fresh.eda;
	await ext.clearReturnPath();
	await ext.rerunAnalysis();
	assert.match(fresh.messages[0], /No analysis to rerun yet/);
	await ext.toggleReturnPath();
	assert.match(fresh.toasts.at(-1)!, /No overlay to show/);

	const first = createMockEda(board, '3V3', [], d => (d.kind === 'input' ? 'U2=150mA, U3=0.02' : d.dflt), { storage });
	(globalThis as Record<string, unknown>).eda = first.eda;
	await ext.showDcReturn();
	const drawn = first.markers.map(m => JSON.stringify(m));
	assert.ok(drawn.length > 0);
	await ext.toggleReturnPath();
	assert.equal(first.markers.length, 0);
	assert.match(first.toasts.at(-1)!, /Overlay hidden/);
	await ext.toggleReturnPath();
	assert.deepEqual(first.markers.map(m => JSON.stringify(m)), drawn, 'shown again exactly as drawn');

	const moved = { ...board, vias: [...board.vias, { ...board.vias.find(v => v.net === 'GND')!, id: 'new-gnd-via', at: { x: 30, y: 20 } }] };
	const after = createMockEda(moved, '', [], undefined, { storage });
	(globalThis as Record<string, unknown>).eda = after.eda;
	await ext.rerunAnalysis();
	assert.equal(after.dialogs.length, 0, 'no wizard');
	assert.equal(after.counts.boardReads, 1, 'the board is read again');
	assert.match(after.messages.at(-1)!, /^3V3 \/ GND: source U1, loads U2, U3, J2\./);
	assert.match(after.messages.at(-1)!, /3V3: drop \d+\.\d+ mV,/, 'the given currents are kept');
	assert.ok(after.markers.length > 0);
	await ext.clearReturnPath();
	await ext.toggleReturnPath();
	assert.equal(after.markers.length, 0, 'Clear Overlay forgets it');
});

test('Show for Selected Net on a switching node (a net on an inductor) offers the DC view with that net preselected', async () => {
	const u2 = board.components.find(c => c.designator === 'U2')!;
	const pads = [
		{ id: 'sw.u', net: 'SWN', layer: 1, number: '7', at: { x: u2.at.x + 1, y: u2.at.y }, shape: [[{ x: u2.at.x + 0.8, y: u2.at.y - 0.2 }, { x: u2.at.x + 1.2, y: u2.at.y - 0.2 }, { x: u2.at.x + 1.2, y: u2.at.y + 0.2 }, { x: u2.at.x + 0.8, y: u2.at.y + 0.2 }]], holeDiameter: 0, componentId: u2.id },
		{ id: 'sw.l', net: 'SWN', layer: 1, number: '1', at: { x: u2.at.x + 4, y: u2.at.y }, shape: [[{ x: u2.at.x + 3.5, y: u2.at.y - 0.5 }, { x: u2.at.x + 4.5, y: u2.at.y - 0.5 }, { x: u2.at.x + 4.5, y: u2.at.y + 0.5 }, { x: u2.at.x + 3.5, y: u2.at.y + 0.5 }]], holeDiameter: 0, componentId: 'l9' },
	];
	const sw = {
		...board,
		pads: [...board.pads, ...pads],
		tracks: [...board.tracks, { id: 'sw.t', net: 'SWN', layer: 1, a: pads[0].at, b: pads[1].at, width: 0.3 }],
		components: [...board.components.map(c => (c.id === u2.id ? { ...c, padIds: [...c.padIds, 'sw.u'] } : c)), { id: 'l9', designator: 'L9', at: pads[1].at, rotation: 0, layer: 1, padIds: ['sw.l'] }],
	};
	const mock = createMockEda(sw, 'SWN', [], d => (d.kind === 'confirm' ? true : d.kind === 'select' && /active source/.test(d.prompt) ? undefined : d.dflt));
	(globalThis as Record<string, unknown>).eda = mock.eda;
	await ext.showReturnPath();
	assert.equal(mock.dialogs[0].kind, 'confirm');
	assert.match(mock.dialogs[0].prompt, /SWN connects to L9, an inductor or ferrite bead/);
	assert.ok((mock.dialogs[1].dflt as string[]).includes('SWN'), 'ticked in step 1 though its name is not a rail name');
	assert.equal(mock.dialogs[2].dflt, 'SWN', 'and preselected in step 2');
});

test('a ground with no copper path from any load is reported in words and gets no contours', async () => {
	const noGnd = { ...board, pours: board.pours.filter(p => p.net !== 'GND'), tracks: board.tracks.filter(t => t.net !== 'GND'), vias: board.vias.filter(v => v.net !== 'GND') };
	const mock = createMockEda(noGnd, '3V3');
	(globalThis as Record<string, unknown>).eda = mock.eda;
	await ext.showDcReturn();
	const msg = mock.messages.at(-1)!;
	assert.match(msg, /GND: no load has a copper path to U1; nothing is drawn for it\./);
	assert.doesNotMatch(msg, /GND: drop/);

	assert.ok(mock.logs.some(l => /GND: .* not reached from U1; source pads .*; pours on GND: none/.test(l.message)));
});
