import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { formatBoardInfoCsv, parseBoardInfoCsv, type BoardInfo } from '@returnpath/core';
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

const hfBoard = load(buildEpro('demo', 'object'));
const dcBoard = load(buildDcEpro());
const ext = await import('../src/index.ts');
const sample = readFileSync(new URL('../examples/board-info-sample.csv', import.meta.url), 'utf8');
const KEY = 'boardInfo:demo-project';
const stored = (storage: Map<string, unknown>, key = KEY) => JSON.parse(storage.get(key) as string) as BoardInfo;
const csvInfo = (text: string) => parseBoardInfoCsv(text).info;

function install(board: typeof hfBoard, selected: string, answer: (d: DialogCall) => unknown = d => d.dflt, host: MockHost = {}) {
	const mock = createMockEda(board, selected, [], answer, { storage: new Map(), ...host });
	(globalThis as Record<string, unknown>).eda = mock.eda;
	return mock;
}

test('Load Board Info reads the CSV into the open project; Save Board Info writes it back in the same format', async () => {
	const mock = install(hfBoard, '', undefined, { openFile: { name: 'board-info-sample.csv', text: sample } });
	await ext.loadBoardInfo();
	const info = stored(mock.storage);
	assert.deepEqual(info, csvInfo(sample));
	assert.match(mock.infoDialogs.at(-1)!, /^Board info of Demo board: 11 nets, 5 loads, 4 layers\. HF check and DC check prefill/);

	await ext.saveBoardInfo();
	assert.equal(mock.downloads.at(-1)!.name, 'Demo_board-board-info.csv');
	assert.equal(mock.downloads.at(-1)!.text, formatBoardInfoCsv(info));
	assert.deepEqual(csvInfo(mock.downloads.at(-1)!.text), info, 'the saved file loads back to the same info');

	const other = install(hfBoard, '', undefined, { storage: mock.storage, project: { uuid: 'other-project', friendlyName: 'Other' } });
	await ext.saveBoardInfo();
	assert.equal(other.downloads.at(-1)!.text.trim().split('\n').length, 1, 'another project has its own, empty, board info: header only');
	assert.match(other.toasts.at(-1)!, /No board info for Other yet/);
});

test('loading into a project that has board info asks whether to replace it or add the file; unreadable cells are listed', async () => {
	const storage = new Map<string, unknown>([[KEY, JSON.stringify(csvInfo(sample))]]);
	const extra = 'row,net,speed,notes,colour\nnet,I2C_SCL,,changed note,\nnet,NEW_NET,fast,,\n';
	const added = install(hfBoard, '', d => (d.kind === 'select' && /Replace it with/.test(d.prompt) ? 'add' : d.dflt), { storage, openFile: { name: 'extra.csv', text: extra } });
	await ext.loadBoardInfo();
	const q = added.dialogs.find(d => /already has board info \(11 nets, 5 loads, 4 layers\)/.test(d.prompt))!;
	assert.equal(q.dflt, 'replace');
	const info = stored(storage);
	assert.equal(info.nets.length, 12);
	assert.equal(info.nets.find(n => n.net === 'I2C_SCL')!.notes, 'changed note');
	assert.equal(info.nets.find(n => n.net === 'I2C_SCL')!.speedHz, 400e3, 'a blank cell keeps what was there');
	assert.match(added.infoDialogs.at(-1)!, /Not read:\nline 1: column "colour" is not known and is ignored\nline 3: speed "fast" is not a frequency/);

	install(hfBoard, '', d => (d.kind === 'select' && /Replace it with/.test(d.prompt) ? 'replace' : d.dflt), { storage, openFile: { name: 'extra.csv', text: extra } });
	await ext.loadBoardInfo();
	assert.deepEqual(stored(storage).nets.map(n => n.net), ['I2C_SCL', 'NEW_NET']);
	assert.equal(stored(storage).loads.length, 0);
});

test('HF check: the board info gives the net its protocol, speed and driver; no driver question; the notes are in the result', async () => {
	const info = csvInfo('row,net,kind,protocol,speed,driver_part,reference,diff_partner,notes\nnet,CLK,clock,MCO,8 MHz,U2,GND on Inner1,,from the MCU clock output\n');
	const mock = install(hfBoard, 'CLK', undefined, { storage: new Map([[KEY, JSON.stringify(info)]]) });
	await ext.showReturnPath();
	const pick = mock.wizardPages.find(p => p.kind === 'nets')!;
	assert.equal(pick.options[0].label, 'CLK · MCO · 65 mm · board info');
	assert.equal(pick.options[0].speed, String(8e6), 'prefilled with the board-info speed, not the usual 16 MHz');
	assert.ok(!mock.dialogs.some(d => /Which part drives/.test(d.prompt)), 'the driver comes from the board info');
	assert.match(mock.messages[0], /^CLK: MCO at 8 MHz\./m);
	assert.match(mock.messages[0], /Driver: U2\./);
	assert.match(mock.messages[0], /^Board info: kind clock; intended reference GND on Inner1; from the MCU clock output\.$/m);
	assert.deepEqual(stored(mock.storage), info, 'nothing changed, so nothing is written');

	const selected = install(hfBoard, 'CLK', undefined, { storage: new Map([[KEY, JSON.stringify(info)]]) });
	await ext.showForSelectedTrace();
	assert.match(selected.messages[0], /^CLK: MCO at 8 MHz\./m, 'Selected trace uses the board-info speed too');
	assert.doesNotMatch(selected.messages[0], /The usual speed of this kind of line/);
});

