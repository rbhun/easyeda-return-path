import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { rect, union, type Path, type Paths } from '@returnpath/core';
import { MAX_REPLY_BYTES, RCP_TOPICS, registerRcpServices, resetRcpServiceState } from '../src/rcp/service.js';
import type {
  AnalysisJobReplyData,
  CheckNetReplyData,
  ClearMarkersReplyData,
  InfoReplyData,
  ListNetsReplyData,
  ServiceEnvelope,
  ShowFindingsReplyData,
} from '../src/rcp/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIL = 0.0254;
const toMil = (mm: number) => mm / MIL;

function ringToSource(ring: Path, unitScale = 1): unknown[] {
  const [first, ...rest] = ring;
  return [
    toMil(first.x) / unitScale,
    toMil(first.y) / unitScale,
    'L',
    ...rest.flatMap((p) => [toMil(p.x) / unitScale, toMil(p.y) / unitScale]),
  ];
}

interface MockFixtureOptions {
  documentType?: number;
  pouredUnitMil?: number;
  extraLines?: Array<{ id: string; net: string; layer: number; a: { x: number; y: number }; b: { x: number; y: number } }>;
  stackupMode?: 'getStackup' | 'physicalConfig' | 'fallback';
  /** Inner1 is a PLANE layer between Top and Bottom, with this PCB document as its zone. */
  planeDocument?: string;
}

