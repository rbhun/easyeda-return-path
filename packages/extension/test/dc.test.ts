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
	assert.doesNotMatch(msg, /Contours drawn/, 'no contours until colours are confirmed');
	assert.match(msg, /Streamlines: GND return thick, solid on Top Layer and dotted on other layers, with a circle where it changes layer; 3V3 supply thin and dashed\./);
	assert.match(msg, /Density contours need marker colours: run Return Path > Check Marker Colours\.\.\. once\./);
	const colors = new Set(mock.markers.map(m => JSON.stringify(m.color)));
	assert.deepEqual(colors, new Set([DC_COLORS.supply, DC_COLORS.return, DC_COLORS.bottleneck].map(c => JSON.stringify(c))));
	assert.ok(mock.markers.every(m => m.shape.type === 'line' || m.shape.type === 'circle'));
	const of = (c: unknown) => mock.markers.filter(m => JSON.stringify(m.color) === JSON.stringify(c));
	assert.ok(of(DC_COLORS.supply).every(m => m.width === 1) && of(DC_COLORS.return).every(m => m.width === 3), 'supply thin, return thick');
	assert.ok(of(DC_COLORS.return).some(m => m.shape.type === 'circle'), 'GND changes layer at vias on this board, marked with circles');

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

test('a ground with no copper path from any load is reported in words and gets no contours; the supply is dashed', async () => {
	const noGnd = { ...board, pours: board.pours.filter(p => p.net !== 'GND'), tracks: board.tracks.filter(t => t.net !== 'GND'), vias: board.vias.filter(v => v.net !== 'GND') };
	const mock = createMockEda(noGnd, '3V3');
	(globalThis as Record<string, unknown>).eda = mock.eda;
	await ext.showDcReturn();
	const msg = mock.messages.at(-1)!;
	assert.match(msg, /GND: no load has a copper path to U1; nothing is drawn for it\./);
	assert.doesNotMatch(msg, /GND: drop/);
	assert.match(msg, /Streamlines: GND return thick/);
	assert.ok(mock.logs.some(l => /GND: .* not reached from U1; source pads .*; pours on GND: none/.test(l.message)));
	const supply = mock.markers.filter(m => JSON.stringify(m.color) === JSON.stringify(DC_COLORS.supply));
	const len = (m: { shape: Record<string, unknown> }) => Math.hypot((m.shape.endX as number) - (m.shape.startX as number), (m.shape.endY as number) - (m.shape.startY as number));
	assert.ok(supply.length > 0 && supply.every(m => len(m) <= 1 / 0.0254 + 1e-6), 'supply streamlines in dashes of at most 1 mm');
});

test('dashes split a polyline into dashes of the given pattern, across its corners', async () => {
	const { dashes } = await import('../src/dc-overlay.ts');
	const d = dashes([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }], [0.8, 0.6]);
	const length = (p: { x: number; y: number }[]) => p.slice(1).reduce((s, q, i) => s + Math.hypot(q.x - p[i].x, q.y - p[i].y), 0);
	assert.equal(d.length, 8);
	assert.ok(d.slice(0, 7).every(p => Math.abs(length(p) - 0.8) < 1e-9));
	assert.ok(Math.abs(length(d[7]) - 0.2) < 1e-9);
	assert.ok(d.some(p => p.length === 3), 'a dash bends around the corner');
});

test('Check Marker Colours draws red on both RGB scales, stores the answer, and contours follow it', async () => {
	const { COLOUR_SCALE } = await import('../src/overlay.ts');
	for (const [answer, red] of [['255', { r: 255, g: 0, b: 0 }], ['1', { r: 1, g: 0, b: 0 }], ['0', undefined]] as const) {
		const storage = new Map<string, unknown>();
		const check = createMockEda(board, '3V3', [], () => answer, { storage });
		(globalThis as Record<string, unknown>).eda = check.eda;
		let drawn: typeof check.markers = [];
		await ext.runColourCheck({ select: async () => (drawn = [...check.markers], answer), multi: async () => undefined, input: async () => undefined, confirm: async () => false } as never);
		assert.ok(drawn.length >= 2 && drawn.every(m => m.zoom === true), 'circles drawn and zoomed to before asking');
		assert.equal(check.markers.length, 0, 'cleared afterwards');
		assert.equal(storage.get(COLOUR_SCALE), Number(answer));

		const mock = createMockEda(board, '3V3', [], undefined, { storage });
		(globalThis as Record<string, unknown>).eda = mock.eda;
		await ext.showDcReturn();
		const colors = new Set(mock.markers.map(m => JSON.stringify(m.color)));
		if (red) {
			assert.match(mock.messages.at(-1)!, /Contours drawn on: 3V3 Inner2, GND Inner1\./);
			const k = red.r === 1 ? 255 : 1;
			for (const c of [DC_COLORS.supply, DC_COLORS.return, DC_COLORS.bottleneck, ...DC_COLORS.bins])
				assert.ok(colors.has(JSON.stringify({ r: c.r / k, g: c.g / k, b: c.b / k, alpha: c.alpha })), `markers in ${JSON.stringify(c)} on the 0-${255 / k} scale`);
		}
		else {
			assert.doesNotMatch(mock.messages.at(-1)!, /Contours drawn|Check Marker Colours/);
		}
	}
});