test('HF check: a speed and a driver the user gives are saved, and the next run starts from them', async () => {
	const storage = new Map<string, unknown>();
	const first = install(hfBoard, 'CLK', d => (d.kind === 'nets' ? ['CLK', '25 MHz'] : /Which part drives/.test(d.prompt) ? 'U1' : d.dflt), { storage });
	await ext.showReturnPath();
	assert.match(first.messages[0], /^CLK: clock at 25 MHz\./m);
	const clk = stored(storage).nets.find(n => n.net === 'CLK')!;
	assert.equal(clk.speedHz, 25e6);
	assert.deepEqual(clk.driver, { parts: ['U1'], pin: '1' });

	const second = install(hfBoard, 'CLK', undefined, { storage });
	await ext.showReturnPath();
	assert.equal(second.wizardPages.find(p => p.kind === 'nets')!.options[0].speed, String(25e6));
	assert.ok(!second.dialogs.some(d => /Which part drives/.test(d.prompt)), 'asked once only');
	assert.match(second.messages[0], /^CLK: clock at 25 MHz\./m);
	assert.match(second.messages[0], /Driver: U1\./);

	const unchanged = install(hfBoard, 'CLK', d => (/Which part drives/.test(d.prompt) ? 'U1' : d.dflt), { storage: new Map() });
	await ext.showReturnPath();
	assert.deepEqual(stored(unchanged.storage).nets, [{ net: 'CLK', driver: { parts: ['U1'], pin: '1' } }], 'the usual speed left as it was is not saved; the answered driver is');
});

test('HF check: nets the board info calls power or ground are left out of the net list, and its data lines come first', async () => {
	const info = csvInfo('row,net,kind\nnet,CLK,ground\n');
	const mock = install(hfBoard, '', d => (d.kind === 'nets' ? undefined : d.dflt), { storage: new Map([[KEY, JSON.stringify(info)]]) });
	await ext.showReturnPath();
	const listed = (mock.wizardPages.find(p => p.kind === 'nets')?.options ?? []).map(o => o.value);
	assert.ok(!listed.includes('CLK'));
});

test('DC check: source, loads and typical currents come from the board info; a change in the wizard is saved for the rail', async () => {
	const des = (id: string) => dcBoard.components.find(c => c.id === id)!.designator;
	const id = (d: string) => dcBoard.components.find(c => c.designator === d)!.id;
	const info = csvInfo('row,net,voltage,source_part,load_part,typical_current,peak_current\nload,3V3,3.3,J2,U2,150mA,400mA\nload,3V3,3.3,J2,U3,20mA,\n');
	const storage = new Map<string, unknown>([[KEY, JSON.stringify(info)]]);
	const mock = install(dcBoard, '3V3', undefined, { storage });
	await ext.showDcReturn();
	const [source, loads, currents] = mock.dialogs;
	assert.equal(source.dflt, id('J2'));
	assert.match(source.prompt, /active source of 3V3: J2, from the board info/);
	assert.deepEqual((loads.dflt as string[]).map(des), ['U2', 'U3']);
	assert.equal(currents.dflt, 'U2=150mA, U3=20mA');
	assert.match(mock.messages[0], /^3V3 \/ GND: source J2, loads U2, U3\./);
	assert.deepEqual(stored(storage), info, 'accepted as prefilled: nothing written');

	const changed = install(dcBoard, '3V3', d => (d.kind === 'currents' ? 'U2=200mA, U3=20mA' : d.dflt), { storage });
	await ext.showDcReturn();
	assert.match(changed.messages[0], /source J2, loads U2, U3/);
	const rows = stored(storage).loads;
	assert.deepEqual(rows.map(r => [r.load?.part, r.typicalA, r.peakA, r.voltage, r.source?.part]), [['U2', 0.2, 0.4, 3.3, 'J2'], ['U3', 0.02, undefined, 3.3, 'J2']], 'the peak current and voltage from the file are kept');
});

test('DC check: without board info, a changed current saves the whole rail setup, and the next run is prefilled from it', async () => {
	const storage = new Map<string, unknown>();
	install(dcBoard, '3V3', storage.size ? undefined : d => (d.kind === 'currents' ? 'U2=150mA, U3=100mA, J2=100mA' : d.dflt), { storage });
	await ext.showDcReturn();
	assert.deepEqual(stored(storage).loads.map(r => [r.net, r.source?.part, r.load?.part, r.typicalA]), [['3V3', 'U1', 'U2', 0.15], ['3V3', 'U1', 'U3', 0.1], ['3V3', 'U1', 'J2', 0.1]]);

	const next = install(dcBoard, '3V3', undefined, { storage });
	await ext.showDcReturn();
	assert.equal(next.dialogs.find(d => d.kind === 'currents')!.dflt, 'U2=150mA, U3=100mA, J2=100mA');

	const untouched = install(dcBoard, '3V3', undefined, { storage: new Map() });
	await ext.showDcReturn();
	assert.equal(untouched.storage.get(KEY), undefined, 'guesses accepted as they are: nothing is written');
});

test('without an open project the board info goes to one shared entry', async () => {
	const mock = install(hfBoard, '', undefined, { project: null, openFile: { name: 'a.csv', text: 'row,net,speed\nnet,CLK,1M\n' } });
	await ext.loadBoardInfo();
	assert.equal(stored(mock.storage, 'boardInfo:no-project').nets[0].speedHz, 1e6);
	assert.ok(mock.logs.some(l => /board info: no project is open/.test(l.message)));
});
