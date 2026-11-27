import assert from 'node:assert/strict';
import test from 'node:test';
import { circle, difference, rect, union, MULTI_LAYER, type Paths, type Stackup, type Track, type Via } from '@returnpath/core';
import { checkNetGeometry, type CheckBoardInput } from '../src/rcp/checker.js';

function make4LayerStackup(): Stackup {
  return {
    copper: [
      { id: 1, name: 'Top Layer', index: 0, z: 0, thicknessMm: 0.035 },
      { id: 15, name: 'Inner1', index: 1, z: 0.21, thicknessMm: 0.017 },
      { id: 16, name: 'Inner2', index: 2, z: 1.275, thicknessMm: 0.017 },
      { id: 2, name: 'Bottom Layer', index: 3, z: 1.485, thicknessMm: 0.035 },
    ],
    dielectrics: [
      { name: 'Prepreg 1', thicknessMm: 0.21 },
      { name: 'Core', thicknessMm: 1.065 },
      { name: 'Prepreg 2', thicknessMm: 0.21 },
    ],
  };
}

function make2LayerStackup(): Stackup {
  return {
    copper: [
      { id: 1, name: 'Top Layer', index: 0, z: 0 },
      { id: 2, name: 'Bottom Layer', index: 1, z: 1.5 },
    ],
    dielectrics: [{ name: 'Core', thicknessMm: 1.5 }],
  };
}

test('clean trace centered over solid GND plane reports zero findings', () => {
  const gnd = union([rect(25, 25, 40, 40)]);
  const input: CheckBoardInput = {
    stackup: make4LayerStackup(),
    tracks: [
      { id: 't1', net: 'SPI_CLK', layer: 1, a: { x: 12, y: 25 }, b: { x: 38, y: 25 }, width: 0.2 },
    ],
    vias: [],
    copperByLayer: new Map([[15, new Map([['GND', gnd]])]]),
  };

  const res = checkNetGeometry(input, 'SPI_CLK');
  assert.equal(res.segmentsChecked, 1);
  assert.deepEqual(res.referenceNetsUsed, ['GND']);
  assert.equal(res.findings.length, 0);
});

test('detects no_reference_plane when adjacent layer has no reference copper', () => {
  const input: CheckBoardInput = {
    stackup: make4LayerStackup(),
    tracks: [
      { id: 't1', net: 'SIG_A', layer: 1, a: { x: 10, y: 10 }, b: { x: 20, y: 10 }, width: 0.2 },
      { id: 't2', net: 'SIG_A', layer: 1, a: { x: 20, y: 10 }, b: { x: 30, y: 10 }, width: 0.2 },
    ],
    vias: [],
    copperByLayer: new Map(),
  };

  const res = checkNetGeometry(input, 'sig_a');
  assert.equal(res.net, 'SIG_A');
  assert.equal(res.findings.length, 1);
  const f = res.findings[0];
  assert.equal(f.kind, 'no_reference_plane');
  assert.equal(f.severity, 'error');
  assert.equal(f.layerId, 1);
  assert.equal(f.referenceLayerId, 15);
  assert.ok(Math.abs((f.lengthMm ?? 0) - 20) < 0.1);
  assert.deepEqual(f.primitiveIds?.sort(), ['t1', 't2']);
});

test('detects plane_split_crossing between two GND islands and reports primitive IDs', () => {
  const leftPlane = rect(10, 20, 18, 30); // x in [1, 19]
  const rightPlane = rect(30, 20, 18, 30); // x in [21, 39] -> 2 mm split at x in [19, 21]
  const gnd = union([leftPlane, rightPlane]);

  const input: CheckBoardInput = {
    stackup: make4LayerStackup(),
    tracks: [
      { id: 'seg1', net: 'USB_DP', layer: 1, a: { x: 5, y: 20 }, b: { x: 20, y: 20 }, width: 0.15 },
      { id: 'seg2', net: 'USB_DP', layer: 1, a: { x: 20, y: 20 }, b: { x: 35, y: 20 }, width: 0.15 },
    ],
    vias: [],
    copperByLayer: new Map([[15, new Map([['GND', gnd]])]]),
  };

  const res = checkNetGeometry(input, 'USB_DP', { planeEdgeClearanceFactor: 0 });
  const splits = res.findings.filter((f) => f.kind === 'plane_split_crossing');
  assert.equal(splits.length, 1);
  assert.equal(splits[0].severity, 'error');
  assert.ok(Math.abs(splits[0].at.x - 20) < 0.3);
  assert.ok(Math.abs((splits[0].lengthMm ?? 0) - 2.0) < 0.35);
  assert.deepEqual(splits[0].primitiveIds?.sort(), ['seg1', 'seg2']);
});

