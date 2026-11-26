import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEasyEdaPcb } from '@returnpath/cli/parse';
import { buildDcEpro } from '@returnpath/cli/synth-dc';
import { strFromU8, unzipSync } from 'fflate';
import { BACK_ANSWER, createMockEda, type DialogCall } from './mock-eda.ts';

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

const board = dcBoard();
const ext = await import('../src/index.ts');
const { PALETTE } = await import('../src/style.ts');
const DC_COLORS = { supply: PALETTE.yellow, return: PALETTE.magenta, returnOther: PALETTE.cyan, bottleneck: PALETTE.red };

async function run(selected: string, answer?: (d: DialogCall) => unknown) {
	const mock = createMockEda(board, selected, [], answer);
	(globalThis as Record<string, unknown>).eda = mock.eda;
	await ext.showDcReturn();
	return mock;
}

test('wizard step 1 with the guessed defaults, then the DC overlay', async () => {
	const mock = await run('3V3');
	const kinds = mock.dialogs.map(d => d.kind);
	assert.deepEqual(kinds, ['select', 'multi', 'currents'], 'a selected rail skips steps 1 and 2: source, loads, currents (one ground: no pairing dialog)');
	assert.ok(mock.logs.some(l => /rail 3V3 taken from the selection; steps 1 and 2 skipped/.test(l.message)));
	const u1 = board.components.find(c => c.designator === 'U1')!.id;
	assert.equal(mock.dialogs[0].dflt, u1, 'U1 guessed as the source');
	assert.equal(mock.dialogs[0].options[0], u1, 'candidates first');
	assert.match(mock.dialogs[0].prompt, /Other candidate sources are left out/);
	const des = (id: string) => board.components.find(c => c.id === id)!.designator;
	assert.deepEqual((mock.dialogs[1].dflt as string[]).map(des), ['U2', 'U3', 'J2']);
	assert.equal(mock.dialogs[2].dflt, 'U2=100mA, U3=100mA, J2=100mA', 'every load prefilled with 100 mA');

	assert.ok(mock.iframes.has('returnPathPanel'), 'an analysis opens the panel');
	assert.equal(mock.messages.length, 1);
	const msg = mock.messages[0];
	assert.match(msg, /^3V3 \/ GND: source U1, loads U2, U3, J2\./);
	assert.match(msg, /3V3: drop \d+\.\d+ mV,/);
	assert.match(msg, /GND: drop \d+\.\d+ mV,/);
	assert.doesNotMatch(msg, /Contours drawn/);
	assert.match(msg, /Streamlines: 3V3 supply yellow; GND return magenta on Top Layer and cyan on other layers, with a circle where it changes layer\./);
	const colors = new Set(mock.markers.map(m => JSON.stringify(m.color)));
	assert.deepEqual(colors, new Set([DC_COLORS.supply, DC_COLORS.return, DC_COLORS.returnOther, DC_COLORS.bottleneck].map(c => JSON.stringify(c))));
	assert.ok(mock.markers.every(m => ['r', 'g', 'b'].every(k => [0, 255].includes((m.color as Record<string, number>)[k]))), 'channels only 0 or 255: EasyEDA Pro 3.2 clips colours to a 0–1 scale');
	assert.ok(mock.markers.every(m => m.shape.type === 'line' || m.shape.type === 'circle'));
	const of = (c: unknown) => mock.markers.filter(m => JSON.stringify(m.color) === JSON.stringify(c));
	assert.ok(of(DC_COLORS.supply).every(m => m.width === 2) && [...of(DC_COLORS.return), ...of(DC_COLORS.returnOther)].every(m => m.width === 5), 'supply thin, return thick');
	assert.ok(of(DC_COLORS.returnOther).some(m => m.shape.type === 'circle'), 'GND changes layer at vias on this board, marked with circles');
	assert.ok(of(DC_COLORS.returnOther).some(m => m.shape.type === 'line'), 'and runs on Inner1');

	await ext.clearReturnPath();
	assert.equal(mock.markers.length, 0);
});

