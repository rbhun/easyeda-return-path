import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEasyEdaPcb } from '@returnpath/cli/parse';
import { buildEpro } from '@returnpath/cli/synth';
import { buildDcEpro } from '@returnpath/cli/synth-dc';
import { strFromU8, unzipSync } from 'fflate';
import { largeBoard } from '../../core/test/large-board.ts';
import { createMockEda, type DialogCall } from './mock-eda.ts';

function load(epro: Uint8Array) {
	const files = unzipSync(epro);
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

const ext = await import('../src/index.ts');
const { dialogAsk } = await import('../src/wizard.ts');

function install(mock: ReturnType<typeof createMockEda>) {
	(globalThis as Record<string, unknown>).eda = mock.eda;
	return mock;
}

test('every phase is logged to the app log panel with timings and sizes; the progress bar opens and closes', async () => {
	const mock = install(createMockEda(load(buildEpro('demo', 'object')), 'CLK'));
	await ext.showReturnPath();
	const text = mock.logs.map(l => l.message);
	assert.ok(text.every(m => m.startsWith('[ReturnPath] ')));
	assert.ok(text.some(m => /^\[ReturnPath\] read board: \d+ ms; 4 copper layers, .* track segments, .* vias, .* pads, .* pours\/fills \(\d+ vertices\)/.test(m)), text.join('\n'));
	for (const p of ['reference copper', 'chains', 'sampling', 'detour', 'vias'])
		assert.ok(text.some(m => m.includes(`phase "${p}"`)), `phase ${p}`);
	assert.ok(text.some(m => /Return path: finished in \d+ ms \(reference copper \d+ ms/.test(m)));
	assert.ok(text.some(m => /segments=\d+ .*refVertices=\d+ .*samples=\d+/.test(m)), 'analysis sizes');
	assert.ok(text.some(m => /draw markers: \d+ ms; \d+ markers/.test(m)));
	assert.ok(mock.progress.some(p => (p.progress ?? 0) > 0 && p.title?.startsWith('Return path')));
	assert.deepEqual(mock.progress.at(-1), {}, 'progress bar destroyed');
	assert.equal(mock.messages.length, 1);
});

test('a power net is not run through the high-frequency check: hint, then the DC view on request', async () => {
	const board = load(buildDcEpro());
	const decline = install(createMockEda(board, '3V3'));
	await ext.showReturnPath();
	assert.equal(decline.dialogs[0].kind, 'confirm');
	assert.match(decline.dialogs[0].prompt, /3V3 looks like a power rail/);
	assert.equal(decline.markers.length, 0);
	assert.ok(decline.logs.some(l => l.type === 'warn' && /not a signal net \(power\)/.test(l.message)));

	const accept = install(createMockEda(board, '3V3', [], (d: DialogCall) => (d.kind === 'confirm' ? true : d.dflt)));
	await ext.runReturnPath(dialogAsk());
	assert.deepEqual(accept.dialogs.map(d => d.kind), ['confirm', 'multi', 'select', 'select', 'multi', 'input']);
	assert.equal(accept.dialogs[2].dflt, '3V3', 'rail preselected in the wizard');
	assert.ok(accept.markers.length > 0);
	assert.match(accept.messages.at(-1)!, /3V3 \/ GND: source U1/);
});

test('an error ends in a dialog and an error entry with its stack in the log', async () => {
	const mock = install(createMockEda(load(buildEpro('demo', 'object')), 'CLK'));
	(mock.eda.pcb_PrimitiveLine as { getAll: () => Promise<unknown> }).getAll = async () => {
		throw new Error('API went away');
	};
	await ext.showReturnPath();
	assert.match(mock.messages[0], /^Error: API went away/);
	assert.match(mock.messages[0], /log panel/);
	const err = mock.logs.find(l => l.type === 'error')!;
	assert.match(err.message, /Return path: error: API went away\n.*Error: API went away/s);
});

test('closing the progress bar cancels a long analysis; nothing is drawn', async () => {
	const mock = install(createMockEda(largeBoard('BIGNET', 600), 'BIGNET'));
	const run = ext.showReturnPath();
	while (!mock.progress.some(p => (p.progress ?? 0) > 40))
		await new Promise(r => setTimeout(r, 5));
	mock.closeProgressBar();
	await run;
	assert.equal(mock.markers.length, 0);
	assert.equal(mock.messages.length, 0);
	assert.match(mock.toasts[0], /cancelled/);
	assert.ok(mock.logs.some(l => /cancel requested/.test(l.message)));
	assert.ok(mock.logs.some(l => l.type === 'warn' && /stopped after \d+ ms in phase/.test(l.message)));
});

test('cancel with nothing running says so', () => {
	const mock = install(createMockEda(load(buildEpro('demo', 'object')), 'CLK'));
	ext.cancelAnalysis();
	assert.match(mock.toasts[0], /No analysis is running/);
});
