import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveNet, sameNet, uniqueNets, unifyNetCase, type Board } from '../src/index.js';

const at = { x: 0, y: 0 };
const mixed = (): Board => ({
  outline: [],
  stackup: { copper: [], dielectrics: [] },
  nets: ['3V3', '3v3', 'GND', 'gnd', 'SDA'],
  tracks: [
    { id: 't1', net: '3V3', layer: 1, a: at, b: at, width: 0.3 },
    { id: 't2', net: '3v3', layer: 1, a: at, b: at, width: 0.3 },
    { id: 't3', net: '3v3', layer: 1, a: at, b: at, width: 0.3 },
    { id: 't4', net: 'gnd', layer: 1, a: at, b: at, width: 0.3 },
    { id: 't5', net: 'SDA', layer: 1, a: at, b: at, width: 0.2 },
  ],
  vias: [{ id: 'v1', net: 'GND', at, drill: 0.3, diameter: 0.6, stitching: false }],
  pads: [{ id: 'p1', net: 'GND', layer: 1, number: '1', at, shape: [], holeDiameter: 0 }],
  components: [],
  pours: [{ id: 'q1', net: 'Gnd', layer: 2, name: 'Bottom', priority: 1, outline: [] }],
  keepouts: [],
  warnings: [],
});

test('net names that differ only in case are one net, spelt as most of its copper spells it', () => {
  const b = unifyNetCase(mixed());
  assert.deepEqual(b.nets, ['3v3', 'GND', 'SDA']);
  assert.deepEqual(b.tracks.map((t) => t.net), ['3v3', '3v3', '3v3', 'GND', 'SDA']);
  assert.equal(b.pours[0].net, 'GND');
  assert.deepEqual(b.warnings, [
    'Nets 3V3 and 3v3 differ only in letter case; EasyEDA takes them as one net, analysed as 3v3.',
    'Nets GND, gnd and Gnd differ only in letter case; EasyEDA takes them as one net, analysed as GND.',
  ]);
  const clean = unifyNetCase({ ...mixed(), nets: ['SDA'], tracks: mixed().tracks.slice(4), vias: [], pads: [], pours: [] });
  assert.deepEqual(clean.warnings, [], 'a board without case variants is left as it is');
});

test('a name typed or stored in another case finds the board net', () => {
  const b = unifyNetCase(mixed());
  assert.equal(resolveNet(b, '3V3'), '3v3');
  assert.equal(resolveNet(b, 'gNd'), 'GND');
  assert.equal(resolveNet(b, 'sda'), 'SDA');
  assert.equal(resolveNet(b, 'SCL'), 'SCL', 'a net the board does not have stays as given');
  assert.equal(resolveNet({ pours: [{ id: 'q', net: 'AGND', layer: 1, name: '', priority: 1, outline: [] }] }, 'agnd'), 'AGND', 'a pour-only net too');
  assert.ok(sameNet('Vbus', 'VBUS') && !sameNet('VBUS', undefined));
  assert.deepEqual(uniqueNets(['VBUS', '3V3', 'vbus', '3v3', 'GND']), ['VBUS', '3V3', 'GND']);
});
