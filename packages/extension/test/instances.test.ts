// EasyEDA can run menu actions and the panel's commands in separate instances of the extension.
// Here the bundle is loaded twice, each instance in its own context with its own copy of the stored
// settings, against one editor: the panel must still show and act on what either instance did.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parseEasyEdaPcb } from '@returnpath/cli/parse';
import { buildDcEpro } from '@returnpath/cli/synth-dc';
import esbuild from 'esbuild';
import { strFromU8, unzipSync } from 'fflate';
import common from '../config/esbuild.common.ts';
import { createMockEda } from './mock-eda.ts';

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

const bundle = (await esbuild.build({ ...common, absWorkingDir: fileURLToPath(new URL('..', import.meta.url)), write: false, logLevel: 'silent' })).outputFiles.find(f => f.path.endsWith('index.js'))!.text;

type Ext = Record<string, (...a: unknown[]) => Promise<void> | void>;

/** One extension instance: own module state and own stored settings, shared editor and message bus. */
function instance(eda: Record<string, unknown>, storage = new Map<string, unknown>()): Ext {
	const own = { ...eda, sys_Storage: { getExtensionUserConfig: (k: string) => storage.get(k), setExtensionUserConfig: async (k: string, v: unknown) => (storage.set(k, structuredClone(v)), true) } };
	const ctx = vm.createContext({ eda: own, console, setTimeout, clearTimeout, structuredClone, Blob, TextEncoder, TextDecoder });
	return vm.runInContext(`${bundle};edaEsbuildExportName`, ctx) as Ext;
}

const settle = async (until: () => boolean) => {
	for (let i = 0; i < 400 && !until(); i++)
		await new Promise(r => setTimeout(r, 25));
};

test('two instances: a menu run in one shows in the panel opened by the other, and the panel acts on its overlay', async () => {
	const mock = createMockEda(dcBoard(), '3V3');
	const panelSide = instance(mock.eda);
	const menuSide = instance(mock.eda);
	panelSide.activate();
	menuSide.activate();

	await panelSide.showPanel();
	mock.panelSend({ cmd: 'hello' });
	const states = () => mock.published.filter(p => p.topic === 'returnpath.panel.state').map(p => p.message);
	assert.equal(states().at(-1).result, undefined);

	await menuSide.showDcReturn();
	assert.equal(mock.infoDialogs.length, 0, 'no result dialog');
	assert.match(mock.toasts.at(-1)!, /result is in the Return Path panel/);
	assert.match(states().at(-1).result.lines[0], /^3V3 \/ GND: source U1/);
	assert.match(states().at(-1).lastRun, /^DC 3V3 \/ GND, source U1/);
	assert.equal(states().at(-1).overlay, 'shown');

	mock.panelSend({ cmd: 'hello' });
	assert.match(states().at(-1).result.lines[0], /^3V3 \/ GND/, 'reopening the page still shows it');

	const drawn = mock.markers.length;
	mock.panelSend({ cmd: 'toggle' });
	await settle(() => states().at(-1).overlay === 'hidden');
	assert.equal(mock.markers.length, 0, 'Hide in the panel reaches the instance that drew the overlay');
	mock.panelSend({ cmd: 'toggle' });
	await settle(() => states().at(-1).overlay === 'shown');
	assert.equal(mock.markers.length, drawn);

	const yellow = JSON.stringify({ r: 255, g: 255, b: 0, alpha: 255 });
	mock.panelSend({ cmd: 'style', style: { forwardTop: { visible: false } } });
	await settle(() => !mock.markers.some(m => JSON.stringify(m.color) === yellow));
	assert.ok(mock.markers.length > 0 && !mock.markers.some(m => JSON.stringify(m.color) === yellow), 'the supply hidden, the return still drawn');
	assert.equal(states().at(-1).roles.find((r: { role: string }) => r.role === 'forwardTop').visible, false);

	const dialogsBefore = mock.dialogs.length;
	mock.panelSend({ cmd: 'rerun' });
	await settle(() => !states().at(-1).busy && mock.toasts.filter(t => /result is in the Return Path panel/.test(t)).length >= 2);
	assert.equal(mock.dialogs.length, dialogsBefore, 'Rerun in the panel repeats the menu run without the wizard');
	assert.ok(mock.markers.length > 0 && !mock.markers.some(m => JSON.stringify(m.color) === yellow), 'drawn by the panel instance with the hidden supply still hidden');

	await menuSide.toggleReturnPath();
	await settle(() => states().at(-1).overlay === 'hidden');
	assert.equal(mock.markers.length, 0, 'Hide/Show from the menu reaches the instance that now holds the overlay');
	await menuSide.clearReturnPath();
	await settle(() => states().at(-1).overlay === 'none');
	assert.equal(states().at(-1).overlay, 'none');
});

/** The panel page's protocol (iframe/index.html): state subscription, hello, and the mailbox pull loop. */
function page(eda: Record<string, any>) {
	const bus = eda.sys_MessageBus;
	const states: any[] = [];
	let newest: any = null;
	const at = (snap: any, k: string) => snap?.fields?.[k]?.at ?? -1;
	const keys = ['result', 'overlayOwner', 'lastRun'];
	bus.subscribe('returnpath.panel.state', (s: any) => {
		states.push(s);
		if (newest && s.stamps && keys.some(k => at(newest, k) > s.stamps[k]))
			bus.publish('returnpath.panel.command', { cmd: 'adopt', snapshot: newest });
	});
	bus.publish('returnpath.panel.command', { cmd: 'hello' });
	let open = true;
	(async () => {
		while (open) {
			const snap = await bus.pullAsync('returnpath.panel.mailbox');
			if (!open)
				break;
			if (!newest || keys.some(k => at(snap, k) > at(newest, k)))
				newest = snap;
			bus.publish('returnpath.panel.command', { cmd: 'adopt', snapshot: snap });
		}
	})();
	return { states, close: () => (open = false) };
}