test('detects plane_split_crossing AND reference_net_change when crossing GND to 48V_PGND', () => {
  const gnd = union([rect(10, 20, 19.4, 30)]); // x in [0.3, 19.7]
  const pgnd = union([rect(30, 20, 19.4, 30)]); // x in [20.3, 39.7] -> 0.6 mm split

  const input: CheckBoardInput = {
    stackup: make2LayerStackup(),
    tracks: [
      { id: 's1', net: 'ISO_TX', layer: 1, a: { x: 5, y: 20 }, b: { x: 35, y: 20 }, width: 0.2 },
    ],
    vias: [],
    copperByLayer: new Map([
      [
        2,
        new Map<string, Paths>([
          ['GND', gnd],
          ['48V_PGND', pgnd],
        ]),
      ],
    ]),
  };

  const res = checkNetGeometry(input, 'ISO_TX', { planeEdgeClearanceFactor: 0 });
  assert.ok(res.referenceNetsUsed.includes('GND'));
  assert.ok(res.referenceNetsUsed.includes('48V_PGND'));
  assert.ok(res.findings.some((f) => f.kind === 'plane_split_crossing'));
  const netChanges = res.findings.filter((f) => f.kind === 'reference_net_change');
  assert.equal(netChanges.length, 1);
  assert.match(netChanges[0].detail, /GND.*48V_PGND/);
});

test('detects plane_void when trace runs across an interior hole/cutout in GND plane', () => {
  const planeWithHole = difference(union([rect(25, 25, 40, 40)]), union([circle({ x: 25, y: 25 }, 1.2)]));

  const input: CheckBoardInput = {
    stackup: make4LayerStackup(),
    tracks: [
      { id: 'v_seg', net: 'CLK', layer: 1, a: { x: 10, y: 25 }, b: { x: 40, y: 25 }, width: 0.15 },
    ],
    vias: [],
    copperByLayer: new Map([[15, new Map([['GND', planeWithHole]])]]),
  };

  const res = checkNetGeometry(input, 'CLK', { planeEdgeClearanceFactor: 0 });
  const voids = res.findings.filter((f) => f.kind === 'plane_void');
  assert.equal(voids.length, 1);
  assert.ok(Math.abs(voids[0].at.x - 25) < 0.3);
  assert.ok((voids[0].lengthMm ?? 0) > 2.0);
  assert.deepEqual(voids[0].primitiveIds, ['v_seg']);
});

test('detects near_plane_edge within N * dielectric height and merges along consecutive segments', () => {
  // Inner1 GND covers x in [0, 40], y in [0, 40]. Dielectric h = 0.21 mm -> 3*h = 0.63 mm.
  const gnd = union([rect(20, 20, 40, 40)]);
  const input: CheckBoardInput = {
    stackup: make4LayerStackup(),
    tracks: [
      { id: 'e1', net: 'DATA0', layer: 1, a: { x: 5, y: 0.25 }, b: { x: 15, y: 0.25 }, width: 0.15 },
      { id: 'e2', net: 'DATA0', layer: 1, a: { x: 15, y: 0.25 }, b: { x: 25, y: 0.25 }, width: 0.15 },
    ],
    vias: [],
    copperByLayer: new Map([[15, new Map([['GND', gnd]])]]),
  };

  const res = checkNetGeometry(input, 'DATA0');
  const near = res.findings.filter((f) => f.kind === 'near_plane_edge');
  assert.equal(near.length, 1, 'adjacent near_plane_edge segments should merge into one finding');
  assert.equal(near[0].severity, 'warning');
  assert.ok(Math.abs((near[0].lengthMm ?? 0) - 20) < 0.3);
  assert.deepEqual(near[0].primitiveIds?.sort(), ['e1', 'e2']);
});

