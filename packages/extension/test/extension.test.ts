import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeNet } from '@returnpath/core';
import { parseEasyEdaPcb } from '@returnpath/cli/parse';
import { buildEpro } from '@returnpath/cli/synth';
import { strFromU8, unzipSync } from 'fflate';
import { createMockEda } from './mock-eda.ts';

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
const COLORS = { band: PALETTE.white, gap: PALETTE.red, hop: PALETTE.yellow };
const RETURN_COLORS = { bottom: PALETTE.cyan, inner: [PALETTE.green, PALETTE.blue] };

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
	assert.match(mock.messages[0], /Return path on Inner1: green, Inner2: blue\. Dashed yellow: hop through a via, decap, bridging cap or IC pin\. red: trace over a gap, or band without copper\. Thin white: ±3h band edges\./);
	const q = mock.dialogs.find(d => /Which part drives CLK/.test(d.prompt))!;
	assert.deepEqual(q.options, ['U1', 'U2', '*', '-'], 'no pin names on this board: both ICs offered, plus both and none');
	assert.match(mock.messages[0], /Driver: U1\./);
	const colors = new Set(mock.markers.map(m => JSON.stringify(m.color)));
	const expectedColors = [COLORS.band, COLORS.gap, COLORS.hop, RETURN_COLORS.inner[0], RETURN_COLORS.inner[1]].map(c => JSON.stringify(c));
	assert.deepEqual(colors, new Set(expectedColors), 'band, gap, hop and one return colour per reference layer, all opaque');
	assert.ok(mock.markers.every(m => (m.color as { alpha: number }).alpha === 1));
	assert.ok(mock.markers.every(m => ['r', 'g', 'b'].every(k => [0, 255].includes((m.color as Record<string, number>)[k]))), 'channels only 0 or 255: EasyEDA Pro 3.2 clips colours to a 0–1 scale');
	const of = (c: object) => mock.markers.filter(m => JSON.stringify(m.color) === JSON.stringify(c));
	assert.ok([RETURN_COLORS.inner[0], RETURN_COLORS.inner[1]].every(c => of(c).length && of(c).every(m => m.width === 5)), 'return path thick');
	assert.ok(of(COLORS.band).every(m => m.width === 1), 'band edges thin');
	assert.ok(of(COLORS.hop).filter(m => m.shape.type === 'circle').length >= 5, 'a circle at each hop target: C2 twice, the GND via, the decap, two IC pins');

	const count = mock.markers.length;
	await ext.showReturnPath();
	assert.equal(mock.markers.length, count, 'redraw replaces the previous markers');
	await ext.clearReturnPath();
	assert.equal(mock.markers.length, 0);
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
	const yellow = JSON.stringify(COLORS.hop);
	const without = await hf();
	assert.match(without.result.lines.join('\n'), /Driver: not chosen/);
	const hopsWithout = mock.markers.filter(m => JSON.stringify(m.color) === yellow).length;

	driver = 'U1';
	const done = await hf();
	assert.equal(mock.messages.length, 0, 'no modal result dialog while the panel is open');
	assert.ok(done.result.lines.includes('Driver: U1. Its other edge is drawn dashed yellow from its ground pin through the decap to its supply pin.'), done.result.lines.join('\n'));
	assert.ok(done.result.lines.some((l: string) => /^\[warn\] U1 \(driver\): .* decap C1 into U1 pad 3 \(3V3\)/.test(l)));
	assert.equal(done.lastRun, 'Show for Selected Net: CLK, driver U1');
	const hops = mock.markers.filter(m => JSON.stringify(m.color) === yellow).length;
	assert.ok(hops > hopsWithout, 'the two driver legs are drawn as hops');

	mock.panelSend({ cmd: 'style', style: { hop: { colour: 'cyan', width: 3 } } });
	for (let i = 0; i < 40 && mock.markers.some(m => JSON.stringify(m.color) === yellow); i++)
		await new Promise(r => setTimeout(r, 25));
	assert.equal(mock.markers.filter(m => JSON.stringify(m.color) === yellow).length, 0, 'driver legs restyled with the other hops');
	const cyan = mock.markers.filter(m => JSON.stringify(m.color) === JSON.stringify(RETURN_COLORS.bottom));
	assert.equal(cyan.length, hops);
	assert.ok(cyan.every(m => m.width === 3));
	mock.panelSend({ cmd: 'resetStyle' });
	await new Promise(r => setTimeout(r, 50));
});