/** An instance whose subscriptions stop when it is gone, as when EasyEDA ends the context of a menu action. */
function shortLived(eda: Record<string, any>) {
	let alive = true;
	const bus = eda.sys_MessageBus;
	const own = { ...eda, sys_MessageBus: { ...bus, subscribe: (t: string, fn: (m: unknown) => void) => bus.subscribe(t, (m: unknown) => alive && fn(m)) } };
	return { ext: instance(own), end: () => (alive = false) };
}

test('an instance that ran an analysis and is gone: the panel opened later shows its result and can hide and rerun it', async () => {
	const mock = createMockEda(dcBoard(), '3V3');
	const menu = shortLived(mock.eda);
	await menu.ext.showDcReturn();
	assert.equal(mock.infoDialogs.length, 0, 'no page has connected yet, and still no result dialog');
	const drawn = mock.markers.length;
	assert.ok(drawn > 0);
	menu.end();
	mock.iframes.clear();

	const opener = instance(mock.eda);
	await opener.showPanel();
	const p = page(mock.eda);
	await settle(() => p.states.some(s => s.result));
	const s = p.states.at(-1);
	assert.match(s.result.lines[0], /^3V3 \/ GND: source U1/, 'the result of the gone instance');
	assert.match(s.lastRun, /^DC 3V3 \/ GND, source U1/);
	assert.equal(s.overlay, 'shown');

	mock.panelSend({ cmd: 'toggle' });
	await settle(() => p.states.at(-1).overlay === 'hidden');
	assert.equal(mock.markers.length, 0, 'the drawing it took over can be hidden');
	mock.panelSend({ cmd: 'toggle' });
	await settle(() => p.states.at(-1).overlay === 'shown');
	assert.equal(mock.markers.length, drawn, 'and shown again');

	const dialogs = mock.dialogs.length;
	mock.panelSend({ cmd: 'rerun' });
	await settle(() => mock.toasts.some(t => /result is in the Return Path panel/.test(t)) && !p.states.at(-1).busy);
	assert.equal(mock.dialogs.length, dialogs, 'Rerun uses the last run of the gone instance, without the wizard');
	assert.equal(mock.infoDialogs.length, 0, 'and its result goes to the panel');
	p.close();
});

test('Open Panel in a new instance while the page of a gone instance is still open: the page hands its snapshot over', async () => {
	const mock = createMockEda(dcBoard(), '3V3');
	const first = shortLived(mock.eda);
	const p = page(mock.eda);
	await first.ext.showPanel();
	mock.panelSend({ cmd: 'hello' });
	await first.ext.showDcReturn();
	await settle(() => p.states.some(s => s.result));
	first.end();

	const second = instance(mock.eda);
	await second.showPanel();
	await settle(() => p.states.at(-1).stamps.result >= 0 && p.states.at(-1).overlay === 'shown' && p.states.length > 3);
	mock.panelSend({ cmd: 'clear' });
	await settle(() => p.states.at(-1).overlay === 'none');
	assert.equal(mock.markers.length, 0, 'Clear reaches the new owner, which took over the drawing');
	assert.match(p.states.at(-1).result.lines[0], /^3V3 \/ GND/);
	p.close();
});

test('after an update, markers the old version left on the board are known: the panel names them, and Clear or Hide removes them', async () => {
	const { version } = (await import('../extension.json', { with: { type: 'json' } })).default;
	const storage = new Map<string, unknown>();
	const before = createMockEda(dcBoard(), '3V3');
	await instance(before.eda, storage).showDcReturn();
	assert.ok(before.markers.length > 0);
	assert.equal(storage.get('overlayOnCanvas'), version, 'the drawing version is stored while markers are on the canvas');

	for (const cmd of ['clear', 'toggle'] as const) {
		// The updated extension: new instance and message bus, the same settings and the same canvas.
		const after = createMockEda(dcBoard(), '3V3');
		after.markers.push(...before.markers);
		storage.set('overlayOnCanvas', version);
		const updated = instance(after.eda, storage);
		await updated.showPanel();
		const p = page(after.eda);
		await settle(() => p.states.length > 0);
		assert.equal(p.states.at(-1).overlay, 'shown', `${cmd}: the leftover overlay shows in the panel`);
		assert.equal(p.states.at(-1).leftover, version);
		assert.ok(after.logs.some(l => /markers drawn by v[\d.]+ may still be on the canvas/.test(l.message)));
		after.panelSend({ cmd });
		await settle(() => p.states.at(-1).overlay === 'none');
		assert.equal(after.markers.length, 0, `${cmd} removes them`);
		assert.equal(storage.get('overlayOnCanvas'), false);
		if (cmd === 'toggle')
			assert.match(after.toasts.at(-1)!, /Removed the overlay left on the board by an earlier session/);
		p.close();
	}
});

test('Clear works when the instance that drew the overlay is gone without handing it over', async () => {
	const mock = createMockEda(dcBoard(), '3V3');
	const owner = instance(mock.eda);
	await owner.showPanel();
	mock.panelSend({ cmd: 'hello' });
	const drawer = shortLived(mock.eda);
	await drawer.ext.showDcReturn();
	assert.ok(mock.markers.length > 0);
	drawer.end();
	const states = () => mock.published.filter(p => p.topic === 'returnpath.panel.state').map(p => p.message);
	mock.panelSend({ cmd: 'clear' });
	await settle(() => mock.markers.length === 0 && states().at(-1).overlay === 'none');
	assert.equal(mock.markers.length, 0, 'the panel owner removes the markers itself');
	assert.equal(states().at(-1).overlay, 'none');
});
