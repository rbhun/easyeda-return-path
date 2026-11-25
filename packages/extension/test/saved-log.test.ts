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
	assert.ok(saved(mock).some(l => /read board: pcb_PrimitivePoured.get 1\/3 \(.*\)…$/.test(l)));
	assert.deepEqual(calls, ['pcb_Layer.getStackup', 'pcb_PrimitiveLine.getAll', 'pcb_PrimitiveArc.getAll', 'pcb_PrimitiveVia.getAll', 'pcb_PrimitivePad.getAll', 'pcb_PrimitiveComponent.getAll', 'pcb_PrimitiveFill.getAll', 'pcb_PrimitivePoured.getAllPrimitiveId', 'pcb_PrimitivePour.getAll']);
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
	mock.eda.pcb_PrimitivePour.getAll = never;
	await ext.showReturnPath();
	assert.match(mock.messages.at(-1)!, /pcb_PrimitivePour.getAll did not answer within/);
	const lines = saved(mock);
	const at = lines.findIndex(l => /read board: pcb_PrimitivePour.getAll…$/.test(l));
	assert.ok(at >= 0);
	assert.ok(lines.slice(at + 1).every(l => /ERROR|did not answer|^\s+at /.test(l) || !/read board/.test(l)), lines.slice(at).join('\n'));
});

test('without the stackup API only the copper layers the board uses are read, not every possible inner layer', async () => {
	const mock = install({});
	(mock.eda.pcb_Layer as Record<string, unknown>).getStackup = undefined;
	const listed = [1, 2, ...Array.from({ length: 32 }, (_, i) => 15 + i)].map(id => ({ id, name: `L${id}`, type: 'SIGNAL', layerStatus: id === 1 || id === 2 || id === 15 || id === 16 ? 1 : 0 }));
	mock.eda.pcb_Layer.getAllLayers = async () => listed;
	await ext.showReturnPath();
	assert.ok(saved(mock).some(l => /read board: 4 copper layers in use \(board says 4; 34 listed\)/.test(l)), saved(mock).join('\n'));
	assert.ok(saved(mock).some(l => /read board: stackup, 4 copper layers/.test(l)));

	const byCount = install({});
	(byCount.eda.pcb_Layer as Record<string, unknown>).getStackup = undefined;
	byCount.eda.pcb_Layer.getAllLayers = async () => listed.map(l => ({ ...l, layerStatus: 1 }));
	await ext.showReturnPath();
	assert.ok(saved(byCount).some(l => /read board: 4 copper layers in use \(board says 4; 34 listed\)/.test(l)));
});

test('computed pour fills are fetched one at a time; a run that hung there makes the next one use pour outlines', async () => {
	const storage = new Map<string, unknown>();
	const hung = install({ storage }, () => false);
	hung.eda.pcb_PrimitivePoured.get = never;
	boardModule.apiTimeouts.callMs = 1500;
	void ext.showReturnPath();
	await new Promise(r => setTimeout(r, 150));
	boardModule.apiTimeouts.callMs = 200;
	assert.ok(storage.get('fetchingPouredSince'), 'marker set while fetching');
	assert.match(saved(hung).at(-1)!, /read board: pcb_PrimitivePoured.get 1\/3 \(.*\)…$/);

	const next = install({ storage });
	let fetched = 0;
	next.eda.pcb_PrimitivePoured.get = async () => (fetched++, undefined);
	await ext.showReturnPath();
	assert.equal(fetched, 0);
	assert.match(next.messages.at(-1)!, /previous run stopped while fetching computed pour fills/);
	assert.ok(next.markers.length > 0, 'analysis still ran on outline-computed pours');
	assert.equal(storage.get('fetchingPouredSince'), '');
});

test('slow pour-fill fetches switch the rest to outlines', async () => {
	const mock = install({});
	const get = mock.eda.pcb_PrimitivePoured.get;
	boardModule.apiTimeouts.pouredSlowMs = 20;
	try {
		mock.eda.pcb_PrimitivePoured.get = async (id: string) => {
			await new Promise(r => setTimeout(r, 40));
			return get(id);
		};
		await ext.showReturnPath();
	}
	finally {
		boardModule.apiTimeouts.pouredSlowMs = 3000;
	}
	assert.match(mock.messages.at(-1)!, /the remaining 2 are computed from their outlines/);
	assert.ok(mock.markers.length > 0);
});

test('a saved log from an older build that ends in pcb_PrimitivePoured.getAll also switches to pour outlines', async () => {
	const storage = new Map<string, unknown>([['log', '2026-11-26 00:19:41.588 INFO  read board: pcb_PrimitivePoured.getAll…']]);
	const mock = install({ storage });
	let fetched = 0;
	mock.eda.pcb_PrimitivePoured.get = async () => (fetched++, undefined);
	await ext.showReturnPath();
	assert.equal(fetched, 0);
	assert.match(mock.messages.at(-1)!, /previous run stopped while fetching computed pour fills \(started 2026-11-26 00:19:41.588\)/);
	const again = install({ storage });
	await ext.showReturnPath();
	assert.doesNotMatch(again.messages.at(-1)!, /previous run stopped/);
});