test('wizard: user picks another source and gives currents', async () => {
	const j2 = board.components.find(c => c.designator === 'J2')!.id;
	const mock = await run('', (d) => {
		if (d.kind === 'select' && /active source/.test(d.prompt))
			return j2;
		if (d.kind === 'currents')
			return 'U2=150mA, U3=0.02';
		return d.dflt;
	});
	assert.deepEqual(mock.dialogs.slice(0, 2).map(d => d.kind), ['multi', 'select'], 'nothing selected: rails are confirmed and picked');
	assert.deepEqual(mock.dialogs[0].dflt, ['3V3', 'VBUS']);
	const msg = mock.messages[0];
	assert.match(msg, /^3V3 \/ GND: source J2, loads U2, U3\./, 'U1 is a candidate source, so it is left out once J2 is active');
	assert.doesNotMatch(msg, /per amp/);
	assert.match(msg, /3V3: drop \d+\.\d+ mV,/);
});

test('wizard: Back on the loads page asks for the source again, preselecting the earlier answer', async () => {
	const j2 = board.components.find(c => c.designator === 'J2')!.id;
	let sources = 0;
	const mock = await run('3V3', (d) => {
		if (/active source/.test(d.prompt))
			return ++sources === 1 ? d.dflt : j2;
		if (d.kind === 'multi' && sources === 1)
			return BACK_ANSWER;
		return d.dflt;
	});
	assert.deepEqual(mock.wizardPages.map(p => p.kind), ['select', 'multi', 'select', 'multi', 'currents']);
	assert.deepEqual(mock.wizardPages.map(p => p.back), [false, true, false, true, true], 'no Back on the first page');
	const u1 = board.components.find(c => c.designator === 'U1')!.id;
	assert.equal(mock.wizardPages[2].value, u1, 'the source picked before is preselected');
	assert.match(mock.messages[0], /^3V3 \/ GND: source J2,/);
});

test('wizard: cancelling draws nothing', async () => {
	const mock = await run('3V3', d => (d.kind === 'select' ? undefined : d.dflt));
	assert.equal(mock.messages.length, 0);
	assert.equal(mock.markers.length, 0);
});

test('wizard: with several grounds, the ground is asked once, for the rail being solved', async () => {
	const mock = createMockEda({ ...board, vias: [...board.vias, { ...board.vias[0], id: 'pgnd-via', net: 'VBUS_PGND' }] }, '3V3');
	(globalThis as Record<string, unknown>).eda = mock.eda;
	await ext.showDcReturn();
	assert.deepEqual(mock.dialogs.map(d => d.kind), ['select', 'select', 'multi', 'currents']);
	assert.match(mock.dialogs[0].prompt, /Step 3\/5: ground that carries the return current of 3V3/);
	assert.equal(mock.dialogs[0].dflt, 'GND');
	assert.ok(mock.markers.length > 0);
});

test('board outline: when the polyline API leaves out the BOARD_OUTLINE polyline, it is read from the document source', async () => {
	const { readBoard, outlineFromSource } = await import('../src/eda-board.ts');
	const line = '{"type":"POLY","ticket":9,"id":"e9"}||{"partitionId":"","groupId":0,"netName":"","layerId":11,"width":10,"path":["R",-625,-50,1000,400,0,0],"locked":false,"zIndex":-1,"polyType":"BOARD_OUTLINE"}|';
	const [ring] = outlineFromSource(`{"type":"DOCHEAD"}||{}|\n${line}\n{"type":"POLY","ticket":10,"id":"e10"}||{"layerId":3,"path":[0,0,"L",1,1]}|`);
	const xs = ring.map(p => p.x);
	const ys = ring.map(p => p.y);
	assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 25.4) < 1e-6 && Math.abs(Math.max(...ys) - Math.min(...ys) - 10.16) < 1e-6, 'a 1000 × 400 mil rectangle');

	const mock = createMockEda({ ...board, outline: [] }, '3V3');
	(globalThis as Record<string, unknown>).eda = mock.eda;
	(mock.eda as Record<string, unknown>).sys_FileManager = { getDocumentSource: async () => `{"type":"DOCHEAD"}||{}|\n${line}\n` };
	const b = await readBoard();
	assert.equal(b.outline.length, 1);
	assert.ok(!b.warnings.some(w => /No board outline/.test(w)));
	assert.ok(mock.logs.some(l => /board outline, all layers: \d+ polylines, 0 on the outline layer/.test(l.message)));
	assert.ok(mock.logs.some(l => /board outline from the document source: 1 ring/.test(l.message)));
});

