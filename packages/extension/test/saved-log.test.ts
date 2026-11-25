import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEasyEdaPcb } from '@returnpath/cli/parse';
import { buildEpro } from '@returnpath/cli/synth';
import { buildDcEpro } from '@returnpath/cli/synth-dc';
import { strFromU8, unzipSync } from 'fflate';
import { createMockEda, type DialogCall, type MockHost } from './mock-eda.ts';

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
const runner = await import('../src/runner.ts');
const demo = load(buildEpro('demo', 'object'));
const LOG_FILE = 'C:\\Users\\me\\Documents\\EasyEDA-Pro\\ReturnPath\\returnpath-log.txt';

const saved = (mock: { storage: Map<string, unknown> }) => String(mock.storage.get('log') ?? '').split('\n');
const never = () => new Promise<never>(() => {});
const boardModule = await import('../src/eda-board.ts');
runner.saveTimeouts.ms = 50;
Object.assign(boardModule.apiTimeouts, { callMs: 200, stackupMs: 100, pinsMs: 100 });

function install(host: MockHost, answer: (d: DialogCall) => unknown = d => d.dflt, board = demo, net = 'CLK') {
	const mock = createMockEda(board, net, [], answer, host);
	(globalThis as Record<string, unknown>).eda = mock.eda;
	return mock;
}

test('with file access the log is written to a file under the EDA documents folder, with timestamps', async () => {
	const mock = install({ fileSystem: 'allowed' });
	await ext.showReturnPath();
	const text = mock.files.get(LOG_FILE);
	assert.ok(text, [...mock.files.keys()].join());
	assert.match(text, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} INFO {2}Show for Selected Net: CLK \(v\d+\.\d+\.\d+\)$/m);
	assert.match(text, /read board: \d+ track segments from lines and arcs \(\d+ ms\)/);
	assert.match(text, /Return path: finished in \d+ ms/);
	assert.match(text, /draw markers: \d+ ms; \d+ markers/);
	assert.deepEqual(saved(mock), text.trimEnd().split('\n'));
});

test('the log is on disk before the board read starts, so a freeze inside it still leaves a trace', async () => {
	const mock = install({ fileSystem: 'allowed' });
	const getAll = mock.eda.pcb_PrimitiveLine.getAll;
	let onDisk = '';
	mock.eda.pcb_PrimitiveLine.getAll = async () => {
		onDisk = mock.files.get(LOG_FILE) ?? '';
		return getAll();
	};
	await ext.showReturnPath();
	assert.match(onDisk, /read board…$/m);
	assert.match(onDisk, /read board: stackup, 4 copper layers/);
	assert.doesNotMatch(onDisk, /read board: \d+ ms;/);
});

test('after a restart Show Saved Log lists the stored lines and saves them as a file on request', async () => {
	const storage = new Map<string, unknown>();
	install({ storage });
	await ext.showReturnPath();
	const before = (storage.get('log') as string).split('\n').length;
	assert.ok(before > 10);

	const restarted = install({ storage }, d => d.kind === 'confirm');
	await ext.showSavedLog();
	const dialog = restarted.dialogs.at(-1)!;
	assert.equal(dialog.kind, 'confirm');
	assert.match(dialog.prompt, /allow "External Interaction" for this extension/);
	assert.match(dialog.prompt, /Return path: finished in/);
	assert.equal(restarted.downloads.length, 1);
	assert.equal(restarted.downloads[0].name, 'returnpath-log.txt');
	assert.ok(restarted.downloads[0].text.trimEnd().split('\n').length >= before);
	assert.match(restarted.downloads[0].text, /Show for Selected Net: CLK/);
});

test('without the external-interaction permission nothing fails and the log still goes to storage', async () => {
	const mock = install({ fileSystem: 'denied' }, () => false);
	await ext.showReturnPath();
	assert.equal(mock.files.size, 0);
	assert.ok(saved(mock).some(l => l.includes('Return path: finished')));
	assert.equal(await runner.logFilePath(), null);
	await ext.showSavedLog();
	assert.match(mock.dialogs.at(-1)!.prompt, /External Interaction/);
});

test('a power net is turned away before the board is read', async () => {
	const mock = install({}, () => false, load(buildDcEpro()), '3V3');
	await ext.showReturnPath();
	assert.equal(mock.counts.boardReads, 0);
	assert.match(mock.dialogs[0].prompt, /3V3 looks like a power rail/);
});

test('the saved log keeps the last 1000 lines', async () => {
	const mock = install({});
	for (let i = 0; i < 1100; i++) runner.log(`line ${i}`);
	await runner.checkpoint();
	const lines = saved(mock);
	assert.equal(lines.length, 1000);
	assert.match(lines.at(-1)!, /line 1099$/);
	assert.match(lines[0], /line 100$/);
});

test('every API call of the board read is logged before it is made', async () => {
	const mock = install({});
	await ext.showReturnPath();
	const calls = saved(mock).map(l => /read board: (pcb_\w+\.\w+)…$/.exec(l)?.[1]).filter(Boolean);
	assert.deepEqual(calls, ['pcb_Layer.getStackup', 'pcb_PrimitiveLine.getAll', 'pcb_PrimitiveArc.getAll', 'pcb_PrimitiveVia.getAll', 'pcb_PrimitivePad.getAll', 'pcb_PrimitiveComponent.getAll', 'pcb_PrimitiveFill.getAll', 'pcb_PrimitivePoured.getAll', 'pcb_PrimitivePour.getAll']);
});

test('log writes that never answer are switched off and the run still finishes', async () => {
	const mock = install({ fileSystem: 'allowed' });
	mock.eda.sys_Storage.setExtensionUserConfig = never;
	(mock.eda.sys_FileSystem as Record<string, unknown>).getEdaPath = never;
	await ext.showReturnPath();
	assert.equal(mock.messages.length, 1, 'results dialog');
	const panel = mock.logs.map(l => l.message);
	assert.ok(panel.some(m => /saved log disabled: sys_Storage.setExtensionUserConfig did not answer/.test(m)), panel.join('\n'));
	assert.ok(panel.some(m => /log file disabled: sys_FileSystem.getEdaPath did not answer/.test(m)));
	assert.ok(panel.some(m => /Return path: finished/.test(m)));
});

test('a stackup call that never answers falls back to the layer list', async () => {
	const mock = install({});
	mock.eda.pcb_Layer.getStackup = never;
	await ext.showReturnPath();
	assert.ok(saved(mock).some(l => /pcb_Layer.getStackup failed \(pcb_Layer.getStackup did not answer/.test(l)));
	assert.ok(saved(mock).some(l => /Return path: finished/.test(l)));
});

test('a board-read call that never answers ends in a dialog naming it, and the saved log ends there', async () => {
	const mock = install({});
	mock.eda.pcb_PrimitivePoured.getAll = never;
	await ext.showReturnPath();
	assert.match(mock.messages.at(-1)!, /pcb_PrimitivePoured.getAll did not answer within/);
	const lines = saved(mock);
	const at = lines.findIndex(l => /read board: pcb_PrimitivePoured.getAll…$/.test(l));
	assert.ok(at >= 0);
	assert.ok(lines.slice(at + 1).every(l => /ERROR|did not answer|^\s+at /.test(l) || !/read board/.test(l)), lines.slice(at).join('\n'));
});
