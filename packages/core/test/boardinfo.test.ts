import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { formatBoardInfoCsv, infoRails, mergeBoardInfo, netInfo, parseAmps, parseBoardInfoCsv, parseVolts, railInfo, signalKindForProtocol, splitCsv, withNet, withRail } from '../src/index.js';

const sample = readFileSync(new URL('../../extension/examples/board-info-sample.csv', import.meta.url), 'utf8');

test('board info: the sample CSV reads without warnings into nets, loads and layers', () => {
  const { info, warnings } = parseBoardInfoCsv(sample);
  assert.deepEqual(warnings, []);
  assert.equal(info.nets.length, 11);
  assert.equal(info.loads.length, 5);
  assert.equal(info.layers.length, 4);
  const scl = netInfo(info, 'I2C_SCL')!;
  assert.deepEqual(scl, { net: 'I2C_SCL', kind: 'clock', protocol: 'I2C', speedHz: 400e3, driver: { parts: ['U1'], pin: '12', pinName: 'PB6' }, receivers: ['U4', 'U5'], reference: 'GND on In1', notes: 'pull-ups R7/R8 4.7k to 3V3' });
  assert.equal(netInfo(info, 'USB_DP')!.kind, 'diff pair');
  assert.equal(netInfo(info, 'USB_DP')!.diffPartner, 'USB_DN');
  assert.deepEqual(netInfo(info, 'LED_STATUS')!.driver, { parts: [] }, 'driver "none": no driver loop');
  assert.deepEqual(railInfo(info, '3V3'), { voltage: 3.3, source: 'U2', loads: [{ part: 'U1', typicalA: 0.045, peakA: 0.12 }, { part: 'U4', typicalA: 0.002, peakA: 0.005 }, { part: 'U5', typicalA: 0.015, peakA: 0.03 }, { part: 'U6', typicalA: 0.008, peakA: 0.025 }] });
  assert.deepEqual(infoRails(info).sort(), ['3V3', 'VBUS']);
  assert.equal(info.layers.find(l => l.layer === 'In2')!.splits, '3V3 / VBUS split under U2');
});

test('board info: export writes the same CSV format, and reading it back gives the same info', () => {
  const { info } = parseBoardInfoCsv(sample);
  const csv = formatBoardInfoCsv(info);
  assert.ok(csv.startsWith('row,net,kind,protocol,speed,'));
  assert.deepEqual(parseBoardInfoCsv(csv), { info, warnings: [] });
});

test('board info: header names are matched loosely, Excel semicolon files and quoted cells are read, bad cells are reported by line', () => {
  const text = '\uFEFFRow;Net;Kind;Speed;Driver part;Typical current;Notes;Colour\r\nnet;CLK;Clock;8 MHz;U1;;"say ""hi""; twice";red\r\nnet;X;wobbly;fast;;;;\r\nload;3V3;;;;lots;;\r\nfoo;;;;;;;\r\n';
  const { info, warnings } = parseBoardInfoCsv(text);
  assert.deepEqual(netInfo(info, 'CLK'), { net: 'CLK', kind: 'clock', speedHz: 8e6, driver: { parts: ['U1'] }, notes: 'say "hi"; twice' });
  assert.deepEqual(warnings, [
    'line 1: column "Colour" is not known and is ignored',
    'line 3: kind "wobbly" is not one of clock, data, bus, diff pair, power, ground, analog, control',
    'line 3: speed "fast" is not a frequency (use 400k, 12 MHz or 115200)',
    'line 4: typical_current "lots" is not a current (use 150mA or 0.15)',
    'line 5: row "foo" is not net, load or layer',
  ]);
  assert.deepEqual(splitCsv('a,"b\nc",d\n'), [['a', 'b\nc', 'd']]);
  assert.match(parseBoardInfoCsv('net,kind\nA,clock\n').warnings[0], /first column must be "row"/);
});

test('board info: currents, voltages and protocols', () => {
  assert.equal(parseAmps('150mA'), 0.15);
  assert.equal(parseAmps('0,2'), 0.2);
  assert.equal(parseAmps('1.5 A'), 1.5);
  assert.equal(parseAmps('500uA'), 0.0005);
  assert.equal(parseAmps('a lot'), undefined);
  assert.equal(parseVolts('3V3'), 3.3);
  assert.equal(parseVolts('1.8V'), 1.8);
  assert.equal(parseVolts('5'), 5);
  assert.equal(signalKindForProtocol('I²C')?.type, 'i2c');
  assert.equal(signalKindForProtocol('QSPI')?.type, 'spi');
  assert.equal(signalKindForProtocol('RS-485')?.type, 'uart');
  assert.equal(signalKindForProtocol('USB 2.0 FS')?.label, 'USB 2.0 FS');
  assert.equal(signalKindForProtocol('custom'), undefined);
});

test('board info: an import adds to what is there, a manual change overrides one field, a rail change keeps pins and peak currents', () => {
  const { info } = parseBoardInfoCsv(sample);
  const edited = withNet(info, 'I2C_SCL', { speedHz: 1e6 });
  assert.equal(netInfo(edited, 'I2C_SCL')!.speedHz, 1e6);
  assert.equal(netInfo(edited, 'I2C_SCL')!.protocol, 'I2C', 'other fields kept');
  const more = parseBoardInfoCsv('row,net,notes\nnet,I2C_SCL,new note\nnet,NEW,\n').info;
  const merged = mergeBoardInfo(edited, more);
  assert.equal(netInfo(merged, 'I2C_SCL')!.notes, 'new note');
  assert.equal(netInfo(merged, 'I2C_SCL')!.speedHz, 1e6, 'blank cells leave the field as it was');
  assert.ok(netInfo(merged, 'NEW'));

  const rail = withRail(info, '3V3', { source: 'U2', loads: [{ part: 'U1', typicalA: 0.06 }, { part: 'U9', typicalA: 0.01 }] });
  const rows = rail.loads.filter(l => l.net === '3V3');
  assert.deepEqual(rows.map(r => r.load?.part), ['U1', 'U9'], 'U4, U5 and U6 are no longer loads');
  assert.deepEqual(rows[0], { net: '3V3', voltage: 3.3, source: { part: 'U2', pin: '5' }, load: { part: 'U1', pin: '1' }, typicalA: 0.06, peakA: 0.12, notes: 'MCU at full speed' });
  assert.deepEqual(rows[1], { net: '3V3', voltage: 3.3, source: { part: 'U2', pin: '5' }, load: { part: 'U9' }, typicalA: 0.01 });
  assert.equal(rail.loads.filter(l => l.net === 'VBUS').length, 1, 'other rails untouched');
});
