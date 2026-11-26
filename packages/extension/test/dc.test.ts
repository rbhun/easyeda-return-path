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
	assert.match(msg, /Contours drawn on: 3V3 Inner2, GND Inner1\./);
	const colors = mock.markers.map(m => JSON.stringify(m.color));
	for (const c of [DC_COLORS.supply, DC_COLORS.return, DC_COLORS.bottleneck, ...DC_COLORS.bins])
		assert.ok(colors.includes(JSON.stringify(c)), `markers in ${JSON.stringify(c)}`);
	assert.ok(mock.markers.every(m => m.shape.type === 'line' || m.shape.type === 'circle'));

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