function installMockEda(opts: MockFixtureOptions = {}) {
  const rpcs = new Map<string, (msg: unknown) => Promise<unknown> | unknown>();
  const generatedMarkers: Array<{ markers: IDMT_IndicatorMarkerShape[]; color: unknown; lineWidth?: number; zoom?: boolean }> = [];
  let removeCount = 0;

  const pouredUnit = opts.pouredUnitMil ?? 1;
  const leftGnd: Paths = union([rect(10, 20, 18, 30)]); // x in [1, 19]
  const rightGnd: Paths = union([rect(30, 20, 18, 30)]); // x in [21, 39]
  const pourOutline = union([rect(20, 20, 38, 30)]);

  const baseLines = [
    { id: 'L1', net: 'USB_DP', layer: 1, a: { x: 5, y: 20 }, b: { x: 20, y: 20 } },
    { id: 'L2', net: 'USB_DP', layer: 1, a: { x: 20, y: 20 }, b: { x: 35, y: 20 } },
    { id: 'L3', net: 'USB_DM', layer: 1, a: { x: 5, y: 24 }, b: { x: 15, y: 24 } },
    { id: 'L4', net: 'USB_DM', layer: 2, a: { x: 15, y: 24 }, b: { x: 15, y: 12 } },
    { id: 'L5', net: '3V3', layer: 1, a: { x: 2, y: 2 }, b: { x: 12, y: 2 } },
    ...(opts.extraLines ?? []),
  ];

  const lines = baseLines.map((l) => ({
    getState_PrimitiveId: () => l.id,
    getState_Net: () => l.net,
    getState_Layer: () => l.layer,
    getState_StartX: () => toMil(l.a.x),
    getState_StartY: () => toMil(l.a.y),
    getState_EndX: () => toMil(l.b.x),
    getState_EndY: () => toMil(l.b.y),
    getState_LineWidth: () => toMil(0.15),
  }));

  const vias = [
    {
      getState_PrimitiveId: () => 'V_DM',
      getState_Net: () => 'USB_DM',
      getState_X: () => toMil(15),
      getState_Y: () => toMil(24),
      getState_HoleDiameter: () => toMil(0.3),
      getState_Diameter: () => toMil(0.6),
      getState_ViaType: () => 0,
    },
  ];

  const pours = [
    {
      getState_PrimitiveId: () => 'POUR_GND_BOT',
      getState_PourName: () => 'GND_BOT',
      getState_Net: () => 'GND',
      getState_Layer: () => 2,
      getState_PourPriority: () => 0,
      getState_ComplexPolygon: () => ({ getSource: () => [ringToSource(pourOutline[0], 1)] }),
    },
  ];

  const pouredMap = new Map<string, unknown>([
    [
      'POURED_1',
      {
        getState_PrimitiveId: () => 'POURED_1',
        getState_PourPrimitiveId: () => 'POUR_GND_BOT',
        getState_Layer: () => 2,
        getState_PourFills: () => [
          { fill: true, path: { getSource: () => [ringToSource(leftGnd[0], pouredUnit)] } },
          { fill: true, path: { getSource: () => [ringToSource(rightGnd[0], pouredUnit)] } },
        ],
      },
    ],
  ]);

  const stackupMode = opts.stackupMode ?? 'getStackup';

  const mockEda = {
    sys_MessageBus: {
      rpcServicePublic: (topic: string, fn: (msg: unknown) => Promise<unknown> | unknown) => {
        rpcs.set(topic, fn);
      },
      rpcCallPublic: async (topic: string, msg: unknown) => {
        const fn = rpcs.get(topic);
        if (!fn) throw undefined;
        return await fn(msg);
      },
    },
    dmt_SelectControl: {
      getCurrentDocumentInfo: async () =>
        opts.documentType === -1
          ? null
          : { documentType: opts.documentType ?? 3, uuid: 'pcb-test-uuid', tabId: 'tab-1' },
    },
    dmt_EditorControl: {
      generateIndicatorMarkers: async (
        markers: IDMT_IndicatorMarkerShape[],
        color: unknown,
        lineWidth?: number,
        zoom?: boolean,
      ) => {
        generatedMarkers.push({ markers, color, lineWidth, zoom });
        return true;
      },
      removeIndicatorMarkers: async () => {
        removeCount += 1;
        return true;
      },
    },
    pcb_Document: {
      convertDataOriginToCanvasOrigin: async () => ({ x: 100, y: -50 }),
    },
    pcb_Layer: {
      ...(stackupMode === 'getStackup'
        ? {
            getStackup: async () => ({
              unit: 'mm',
              totalThickness: 1.6,
              layers: opts.planeDocument
                ? [
                    { layerId: 1, layerName: 'Top Layer', kind: 'copper', thickness: 0.035, zIndex: 0 },
                    { layerId: 0, layerName: 'Prepreg', kind: 'dielectric', thickness: 0.1, zIndex: 1 },
                    { layerId: 15, layerName: 'Inner1', kind: 'copper', thickness: 0.035, zIndex: 2 },
                    { layerId: 0, layerName: 'Core', kind: 'dielectric', thickness: 1.4, zIndex: 3 },
                    { layerId: 2, layerName: 'Bottom Layer', kind: 'copper', thickness: 0.035, zIndex: 4 },
                  ]
                : [
                    { layerId: 1, layerName: 'Top Layer', kind: 'copper', thickness: 0.035, zIndex: 0 },
                    { layerId: 0, layerName: 'FR4 Core', kind: 'dielectric', thickness: 1.5, zIndex: 1 },
                    { layerId: 2, layerName: 'Bottom Layer', kind: 'copper', thickness: 0.035, zIndex: 2 },
                  ],
            }),
          }
        : {}),
      ...(stackupMode === 'physicalConfig'
        ? {
            getCurrentPhysicalStackingConfiguration: async () => ({
              name: '2L-1.6mm',
              layerCount: 3,
              list: [
                { layerId: 1, layerName: 'Top Layer', kind: 'copper', thickness: 0.035, unit: 'mm' },
                { layerId: 0, layerName: 'Core', kind: 'dielectric', thickness: 1.5, unit: 'mm' },
                { layerId: 2, layerName: 'Bottom Layer', kind: 'copper', thickness: 0.035, unit: 'mm' },
              ],
            }),
          }
        : {}),
      getAllLayers: async () => [
        { id: 1, name: 'Top Layer', type: 'SIGNAL', layerStatus: 1 },
        { id: 2, name: 'Bottom Layer', type: 'SIGNAL', layerStatus: 1 },
        { id: 15, name: 'Inner1', type: opts.planeDocument ? 'PLANE' : 'SIGNAL', layerStatus: opts.planeDocument ? 1 : 0 },
      ],
      getTheNumberOfCopperLayers: async () => 2,
    },
    pcb_Net: {
      getAllNetsName: async () => ['GND', '3V3', 'USB_DP', 'USB_DM'],
    },
    pcb_PrimitiveLine: {
      getAll: async () => lines,
    },
    pcb_PrimitiveArc: {
      getAll: async () => [],
    },
    pcb_PrimitiveVia: {
      getAll: async () => vias,
    },
    pcb_PrimitivePad: {
      getAll: async () => [],
    },
    pcb_PrimitiveFill: {
      getAll: async () => [],
    },
    pcb_PrimitivePour: {
      getAll: async () => pours,
    },
    pcb_PrimitivePoured: {
      getAllPrimitiveId: async () => [...pouredMap.keys()],
      get: async (id: string) => pouredMap.get(id),
    },
    ...(opts.planeDocument !== undefined
      ? {
          sys_FileManager: {
            getDocumentSource: async () => opts.planeDocument,
          },
        }
      : {}),
  };

  (globalThis as unknown as { eda: unknown }).eda = mockEda;
  resetRcpServiceState();
  registerRcpServices();

  return {
    call: <T>(topic: string, msg?: unknown) =>
      mockEda.sys_MessageBus.rpcCallPublic(topic, msg) as Promise<ServiceEnvelope<T>>,
    rpcs,
    generatedMarkers,
    getRemoveCount: () => removeCount,
  };
}

