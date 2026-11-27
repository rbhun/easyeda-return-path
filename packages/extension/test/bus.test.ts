import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { analyzeNet } from '@returnpath/core';
import { parseEasyEdaPcb } from '@returnpath/cli/parse';
import { buildEpro } from '@returnpath/cli/synth';
import { buildDcEpro } from '@returnpath/cli/synth-dc';
import esbuild from 'esbuild';
import { strFromU8, unzipSync } from 'fflate';
import common from '../config/esbuild.common.ts';
import { createMockEda, type MockHost } from './mock-eda.ts';

function boardFromZip(zip: Uint8Array) {
	const files = unzipSync(zip);
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

const demoBoard = boardFromZip(buildEpro('demo', 'object'));
const dcBoard = boardFromZip(buildDcEpro());
const ext = await import('../src/index.ts');
const { TOPIC_PUBLIC_RESULT, TOPIC_PUBLIC_RUN } = await import('../src/bus.ts');

function activateWith(board: ReturnType<typeof boardFromZip>, host: MockHost = {}) {
	const mock = createMockEda(board, 'CLK', [], () => {
		throw new Error('no dialog may be opened during public bus runs');
	}, host);
	(globalThis as Record<string, unknown>).eda = mock.eda;
	ext.activate();
	return mock;
}

function waitForReply(mock: ReturnType<typeof createMockEda>, topic = TOPIC_PUBLIC_RESULT): Promise<any> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${topic}`)), 60_000);
		mock.eda.sys_MessageBus.subscribeOncePublic(topic, (msg: unknown) => {
			clearTimeout(timer);
			resolve(msg);
		});
	});
}

test('public bus HF run via publishPublic returns structured findings, log paths, and opens zero dialogs', async () => {
	const mock = activateWith(demoBoard, { fileSystem: 'allowed' });
	const expected = analyzeNet(demoBoard, 'CLK', { drivers: ['U1'] }).findings;

	const replyP = waitForReply(mock);
	mock.eda.sys_MessageBus.publishPublic(TOPIC_PUBLIC_RUN, {
		kind: 'hf',
		net: 'clk',
		drivers: 'U1',
		speed: '25 MHz',
		requestId: 'hf-1',
	});
	const reply = await replyP;

	assert.equal(reply.requestId, 'hf-1');
	assert.equal(reply.ok, true);
	assert.equal(reply.kind, 'hf');
	assert.equal(reply.hf.net, 'CLK');
	assert.deepEqual(reply.hf.drivers, ['U1']);
	assert.equal(reply.hf.signal.hz, 25e6);
	assert.equal(reply.findings.length, expected.length);
	assert.match(reply.summary, /^CLK: \d+ finding\(s\), \d+ overlay marker\(s\)\.$/);
	assert.ok(reply.hf.markers > 0 && mock.markers.length === reply.hf.markers);
	assert.ok(reply.logPath && reply.logPath.endsWith('.log'), `expected .log path, got ${reply.logPath}`);
	assert.ok(reply.resultsPath && reply.resultsPath.endsWith('.results.json'), `expected .results.json path, got ${reply.resultsPath}`);
	assert.ok(mock.files.has(reply.logPath));
	assert.ok(mock.files.has(reply.resultsPath));
	assert.equal(mock.dialogs.length, 0);
	assert.equal(mock.infoDialogs.length, 0);
	assert.equal(mock.wizard.opens, 0);
	assert.equal(mock.iframes.size, 0, 'does not auto-open the panel window');
	assert.equal(mock.toasts.length, 0);
});

test('public bus HF run supports draw: false and omits driver when ambiguous without asking', async () => {
	const mock = activateWith(demoBoard);
	const replyP = waitForReply(mock);
	mock.eda.sys_MessageBus.publishPublic(TOPIC_PUBLIC_RUN, {
		kind: 'hf',
		net: 'CLK',
		draw: false,
		requestId: 'hf-nodraw',
	});
	const reply = await replyP;

	assert.equal(reply.ok, true);
	assert.equal(reply.requestId, 'hf-nodraw');
	assert.deepEqual(reply.hf.drivers, []);
	assert.equal(reply.hf.markers, 0);
	assert.equal(mock.markers.length, 0);
	assert.equal(mock.dialogs.length, 0);
	assert.equal(mock.wizard.opens, 0);
});

test('public bus DC run supports custom replyTopic, pullAsyncPublic, and explicit loads/currents with zero dialogs', async () => {
	const mock = activateWith(dcBoard, { fileSystem: 'allowed' });
	const replyTopic = 'returnpath.result.dc-1';
	const subP = waitForReply(mock, replyTopic);

	mock.eda.sys_MessageBus.publishPublic(TOPIC_PUBLIC_RUN, {
		kind: 'dc',
		rail: '3v3',
		ground: 'gnd',
		source: 'U1',
		loads: ['U2', 'U3'],
		currents: { U2: '150mA', U3: 0.05 },
		requestId: 'dc-1',
		replyTopic,
	});

	const [fromSub, fromPull] = await Promise.all([
		subP,
		mock.eda.sys_MessageBus.pullAsyncPublic(replyTopic) as Promise<any>,
	]);

	for (const reply of [fromSub, fromPull]) {
		assert.equal(reply.ok, true);
		assert.equal(reply.requestId, 'dc-1');
		assert.equal(reply.kind, 'dc');
		assert.equal(reply.dc.rail, '3V3');
		assert.equal(reply.dc.ground, 'GND');
		assert.equal(reply.dc.source, 'U1');
		assert.equal(reply.dc.normalised, false);
		assert.deepEqual(reply.dc.loads, [
			{ designator: 'U2', current: 0.15 },
			{ designator: 'U3', current: 0.05 },
		]);
		assert.equal(reply.dc.nets.length, 2);
		assert.ok(reply.dc.nets.every((n: { dropV: number }) => n.dropV > 0));
		assert.match(reply.summary, /^3V3 \/ GND: source U1, loads U2, U3\./);
		assert.ok(reply.logPath && reply.resultsPath);
	}
	assert.equal(mock.dialogs.length, 0);
	assert.equal(mock.infoDialogs.length, 0);
	assert.equal(mock.wizard.opens, 0);
});

test('public bus accepts pushPublic requests and RPC calls via rpcCallPublic', async () => {
	const mock = activateWith(dcBoard);

	const pushReplyTopic = 'returnpath.result.push-1';
	mock.eda.sys_MessageBus.pushPublic(TOPIC_PUBLIC_RUN, {
		kind: 'dc',
		rail: '3V3',
		currents: 'U2=100mA, U3=50mA',
		requestId: 'push-1',
		replyTopic: pushReplyTopic,
		draw: false,
	});
	const pushed = await mock.eda.sys_MessageBus.pullAsyncPublic(pushReplyTopic) as any;
	assert.equal(pushed.ok, true);
	assert.equal(pushed.requestId, 'push-1');
	assert.equal(pushed.dc.source, 'U1');
	assert.equal(pushed.dc.ground, 'GND');
	assert.equal(pushed.dc.markers, 0);

	// Subsequent push works too (pullPublic re-armed) and RPC works directly.
	const rpc = await mock.eda.sys_MessageBus.rpcCallPublic(TOPIC_PUBLIC_RUN, {
		kind: 'dc',
		rail: '3V3',
		focus: 'U2',
		requestId: 'rpc-1',
		draw: false,
	}) as any;
	assert.equal(rpc.ok, true);
	assert.equal(rpc.requestId, 'rpc-1');
	assert.equal(rpc.dc.focus, 'U2');
	assert.deepEqual(rpc.dc.loads.map((l: { designator: string }) => l.designator), ['U2']);
	assert.equal(mock.dialogs.length, 0);
});

test('public bus returns clear errors when PCB is not focused, args are invalid, or net is non-signal', async () => {
	// 1. No document focused
	const noDoc = activateWith(demoBoard, { documentInfo: null });
	const r1 = await noDoc.eda.sys_MessageBus.rpcCallPublic(TOPIC_PUBLIC_RUN, { kind: 'hf', net: 'CLK', requestId: 'e-nodoc' }) as any;
	assert.equal(r1.ok, false);
	assert.equal(r1.requestId, 'e-nodoc');
	assert.match(r1.error, /No PCB document is focused/);
	assert.equal(noDoc.counts.boardReads, 0);
	assert.equal(noDoc.dialogs.length, 0);

	// 2. Schematic focused instead of PCB (documentType = 1)
	const schDoc = activateWith(demoBoard, { documentInfo: { documentType: 1, uuid: 'sch-1' } });
	const r2 = await schDoc.eda.sys_MessageBus.rpcCallPublic(TOPIC_PUBLIC_RUN, { kind: 'hf', net: 'CLK', requestId: 'e-sch' }) as any;
	assert.equal(r2.ok, false);
	assert.equal(r2.requestId, 'e-sch');
	assert.match(r2.error, /not a PCB.*documentType=1/);
	assert.equal(schDoc.counts.boardReads, 0);

	// 3. Validation errors & non-signal HF net & unknown net/driver
	const mock = activateWith(demoBoard);
	const badJson = await mock.eda.sys_MessageBus.rpcCallPublic(TOPIC_PUBLIC_RUN, '{not-json') as any;
	assert.equal(badJson.ok, false);
	assert.match(badJson.error, /Invalid JSON payload/);

	const badKind = await mock.eda.sys_MessageBus.rpcCallPublic(TOPIC_PUBLIC_RUN, { kind: 'ac', requestId: 'e-kind' }) as any;
	assert.equal(badKind.ok, false);
	assert.equal(badKind.requestId, 'e-kind');
	assert.match(badKind.error, /Missing or invalid "kind"/);

	const missingNet = await mock.eda.sys_MessageBus.rpcCallPublic(TOPIC_PUBLIC_RUN, { kind: 'hf', requestId: 'e-net' }) as any;
	assert.equal(missingNet.ok, false);
	assert.match(missingNet.error, /Missing required "net"/);

	const badSpeed = await mock.eda.sys_MessageBus.rpcCallPublic(TOPIC_PUBLIC_RUN, { kind: 'hf', net: 'CLK', speed: 'fast', requestId: 'e-speed' }) as any;
	assert.equal(badSpeed.ok, false);
	assert.match(badSpeed.error, /Invalid "speed"/);

	const unknownNet = await mock.eda.sys_MessageBus.rpcCallPublic(TOPIC_PUBLIC_RUN, { kind: 'hf', net: 'NO_SUCH_NET', requestId: 'e-unknown' }) as any;
	assert.equal(unknownNet.ok, false);
	assert.match(unknownNet.error, /Net "NO_SUCH_NET" not found/);

	const nonSignal = await mock.eda.sys_MessageBus.rpcCallPublic(TOPIC_PUBLIC_RUN, { kind: 'hf', net: 'GND', requestId: 'e-gnd' }) as any;
	assert.equal(nonSignal.ok, false);
	assert.match(nonSignal.error, /ground/i);

	const badDriver = await mock.eda.sys_MessageBus.rpcCallPublic(TOPIC_PUBLIC_RUN, { kind: 'hf', net: 'CLK', drivers: ['U99'], requestId: 'e-drv' }) as any;
	assert.equal(badDriver.ok, false);
	assert.match(badDriver.error, /Driver "U99" has no pad on net "CLK"/);

	// 4. JSON string payload works when valid
	const fromJsonStr = await mock.eda.sys_MessageBus.rpcCallPublic(TOPIC_PUBLIC_RUN, JSON.stringify({ kind: 'hf', net: 'CLK', draw: false, requestId: 'json-str' })) as any;
	assert.equal(fromJsonStr.ok, true);
	assert.equal(fromJsonStr.requestId, 'json-str');
	assert.equal(mock.dialogs.length, 0);
	assert.equal(mock.infoDialogs.length, 0);
});

test('public bus rejects DC arg errors, concurrent busy requests, and recovers after board-read failure', async () => {
	const mock = activateWith(dcBoard);

	const missingRail = await mock.eda.sys_MessageBus.rpcCallPublic(TOPIC_PUBLIC_RUN, { kind: 'dc', requestId: 'dc-norail' }) as any;
	assert.equal(missingRail.ok, false);
	assert.match(missingRail.error, /Missing required "rail"/);

	const badCurrents = await mock.eda.sys_MessageBus.rpcCallPublic(TOPIC_PUBLIC_RUN, { kind: 'dc', rail: '3V3', currents: { U99: 0.1 }, requestId: 'dc-badcurr' }) as any;
	assert.equal(badCurrents.ok, false);
	assert.match(badCurrents.error, /Unknown component "U99" in "currents"/);

	const badSource = await mock.eda.sys_MessageBus.rpcCallPublic(TOPIC_PUBLIC_RUN, { kind: 'dc', rail: '3V3', source: 'U99', requestId: 'dc-badsrc' }) as any;
	assert.equal(badSource.ok, false);
	assert.match(badSource.error, /source "U99" not found/);

	// Simulate a slow board read to verify concurrent request gets a clean busy error, and failure clears busy state.
	const origGetAll = mock.eda.pcb_PrimitiveLine.getAll;
	let releaseFirst!: () => void;
	const firstStarted = new Promise<void>(r => (mock.eda.pcb_PrimitiveLine.getAll = async () => {
		r();
		await new Promise<void>(done => (releaseFirst = done));
		throw new Error('simulated PCB read failure');
	}));

	const firstP = mock.eda.sys_MessageBus.rpcCallPublic(TOPIC_PUBLIC_RUN, { kind: 'dc', rail: '3V3', draw: false, requestId: 'busy-1' }) as Promise<any>;
	await firstStarted;
	const second = await mock.eda.sys_MessageBus.rpcCallPublic(TOPIC_PUBLIC_RUN, { kind: 'dc', rail: '3V3', draw: false, requestId: 'busy-2' }) as any;
	assert.equal(second.ok, false);
	assert.equal(second.requestId, 'busy-2');
	assert.match(second.error, /already running/i);

	releaseFirst();
	const first = await firstP;
	assert.equal(first.ok, false);
	assert.equal(first.requestId, 'busy-1');
	assert.match(first.error, /simulated PCB read failure/);

	// After the failure, busy state is cleared and the next request succeeds cleanly.
	mock.eda.pcb_PrimitiveLine.getAll = origGetAll;
	const recovered = await mock.eda.sys_MessageBus.rpcCallPublic(TOPIC_PUBLIC_RUN, { kind: 'dc', rail: '3V3', draw: false, requestId: 'busy-3' }) as any;
	assert.equal(recovered.ok, true);
	assert.equal(recovered.requestId, 'busy-3');
	assert.equal(mock.dialogs.length, 0);
	assert.equal(mock.infoDialogs.length, 0);
});

const bundle = (await esbuild.build({ ...common, absWorkingDir: fileURLToPath(new URL('..', import.meta.url)), write: false, logLevel: 'silent' })).outputFiles.find(f => f.path.endsWith('index.js'))!.text;

function vmInstance(eda: Record<string, unknown>, storage = new Map<string, unknown>()) {
	const own = { ...eda, sys_Storage: { getExtensionUserConfig: (k: string) => storage.get(k), setExtensionUserConfig: async (k: string, v: unknown) => (storage.set(k, structuredClone(v)), true) } };
	const ctx = vm.createContext({ eda: own, console, setTimeout, clearTimeout, queueMicrotask, structuredClone, Blob, TextEncoder, TextDecoder });
	return vm.runInContext(`${bundle};edaEsbuildExportName`, ctx) as Record<string, (...a: unknown[]) => Promise<void> | void>;
}

test('two activated instances handle a publishPublic request once and sync the result to the open panel', async () => {
	const mock = createMockEda(dcBoard, '3V3');
	const a = vmInstance(mock.eda);
	const b = vmInstance(mock.eda);
	a.activate();
	b.activate();

	await a.showPanel();
	mock.panelSend({ cmd: 'hello' });

	const replies: any[] = [];
	mock.eda.sys_MessageBus.subscribePublic(TOPIC_PUBLIC_RESULT, (m: unknown) => replies.push(m));
	mock.eda.sys_MessageBus.publishPublic(TOPIC_PUBLIC_RUN, {
		kind: 'dc',
		rail: '3V3',
		requestId: 'multi-1',
	});

	for (let i = 0; i < 1200 && replies.length === 0; i++)
		await new Promise(r => setTimeout(r, 25));
	await new Promise(r => setTimeout(r, 100));

	assert.equal(replies.length, 1, 'exactly one instance handles the broadcast and replies');
	assert.equal(replies[0].ok, true);
	assert.equal(replies[0].requestId, 'multi-1');
	assert.equal(mock.counts.boardReads, 1, 'board is read only once');
	const states = mock.published.filter(p => p.topic === 'returnpath.panel.state').map(p => p.message);
	assert.match(states.at(-1).result.lines[0], /^3V3 \/ GND: source U1/);
	assert.equal(states.at(-1).overlay, 'shown');
	assert.equal(mock.dialogs.length, 0);
	assert.equal(mock.infoDialogs.length, 0);
});

test('the Return Path extension itself serves mcp.rcp.* on the public bus and lists them in About', async () => {
	const mock = activateWith(demoBoard);
	const info = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.info', {}) as any;
	assert.equal(info.ok, true);
	assert.equal(info.data.service, 'easyeda-return-path');
	assert.equal(info.data.unit, 'mm');
	assert.deepEqual(info.data.topics, [
		'mcp.rcp.info',
		'mcp.rcp.listNets',
		'mcp.rcp.checkNet',
		'mcp.rcp.showFindings',
		'mcp.rcp.clearMarkers',
		'mcp.rcp.getConfig',
		'mcp.rcp.setConfig',
		'mcp.rcp.startAnalysis',
		'mcp.rcp.getAnalysis',
		'mcp.rcp.cancelAnalysis',
	]);

	const nets = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.listNets', { includePower: true }) as any;
	assert.equal(nets.ok, true);
	assert.ok(nets.data.nets.some((n: { name: string }) => n.name === 'CLK'));

	const check = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.checkNet', { net: 'clk' }) as any;
	assert.equal(check.ok, true, check.error);
	assert.equal(check.data.net, 'CLK');
	assert.ok(Array.isArray(check.data.findings));

	const cleared = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.clearMarkers', {}) as any;
	assert.equal(cleared.ok, true);

	ext.about();
	const text = mock.infoDialogs.map((d: any) => JSON.stringify(d)).join('\n');
	assert.match(text, /MCP bridge services/);
	assert.match(text, /mcp\.rcp\.checkNet/);
	assert.match(text, /mcp\.rcp\.getConfig/);
	assert.match(text, /mcp\.rcp\.startAnalysis/);
});

test('mcp.rcp.getConfig and setConfig read/write boardInfo, rules, hf/dc options, and overlayStyle idempotently', async () => {
	const mock = activateWith(demoBoard);

	const initial = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.getConfig', {}) as any;
	assert.equal(initial.ok, true, initial.error);
	assert.equal(initial.data.unit, 'mm');
	assert.equal(initial.data.project.id, 'demo-project');
	assert.deepEqual(initial.data.boardInfo, { nets: [], loads: [], layers: [] });
	assert.equal(initial.data.rules.returnViaRadiusMm, 2.5);
	assert.deepEqual(initial.data.hf.nets, []);
	assert.equal(initial.data.hf.draw, true);

	const payload = {
		boardInfo: {
			nets: [
				{ net: 'CLK', kind: 'clock', speed: '25 MHz', driver: 'U1', edge: 'fast', drive: 'push-pull' },
			],
			loads: [
				{ net: '3V3', voltage: '3V3', source: 'U1', load: 'U2', typicalCurrent: '150mA' },
			],
			layers: [
				{ layer: 'Bottom', pours: 'GND', splits: 'none' },
			],
		},
		rules: {
			returnViaRadiusMm: 4.0,
			skipNets: ['RESET'],
		},
		hf: {
			nets: ['CLK'],
			draw: true,
			timeoutMs: 30_000,
		},
		dc: {
			rail: '3V3',
			ground: 'GND',
			source: 'U1',
			loads: ['U2'],
			currents: { U2: '150mA' },
			draw: false,
		},
		overlayStyle: {
			hop: { colour: 'cyan', width: 3 },
		},
	};

	const set1 = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.setConfig', payload) as any;
	assert.equal(set1.ok, true, set1.error);
	assert.deepEqual(set1.data.updated, ['boardInfo', 'rules', 'hf', 'dc', 'overlayStyle']);
	assert.equal(set1.data.config.boardInfo.nets[0].net, 'CLK');
	assert.equal(set1.data.config.boardInfo.nets[0].speedHz, 25_000_000);
	assert.deepEqual(set1.data.config.boardInfo.nets[0].driver, { parts: ['U1'] });
	assert.equal(set1.data.config.boardInfo.loads[0].typicalA, 0.15);
	assert.equal(set1.data.config.rules.returnViaRadiusMm, 4);
	assert.deepEqual(set1.data.config.hf.nets, ['CLK']);
	assert.equal(set1.data.config.dc.currents.U2, 0.15);
	assert.equal(set1.data.config.overlayStyle.hop.colour, 'cyan');
	assert.equal(set1.data.config.overlayStyle.hop.width, 3);

	// Idempotency: applying the exact same setConfig again yields identical config state.
	const set2 = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.setConfig', payload) as any;
	assert.equal(set2.ok, true, set2.error);
	assert.deepEqual(set2.data.config, set1.data.config);

	// Rules set via setConfig are applied automatically by mcp.rcp.checkNet.
	const check = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.checkNet', { net: 'CLK' }) as any;
	assert.equal(check.ok, true, check.error);
	assert.equal(check.data.rulesApplied.returnViaRadiusMm, 4);

	// Invalid input returns { ok: false, error } without mutating saved config.
	const bad = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.setConfig', { hf: { timeoutMs: -5 } }) as any;
	assert.equal(bad.ok, false);
	assert.match(bad.error, /timeoutMs/);

	// Replace & reset work cleanly.
	const reset = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.setConfig', { reset: true, boardInfo: null, overlayStyle: 'reset' }) as any;
	assert.equal(reset.ok, true, reset.error);
	assert.deepEqual(reset.data.config.boardInfo, { nets: [], loads: [], layers: [] });
	assert.equal(reset.data.config.rules.returnViaRadiusMm, 2.5);
	assert.deepEqual(reset.data.config.hf.nets, []);
	assert.equal(reset.data.config.overlayStyle.hop.colour, 'white');
});

test('mcp.rcp.startAnalysis runs HF using configured defaults, draws overlay, supports idempotency and rescoring', async () => {
	const mock = activateWith(demoBoard);
	const expected = analyzeNet(demoBoard, 'CLK', { drivers: ['U1'] }).findings;

	// Configure CLK + HF target nets via mcp.rcp.setConfig.
	const cfg = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.setConfig', {
		boardInfo: {
			nets: [{ net: 'CLK', kind: 'clock', speed: '25 MHz', driver: 'U1', edge: 'fast', drive: 'push-pull' }],
		},
		hf: { nets: ['CLK'], draw: true },
	}) as any;
	assert.equal(cfg.ok, true, cfg.error);

	// Start HF analysis omitting net/drivers/speed: uses configured hf.nets and boardInfo.
	const run = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.startAnalysis', {
		kind: 'hf',
		requestId: 'hf-clk-demo',
		waitMs: 15_000,
	}) as any;
	assert.equal(run.ok, true, run.error);
	assert.equal(run.data.status, 'completed');
	assert.equal(run.data.kind, 'hf');
	assert.equal(run.data.requestId, 'hf-clk-demo');
	assert.equal(run.data.unit, 'mm');
	assert.equal(run.data.result.batch, false);
	assert.equal(run.data.result.hf.net, 'CLK');
	assert.deepEqual(run.data.result.hf.drivers, ['U1']);
	assert.equal(run.data.result.hf.signal.hz, 25_000_000);
	assert.equal(run.data.result.findings.length, expected.length);
	assert.ok(run.data.result.hf.markers > 0, 'draws temporary overlay markers like the UI');
	assert.ok(mock.markers.length > 0);
	assert.equal(mock.dialogs.length, 0);
	assert.equal(mock.infoDialogs.length, 0);

	// Idempotent retry with same requestId returns the exact same job without re-running.
	const retry = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.startAnalysis', {
		kind: 'hf',
		requestId: 'hf-clk-demo',
	}) as any;
	assert.equal(retry.ok, true, retry.error);
	assert.equal(retry.data.jobId, run.data.jobId);
	assert.equal(retry.data.status, 'completed');

	// getConfig now reflects lastRun from the UI-equivalent analysis.
	const afterCfg = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.getConfig', {}) as any;
	assert.equal(afterCfg.ok, true);
	assert.equal(afterCfg.data.lastRun?.kind, 'hf');
	assert.equal(afterCfg.data.lastRun?.net, 'CLK');

	// Updating edge class via setConfig rescores the stored HF check without re-solving.
	const slowRes = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.setConfig', {
		boardInfo: { nets: [{ net: 'CLK', edge: 'slow' }] },
	}) as any;
	assert.equal(slowRes.ok, true, slowRes.error);
});

test('mcp.rcp.startAnalysis runs DC using configured defaults and rejects oversized HF batches', async () => {
	const mock = activateWith(dcBoard);

	const cfg = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.setConfig', {
		dc: { rail: '3V3', draw: false },
	}) as any;
	assert.equal(cfg.ok, true, cfg.error);

	const dcRun = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.startAnalysis', {
		kind: 'dc',
		requestId: 'dc-3v3-demo',
		waitMs: 30_000,
	}) as any;
	assert.equal(dcRun.ok, true, dcRun.error);
	assert.equal(dcRun.data.status, 'completed');
	assert.equal(dcRun.data.kind, 'dc');
	assert.equal(dcRun.data.result.dc.rail, '3V3');
	assert.equal(dcRun.data.result.dc.ground, 'GND');
	assert.equal(dcRun.data.result.dc.source, 'U1');
	assert.ok(dcRun.data.result.dc.nets.some((n: { role: string }) => n.role === 'supply'));
	assert.equal(mock.dialogs.length, 0);

	// Oversized HF batch (> 10 nets) is rejected cleanly.
	const tooMany = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.startAnalysis', {
		kind: 'hf',
		nets: Array.from({ length: 11 }, (_, i) => `SIG_${i}`),
	}) as any;
	assert.equal(tooMany.ok, false);
	assert.match(tooMany.error, /maximum of 10/);
});

test('mcp.rcp.startAnalysis returns a pollable running handle when exceeding waitMs, supports getAnalysis & cancelAnalysis', async () => {
	const mock = activateWith(demoBoard);

	// Delay pcb_PrimitiveLine.getAll so the analysis stays running past waitMs=0.
	let releaseRead!: () => void;
	const readGate = new Promise<void>(r => { releaseRead = r; });
	const origGetAll = mock.eda.pcb_PrimitiveLine.getAll;
	mock.eda.pcb_PrimitiveLine.getAll = async () => {
		await readGate;
		return origGetAll();
	};

	const started = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.startAnalysis', {
		kind: 'hf',
		net: 'CLK',
		drivers: ['U1'],
		draw: false,
		requestId: 'slow-hf-1',
		waitMs: 0,
	}) as any;
	assert.equal(started.ok, true, started.error);
	assert.equal(started.data.status, 'running');
	assert.equal(started.data.pollTopic, 'mcp.rcp.getAnalysis');
	const jobId = started.data.jobId;

	// A different request while running is rejected cleanly, naming the active jobId.
	const busy = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.startAnalysis', {
		kind: 'hf',
		net: 'CLK',
		requestId: 'slow-hf-2',
		waitMs: 0,
	}) as any;
	assert.equal(busy.ok, false);
	assert.match(busy.error, new RegExp(jobId));

	// Retrying with the SAME requestId while running is idempotent and returns the same handle.
	const same = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.startAnalysis', {
		kind: 'hf',
		net: 'CLK',
		requestId: 'slow-hf-1',
		waitMs: 0,
	}) as any;
	assert.equal(same.ok, true);
	assert.equal(same.data.jobId, jobId);
	assert.equal(same.data.status, 'running');

	// Release the board read and long-poll via mcp.rcp.getAnalysis until completed.
	releaseRead();
	const polled = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.getAnalysis', {
		jobId,
		waitMs: 15_000,
	}) as any;
	assert.equal(polled.ok, true, polled.error);
	assert.equal(polled.data.status, 'completed');
	assert.equal(polled.data.result.hf.net, 'CLK');

	// List recent jobs via mcp.rcp.getAnalysis({ list: true }).
	const listed = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.getAnalysis', { list: true }) as any;
	assert.equal(listed.ok, true);
	assert.equal(listed.data.activeJobId, null);
	assert.ok(listed.data.jobs.some((j: { jobId: string }) => j.jobId === jobId));

	// Cancel on an already-completed job is idempotent.
	const cancelDone = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.cancelAnalysis', { jobId }) as any;
	assert.equal(cancelDone.ok, true);
	assert.equal(cancelDone.data.cancelled, false);
	assert.equal(cancelDone.data.status, 'completed');

	// Start another paused job and cancel it while running.
	let releaseRead2!: () => void;
	const readGate2 = new Promise<void>(r => { releaseRead2 = r; });
	mock.eda.pcb_PrimitiveLine.getAll = async () => {
		await readGate2;
		return origGetAll();
	};
	const started2 = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.startAnalysis', {
		kind: 'hf',
		nets: ['CLK', 'MISSING_NET'],
		draw: false,
		waitMs: 0,
	}) as any;
	assert.equal(started2.ok, true);
	assert.equal(started2.data.status, 'running');

	const cancelNow = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.cancelAnalysis', { jobId: started2.data.jobId }) as any;
	assert.equal(cancelNow.ok, true);
	assert.equal(cancelNow.data.cancelled, true);
	assert.equal(cancelNow.data.status, 'cancelling');

	releaseRead2();
	const afterCancel = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.getAnalysis', {
		jobId: started2.data.jobId,
		waitMs: 15_000,
	}) as any;
	assert.equal(afterCancel.ok, true, afterCancel.error);
	assert.equal(afterCancel.data.status, 'cancelled');

	mock.eda.pcb_PrimitiveLine.getAll = origGetAll;
});

test('mcp.rcp.startAnalysis runs a small HF batch and rejects when no PCB is focused', async () => {
	const mock = activateWith(demoBoard);
	const batch = await mock.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.startAnalysis', {
		kind: 'hf',
		nets: ['CLK', 'NO_SUCH_NET'],
		draw: false,
		waitMs: 15_000,
	}) as any;
	assert.equal(batch.ok, true, batch.error);
	assert.equal(batch.data.status, 'completed');
	assert.equal(batch.data.result.batch, true);
	assert.equal(batch.data.result.total, 2);
	assert.equal(batch.data.result.completed, 1);
	assert.equal(batch.data.result.failed, 1);
	assert.equal(batch.data.result.nets[0].ok, true);
	assert.equal(batch.data.result.nets[0].net, 'CLK');
	assert.equal(batch.data.result.nets[1].ok, false);

	// No PCB focused rejects cleanly even with waitMs=0.
	const noPcb = activateWith(demoBoard, { documentInfo: null });
	const err = await noPcb.eda.sys_MessageBus.rpcCallPublic('mcp.rcp.startAnalysis', {
		kind: 'hf',
		net: 'CLK',
		waitMs: 0,
	}) as any;
	assert.equal(err.ok, false);
	assert.match(err.error, /Focus a PCB document first/);
});
