import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { area, bbox } from '@returnpath/core';
import { loadBoard } from '../src/easyeda/load.js';

const line = (head: object, body: object) => `${JSON.stringify(head)}||${JSON.stringify(body)}|`;

/** A minimal EasyEDA Pro 3.2 project: one .epru holding the PCB and a footprint, in the object form. */
function epro2(): string {
  const pcb = [
    line({ type: 'DOCHEAD', ticket: 1 }, { docType: 'PCB', uuid: 'pcb1' }),
    line({ type: 'LAYER', id: '["LAYER",1]' }, { layerId: 1, layerType: 'TOP', layerName: 'Top Layer', use: true }),
    line({ type: 'LAYER', id: '["LAYER",2]' }, { layerId: 2, layerType: 'BOTTOM', layerName: 'Bottom Layer', use: true }),
    line({ type: 'LAYER', id: '["LAYER",15]' }, { layerId: 15, layerType: 'SIGNAL', layerName: 'Inner1', use: false }),
    line({ type: 'NET', id: '["NET","GND"]' }, {}),
    line({ type: 'POLY', id: 'o1' }, { netName: '', layerId: 11, width: 10, path: ['R', 0, 0, 2000, 1000, 0, 0], polyType: 'BOARD_OUTLINE' }),
    line({ type: 'LINE', id: 't1' }, { netName: 'GND', layerId: 1, startX: 100, startY: -100, endX: 1900, endY: -100, width: 20 }),
    line({ type: 'POUR', id: 'p1' }, { netName: 'GND', layerId: 2, width: 0.2, name: 'POUR1', order: 1, path: [['R', 0, 0, 2000, 1000, 0, 0]] }),
    // Pour fills are in units of 10 mil; the unfilled entry is a thermal spoke stroked with its width.
    line({ type: 'POURED', id: '["POURED","p1"]' }, { pourFill: [
      { strokeWidth: 0, fill: true, path: [[5, -5, 'L', 195, -5, 195, -95, 5, -95]] },
      { strokeWidth: 1, fill: false, path: [[50, -96, 'L', 50, -99]] },
    ] }),
    line({ type: 'REGION', id: 'k1' }, { layerId: 2, prohibitType: ['COPPER', 'FILL'], path: [['R', 900, -400, 200, 200, 0, 0]], regionType: 'PROHIBIT' }),
    line({ type: 'REGION', id: 'k2' }, { layerId: 2, prohibitType: ['COMPONENT'], path: [['R', 100, -400, 200, 200, 0, 0]], regionType: 'PROHIBIT' }),
    line({ type: 'COMPONENT', id: 'c1' }, { layerId: 1, x: 1000, y: -500, angle: 0, attrs: {} }),
    line({ type: 'ATTR', id: 'a1' }, { parentId: 'c1', key: 'Footprint', value: 'fp1' }),
    line({ type: 'ATTR', id: 'a2' }, { parentId: 'c1', key: 'Designator', value: 'U1' }),
    line({ type: 'ATTR', id: 'a3' }, { parentId: 'c1', key: 'Device', value: 'dev1' }),
    line({ type: 'PAD_NET', id: '["PAD_NET","c1","1","e1"]' }, { padNet: 'GND' }),
  ];
  const footprint = [
    line({ type: 'DOCHEAD', ticket: 2 }, { docType: 'FOOTPRINT', uuid: 'fp1' }),
    line({ type: 'PAD', id: 'e1' }, { netName: '', layerId: 1, num: '1', centerX: 0, centerY: 0, padAngle: 0, hole: null, defaultPad: { padType: 'RECT', width: 40, height: 20 } }),
  ];
  // Pin names live in the symbol, reached through the component's device.
  const device = [
    line({ type: 'DOCHEAD', ticket: 3 }, { docType: 'DEVICE', uuid: 'dev1' }),
    line({ type: 'META', id: 'META' }, { attributes: { Symbol: 'sym1', Footprint: 'fp1' } }),
  ];
  const symbol = [
    line({ type: 'DOCHEAD', ticket: 4 }, { docType: 'SYMBOL', uuid: 'sym1' }),
    line({ type: 'PIN', id: 'pin1' }, { x: 0, y: 0 }),
    line({ type: 'ATTR', id: 'pa1' }, { parentId: 'pin1', key: 'Pin Number', value: '1' }),
    line({ type: 'ATTR', id: 'pa2' }, { parentId: 'pin1', key: 'Pin Name', value: 'GND' }),
  ];
  const dir = mkdtempSync(join(tmpdir(), 'epro2-'));
  const file = join(dir, 'board.epro2');
  writeFileSync(file, zipSync({ 'project2.json': strToU8('{}'), 'board.epru': strToU8([...footprint, ...device, ...symbol, ...pcb].join('\n')) }));
  return file;
}

test('.epro2 (one .epru, object form): layers in use, tracks, 10 mil pour fills with spokes, keepout words, footprint pads', () => {
  const b = loadBoard(epro2());
  assert.deepEqual(b.stackup.copper.map((c) => c.id), [1, 2]);
  assert.equal(b.tracks.length, 1);
  const pour = b.pours.find((p) => p.id === 'p1')!;
  const f = bbox(pour.poured!);
  assert.ok(Math.abs(f.maxX - 195 * 0.254) < 1e-6 && Math.abs(f.minY + 99 * 0.254 + 0.127) < 0.01, JSON.stringify(f));
  assert.ok(Math.abs(area(pour.poured!) - (190 * 90 + 3 * 1) * 0.254 ** 2) < 0.2, String(area(pour.poured!)));
  assert.deepEqual(b.keepouts.map((k) => k.id), ['k1']);
  const pad = b.pads.find((p) => p.componentId === 'c1')!;
  assert.equal(pad.net, 'GND');
  assert.ok(Math.abs(area(pad.shape) - 40 * 20 * 0.0254 ** 2) < 1e-6);
  assert.equal(b.components[0].designator, 'U1');
  assert.equal(pad.pinName, 'GND', 'pin name from the symbol of the device');
});
