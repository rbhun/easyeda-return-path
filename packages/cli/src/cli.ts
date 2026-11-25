#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { Resvg } from '@resvg/resvg-js';
import { analyzeNet, type Analysis, type Board } from '@returnpath/core';
import { loadBoard } from './easyeda/load.js';
import { renderOverlay } from './render/svg.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    net: { type: 'string', short: 'n' },
    out: { type: 'string', short: 'o', default: 'out' },
    name: { type: 'string' },
    png: { type: 'boolean', default: false },
    clearance: { type: 'string' },
    'phys-unit': { type: 'string', default: 'auto' },
    pcb: { type: 'string' },
    'list-nets': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const file = positionals[0];
if (values.help || !file) {
  console.log(`Usage: returnpath <board.epro|board.epcb> --net CLK [--out dir] [--name prefix] [--png]
       [--clearance mm] [--phys-unit auto|mil|mm] [--pcb name] [--list-nets]`);
  process.exit(file ? 0 : 1);
}

const board = loadBoard(file, { physUnit: values['phys-unit'] as 'auto' | 'mil' | 'mm', pcb: values.pcb });
for (const w of board.warnings) console.warn(`warning: ${w}`);
if (values['list-nets'] || !values.net) {
  console.log(board.nets.join('\n'));
  process.exit(values.net ? 0 : 1);
}

const net = values.net;
const analysis = analyzeNet(board, net, values.clearance ? { clearance: Number(values.clearance) } : {});
const prefix = values.name ?? `${basename(file).replace(/\.[^.]+$/, '')}-${net.toLowerCase()}`;
mkdirSync(values.out!, { recursive: true });

const layerName = (id: number) => board.stackup.copper.find((l) => l.id === id)?.name ?? `L${id}`;
const views: { suffix: string; title: string; refLayer?: number }[] = [{ suffix: 'overview', title: `${net} return path: overview (${basename(file)})` }];
for (const rl of new Set(analysis.chains.map((c) => c.ref?.layer).filter((x): x is number => x !== undefined))) {
  const sig = [...new Set(analysis.chains.filter((c) => c.ref?.layer === rl).map((c) => layerName(c.chain.layer)))].join(' + ');
  views.push({ suffix: `ref-${layerName(rl).toLowerCase().replace(/\W+/g, '')}`, title: `${net} on ${sig}, referenced to ${layerName(rl)}`, refLayer: rl });
}

for (const v of views) {
  const svg = renderOverlay(board, analysis, { title: v.title, refLayer: v.refLayer });
  const base = join(values.out!, `${prefix}-${v.suffix}`);
  writeFileSync(`${base}.svg`, svg);
  console.log(`wrote ${base}.svg`);
  if (values.png) {
    const png = new Resvg(svg, { fitTo: { mode: 'zoom', value: 1.5 }, font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' } }).render().asPng();
    writeFileSync(`${base}.png`, png);
    console.log(`wrote ${base}.png`);
  }
}
writeFileSync(join(values.out!, `${prefix}-report.json`), JSON.stringify(report(board, analysis), null, 2));
console.log(`wrote ${join(values.out!, `${prefix}-report.json`)}`);

console.log(`\n${net}: ${analysis.findings.length} finding(s)`);
for (const f of analysis.findings) console.log(`  [${f.severity}] ${f.message}`);

function report(b: Board, a: Analysis) {
  const r2 = (n: number) => Math.round(n * 1000) / 1000;
  const pt = (p: { x: number; y: number }) => ({ x: r2(p.x), y: r2(p.y) });
  return {
    net: a.net,
    units: 'mm',
    warnings: b.warnings,
    stackup: b.stackup,
    findings: a.findings.map((f) => ({ ...f, at: pt(f.at) })),
    chains: a.chains.map((c) => ({
      layer: layerName(c.chain.layer),
      reference: c.ref ? { layer: layerName(c.ref.layer), h: c.ref.h, band: r2(3 * c.ref.h) } : null,
      referenceNets: c.refNets,
      length: r2(c.chain.pts.reduce((s, p, i) => (i ? s + Math.hypot(p.x - c.chain.pts[i - 1].x, p.y - c.chain.pts[i - 1].y) : 0), 0)),
      coverage: c.coverage.map((x) => ({ track: x.trackId, ratio: r2(x.ratio) })),
      gaps: c.gaps.map((g) => ({
        kind: g.kind,
        from: pt(g.a),
        to: pt(g.b),
        netBefore: g.netBefore,
        netAfter: g.netAfter,
        detour: g.detour && { length: r2(g.detour.length), direct: r2(g.detour.directLength), extra: r2(g.detour.extraLength), addedLoopArea: r2(g.detour.loopArea), path: g.detour.path.map(pt) },
        bridge: g.bridge && { component: g.bridge.component.designator, distance: r2(g.bridge.distance) },
      })),
    })),
    vias: a.vias.map((v) => ({
      via: v.via.id,
      at: pt(v.via.at),
      transitions: v.transitions.map((t) => ({
        from: layerName(t.fromLayer),
        to: layerName(t.toLayer),
        fromReference: t.fromRef && `${layerName(t.fromRef.layer)} ${t.fromNet}`,
        toReference: t.toRef && `${layerName(t.toRef.layer)} ${t.toNet}`,
        kind: t.kind,
        target: t.target && { label: t.target.label, at: pt(t.target.at) },
        distance: t.distance && r2(t.distance),
        verticalLoopArea: t.loopArea && r2(t.loopArea),
        severity: t.severity,
      })),
    })),
  };
}
