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

	for (let i = 0; i < 200 && replies.length === 0; i++)
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