test('the Return Path extension.json stays the one shipped extension and activates on startup for the bridge', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension.json'), 'utf8'));
  assert.equal(manifest.name, 'easyeda-return-path');
  assert.equal(manifest.uuid, 'cfe3a38bdd3044659ee9f3eadd5ebbc8');
  assert.equal(manifest.license, 'Apache-2.0');
  assert.equal(manifest.activationEvents?.onStartupFinished, true);
  assert.equal(fs.existsSync(path.join(__dirname, '..', '..', 'mcp-rcp')), false, 'no separate mcp-rcp extension package');
});

test('registers all 10 mcp.rcp.* topics matching the bridge topic regex, once per message bus', () => {
  const env = installMockEda();
  const topicPattern = /^mcp\.[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;
  assert.equal(RCP_TOPICS.length, 10);
  for (const topic of RCP_TOPICS) {
    assert.ok(topicPattern.test(topic), `topic ${topic} must satisfy bridge regex`);
    assert.ok(env.rpcs.has(topic), `topic ${topic} should be registered on public bus`);
  }
  const before = env.rpcs.get('mcp.rcp.info');
  registerRcpServices();
  assert.equal(env.rpcs.get('mcp.rcp.info'), before, 'a second call on the same bus does not register again');
});

test('returns { ok: false, error } when a PCB document is not focused', async () => {
  const env = installMockEda({ documentType: 1 });
  const reply = await env.call<InfoReplyData>('mcp.rcp.info', {});
  assert.equal(reply.ok, false);
  if (!reply.ok) assert.match(reply.error, /Focus a PCB document first/);
});

test('mcp.rcp.info returns stackup, copperLayers, unit, and defaultRules across stackup API variants', async () => {
  for (const stackupMode of ['getStackup', 'physicalConfig', 'fallback'] as const) {
    const env = installMockEda({ stackupMode });
    const reply = await env.call<InfoReplyData>('mcp.rcp.info', null);
    assert.equal(reply.ok, true);
    if (!reply.ok) continue;
    assert.equal(reply.data.pcbUuid, 'pcb-test-uuid');
    assert.equal(reply.data.copperLayers, 2);
    assert.equal(reply.data.unit, 'mm');
    assert.equal(reply.data.stackup.filter((s) => s.type === 'copper').length, 2);
    assert.equal(reply.data.defaultRules.returnViaRadiusMm, 2.5);
    assert.equal(reply.data.defaultRules.planeEdgeClearanceFactor, 3);
    assert.deepEqual(reply.data.topics, [...RCP_TOPICS]);
  }
});

test('mcp.rcp.listNets pages results and flags power/ground nets', async () => {
  const env = installMockEda();

  // Default includePower=false filters out GND and 3V3.
  const sigPage = await env.call<ListNetsReplyData>('mcp.rcp.listNets', { offset: 0, limit: 1 });
  assert.equal(sigPage.ok, true);
  if (sigPage.ok) {
    assert.equal(sigPage.data.unit, 'mm');
    assert.equal(sigPage.data.total, 2);
    assert.equal(sigPage.data.totalAll, 4);
    assert.equal(sigPage.data.hasMore, true);
    assert.equal(sigPage.data.nets.length, 1);
    assert.equal(sigPage.data.nets[0].isPower, false);
    assert.equal(sigPage.data.nets[0].isGround, false);
  }

  // includePower=true includes GND and 3V3 with flags set.
  const allPage = await env.call<ListNetsReplyData>('mcp.rcp.listNets', { includePower: true, limit: 20 });
  assert.equal(allPage.ok, true);
  if (allPage.ok) {
    assert.equal(allPage.data.total, 4);
    assert.equal(allPage.data.hasMore, false);
    const gnd = allPage.data.nets.find((n) => n.name === 'GND');
    const pwr = allPage.data.nets.find((n) => n.name === '3V3');
    assert.equal(gnd?.isGround, true);
    assert.equal(gnd?.hasPour, true);
    assert.equal(pwr?.isPower, true);
  }
});

test('mcp.rcp.checkNet detects split crossing even with EasyEDA 10-mil poured fill units', async () => {
  const env = installMockEda({ pouredUnitMil: 10 });
  const reply = await env.call<CheckNetReplyData>('mcp.rcp.checkNet', {
    net: 'usb_dp',
    rules: { planeEdgeClearanceFactor: 0 },
  });
  assert.equal(reply.ok, true);
  if (reply.ok) {
    assert.equal(reply.data.net, 'USB_DP');
    assert.equal(reply.data.unit, 'mm');
    assert.equal(reply.data.segmentsChecked, 2);
    const splits = reply.data.findings.filter((f) => f.kind === 'plane_split_crossing');
    assert.equal(splits.length, 1);
    assert.ok(Math.abs(splits[0].at.x - 20) < 0.3);
    assert.deepEqual(splits[0].primitiveIds?.sort(), ['L1', 'L2']);
    assert.ok(Buffer.byteLength(JSON.stringify(reply), 'utf8') <= MAX_REPLY_BYTES);
  }

  // Missing net returns { ok: false, error }.
  const bad = await env.call<CheckNetReplyData>('mcp.rcp.checkNet', { net: 'NONEXISTENT' });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /not found/);
});