test('detects layer_change_no_return when no GND stitching via is within radius, and clears when one is added', () => {
  const gndIn1 = union([rect(25, 25, 40, 40)]);
  const gndIn2 = union([rect(25, 25, 40, 40)]);

  const tracks: Track[] = [
    { id: 'top1', net: 'ETH_TX', layer: 1, a: { x: 10, y: 25 }, b: { x: 25, y: 25 }, width: 0.15 },
    { id: 'bot1', net: 'ETH_TX', layer: 2, a: { x: 25, y: 25 }, b: { x: 38, y: 25 }, width: 0.15 },
  ];
  const signalVia: Via = { id: 'sv1', net: 'ETH_TX', at: { x: 25, y: 25 }, drill: 0.3, diameter: 0.6, stitching: false };
  const farGndVia: Via = { id: 'gv_far', net: 'GND', at: { x: 33, y: 25 }, drill: 0.3, diameter: 0.6, stitching: true };

  const baseInput: CheckBoardInput = {
    stackup: make4LayerStackup(),
    tracks,
    vias: [signalVia, farGndVia],
    copperByLayer: new Map([
      [15, new Map([['GND', gndIn1]])],
      [16, new Map([['GND', gndIn2]])],
    ]),
  };

  const resFail = checkNetGeometry(baseInput, 'ETH_TX', { returnViaRadiusMm: 2.5 });
  const viaFindings = resFail.findings.filter((f) => f.kind === 'layer_change_no_return');
  assert.equal(viaFindings.length, 1);
  assert.equal(viaFindings[0].severity, 'error');
  assert.deepEqual(viaFindings[0].primitiveIds, ['sv1']);
  assert.match(viaFindings[0].detail, /8 mm away/);

  // Adding a GND via 1.2 mm away satisfies the 2.5 mm radius.
  const nearGndVia: Via = { id: 'gv_near', net: 'GND', at: { x: 26.2, y: 25 }, drill: 0.3, diameter: 0.6, stitching: true };
  const resPass = checkNetGeometry({ ...baseInput, vias: [signalVia, farGndVia, nearGndVia] }, 'ETH_TX', {
    returnViaRadiusMm: 2.5,
  });
  assert.equal(resPass.findings.filter((f) => f.kind === 'layer_change_no_return').length, 0);

  // A through-hole GND pad within radius also satisfies return via requirement.
  const resPad = checkNetGeometry(
    {
      ...baseInput,
      pads: [{ id: 'pad_gnd', net: 'GND', layer: MULTI_LAYER, at: { x: 25, y: 26.5 }, holeDiameter: 0.8 }],
    },
    'ETH_TX',
    { returnViaRadiusMm: 2.5 },
  );
  assert.equal(resPad.findings.filter((f) => f.kind === 'layer_change_no_return').length, 0);
});

test('does not flag layer_change_no_return when both signal layers share the same reference plane', () => {
  // 4-layer stack: Top (1) and Inner2 (16) both sit directly adjacent to Inner1 (15) GND!
  const gndIn1 = union([rect(25, 25, 40, 40)]);
  const input: CheckBoardInput = {
    stackup: make4LayerStackup(),
    tracks: [
      { id: 't_top', net: 'SHARED_REF', layer: 1, a: { x: 10, y: 25 }, b: { x: 25, y: 25 }, width: 0.15 },
      { id: 't_in2', net: 'SHARED_REF', layer: 16, a: { x: 25, y: 25 }, b: { x: 38, y: 25 }, width: 0.15 },
    ],
    vias: [{ id: 'sv_shared', net: 'SHARED_REF', at: { x: 25, y: 25 }, drill: 0.3, diameter: 0.6, stitching: false }],
    copperByLayer: new Map([[15, new Map([['GND', gndIn1]])]]),
  };

  const res = checkNetGeometry(input, 'SHARED_REF', { planeEdgeClearanceFactor: 0 });
  assert.equal(res.findings.filter((f) => f.kind === 'layer_change_no_return').length, 0);
});

test('respects skipNets and minSegmentLengthMm rules', () => {
  const input: CheckBoardInput = {
    stackup: make4LayerStackup(),
    tracks: [{ id: 'short1', net: 'SHORT_SIG', layer: 1, a: { x: 10, y: 10 }, b: { x: 10.2, y: 10 }, width: 0.15 }],
    vias: [],
    copperByLayer: new Map(),
  };

  const skipped = checkNetGeometry(input, 'short_sig', { skipNets: ['SHORT_SIG'] });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.findings.length, 0);

  const filtered = checkNetGeometry(input, 'SHORT_SIG', { minSegmentLengthMm: 0.5 });
  assert.equal(filtered.findings.length, 0);

  const reported = checkNetGeometry(input, 'SHORT_SIG', { minSegmentLengthMm: 0.1 });
  assert.equal(reported.findings.length, 1);
});
