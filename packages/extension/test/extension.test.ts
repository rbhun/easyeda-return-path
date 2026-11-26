import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { analyzeNet } from '@returnpath/core';
import { parseEasyEdaPcb } from '@returnpath/cli/parse';
import { buildEpro } from '@returnpath/cli/synth';
import { strFromU8, unzipSync } from 'fflate';
import { BACK_ANSWER, createMockEda } from './mock-eda.ts';

function demoBoard() {
	const files = unzipSync(buildEpro('demo', 'object'));
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

const board = demoBoard();
const expected = analyzeNet(board, 'CLK', { drivers: ['U1'] }).findings.map(f => `[${f.severity}] ${f.message}`);
const ext = await import('../src/index.ts');
const { PALETTE } = await import('../src/style.ts');
const COLORS = { band: PALETTE.white, gap: PALETTE.red, hop: PALETTE.white, signal: PALETTE.yellow, signalOther: PALETTE.green };
const RETURN_COLORS = { top: PALETTE.magenta, bottom: PALETTE.cyan, inner: PALETTE.blue };

async function run(planeLayers: number[]) {
	const mock = createMockEda(board, 'CLK', planeLayers);
	(globalThis as Record<string, unknown>).eda = mock.eda;
	await ext.showReturnPath();
	return mock;
}

test('menu action reads the board through the API and draws temporary markers', async () => {
	const mock = await run([]);
	assert.equal(mock.messages.length, 1);
	assert.deepEqual(mock.messages[0].split('\n').filter(l => l.startsWith('[')), expected);
	assert.match(mock.messages[0], /^CLK: 8 finding\(s\)/);
	assert.match(mock.messages[0], /Current drawn where it flows, in the colour of the copper layer it flows in\. Forward \(the signal trace\): Top Layer yellow, Bottom Layer green, with a circle on each via it passes through\. Return: Inner1 blue, Top Layer magenta, Inner2 blue; on the trace where it runs in the copper of another layer, beside it in a pour on the trace's own layer\. Dashed white: hop between layers or into a part .*red over the trace: it crosses a gap, or has less than half the reference copper it needs/);
	assert.match(mock.messages[0], /^CLK: clock at 16 MHz\. Edges ≈ 2\.0 ns .* it acts as a transmission line/m);
	const pick = mock.wizardPages.find(p => /^Net to check and its speed/.test(p.prompt))!;
	assert.equal(pick.kind, 'nets', 'net and speed on one page');
	assert.deepEqual(pick.options.map(o => o.label), ['CLK · clock · 65 mm'], 'the selected net is offered with its kind and length');
	assert.equal(pick.value, 'CLK');
	const clk = pick.options[0] as unknown as { speed: string; speeds: { value: string; label: string }[] };
	assert.equal(clk.speed, String(16e6), 'prefilled with the usual speed of a clock');
	assert.ok(clk.speeds.every(s => /^\S.* \(edges ≈ [\d.]+ ns\)$/.test(s.label) && !s.label.includes('${')), 'speed labels are filled in');
	assert.equal(pick.back, false, 'nothing to go back to on the first page');
	assert.equal(mock.wizardPages.find(p => /Which part drives CLK/.test(p.prompt))?.back, true, 'Back on the driver page');
	const q = mock.dialogs.find(d => /Which part drives CLK/.test(d.prompt))!;
	assert.deepEqual(q.options, ['U1', 'U2', '*', '-'], 'no pin names on this board: both ICs offered, plus both and none');
	assert.match(mock.messages[0], /Driver: U1\./);
	const colors = new Set(mock.markers.map(m => JSON.stringify(m.color)));
	const expectedColors = [COLORS.gap, COLORS.hop, COLORS.signal, COLORS.signalOther, RETURN_COLORS.inner, RETURN_COLORS.top].map(c => JSON.stringify(c));
	assert.deepEqual(colors, new Set(expectedColors), 'gap, hop, the signal and its return in one colour per copper layer each, all opaque; band edges are hidden by default');
	assert.ok(mock.markers.every(m => (m.color as { alpha: number }).alpha === 255), 'alpha 255: opaque on a 0–1 (clipped) or a 0–255 scale');
	assert.ok(mock.markers.every(m => ['r', 'g', 'b'].every(k => [0, 255].includes((m.color as Record<string, number>)[k]))), 'channels only 0 or 255: EasyEDA Pro 3.2 clips colours to a 0–1 scale');
	const of = (c: object) => mock.markers.filter(m => JSON.stringify(m.color) === JSON.stringify(c));
	assert.ok(of(RETURN_COLORS.inner).length && of(RETURN_COLORS.inner).every(m => m.width === 5), 'return path thick');
	const signal = of(COLORS.signal);
	assert.ok([signal, of(COLORS.signalOther)].every(s => s.some(m => m.shape.type === 'line') && s.every(m => m.width === 2)), 'the signal trace drawn thin over its return, in the colour of its layer');
	assert.equal(signal.filter(m => m.shape.type === 'circle').length, 2, 'a circle on each of the two vias CLK passes through');
	assert.ok(of(COLORS.hop).filter(m => m.shape.type === 'circle').length >= 5, 'a circle at each hop target: C2 twice, the GND via, the decap, two IC pins');

	const count = mock.markers.length;
	await ext.showReturnPath();
	assert.equal(mock.markers.length, count, 'redraw replaces the previous markers');
	await ext.clearReturnPath();
	assert.equal(mock.markers.length, 0);
});

test('net and speed on one page: a listed speed or a typed one sets the edge time', async () => {
	for (const [speed, shown] of [['400000', '400 kHz'], ['2.5 MHz', '2.5 MHz']]) {
		const mock = createMockEda(board, 'CLK', [], d => (d.kind === 'nets' ? ['CLK', speed] : d.dflt));
		(globalThis as Record<string, unknown>).eda = mock.eda;
		await ext.showReturnPath();
		assert.ok(!mock.dialogs.some(d => /^Speed of/.test(d.prompt)), 'no separate speed page');
		assert.match(mock.messages[0], new RegExp(`^CLK: clock at ${shown.replace('.', '\\.')}\\.`, 'm'));
	}
});

test('Back on the driver page returns to the net page with the earlier net and speed kept', async () => {
	let driverPages = 0;
	const mock = createMockEda(board, 'CLK', [], (d) => {
		if (d.kind === 'nets')
			return mock.wizardPages.filter(p => p.kind === 'nets').length === 1 ? ['CLK', '4000000'] : d.dflt;
		if (/Which part drives/.test(d.prompt))
			return ++driverPages === 1 ? BACK_ANSWER : 'U2';
		return d.dflt;
	});
	(globalThis as Record<string, unknown>).eda = mock.eda;
	await ext.showReturnPath();
	const nets = mock.wizardPages.filter(p => p.kind === 'nets');
	assert.equal(nets.length, 2, 'the net page is shown again');
	assert.equal(nets[1].value, 'CLK');
	assert.equal(nets[1].options[0].speed, '4000000', 'with the speed given before');
	assert.equal(mock.wizard.opens, 1, 'in the same window');
	assert.match(mock.messages[0], /^CLK: clock at 4 MHz\./m);
	assert.match(mock.messages[0], /Driver: U2\./);
	assert.ok(mock.logs.some(l => /wizard: back/.test(l.message)));
});

test('without the wizard window the net and its speed are asked in two system dialogs, with a typed speed', async () => {
	const { wizardTimeouts } = await import('../src/wizard-window.ts');
	const saved = wizardTimeouts.helloMs;
	wizardTimeouts.helloMs = 20;
	try {
		const mock = createMockEda(board, 'CLK', [], d => (/^Speed of CLK:/.test(d.prompt) ? 'other' : d.kind === 'input' ? '25 MHz' : d.dflt), { wizardWindow: 'refused' });
		(globalThis as Record<string, unknown>).eda = mock.eda;
		await ext.showReturnPath();
		const speed = mock.dialogs.find(d => /^Speed of CLK:/.test(d.prompt))!;
		assert.equal(speed.dflt, String(16e6), 'the usual speed of a clock is preselected');
		assert.match(mock.messages[0], /^CLK: clock at 25 MHz\./m);
	}
	finally {
		wizardTimeouts.helloMs = saved;
	}
});

test('plane-layer copper takes its net from the mode-2 fill around it', async () => {
	const inner2 = board.stackup.copper.find(l => l.name === 'Inner2')!.id;
	const mock = await run([inner2]);
	assert.deepEqual(mock.messages[0].split('\n').filter(l => l.startsWith('[')), expected);
	assert.ok(!mock.messages[0].includes('warning:'), mock.messages[0]);
});

test('the driver picked in the dialog is kept for Rerun Last Analysis', async () => {
	const mock = createMockEda(board, 'CLK', [], d => (/Which part drives/.test(d.prompt) ? 'U2' : d.dflt));
	(globalThis as Record<string, unknown>).eda = mock.eda;
	await ext.showReturnPath();
	assert.match(mock.messages[0], /Driver: U2\./);
	const asked = mock.dialogs.length;
	await ext.rerunAnalysis();
	assert.equal(mock.dialogs.length, asked, 'no second question');
	assert.match(mock.messages[1], /U2 \(driver\): the falling edge returns into U2 pad 2 \(GND\)/);
});

test('panel: an HF run shows its result and driver there, and the driver legs follow the hop style', async () => {
	let driver = '-';
	const mock = createMockEda(board, 'CLK', [], d => (/Which part drives/.test(d.prompt) ? driver : d.dflt), { storage: new Map() });
	(globalThis as Record<string, unknown>).eda = mock.eda;
	await ext.clearReturnPath();
	await ext.showPanel();
	mock.panelSend({ cmd: 'hello' });
	const states = () => mock.published.filter(p => p.topic === 'returnpath.panel.state').map(p => p.message);
	const hf = async () => {
		const before = states().length;
		mock.panelSend({ cmd: 'hf' });
		for (let i = 0; i < 400 && !(states().length > before && states().at(-1)?.result && !states().at(-1).busy); i++)
			await new Promise(r => setTimeout(r, 25));
		return states().at(-1);
	};
	const hopColour = JSON.stringify(COLORS.hop);
	const without = await hf();
	assert.match(without.result.lines.join('\n'), /Driver: not chosen/);
	const hopsWithout = mock.markers.filter(m => JSON.stringify(m.color) === hopColour).length;
	assert.deepEqual(JSON.parse(mock.storage.get('boardInfo:demo-project') as string).nets, [{ net: 'CLK', driver: { parts: [] } }], 'the answer None is saved to the board info');
	mock.storage.delete('boardInfo:demo-project');

	driver = 'U1';
	const done = await hf();
	assert.equal(mock.infoDialogs.length, 0, 'no modal result dialog');
	assert.ok(done.result.lines.includes('Driver: U1. Its other edge is drawn dashed white from its ground pin through the decap to its supply pin.'), done.result.lines.join('\n'));
	assert.ok(done.result.lines.some((l: string) => /^\[warn\] U1 \(driver\): .* decap C1 into U1 pad 3 \(3V3\)/.test(l)));
	assert.equal(done.lastRun, 'HF check: CLK at 16 MHz, driver U1');
	assert.deepEqual(done.roles.map((r: { role: string }) => r.role), ['forwardTop', 'forwardOther', 'returnTop', 'returnOther', 'returnInner', 'hop', 'gap', 'band'], 'every HF role in the panel');
	assert.equal(done.roles.find((r: { role: string }) => r.role === 'band').visible, false, 'band edges start hidden');
	const asked = mock.wizardPages.filter(p => /Which part drives CLK/.test(p.prompt));
	assert.equal(asked.length, 2, 'the HF check button asks for the driver in the wizard window');
	assert.ok(asked.every(p => p.kind === 'select' && p.options.some(o => o.value === 'U1')));
	assert.ok(!mock.iframes.has('returnPathWizard'), 'the wizard window is closed while the analysis runs');
	const html = readFileSync(new URL('../iframe/index.html', import.meta.url), 'utf8');
	assert.match(html, /<button id="hf"[^>]*>HF check<\/button>/);
	const hops = mock.markers.filter(m => JSON.stringify(m.color) === hopColour).length;
	assert.ok(hops > hopsWithout, 'the two driver legs are drawn as hops');

	mock.panelSend({ cmd: 'style', style: { hop: { colour: 'cyan', width: 3 } } });
	for (let i = 0; i < 40 && mock.markers.some(m => JSON.stringify(m.color) === hopColour); i++)
		await new Promise(r => setTimeout(r, 25));
	assert.equal(mock.markers.filter(m => JSON.stringify(m.color) === hopColour).length, 0, 'driver legs restyled with the other hops');
	const restyled = mock.markers.filter(m => JSON.stringify(m.color) === JSON.stringify(PALETTE.cyan));
	assert.equal(restyled.length, hops, 'no return runs in Bottom copper on this board, so cyan is the hops alone');
	assert.ok(restyled.every(m => m.width === 3));
	mock.panelSend({ cmd: 'resetStyle' });
	await new Promise(r => setTimeout(r, 50));
});

test('every text the extension translates has an entry in each locale, so EasyEDA fills its ${n} placeholders', async () => {
	const { readFileSync, readdirSync } = await import('node:fs');
	const dir = new URL('../src/', import.meta.url);
	const keys = new Set<string>();
	for (const f of readdirSync(dir).filter(f => f.endsWith('.ts'))) {
		for (const m of readFileSync(new URL(f, dir), 'utf8').matchAll(/\bt\((['`])((?:\\.|(?!\1).)*)\1/g))
			keys.add(m[2].replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c)));
	}
	assert.ok(keys.size > 50);
	for (const locale of ['en', 'zh-Hans']) {
		const entries = JSON.parse(readFileSync(new URL(`../locales/${locale}.json`, import.meta.url), 'utf8')) as Record<string, string>;
		assert.deepEqual([...keys].filter(k => !(k in entries)), [], `missing in ${locale}.json`);
	}
});
