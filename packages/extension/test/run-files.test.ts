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
	const names = [...files.keys()].filter(k => k.startsWith(dir)).map(k => k.slice(dir.length + 1)).filter(n => n !== 'returnpath-log.txt').sort();
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
	assert.equal(run.results.command, 'HF check');
	assert.equal(run.results.status, 'ok');
	assert.equal(run.results.net, 'CLK');
	assert.match(run.results.board, /copper layers, \d+ nets, \d+ track segments/);
	assert.ok(run.results.hf.findings.length > 0);
	assert.ok(run.results.hf.markers > 0);
	assert.equal(typeof run.results.hf.stats.segments, 'number');
	assert.ok(run.results.report.some((l: string) => /finding\(s\)/.test(l)));
	assert.match(run.log, /HF check \(v\d+\.\d+\.\d+\), selected net CLK/);
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

	const fromPanel = install({ fileSystem: 'allowed', storage: new Map() }, d => (d.kind === 'input' ? dir : d.dflt));
	await ext.showPanel();
	fromPanel.panelSend({ cmd: 'hello' });
	fromPanel.panelSend({ cmd: 'runFolder' });
	await new Promise(r => setTimeout(r, 50));
	assert.match(fromPanel.messages.at(-1)!, /agent-runs/, 'the panel\'s Run folder button does the same');
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
	assert.equal(all[0].results.command, 'HF check');
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

const CHOSEN = '/Users/me/ReturnPathRuns';
const never = () => new Promise<never>(() => {});
type Fs = Record<string, unknown>;

test('when the run files cannot be written, the log names the API that is missing or the error, not the permission', async () => {
	const cases: [string, (fs: Fs) => void, RegExp][] = [
		['no getEdaPath', fs => delete fs.getEdaPath, /run files not written: sys_FileSystem\.getEdaPath is not available in this EasyEDA version; choose a Run folder/],
		['empty path', fs => (fs.getEdaPath = async () => ''), /run files not written: sys_FileSystem\.getEdaPath returned an empty path; choose a Run folder/],
		['throws', fs => (fs.getEdaPath = async () => {
			throw new Error('getEdaPath is not supported on this platform');
		}), /run files not written: sys_FileSystem\.getEdaPath failed: getEdaPath is not supported on this platform; choose a Run folder/],
		['never answers', fs => (fs.getEdaPath = never), /run files not written: sys_FileSystem\.getEdaPath did not answer within \d+ s; choose a Run folder/],
		['no saveFileToFileSystem', fs => delete fs.saveFileToFileSystem, /run files not written: sys_FileSystem\.saveFileToFileSystem is not available \(allow "External Interaction"/],
	];
	for (const [name, change, expected] of cases) {
		const mock = install({ fileSystem: 'allowed' }, () => false);
		change(mock.eda.sys_FileSystem as Fs);
		await ext.showReturnPath();
		const lines = runner.savedLog();
		assert.ok(lines.some(l => expected.test(l)), `${name}:\n${lines.filter(l => /not written/.test(l)).join('\n')}`);
		if (name !== 'no saveFileToFileSystem')
			assert.ok(!lines.some(l => /run files not written: allow/.test(l)), name);
		assert.equal(mock.files.size, 0, name);
		assert.equal(mock.dialogs.filter(d => /could not be written/.test(d.prompt)).length, name === 'no saveFileToFileSystem' ? 0 : 1, name);
	}
});

test('when getEdaPath fails, the run files and the log file go to the chosen Run folder', async () => {
	const storage = new Map<string, unknown>([['runFolder', CHOSEN]]);
	const mock = install({ fileSystem: 'allowed', storage }, d => (d.kind === 'confirm' ? false : d.dflt));
	delete (mock.eda.sys_FileSystem as Fs).getEdaPath;
	await ext.showReturnPath();
	assert.equal(runs(mock.files, CHOSEN).length, 1);
	assert.match(mock.files.get(`${CHOSEN}/returnpath-log.txt`) ?? '', /Return path: finished.*\n(.*\n)*.*run files written: /);
	assert.ok(runner.savedLog().some(l => /log file goes to the Run folder: sys_FileSystem\.getEdaPath is not available/.test(l)));
	assert.equal(await runner.logFilePath(), `${CHOSEN}/returnpath-log.txt`);
	assert.equal(mock.dialogs.filter(d => /could not be written/.test(d.prompt)).length, 0, 'not asked when a folder is chosen');
});

test('when getEdaPath fails and no Run folder is chosen, one question per session; the chosen folder gets that run and the log', async () => {
	const mock = install({ fileSystem: 'allowed' }, (d) => {
		if (d.kind === 'confirm')
			return /could not be written/.test(d.prompt);
		return d.kind === 'input' ? CHOSEN : d.dflt;
	});
	(mock.eda.sys_FileSystem as Fs).getEdaPath = async () => {
		throw new Error('boom');
	};
	await ext.showReturnPath();
	const asked = mock.dialogs.filter(d => /could not be written/.test(d.prompt));
	assert.equal(asked.length, 1);
	assert.match(asked[0].prompt, /sys_FileSystem\.getEdaPath failed: boom/);
	const [run] = runs(mock.files, CHOSEN);
	assert.equal(run.results.command, 'HF check');
	assert.match(mock.messages.at(-1)!, /last run's files were written there too/);
	assert.match(mock.files.get(`${CHOSEN}/returnpath-log.txt`) ?? '', /run files written: /);

	await ext.showReturnPath();
	assert.equal(runs(mock.files, CHOSEN).length, 2);
	assert.equal(mock.dialogs.filter(d => /could not be written/.test(d.prompt)).length, 1);
});

test('declining the question leaves the reason in Show Saved Log and does not ask again', async () => {
	const mock = install({ fileSystem: 'allowed' }, d => (d.kind === 'confirm' ? false : d.dflt));
	(mock.eda.sys_FileSystem as Fs).getEdaPath = async () => '';
	await ext.showReturnPath();
	await ext.showReturnPath();
	assert.equal(mock.dialogs.filter(d => /could not be written/.test(d.prompt)).length, 1);
	await ext.showSavedLog();
	assert.match(mock.dialogs.at(-1)!.prompt, /returnpath-log\.txt is not written: sys_FileSystem\.getEdaPath returned an empty path; choose a Run folder/);
});
