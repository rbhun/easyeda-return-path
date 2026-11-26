// The panel's buttons are disabled while an analysis runs. Nothing outside the analysis may keep
// them disabled: file writes that never answer, a wizard question whose window went away, or a
// busy state left by an instance that is gone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEasyEdaPcb } from '@returnpath/cli/parse';
import { buildDcEpro } from '@returnpath/cli/synth-dc';
import { strFromU8, unzipSync } from 'fflate';
import { createMockEda, NO_ANSWER, type DialogCall, type MockHost } from './mock-eda.ts';

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

const ext = await import('../src/index.ts');
const runner = await import('../src/runner.ts');
const { panelTimeouts } = await import('../src/panel.ts');
runner.saveTimeouts.ms = 50;
panelTimeouts.cancelMs = 100;

const settle = async (until: () => boolean) => {
	// A DC check solves each load on its own after the combined field, so a run takes longer than the button wait used to allow.
	for (let i = 0; i < 4000 && !until(); i++)
		await new Promise(r => setTimeout(r, 10));
};

function install(answer: (d: DialogCall) => unknown = d => d.dflt, host: MockHost = {}) {
	const mock = createMockEda(dcBoard(), '3V3', [], answer, { storage: new Map(), ...host });
	(globalThis as Record<string, unknown>).eda = mock.eda;
	ext.activate();
	const states = () => mock.published.filter(p => p.topic === 'returnpath.panel.state').map(p => p.message);
	return { mock, states };
}

async function openPanel(mock: ReturnType<typeof createMockEda>, states: () => any[]) {
	await ext.showPanel();
	mock.panelSend({ cmd: 'hello' });
	await settle(() => states().length > 0);
}

test('file writes that never answer (macOS folder access): one timeout, then no more writes; HF and DC checks still run and the buttons come back', async () => {
	const storage = new Map<string, unknown>([['runFolder', '/Users/someone/runs']]);
	const { mock, states } = install(undefined, { storage, fileSystem: 'allowed' });
	const fs = mock.eda.sys_FileSystem as Record<string, unknown>;
	let writes = 0;
	fs.getEdaPath = async () => '';
	fs.createDirectoryInFileSystem = () => new Promise(() => {});
	fs.saveFileToFileSystem = () => {
		writes++;
		return new Promise(() => {});
	};
	await openPanel(mock, states);
	for (const cmd of ['dc', 'hf', 'dc']) {
		mock.panelSend({ cmd });
		await settle(() => states().some(s => s.busy));
		await settle(() => !states().at(-1).busy);
		assert.equal(states().at(-1).busy, undefined, `${cmd}: the buttons are enabled again`);
	}
	assert.ok(mock.messages.some(m => /^3V3 \/ GND: source U1/.test(m)), 'the DC check ran to its result');
	assert.equal(writes, 0, 'the directory call hung first; no file write was attempted after it');
	const lines = mock.logs.map(l => l.message);
	assert.equal(lines.filter(l => /file writes stopped: sys_FileSystem\.createDirectoryInFileSystem did not answer/.test(l)).length, 1);
	assert.ok(lines.some(l => /run files not written: .*file writes are off for this session/.test(l)));

	await runner.setRunFolder('/Users/someone/other');
	fs.createDirectoryInFileSystem = async () => true;
	mock.panelSend({ cmd: 'dc' });
	await settle(() => !states().at(-1).busy && writes > 0);
	assert.ok(writes > 0, 'choosing a Run folder again tries the file writes again');
	await settle(() => !states().at(-1).busy);
});

test('Cancel in the panel ends a wizard question whose window went away, so the run ends and the buttons come back', async () => {
	const { mock, states } = install(() => NO_ANSWER);
	await openPanel(mock, states);
	mock.panelSend({ cmd: 'dc' });
	await settle(() => mock.dialogs.length > 0);
	assert.equal(states().at(-1).busy, 'DC check');
	mock.panelSend({ cmd: 'cancel' });
	await settle(() => !states().at(-1).busy);
	assert.equal(states().at(-1).busy, undefined);
	assert.ok(mock.logs.some(l => /cancel: ended the question waiting in the wizard window/.test(l.message)));
});

test('a busy state left by an instance that is gone is cleared by Cancel, with an error in the log', async () => {
	const { mock, states } = install();
	await openPanel(mock, states);
	const at = Date.now() + 1000;
	mock.eda.sys_MessageBus.publish('returnpath.panel.sync', { from: 'gone-instance', fields: { busy: { v: 'HF check', at }, busyOwner: { v: 'gone-instance', at } } });
	mock.panelSend({ cmd: 'hello' });
	assert.equal(states().at(-1).busy, 'HF check', 'the panel shows the other instance running');
	mock.panelSend({ cmd: 'cancel' });
	await settle(() => !states().at(-1).busy);
	assert.equal(states().at(-1).busy, undefined);
	assert.ok(mock.logs.some(l => l.type === 'error' && /the instance running "HF check" did not answer Cancel within 100 ms; clearing its busy state/.test(l.message)));
	mock.panelSend({ cmd: 'dc' });
	await settle(() => mock.messages.some(m => /^3V3 \/ GND: source U1/.test(m)));
	assert.ok(mock.messages.some(m => /^3V3 \/ GND: source U1/.test(m)), 'DC check runs again');
});
