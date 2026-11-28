import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bbox, buildReferenceCopper, pointInPaths } from '@returnpath/core';
import { parseEasyEdaPcb } from '../src/easyeda/parse.js';

const line = (head: object, body: object) => `${JSON.stringify(head)}||${JSON.stringify(body)}|`;

/** Top, bottom, and Inner1 as a negative plane. The zone is a FILL, not a POUR. */
function planeBoard(extra: string[] = []): ReturnType<typeof parseEasyEdaPcb> {
  const pcb = [
    line({ type: 'LAYER', id: '["LAYER",1]' }, { layerId: 1, layerType: 'TOP', layerName: 'Top Layer', use: true }),
    line({ type: 'LAYER', id: '["LAYER",2]' }, { layerId: 2, layerType: 'BOTTOM', layerName: 'Bottom Layer', use: true }),
    line({ type: 'LAYER', id: '["LAYER",15]' }, { layerId: 15, layerType: 'PLANE', layerName: 'Inner1', use: true }),
    line({ type: 'NET', id: '["NET","GND"]' }, {}),
    line({ type: 'NET', id: '["NET","3V3"]' }, {}),
    line({ type: 'POLY', id: 'outline' }, { layerId: 11, width: 6, path: ['R', 0, 0, 2000, 1000, 0, 0] }),
    line({ type: 'FILL', id: 'zone' }, { netName: 'GND', layerId: 15, width: 0, fillStyle: 2, path: ['R', 0, 0, 2000, 1000, 0, 0] }),
    line({ type: 'REGION', id: 'slot' }, { layerId: 15, prohibitType: ['PLANE'], path: ['R', 800, -600, 300, 200, 0, 0] }),
    line({ type: 'LINE', id: 'split' }, { netName: '', layerId: 15, startX: 100, startY: -900, endX: 1900, endY: -900, width: 20 }),
    line({ type: 'VIA', id: 'v3' }, { netName: '3V3', centerX: 400, centerY: -200, holeDiameter: 20, viaDiameter: 40, viaType: 0 }),
    line({ type: 'VIA', id: 'vg' }, { netName: 'GND', centerX: 1600, centerY: -200, holeDiameter: 20, viaDiameter: 40, viaType: 1 }),
    line({ type: 'FILL', id: 'solid' }, { netName: 'GND', layerId: 1, width: 0, fillStyle: 0, path: ['R', 0, -100, 200, 100, 0, 0] }),
    ...extra,
  ].join('\n');
  return parseEasyEdaPcb({ pcb });
}

const mid = (paths: { outline: { x: number; y: number }[][] }['outline']) => {
  const b = bbox(paths);
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
};

test('a plane layer is one sheet, with keepouts, split lines and other-net vias cut out', () => {
  const b = planeBoard();
  assert.deepEqual(b.stackup.copper.map((c) => c.id), [1, 15, 2]);
  const zone = b.pours.find((p) => p.layer === 15)!;
  assert.equal(zone.net, 'GND');
  assert.equal(zone.name, 'plane');
  assert.equal(zone.poured, undefined);
  assert.equal(b.tracks.some((t) => t.layer === 15), false, 'a line on a plane is a cut, not a trace');
  assert.equal(b.pours.find((p) => p.id === 'solid')?.poured?.length, 1, 'a solid fill on a signal layer is still copper as drawn');
  assert.match(b.warnings.join('\n'), /plane layer has no rebuilt copper/);

  const gnd = buildReferenceCopper(b, { clearance: 0.25 }).get(15)!.byNet.get('GND')!;
  const slot = b.keepouts.find((k) => k.id === 'slot')!;
  const split = b.keepouts.find((k) => k.id.startsWith('split'))!;
  assert.equal(pointInPaths(mid(slot.outline), gnd), false);
  assert.equal(pointInPaths(mid(split.outline), gnd), false);
  assert.equal(pointInPaths({ x: 400 * 0.0254, y: -200 * 0.0254 }, gnd), false, 'another net\'s via is an antipad');
  assert.equal(pointInPaths({ x: 1600 * 0.0254, y: -200 * 0.0254 }, gnd), true, 'a ground via pad stays copper');
  assert.equal(pointInPaths({ x: 25, y: -5 }, gnd), true);
});

test('LAYER_FILL is the plane copper, and its arc angles are tenths of a degree', () => {
  const b = planeBoard([
    line({ type: 'LAYER_FILL', id: '["LAYER_FILL",15]' }, {
      fill: [{
        id: 'sheet',
        netName: 'GND',
        layerId: 15,
        path: [[0, 0, 'L', 1000, 0, 'ARC', 900, 1000, -200, 'L', 0, -200]],
      }],
    }),
  ]);
  const zone = b.pours.find((p) => p.layer === 15)!;
  assert.ok(zone.poured, 'the layer fill is stored copper');
  assert.equal(pointInPaths({ x: 12, y: -2 }, zone.poured!), true);
  assert.equal(pointInPaths({ x: 40, y: -2 }, zone.poured!), false);
  // 900 tenths is a 90° arc (~9 steps). Left as 900° the same corner is about 90 steps.
  assert.ok(zone.poured![0].length < 30, `arc was read as 90°, ${zone.poured![0].length} points`);
});

test('a plane layer with no zone net is left out, with a warning', () => {
  const pcb = [
    line({ type: 'LAYER', id: '["LAYER",1]' }, { layerId: 1, layerType: 'TOP', layerName: 'Top Layer', use: true }),
    line({ type: 'LAYER', id: '["LAYER",2]' }, { layerId: 2, layerType: 'BOTTOM', layerName: 'Bottom Layer', use: true }),
    line({ type: 'LAYER', id: '["LAYER",15]' }, { layerId: 15, layerType: 'PLANE', layerName: 'Inner1', use: true }),
    line({ type: 'POLY', id: 'outline' }, { layerId: 11, width: 6, path: ['R', 0, 0, 2000, 1000, 0, 0] }),
  ].join('\n');
  const b = parseEasyEdaPcb({ pcb });
  assert.equal(b.pours.some((p) => p.layer === 15), false);
  assert.match(b.warnings.join('\n'), /Layer 15 is a plane layer with no zone net/);
});

test('rebuilt plane copper still loses a keepout that the fill does not show', () => {
  const b = planeBoard([
    line({ type: 'POURED', id: 'rebuilt' }, {
      targetId: 'zone',
      strokeWidth: 0,
      fill: true,
      path: [0, 0, 'L', 2000, 0, 2000, -1000, 0, -1000],
    }),
  ]);
  const zone = b.pours.find((p) => p.id === 'zone')!;
  assert.ok(zone.poured, 'the rebuilt sheet is kept');
  const gnd = buildReferenceCopper(b, { clearance: 0.25 }).get(15)!.byNet.get('GND')!;
  const slot = b.keepouts.find((k) => k.id === 'slot')!;
  assert.equal(pointInPaths(mid(slot.outline), gnd), false);
  assert.equal(pointInPaths({ x: 25, y: -5 }, gnd), true);
});