test('a netlist without pin names is skipped on later runs, after an upgrade too', async () => {
	const { addPinNames, readBoard } = await import('../src/eda-board.ts');
	const storage = new Map<string, unknown>([['netlistWithoutPinNames', '0.1.16']]);
	const mock = createMockEda(board, '3V3', [], undefined, { storage });
	(globalThis as Record<string, unknown>).eda = mock.eda;
	let calls = 0;
	(mock.eda.pcb_Net as Record<string, unknown>).getNetlist = async () => {
		calls++;
		throw new Error('Export failed');
	};
	const b = await readBoard();
	await addPinNames(b);
	assert.equal(calls, 1, 'a flag left by 0.1.16 does not stop the first try');
	await addPinNames(await readBoard());
	assert.equal(calls, 1, 'then the netlist is not asked for again');
	assert.ok(mock.logs.some(l => /pin names: skipped, the netlist gave none in an earlier run/.test(l.message)));
});

test('pin names from the project file when the netlist gives none, and the project file is not asked for again after it gave none', async () => {
	const { addPinNames, readBoard } = await import('../src/eda-board.ts');
	const { strToU8, zipSync } = await import('fflate');
	const u2 = board.components.find(c => c.designator === 'U2')!;
	const u2Pads = board.pads.filter(p => p.componentId === u2.id);
	const line = (head: object, body: object) => `${JSON.stringify(head)}||${JSON.stringify(body)}|`;
	const epru = [
		line({ type: 'DOCHEAD' }, { docType: 'DEVICE', uuid: 'dev2' }),
		line({ type: 'META', id: 'META' }, { attributes: { Symbol: 'sym2' } }),
		line({ type: 'DOCHEAD' }, { docType: 'SYMBOL', uuid: 'sym2' }),
		...u2Pads.flatMap((p, i) => [
			line({ type: 'ATTR', id: `n${i}` }, { parentId: `pin${i}`, key: 'Pin Number', value: p.number }),
			line({ type: 'ATTR', id: `m${i}` }, { parentId: `pin${i}`, key: 'Pin Name', value: p.net === 'GND' ? 'GND' : `IO${i}` }),
		]),
		line({ type: 'DOCHEAD' }, { docType: 'PCB', uuid: 'pcb1' }),
		line({ type: 'COMPONENT', id: 'c9' }, { layerId: 1, x: 0, y: 0, angle: 0, attrs: {} }),
		line({ type: 'ATTR', id: 'a1' }, { parentId: 'c9', key: 'Designator', value: 'U2' }),
		line({ type: 'ATTR', id: 'a2' }, { parentId: 'c9', key: 'Device', value: 'dev2' }),
	].join('\n');
	const zip = zipSync({ 'project2.json': strToU8('{}'), 'p.epru': strToU8(epru) });
	const storage = new Map<string, unknown>();
	const mock = createMockEda(board, '3V3', [], undefined, { storage });
	(globalThis as Record<string, unknown>).eda = mock.eda;
	(mock.eda.pcb_Net as Record<string, unknown>).getNetlist = async () => {
		throw new Error('Export failed');
	};
	let files = 0;
	(mock.eda as Record<string, unknown>).sys_FileManager = { getProjectFile: async () => {
		files++;
		return { arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) };
	} };
	const b = await readBoard();
	assert.equal(await addPinNames(b), u2Pads.length);
	assert.deepEqual(b.pads.filter(p => p.componentId === u2.id).map(p => p.pinName), u2Pads.map((p, i) => (p.net === 'GND' ? 'GND' : `IO${i}`)));
	assert.ok(mock.logs.some(l => new RegExp(`pin names: ${u2Pads.length} of \\d+ component pads named from the project file \\(1 parts\\)`).test(l.message)));

	(mock.eda as Record<string, unknown>).sys_FileManager = { getProjectFile: async () => {
		files++;
		throw new Error('no permission');
	} };
	assert.equal(await addPinNames(await readBoard()), 0);
	await addPinNames(await readBoard());
	assert.equal(files, 2, 'after a failure the project file is not asked for again');
});

