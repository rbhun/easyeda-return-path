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
// These tests time the board read; no other extension instance answers the panel's state request here.
(await import('../src/panel.ts')).panelTimeouts.syncMs = 0;
const { area, bbox } = await import('@returnpath/core');
const { version: VERSION } = (await import('../extension.json', { with: { type: 'json' } })).default;
// Long enough that a storage write is not cut short on a busy CI runner (a dropped write loses the markers checked here).
runner.saveTimeouts.ms = 1000;
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
	assert.match(text, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} INFO {2}HF check \(v\d+\.\d+\.\d+\), selected net CLK$/m);
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
	assert.match(restarted.downloads[0].text, /HF check: CLK at 16 MHz/);
});

test('without the external-interaction permission nothing fails and the log still goes to storage', async () => {
	const mock = install({ fileSystem: 'denied' }, d => (/^(Net to check|Speed of)/.test(d.prompt) ? d.dflt : false));
	await ext.showReturnPath();
	assert.equal(mock.files.size, 0);
	assert.ok(saved(mock).some(l => l.includes('Return path: finished')));
	assert.equal(await runner.logFilePath(), null);
	await ext.showSavedLog();
	assert.match(mock.dialogs.at(-1)!.prompt, /returnpath-log\.txt is not written: sys_FileSystem\.getEdaPath failed: external interaction is not allowed/);
});

test('a power net is turned away before the board is read', async () => {
	const mock = install({}, () => false, load(buildDcEpro()), '3V3');
	await ext.showReturnPath();
	assert.equal(mock.counts.boardReads, 0);
	assert.match(mock.dialogs[0].prompt, /3V3 looks like a power rail/);
});

