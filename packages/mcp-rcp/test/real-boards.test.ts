import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEasyEdaPcb } from '@returnpath/cli/parse';
import { splitEpru } from '@returnpath/cli/project';
import { isGroundNet, looksLikePowerNet, type Board } from '@returnpath/core';
import { strFromU8, unzipSync } from 'fflate';
import { buildCopperByLayerFromBoard, checkNetGeometry } from '../src/checker.js';
import { MAX_REPLY_BYTES } from '../src/service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DONGLE_PATH = path.join(REPO_ROOT, 'samples', 'R-Com dongle_2026-11-25-22-41.epro2');
const DISPLAY_PATH = path.join(REPO_ROOT, 'samples', 'rack display_2026-11-26-11-07.epro2');

function loadEpro2Board(filePath: string): Board {
  const entries = unzipSync(new Uint8Array(fs.readFileSync(filePath)));
  const pcbs: string[] = [];
  const footprints = new Map<string, string>();
  const poured: string[] = [];
  for (const [name, data] of Object.entries(entries)) {
    const text = () => strFromU8(data);
    if (name.endsWith('.epcb')) pcbs.push(text());
    else if (name.endsWith('.efoo')) footprints.set(path.basename(name).split('.')[0], text());
    else if (name.endsWith('.ecop')) poured.push(text());
    else if (name.endsWith('.epru')) {
      for (const doc of splitEpru(text())) {
        if (doc.type === 'PCB') pcbs.push(doc.text);
        else if (doc.type === 'FOOTPRINT') footprints.set(doc.uuid, doc.text);
      }
    }
  }
  if (!pcbs.length) throw new Error(`No PCB document found inside ${filePath}`);
  const parsed = pcbs.map((pcb) => parseEasyEdaPcb({ pcb, footprints, poured }));
  return parsed.reduce((a, b) => (b.tracks.length > a.tracks.length ? b : a));
}

test('real board smoke: R-Com dongle checks every signal net fast and under 256 KiB', async (t) => {
  if (!fs.existsSync(DONGLE_PATH)) {
    t.skip('Local R-Com dongle sample not present');
    return;
  }

  const board = loadEpro2Board(DONGLE_PATH);
  const copperByLayer = buildCopperByLayerFromBoard(board);
  const input = {
    stackup: board.stackup,
    tracks: board.tracks,
    vias: board.vias,
    pads: board.pads,
    copperByLayer,
    warnings: board.warnings,
  };

  const signalNets = board.nets.filter((n) => !isGroundNet(n) && !looksLikePowerNet(n));
  assert.ok(signalNets.length > 50, `expected >50 signal nets on R-Com dongle, got ${signalNets.length}`);

  let maxBytes = 0;
  let totalFindings = 0;
  let splitCount = 0;
  let noRefCount = 0;
  let viaCount = 0;
  const t0 = performance.now();

  for (const net of signalNets) {
    const res = checkNetGeometry(input, net);
    const bytes = Buffer.byteLength(JSON.stringify({ ok: true, data: res }), 'utf8');
    if (bytes > maxBytes) maxBytes = bytes;
    assert.ok(bytes <= MAX_REPLY_BYTES, `reply for ${net} was ${bytes} bytes > ${MAX_REPLY_BYTES}`);
    totalFindings += res.findings.length;
    splitCount += res.summary.byKind.plane_split_crossing;
    noRefCount += res.summary.byKind.no_reference_plane;
    viaCount += res.summary.byKind.layer_change_no_return;
  }

  const elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 30_000, `checking all ${signalNets.length} nets took ${Math.round(elapsedMs)} ms`);
  assert.ok(totalFindings > 0, 'expected findings on real 2-layer board');
  assert.ok(splitCount + noRefCount + viaCount > 0, 'expected plane/split/via findings on real board');
});

test('real board smoke: rack display checks every signal net fast and under 256 KiB', async (t) => {
  if (!fs.existsSync(DISPLAY_PATH)) {
    t.skip('Local rack display sample not present');
    return;
  }

  const board = loadEpro2Board(DISPLAY_PATH);
  const copperByLayer = buildCopperByLayerFromBoard(board);
  const input = {
    stackup: board.stackup,
    tracks: board.tracks,
    vias: board.vias,
    pads: board.pads,
    copperByLayer,
    warnings: board.warnings,
  };

  const signalNets = board.nets.filter((n) => !isGroundNet(n) && !looksLikePowerNet(n));
  assert.ok(signalNets.length > 10);

  for (const net of signalNets) {
    const res = checkNetGeometry(input, net);
    const bytes = Buffer.byteLength(JSON.stringify({ ok: true, data: res }), 'utf8');
    assert.ok(bytes <= MAX_REPLY_BYTES, `reply for ${net} exceeded budget: ${bytes} bytes`);
  }
});