test('pin names from the netlist: a load returns only through its GND pin, not through an address pin tied to GND', async () => {
	const u2 = board.components.find(c => c.designator === 'U2')!;
	const gnd = board.pads.find(p => p.componentId === u2.id && p.net === 'GND')!;
	const a0 = { ...gnd, id: `${gnd.id}-a0`, number: '99', at: { x: gnd.at.x + 0.6, y: gnd.at.y }, shape: gnd.shape.map(r => r.map(q => ({ x: q.x + 0.6, y: q.y }))), pinName: 'A0' };
	const pads = board.pads.map(p => (p.componentId === u2.id ? { ...p, pinName: p.net === 'GND' ? 'GND' : 'VCC' } : p));
	const named = { ...board, pads: [...pads, a0], components: board.components.map(c => (c.id === u2.id ? { ...c, padIds: [...c.padIds, a0.id] } : c)) };
	const mock = createMockEda(named, '3V3');
	(globalThis as Record<string, unknown>).eda = mock.eda;
	await ext.showDcReturn();
	assert.match(mock.messages.at(-1)!, /U2: A0 is tied to GND but carries no supply current; the return starts at GND\./);
	assert.ok(mock.logs.some(l => /pin names: \d+ of \d+ component pads named from the netlist/.test(l.message)));
	assert.ok(mock.logs.some(l => /DC setup:/.test(l.message)));
});

test('hide/show keeps the overlay; rerun repeats the last DC analysis on the changed board without the wizard, after a restart too', async () => {
	const storage = new Map<string, unknown>();
	const fresh = createMockEda(board, '3V3', [], undefined, { storage });
	(globalThis as Record<string, unknown>).eda = fresh.eda;
	await ext.clearReturnPath();
	await ext.rerunAnalysis();
	assert.match(fresh.messages[0], /No analysis to rerun yet/);
	await ext.toggleReturnPath();
	assert.match(fresh.toasts.at(-1)!, /No overlay to show/);

	const first = createMockEda(board, '3V3', [], d => (d.kind === 'currents' ? 'U2=150mA, U3=0.02' : d.dflt), { storage });
	(globalThis as Record<string, unknown>).eda = first.eda;
	await ext.showDcReturn();
	const drawn = first.markers.map(m => JSON.stringify(m));
	assert.ok(drawn.length > 0);
	await ext.toggleReturnPath();
	assert.equal(first.markers.length, 0);
	assert.match(first.toasts.at(-1)!, /Overlay hidden/);
	await ext.toggleReturnPath();
	assert.deepEqual(first.markers.map(m => JSON.stringify(m)), drawn, 'shown again exactly as drawn');

	const moved = { ...board, vias: [...board.vias, { ...board.vias.find(v => v.net === 'GND')!, id: 'new-gnd-via', at: { x: 30, y: 20 } }] };
	const after = createMockEda(moved, '', [], undefined, { storage });
	(globalThis as Record<string, unknown>).eda = after.eda;
	await ext.rerunAnalysis();
	assert.equal(after.dialogs.length, 0, 'no wizard');
	assert.equal(after.counts.boardReads, 1, 'the board is read again');
	assert.match(after.messages.at(-1)!, /^3V3 \/ GND: source U1, loads U2, U3, J2\./);
	assert.match(after.messages.at(-1)!, /3V3: drop \d+\.\d+ mV,/, 'the given currents are kept');
	assert.ok(after.markers.length > 0);
	await ext.clearReturnPath();
	await ext.toggleReturnPath();
	assert.equal(after.markers.length, 0, 'Clear Overlay forgets it');
});

test('currents page: prefilled from the last run on the same rail; clearing every field gives the per-amp view', async () => {
	const storage = new Map<string, unknown>();
	const first = createMockEda(board, '3V3', [], d => (d.kind === 'currents' ? 'U2=150mA, U3=0.02' : d.dflt), { storage });
	(globalThis as Record<string, unknown>).eda = first.eda;
	await ext.showDcReturn();

	const again = createMockEda(board, '3V3', [], d => (d.kind === 'currents' ? '' : d.dflt), { storage });
	(globalThis as Record<string, unknown>).eda = again.eda;
	await ext.showDcReturn();
	const page = again.wizardPages.find(p => p.kind === 'currents')!;
	assert.deepEqual(page.options.map(o => o.value), ['U2', 'U3', 'J2'], 'one field per ticked load, by designator');
	assert.deepEqual(page.value, ['150mA', '20mA', '100mA'], 'the last run\'s currents, 100 mA for a load it had none for');
	assert.match(again.messages.at(-1)!, /per amp/);
	await ext.clearReturnPath();
});