test('a DC run with nothing selected logs and saves each step between the board read and the solve', async () => {
	const mock = install({}, d => d.dflt, load(buildDcEpro()), '');
	await ext.showDcReturn();
	const lines = saved(mock);
	const at = (re: RegExp) => {
		const i = lines.findIndex(l => re.test(l));
		assert.ok(i >= 0, `${re} in saved log`);
		return i;
	};
	const order = [
		/read selection: \d+ ms; nothing selected$/,
		/read board: \d+ ms; /,
		/wizard: guessing rails…$/,
		/wizard: \d+ rails \(/,
		/wizard: Step 1\/5: .* \(\d+ options\)$/,
		/wizard: answer \[/,
		/DC setup: \{/,
		/DC [^:]+: source /,
		/DC .*finished/,
	].map(at);
	assert.deepEqual(order, [...order].sort((x, y) => x - y));
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
	assert.deepEqual(calls, ['pcb_Layer.getStackup', 'pcb_PrimitiveLine.getAll', 'pcb_PrimitiveArc.getAll', 'pcb_PrimitiveVia.getAll', 'pcb_PrimitivePad.getAll', 'pcb_PrimitiveComponent.getAll', 'pcb_PrimitiveFill.getAll', 'pcb_PrimitivePoured.getAllPrimitiveId', 'pcb_PrimitivePour.getAll', 'pcb_Net.getNetlist']);
});

test('log writes that never answer are switched off and the run still finishes', async () => {
	const mock = install({ fileSystem: 'allowed' });
	mock.eda.sys_Storage.setExtensionUserConfig = never;
	(mock.eda.sys_FileSystem as Record<string, unknown>).getEdaPath = never;
	runner.saveTimeouts.ms = 50;
	try {
		await ext.showReturnPath();
	}
	finally {
		runner.saveTimeouts.ms = 1000;
	}
	assert.equal(mock.messages.length, 1, 'results dialog');
	const panel = mock.logs.map(l => l.message);
	assert.ok(panel.some(m => /saved log disabled: sys_Storage.setExtensionUserConfig did not answer/.test(m)), panel.join('\n'));
	assert.ok(panel.some(m => /log file not written: sys_FileSystem.getEdaPath did not answer/.test(m)));
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

test('computed pour fills are fetched one at a time; a fill whose fetch hung is skipped from then on, the others are still fetched', async () => {
	const storage = new Map<string, unknown>();
	const hung = install({ storage }, () => false);
	const ids = await hung.eda.pcb_PrimitivePoured.getAllPrimitiveId();
	hung.eda.pcb_PrimitivePoured.get = never;
	boardModule.apiTimeouts.callMs = 1500;
	void ext.showReturnPath();
	await new Promise(r => setTimeout(r, 150));
	boardModule.apiTimeouts.callMs = 200;
	assert.equal(storage.get('fetchingPouredSince'), `${VERSION} get:${ids[0]}`);
	assert.match(saved(hung).at(-1)!, /read board: pcb_PrimitivePoured.get 1\/3 \(.*\)…$/);

	for (let run = 0; run < 2; run++) {
		const next = install({ storage });
		const get = next.eda.pcb_PrimitivePoured.get;
		const fetched: string[] = [];
		next.eda.pcb_PrimitivePoured.get = async (id: string) => (fetched.push(id), get(id));
		await ext.showReturnPath();
		assert.deepEqual(fetched, ids.slice(1));
		assert.deepEqual(storage.get('pouredIdsThatHang'), { version: VERSION, ids: [ids[0]] });
		assert.match(next.messages.at(-1)!, /is computed from its outline: EasyEDA froze when asked for its fill/);
		assert.ok(next.markers.length > 0);
		assert.equal(storage.get('fetchingPouredSince'), '');
	}
});

test('markers and skip lists left by an older version are ignored: that version froze for reasons fixed since', async () => {
	const ids = await install({}).eda.pcb_PrimitivePoured.getAllPrimitiveId();
	for (const [marker, skip] of [[`0.1.7 decode:${ids[1]}`, ['x']], ['get:x', { version: '0.1.7', ids: [ids[0]] }], ['2026-11-26T00:09:10.906Z', [ids[2]]]] as const) {
		const storage = new Map<string, unknown>([['fetchingPouredSince', marker], ['pouredIdsThatHang', skip]]);
		const mock = install({ storage });
		const get = mock.eda.pcb_PrimitivePoured.get;
		const fetched: string[] = [];
		mock.eda.pcb_PrimitivePoured.get = async (id: string) => (fetched.push(id), get(id));
		await ext.showReturnPath();
		assert.deepEqual(fetched, ids);
		assert.ok(saved(mock).some(l => l.includes('ignoring what an older version stored')));
		assert.doesNotMatch(mock.messages.at(-1)!, /computed from (its|their) outlines?/);
	}
});

test('a run that froze decoding or merging a pour fill skips that fill next time; each step is saved first', async () => {
	const first = install({});
	const ids = await first.eda.pcb_PrimitivePoured.getAllPrimitiveId();
	await ext.showReturnPath();
	const lines = saved(first);
	for (const id of ids) {
		const decoding = lines.findIndex(l => l.endsWith(`read board: decoding pour fill ${id}…`));
		assert.ok(decoding >= 0 && /decoded .*: \d+ fill regions, \d+ rings, \d+ points/.test(lines[decoding + 1]), lines.join('\n'));
	}
	assert.ok(lines.some(l => /read board: merging \d+ rings of pour .*…$/.test(l)));
	for (const [marker, skipped] of [[`${VERSION} decode:${ids[1]}`, [ids[1]]], [`${VERSION} union:${ids[0]},${ids[2]}`, [ids[0], ids[2]]]] as const) {
		const storage = new Map<string, unknown>([['fetchingPouredSince', marker]]);
		const mock = install({ storage });
		const get = mock.eda.pcb_PrimitivePoured.get;
		const fetched: string[] = [];
		mock.eda.pcb_PrimitivePoured.get = async (id: string) => (fetched.push(id), get(id));
		await ext.showReturnPath();
		assert.deepEqual(storage.get('pouredIdsThatHang'), { version: VERSION, ids: [...skipped] });
		assert.deepEqual(fetched, ids.filter(i => !skipped.includes(i)));
		assert.ok(saved(mock).some(l => new RegExp(`froze while ${marker.includes('decode') ? 'decoding' : 'merging'} computed pour fill`).test(l)));
		assert.equal(storage.get('fetchingPouredSince'), '');
		assert.ok(mock.markers.length > 0);
	}
});

test('pour fills served in 10 mil units are scaled onto their pours, and thermal spokes are stroked', async () => {
	const plain = await (install({}), boardModule.readBoard());
	const pour = plain.pours.find(p => p.poured?.length && p.name !== 'fill')!;
	const b = bbox(pour.poured!);
	const spoke = { pourId: pour.id, a: { x: b.minX - 0.6, y: b.minY - 0.6 }, b: { x: b.minX - 0.1, y: b.minY - 0.6 }, width: 0.3 };
	const mock = install({ pouredUnitMil: 10, spokes: [spoke] });
	const read = await boardModule.readBoard();
	const scaled = read.pours.find(p => p.id === pour.id)!;
	const a0 = Math.abs(area(pour.poured!));
	assert.ok(Math.abs(Math.abs(area(scaled.poured!)) - a0 - 0.5 * 0.3 - Math.PI * 0.15 ** 2) < 0.02, `${area(scaled.poured!)} vs ${a0}`);
	assert.ok(saved(mock).some(l => l.includes(`pour ${pour.id}: fill coordinates are in units of 10 mil`)));
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

test('a run of this version that froze inside pcb_PrimitivePoured.getAll makes the next one use pour outlines', async () => {
	const storage = new Map<string, unknown>([['fetchingPouredSince', `${VERSION} getAll`]]);
	const mock = install({ storage });
	let fetched = 0;
	mock.eda.pcb_PrimitivePoured.get = async () => (fetched++, undefined);
	await ext.showReturnPath();
	assert.equal(fetched, 0);
	assert.match(mock.messages.at(-1)!, /previous run froze while fetching computed pour fills; pours are computed from their outlines/);
	const again = install({ storage });
	await ext.showReturnPath();
	assert.doesNotMatch(again.messages.at(-1)!, /previous run froze/);
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

test('no-inner-plane keepouts only clear plane layers; other region rules are ignored', async () => {
	const mock = install({});
	const regions = await mock.eda.pcb_PrimitiveRegion.getAll();
	const withRules = (rules: number[]) => regions.map(r => Object.assign(Object.create(r), { getState_RuleType: () => rules }));
	mock.eda.pcb_PrimitiveRegion.getAll = (async () => withRules([8])) as never;
	const read = await boardModule.readBoard();
	const inner = read.stackup.copper.map(c => c.id).filter(id => id !== 1 && id !== 2);
	assert.ok(read.keepouts.every(k => inner.includes(k.layer)), JSON.stringify(read.keepouts.map(k => k.layer)));
	const expected = regions.reduce((n, r) => n + (r.getState_Layer() === 12 ? inner.length : inner.includes(r.getState_Layer() as number) ? 1 : 0), 0);
	assert.ok(expected > 0);
	assert.equal(read.keepouts.length, expected);
	mock.eda.pcb_PrimitiveRegion.getAll = (async () => withRules([2, 5])) as never;
	assert.equal((await boardModule.readBoard()).keepouts.length, 0);
	assert.ok(saved(mock).some(l => /region .*: rules \[2, 5\], layer \d+, ignored$/.test(l)));
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