test('mcp.rcp.checkNet treats an Inner1 PLANE layer as one sheet with keepouts cut out', async () => {
  const mil = (mm: number) => mm / MIL;
  const rec = (head: object, body: object) => `${JSON.stringify(head)}||${JSON.stringify(body)}|`;
  const board = ['R', mil(0), mil(40), mil(50), mil(40), 0, 0];
  const slot = ['R', mil(14), mil(24), mil(8), mil(8), 0, 0];
  const doc = [
    rec({ type: 'LAYER', id: '["LAYER",15]' }, { layerId: 15, layerType: 'PLANE', layerName: 'Inner1', use: true }),
    rec({ type: 'POLY', id: 'outline' }, { layerId: 11, width: 6, path: board }),
    rec({ type: 'FILL', id: 'zone' }, { netName: 'GND', layerId: 15, fillStyle: 2, path: board }),
    rec({ type: 'REGION', id: 'slot' }, { layerId: 15, prohibitType: ['PLANE'], path: slot }),
  ].join('\n');
  const env = installMockEda({ planeDocument: doc });
  const reply = await env.call<CheckNetReplyData>('mcp.rcp.checkNet', {
    net: 'USB_DP',
    rules: { planeEdgeClearanceFactor: 0 },
  });
  assert.equal(reply.ok, true);
  if (!reply.ok) return;
  const onInner = reply.data.findings.filter((f) => f.referenceLayerId === 15);
  const gap = onInner.find((f) => f.kind === 'plane_void' || f.kind === 'plane_split_crossing');
  assert.ok(gap, reply.data.findings.map((f) => `${f.kind} L${f.referenceLayerId} ${f.lengthMm} ${f.detail}`).join('\n'));
  assert.ok((gap.lengthMm ?? 0) > 4 && (gap.lengthMm ?? 0) < 15, String(gap.lengthMm));
  assert.ok(gap.detail.includes('Inner1'));
  assert.equal(
    reply.data.findings.filter((f) => f.kind === 'no_reference_plane' && f.referenceLayerId === 15).length,
    0,
  );
});