test('Show for Selected Net on a switching node (a net on an inductor) offers the DC view for that net without asking for the rail', async () => {
	const u2 = board.components.find(c => c.designator === 'U2')!;
	const pads = [
		{ id: 'sw.u', net: 'SWN', layer: 1, number: '7', at: { x: u2.at.x + 1, y: u2.at.y }, shape: [[{ x: u2.at.x + 0.8, y: u2.at.y - 0.2 }, { x: u2.at.x + 1.2, y: u2.at.y - 0.2 }, { x: u2.at.x + 1.2, y: u2.at.y + 0.2 }, { x: u2.at.x + 0.8, y: u2.at.y + 0.2 }]], holeDiameter: 0, componentId: u2.id },
		{ id: 'sw.l', net: 'SWN', layer: 1, number: '1', at: { x: u2.at.x + 4, y: u2.at.y }, shape: [[{ x: u2.at.x + 3.5, y: u2.at.y - 0.5 }, { x: u2.at.x + 4.5, y: u2.at.y - 0.5 }, { x: u2.at.x + 4.5, y: u2.at.y + 0.5 }, { x: u2.at.x + 3.5, y: u2.at.y + 0.5 }]], holeDiameter: 0, componentId: 'l9' },
	];
	const sw = {
		...board,
		pads: [...board.pads, ...pads],
		tracks: [...board.tracks, { id: 'sw.t', net: 'SWN', layer: 1, a: pads[0].at, b: pads[1].at, width: 0.3 }],
		components: [...board.components.map(c => (c.id === u2.id ? { ...c, padIds: [...c.padIds, 'sw.u'] } : c)), { id: 'l9', designator: 'L9', at: pads[1].at, rotation: 0, layer: 1, padIds: ['sw.l'] }],
	};
	const mock = createMockEda(sw, 'SWN', [], d => (d.kind === 'confirm' ? true : d.kind === 'select' && /active source/.test(d.prompt) ? undefined : d.dflt));
	(globalThis as Record<string, unknown>).eda = mock.eda;
	await ext.showReturnPath();
	assert.equal(mock.dialogs[0].kind, 'confirm');
	assert.match(mock.dialogs[0].prompt, /SWN connects to L9, an inductor or ferrite bead/);
	assert.match(mock.dialogs[1].prompt, /active source of SWN/, 'the wizard goes straight to the source of SWN, though its name is not a rail name');
});

