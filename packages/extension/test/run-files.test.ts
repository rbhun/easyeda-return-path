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
const boardModule = await import('../src/eda-board.ts');
const { version: VERSION } = (await import('../extension.json', { with: { type: 'json' } })).default;
runner.saveTimeouts.ms = 50;
Object.assign(boardModule.apiTimeouts, { callMs: 200, stackupMs: 100, pinsMs: 100 });

const demo = load(buildEpro('demo', 'object'));
const DEFAULT_DIR = 'C:\\Users\\me\\Documents\\EasyEDA-Pro\\ReturnPath\\runs';
const RUN = /^return-path_\d{8}-\d{6}_[0-9a-f]{8}\.(log|results\.json)$/;

function install(host: MockHost, answer: (d: DialogCall) => unknown = d => d.dflt, board = demo, net = 'CLK') {
	const mock = createMockEda(board, net, [], answer, host);
	(globalThis as Record<string, unknown>).eda = mock.eda;
	return mock;
}

/** The run files written to `dir`, as [log text, parsed results] per run. */
function runs(files: Map<string, string>, dir: string) {
	const names = [...files.keys()].filter(k => k.startsWith(dir)).map(k => k.slice(dir.length + 1)).sort();
	for (const n of names) assert.match(n, RUN);
	const bases = [...new Set(names.map(n => n.replace(/\.(log|results\.json)$/, '')))];
	return bases.map((b) => {
		const sep = dir.includes('/') ? '/' : '\\';
		return { base: b, log: files.get(`${dir}${sep}${b}.log`)!, results: JSON.parse(files.get(`${dir}${sep}${b}.results.json`)!) };
	});
}

test('an HF run writes its own log and a results file to ReturnPath/runs by default', async () => {
	const mock = install({ fileSystem: 'allowed' });
	await ext.showReturnPath();
	const [run, ...more] = runs(mock.files, DEFAULT_DIR);
	assert.equal(more.length, 0);
	assert.equal(run.results.schema, 'returnpath-run/v1');
	assert.equal(run.results.version, VERSION);
	assert.equal(run.results.command, 'Show for Selected Net');
	assert.equal(run.results.status, 'ok');
	assert.equal(run.results.net, 'CLK');
	assert.match(run.results.board, /copper layers, \d+ nets, \d+ track segments/);
	assert.ok(run.results.hf.findings.length > 0);
	assert.ok(run.results.hf.markers > 0);
	assert.equal(typeof run.results.hf.stats.segments, 'number');
	assert.ok(run.results.report.some((l: string) => /finding\(s\)/.test(l)));
	assert.match(run.log, /Show for Selected Net: CLK \(v/);
	assert.match(run.log, /Return path: finished in \d+ ms/);
	assert.match(run.log, /run return-path_\S+ ok in \d+ ms/);
});

test('Set Run Folder stores the folder and later runs write there', async () => {
	const dir = '/Users/me/Documents/Cursor/easyeda-return-path/agent-runs';
	const storage = new Map<string, unknown>();
	const mock = install({ fileSystem: 'allowed', storage }, d => (d.kind === 'input' ? dir : d.dflt));
	await ext.setRunFolder();
	assert.match(mock.messages.at(-1)!, /agent-runs/);
	const restarted = install({ fileSystem: 'allowed', storage });
	await ext.showReturnPath();
	assert.equal(runs(restarted.files, dir).length, 1);
	assert.equal(runs(restarted.files, DEFAULT_DIR).length, 0);
});

test('a DC run records rail, source, loads, drops and warnings', async () => {
	const mock = install({ fileSystem: 'allowed' }, d => d.dflt, load(buildDcEpro()), '');
	await ext.showDcReturn();
	const [run] = runs(mock.files, DEFAULT_DIR);
	assert.equal(run.results.command, 'DC Return Current');
	assert.equal(run.results.status, 'ok');
	assert.ok(run.results.dc.rail);
	assert.ok(run.results.dc.source);
	assert.ok(run.results.dc.loads.length > 0);
	assert.ok(run.results.dc.nets.every((n: { dropV: number }) => typeof n.dropV === 'number'));
	assert.match(run.log, /DC setup: \{/);
});

test('the DC hand-off from a power net stays one run', async () => {
	const mock = install({ fileSystem: 'allowed' }, d => d.kind === 'confirm' ? true : d.dflt, load(buildDcEpro()), '3V3');
	await ext.showReturnPath();
	const all = runs(mock.files, DEFAULT_DIR);
	assert.equal(all.length, 1);
	assert.equal(all[0].results.command, 'Show for Selected Net');
	assert.match(all[0].results.outcome, /not a signal net \(power\)/);
	assert.ok(all[0].results.dc);
});

test('an error ends the run with status error, message and stack', async () => {
	const mock = install({ fileSystem: 'allowed' });
	mock.eda.pcb_PrimitiveLine.getAll = async () => {
		throw new Error('lines exploded');
	};
	await ext.showReturnPath();
	const [run] = runs(mock.files, DEFAULT_DIR);
	assert.equal(run.results.status, 'error');
	assert.match(run.results.error.message, /lines exploded/);
	assert.match(run.results.error.stack, /Error: lines exploded/);
	assert.match(run.log, /ERROR .*lines exploded/);
});

test('without file access the run is logged as not written and nothing fails', async () => {
	const mock = install({ fileSystem: 'denied' }, () => false);
	await ext.showReturnPath();
	assert.equal(mock.files.size, 0);
	assert.ok(runner.savedLog().some(l => /run files not written/.test(l)));
	assert.equal(mock.messages.filter(m => /Error/.test(m)).length, 0);
});