test('pcb_PrimitivePoured.get returning an array or plain state still gives the computed fills', async () => {
	for (const wrap of ['array', 'plain'] as const) {
		const mock = install({});
		const get = mock.eda.pcb_PrimitivePoured.get;
		mock.eda.pcb_PrimitivePoured.get = (async (id: string) => {
			const p = (await get(id)) as unknown as { getState_PrimitiveId: () => string; getState_Layer: () => number; getState_PourPrimitiveId: () => string | undefined; getState_PourFills: () => { fill: boolean; path: { getSource: () => unknown } }[] };
			if (wrap === 'array')
				return [p];
			return {
				primitiveId: p.getState_PrimitiveId(),
				layer: p.getState_Layer(),
				pourPrimitiveId: p.getState_PourPrimitiveId(),
				pourFills: p.getState_PourFills().map(f => ({ ...f, path: f.path.getSource() })),
			};
		}) as never;
		await ext.showReturnPath();
		const log = saved(mock);
		assert.ok(log.some(l => (wrap === 'array' ? /get returns array\(1\) of object/ : /get returns object \{primitiveId, layer/).test(l)), log.join('\n'));
		assert.ok(log.some(l => /read board: 3 computed copper areas, 19 rings/.test(l)), `${wrap}: ${log.join('\n')}`);
		assert.doesNotMatch(mock.messages.at(-1)!, /computed from their outlines/);
	}
});

test('an unknown pcb_PrimitivePoured.get result is described in the log and the run falls back to outlines', async () => {
	const mock = install({});
	mock.eda.pcb_PrimitivePoured.get = (async () => ({ foo: 1 })) as never;
	await ext.showReturnPath();
	assert.ok(saved(mock).some(l => /pcb_PrimitivePoured.get returned object \{foo\}; pours are computed from their outlines/.test(l)), saved(mock).join('\n'));
	assert.match(mock.messages.at(-1)!, /Computed pour fills could not be read/);
	assert.ok(mock.markers.length > 0);
});

test('a pour-fill primitive without getState_Layer (EasyEDA Pro API 0.3.59) is used as is', async () => {
	const mock = install({});
	const get = mock.eda.pcb_PrimitivePoured.get;
	mock.eda.pcb_PrimitivePoured.get = (async (id: string) => {
		const p = (await get(id)) as unknown as Record<string, unknown>;
		const { getState_Layer: _drop, ...rest } = p;
		return rest;
	}) as never;
	await ext.showReturnPath();
	assert.ok(saved(mock).some(l => /read board: 3 computed copper areas, 19 rings/.test(l)), saved(mock).join('\n'));
	assert.doesNotMatch(mock.messages.at(-1)!, /computed from their outlines/);
});

test('the board outline and pour keepouts are read', async () => {
	const board = demo;
	const mock = install({});
	const read = await boardModule.readBoard();
	assert.ok(board.outline.length > 0 && read.outline.length === board.outline.length);
	const area = (ps: typeof board.outline) => ps.reduce((s, r) => s + r.reduce((a, p, i) => a + p.x * r[(i + 1) % r.length].y - r[(i + 1) % r.length].x * p.y, 0) / 2, 0);
	assert.ok(Math.abs(Math.abs(area(read.outline)) - Math.abs(area(board.outline))) < 0.01);
	assert.equal(read.keepouts.length, board.keepouts.length);
	assert.ok(saved(mock).some(l => new RegExp(`board outline 1 ring\\(s\\), ${board.keepouts.length} pour keepouts`).test(l)), saved(mock).join('\n'));
});

test('without the stackup API a 2-layer board is assumed to be 1.6 mm thick, not 0.2 mm', async () => {
	assert.deepEqual(boardModule.assumedDielectricsMm(2), [1.5]);
	assert.deepEqual(boardModule.assumedDielectricsMm(4), [0.21, 1.065, 0.21]);
	assert.ok(Math.abs(boardModule.assumedDielectricsMm(6).reduce((a, b) => a + b, 0) - 1.5) < 0.01);
	const mock = install({});
	(mock.eda.pcb_Layer as Record<string, unknown>).getStackup = undefined;
	mock.eda.pcb_Layer.getAllLayers = async () => [1, 2].map(id => ({ id, name: `L${id}`, type: 'SIGNAL', layerStatus: 1 }));
	mock.eda.pcb_Layer.getTheNumberOfCopperLayers = async () => 2;
	const read = await boardModule.readBoard();
	assert.deepEqual(read.stackup.dielectrics.map(d => d.thicknessMm), [1.5]);
	assert.deepEqual(read.stackup.copper.map(c => c.z), [0, 1.5]);
	assert.ok(read.warnings.some(w => /assuming a 1.6 mm board with dielectrics of 1.5 mm/.test(w)));
	assert.ok(!read.warnings.some(w => /4\.1\.93/.test(w)));
});