test('panel: opens without blocking, runs DC from a button, shows the result there, restyles and hides the overlay', async () => {
	const { readFileSync } = await import('node:fs');
	const html = readFileSync(new URL('../iframe/index.html', import.meta.url), 'utf8');
	assert.ok(html.includes("'returnpath.panel.command'") && html.includes("'returnpath.panel.state'"), 'the page uses the same topics');

	const mock = createMockEda(board, '3V3', [], undefined, { storage: new Map() });
	(globalThis as Record<string, unknown>).eda = mock.eda;
	await ext.clearReturnPath();
	await ext.showPanel();
	const win = mock.iframes.get('returnPathPanel')!;
	assert.equal(win.html, '/iframe/index.html');
	assert.equal(win.props.grayscaleMask, false, 'the editor stays usable');
	assert.equal(win.props.minimizeButton, true);

	const states = () => mock.published.filter(p => p.topic === 'returnpath.panel.state').map(p => p.message);
	mock.panelSend({ cmd: 'hello' });
	assert.equal(states().at(-1).overlay, 'none');
	assert.equal(states().at(-1).roles.length, 8, 'before any run every role is listed');

	mock.panelSend({ cmd: 'dc' });
	for (let i = 0; i < 400 && !(states().at(-1)?.result && !states().at(-1).busy); i++)
		await new Promise(r => setTimeout(r, 25));
	const done = states().at(-1);
	assert.ok(states().some(s => s.busy === 'DC check'), 'busy while running');
	assert.match(done.result.lines[0], /^3V3 \/ GND: source U1/);
	assert.equal(done.overlay, 'shown');
	assert.match(done.lastRun, /^DC 3V3 \/ GND, source U1/);
	assert.equal(mock.infoDialogs.length, 0, 'no modal result dialog');
	assert.match(mock.toasts.at(-1)!, /result is in the Return Path panel/);

	const yellow = JSON.stringify({ r: 255, g: 255, b: 0, alpha: 255 });
	const white = JSON.stringify({ r: 255, g: 255, b: 255, alpha: 255 });
	const supplyCount = mock.markers.filter(m => JSON.stringify(m.color) === yellow).length;
	mock.panelSend({ cmd: 'style', style: { supply: { colour: 'white', width: 4 } } });
	for (let i = 0; i < 40 && mock.markers.filter(m => JSON.stringify(m.color) === white).length < supplyCount; i++)
		await new Promise(r => setTimeout(r, 25));
	const restyled = mock.markers.filter(m => JSON.stringify(m.color) === white);
	assert.equal(restyled.length, supplyCount, 'the supply redrawn in the new colour without a new analysis');
	assert.ok(restyled.every(m => m.width === 4));
	assert.equal(states().at(-1).roles.find((r: { role: string }) => r.role === 'supply').colour, 'white');

	mock.panelSend({ cmd: 'resetStyle' });
	await new Promise(r => setTimeout(r, 50));
	assert.equal(mock.markers.filter(m => JSON.stringify(m.color) === yellow).length, supplyCount);

	mock.panelSend({ cmd: 'toggle' });
	for (let i = 0; i < 40 && states().at(-1).overlay !== 'hidden'; i++)
		await new Promise(r => setTimeout(r, 25));
	assert.equal(mock.markers.length, 0);
	assert.equal(states().at(-1).overlay, 'hidden');

	(win.props.buttonCallbackFn as (b: string) => void)('close');
	mock.iframes.delete('returnPathPanel');
	await ext.showDcReturn();
	assert.ok(!mock.iframes.has('returnPathPanel'), 'closed by the user: an analysis does not reopen it');
	assert.equal(mock.infoDialogs.length, 0, 'and no result dialog either');
	assert.ok(mock.toasts.some(t => /open the Return Path panel to see the result/.test(t)), 'a toast points to the panel');
});

test('a ground with no copper path from any load is reported in words and gets no contours', async () => {
	const noGnd = { ...board, pours: board.pours.filter(p => p.net !== 'GND'), tracks: board.tracks.filter(t => t.net !== 'GND'), vias: board.vias.filter(v => v.net !== 'GND') };
	const mock = createMockEda(noGnd, '3V3');
	(globalThis as Record<string, unknown>).eda = mock.eda;
	await ext.showDcReturn();
	const msg = mock.messages.at(-1)!;
	assert.match(msg, /GND: no load has a copper path to U1; nothing is drawn for it\./);
	assert.doesNotMatch(msg, /GND: drop/);

	assert.ok(mock.logs.some(l => /GND: .* not reached from U1; source pads .*; pours on GND: none/.test(l.message)));
});

test('every wizard question is asked in one wizard window: one page layout, select-all for loads, cancel stops the wizard', async () => {
	const mock = await run('3V3');
	assert.deepEqual(mock.wizardPages.map(p => p.kind), ['select', 'multi', 'currents'], 'source, loads and currents all in the window');
	assert.equal(mock.wizard.opens, 1, 'the window stays open from the first question to the last');
	assert.ok(!mock.iframes.has('returnPathWizard'), 'and closes before the analysis runs');
	const q = mock.wizardPages.find(p => /Step 5\/5/.test(p.prompt))!;
	assert.equal(q.labels.all, 'Select all');
	assert.equal(q.labels.step, 'Step ${1} of ${2}');
	const u1 = board.components.find(c => c.designator === 'U1')!.id;
	assert.ok(!q.options.some(o => o.value === u1), 'the source is not offered as a load');

	const all = await run('3V3', d => /Step 5\/5/.test(d.prompt) ? d.options.map(o => o.value) : d.dflt);
	const allLoads = q.options.map(o => board.components.find(c => c.id === o.value)!.designator);
	assert.match(all.messages[0], new RegExp(`loads ${allLoads.join(', ')}\\.`), 'select-all takes every listed part');

	const cancelled = await run('3V3', d => /Step 5\/5/.test(d.prompt) ? undefined : d.dflt);
	assert.equal(cancelled.dialogs.at(-1)!.kind, 'multi', 'nothing is asked after a cancelled question');
	assert.equal(cancelled.markers.length, 0);
	assert.ok(!cancelled.iframes.has('returnPathWizard'), 'cancelling closes the window');
});