test('mcp.rcp.showFindings and mcp.rcp.clearMarkers draw temporary markers with canvas origin offset', async () => {
  const env = installMockEda();
  const showReply = await env.call<ShowFindingsReplyData>('mcp.rcp.showFindings', {
    findings: [
      { x: 10, y: 20, w: 2, h: 1 },
      { at: { x: 25, y: 20 }, severity: 'warning' },
    ],
    color: 'red',
  });
  assert.equal(showReply.ok, true);
  if (showReply.ok) {
    assert.equal(showReply.data.shown, 2);
    assert.equal(showReply.data.unit, 'mm');
  }
  // Idempotent: cleared existing markers before drawing.
  assert.equal(env.getRemoveCount(), 1);
  assert.equal(env.generatedMarkers.length, 1);
  assert.equal(env.generatedMarkers[0].markers.length, 2);
  assert.equal(env.generatedMarkers[0].markers[0].type, 'rectangle');
  assert.equal(env.generatedMarkers[0].markers[1].type, 'circle');
  // Check canvasOrigin offset (+100, -50 mil) was applied to x=25mm, y=20mm.
  const circleMarker = env.generatedMarkers[0].markers[1];
  assert.ok(Math.abs((circleMarker.x ?? 0) - (toMil(25) + 100)) < 1e-6);
  assert.ok(Math.abs((circleMarker.y ?? 0) - (toMil(20) - 50)) < 1e-6);

  const clearReply = await env.call<ClearMarkersReplyData>('mcp.rcp.clearMarkers', {});
  assert.equal(clearReply.ok, true);
  if (clearReply.ok) {
    assert.equal(clearReply.data.cleared, true);
    assert.equal(clearReply.data.unit, 'mm');
  }
  assert.equal(env.getRemoveCount(), 2);
});

test('mcp.rcp.checkNet truncates oversized findings cleanly below the 256 KiB bridge limit', async () => {
  const extraLines = [];
  for (let i = 0; i < 1200; i++) {
    const x = 60 + (i % 60) * 5;
    const y = 60 + Math.floor(i / 60) * 5;
    extraLines.push({
      id: `HUGE_${i}_${'x'.repeat(30)}`,
      net: 'HUGE_NET',
      layer: 1,
      a: { x, y },
      b: { x: x + 2, y },
    });
  }
  const env = installMockEda({ extraLines });
  const reply = await env.call<CheckNetReplyData>('mcp.rcp.checkNet', { net: 'HUGE_NET' });
  assert.equal(reply.ok, true);
  if (reply.ok) {
    const bytes = Buffer.byteLength(JSON.stringify(reply), 'utf8');
    assert.ok(bytes <= MAX_REPLY_BYTES, `expected reply <= ${MAX_REPLY_BYTES} bytes, got ${bytes}`);
    assert.equal(reply.data.truncated, true);
    assert.ok(reply.data.findings.length > 0);
    assert.ok(reply.data.findings.length < 1200);
  }
});

test('mcp.rcp.startAnalysis truncates oversized analysis replies cleanly below the 256 KiB bridge limit', async () => {
  const env = installMockEda();
  registerRcpServices({
    executor: {
      runHf: async (req) => ({
        summary: `${req.net}: 2500 findings`,
        lines: Array.from({ length: 200 }, (_, i) => `line ${i} ${'z'.repeat(80)}`),
        findings: Array.from({ length: 2500 }, (_, i) => ({
          kind: 'gap' as const,
          severity: 'error' as const,
          message: `Gap ${i} ${'m'.repeat(120)}`,
          at: { x: i, y: i },
          layer: 1,
          lengthMm: 1.5,
        })),
        hf: {
          net: req.net,
          drivers: req.drivers ?? [],
          signal: { type: 'clock', hz: 25_000_000, kneeHz: 50_000_000, criticalMm: 100, lengthMm: 20, transmissionLine: false },
          stats: { lengthMm: 20, coveredPct: 50, maxDetourMm: 5, gapCount: 2500, viaCount: 0, returnViaCount: 0 } as never,
          forwardLayers: ['Top'],
          returnLayers: ['Bottom'],
          markers: 0,
          warnings: [],
        },
      }),
      runDc: async () => {
        throw new Error('unused');
      },
    },
  });

  const reply = await env.call<AnalysisJobReplyData>('mcp.rcp.startAnalysis', {
    kind: 'hf',
    net: 'BIG_CLK',
    waitMs: 5_000,
  });
  assert.equal(reply.ok, true);
  if (reply.ok) {
    const bytes = Buffer.byteLength(JSON.stringify(reply), 'utf8');
    assert.ok(bytes <= MAX_REPLY_BYTES, `expected reply <= ${MAX_REPLY_BYTES} bytes, got ${bytes}`);
    assert.equal(reply.data.status, 'completed');
    assert.equal(reply.data.truncated, true);
    assert.ok(reply.data.result && 'batch' in reply.data.result && !reply.data.result.batch);
    if (reply.data.result && 'batch' in reply.data.result && !reply.data.result.batch) {
      assert.ok(reply.data.result.findings.length > 0);
      assert.ok(reply.data.result.findings.length < 2500);
    }
  }
});