test('the wizard falls back to the system dialogs, with a select-all entry, when its window does not connect', async () => {
	const { wizardTimeouts } = await import('../src/wizard-window.ts');
	const saved = wizardTimeouts.helloMs;
	wizardTimeouts.helloMs = 20;
	try {
		for (const wizardWindow of ['silent', 'refused'] as const) {
			const mock = createMockEda(board, '3V3', [], d => d.kind === 'multi' ? ['__returnpath_all__'] : d.dflt, { wizardWindow });
			(globalThis as Record<string, unknown>).eda = mock.eda;
			await ext.showDcReturn();
			assert.deepEqual(mock.dialogs.map(d => d.kind), ['select', 'multi', 'input']);
			const q = mock.dialogs.find(d => d.kind === 'multi')!;
			assert.equal(q.options[0], '__returnpath_all__', `${wizardWindow}: select-all is the first entry`);
			assert.equal(mock.wizardPages.length, 0);
			const des = q.options.slice(1).map(id => board.components.find(c => c.id === id)!.designator);
			assert.match(mock.messages[0], new RegExp(`loads ${des.join(', ')}\\.`), `${wizardWindow}: select-all takes every listed part`);
			assert.ok(mock.logs.some(l => /wizard window: .*system dialogs/.test(l.message)));
			mock.logs.length = 0;
			await ext.showDcReturn();
			assert.ok(!mock.logs.some(l => /wizard window: /.test(l.message)), `${wizardWindow}: no second try on the same editor`);
		}
	}
	finally {
		wizardTimeouts.helloMs = saved;
	}
});

test('the menu has Open Panel, Run Folder, Show Saved Log and About; the analyses and the overlay run from the panel', async () => {
	const config = (await import('../extension.json', { with: { type: 'json' } })).default;
	const items = config.headerMenus.pcb[0].menuItems;
	assert.deepEqual(items.map(i => i.registerFn), ['showPanel', 'setRunFolder', 'showSavedLog', 'about']);
	for (const i of items)
		assert.equal(typeof (ext as Record<string, unknown>)[i.registerFn], 'function');
	const html = await import('node:fs').then(fs => fs.readFileSync(new URL('../iframe/index.html', import.meta.url), 'utf8'));
	for (const id of ['hf', 'dc', 'trace', 'rerun', 'toggle', 'clear'])
		assert.ok(html.includes(`id="${id}"`), `the panel has the ${id} button`);
	for (const id of ['log', 'runFolder'])
		assert.ok(!html.includes(`id="${id}"`), `${id} is in the menu, not the panel`);
	const names = (await import('../locales/extensionJson/zh-Hans.json', { with: { type: 'json' } })).default as Record<string, string>;
	assert.ok(items.every(i => i.title in names), 'every menu title is translated');
});

test('part names with attribute references show the attribute values', async () => {
	const { partName } = await import('../src/eda-board.ts');
	const part = (name: string | undefined, props: Record<string, string> = {}, mpn?: string) => ({
		getState_Name: () => name,
		getState_OtherProperty: () => props,
		getState_ManufacturerId: () => mpn,
	});
	assert.equal(partName(part('={Value}', { Value: '100nF' })), '100nF');
	assert.equal(partName(part('={Manufacturer Part}', {}, 'AMS1117-3.3')), 'AMS1117-3.3');
	assert.equal(partName(part('={Manufacturer Part}', { 'Manufacturer Part': 'TPS7A02' })), 'TPS7A02');
	assert.equal(partName(part('={Value}')), undefined, 'an unknown attribute gives no name, not the template');
	assert.equal(partName(part('={Value} {Package}', { Value: '10uF' })), '10uF');
	assert.equal(partName(part('LM1117')), 'LM1117');
	assert.equal(partName({ getState_Name: () => '={Value}' }), undefined, 'clients without getState_OtherProperty');
});
