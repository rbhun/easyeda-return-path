#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { Resvg } from '@resvg/resvg-js';
import { AnalysisAborted, analyzeNet, classifySignal, GENERIC, guessDrivers, guessRails, hfApplicability, hfCandidates, parseHz, summariseSignal, type Analysis, type Board } from '@returnpath/core';
import { dcReport, dcViews, describeGuess, runDc } from './dc.js';
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
    'list-rails': { type: 'boolean', default: false },
    dc: { type: 'string' },
    ground: { type: 'string' },
    source: { type: 'string' },
    loads: { type: 'string' },
    current: { type: 'string' },
    cell: { type: 'string' },
    driver: { type: 'string' },
    speed: { type: 'string' },
    force: { type: 'boolean', default: false },
    verbose: { type: 'boolean', short: 'v', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const file = positionals[0];
if (values.help || !file) {
  console.log(`Usage: returnpath <board.epro|board.epro2|board.epcb> --net CLK [--out dir] [--name prefix] [--png]
       [--clearance mm] [--phys-unit auto|mil|mm] [--pcb name] [--list-nets] [--driver U1[,U2]] [--speed 400k] [--force] [--verbose]
       returnpath <board> --list-rails
       returnpath <board> --dc 3V3[,MORE_NETS] [--ground GND] [--source U1] [--loads U2,U3] [--current U2=0.15,U3=20mA]
       [--cell mm] [--out dir] [--name prefix] [--png]`);
  process.exit(file ? 0 : 1);
}

const board = loadBoard(file, { physUnit: values['phys-unit'] as 'auto' | 'mil' | 'mm', pcb: values.pcb });
for (const w of board.warnings) console.warn(`warning: ${w}`);
const writeSvg = (base: string, svg: string) => {
  writeFileSync(`${base}.svg`, svg);
  console.log(`wrote ${base}.svg`);
  if (values.png) {
    const png = new Resvg(svg, { fitTo: { mode: 'zoom', value: 1.5 }, font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' } }).render().asPng();
    writeFileSync(`${base}.png`, png);
    console.log(`wrote ${base}.png`);
  }
};
if (values['list-rails']) {
  console.log(describeGuess(guessRails(board)));
  process.exit(0);
}
if (values.dc) {
  let run;
  try {
    const [rail, ...railNets] = values.dc.split(',').map((s) => s.trim()).filter(Boolean);
    run = runDc(board, { rail, railNets, ground: values.ground, source: values.source, loads: values.loads?.split(',').map((s) => s.trim()).filter(Boolean), currents: values.current, cell: values.cell ? Number(values.cell) : undefined });
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  const prefix = values.name ?? `${basename(file).replace(/\.[^.]+$/, '')}-dc-${values.dc.toLowerCase().replace(/\W+/g, '')}`;
  mkdirSync(values.out!, { recursive: true });
  for (const v of dcViews(board, run, basename(file))) writeSvg(join(values.out!, `${prefix}-${v.suffix}`), v.svg);
  const report = dcReport(board, run);
  writeFileSync(join(values.out!, `${prefix}-report.json`), JSON.stringify(report, null, 2));
  console.log(`wrote ${join(values.out!, `${prefix}-report.json`)}`);
  for (const w of run.result.warnings) console.warn(`warning: ${w}`);
  for (const n of [report.supply, report.return]) if (n) console.log(`${n.net} (${n.role}): drop ${n.dropMv} ${report.units.drop}, bottleneck ${n.bottleneck ? `${n.bottleneck.aPerMm} ${report.units.density} on ${n.bottleneck.layer}` : 'n/a'}`);
  process.exit(0);
}
if (values['list-nets'] || !values.net) {
  // Signal nets first (recognised data lines before the rest), then the nets the check turns away.
  const cands = hfCandidates(board);
  const listed = new Set(cands.map((c) => c.net));
  console.log([...cands.map((c) => `${c.net}\t${c.kind ? `${c.kind.label}, usually ${c.kind.speeds[c.kind.dflt].label}` : 'signal'}\t${c.lengthMm.toFixed(0)} mm`), ...board.nets.filter((n) => !listed.has(n))].join('\n'));
  process.exit(values.net ? 0 : 1);
}

const net = values.net;
const scope = hfApplicability(board, net);
if (!scope.ok && !values.force) {
  console.error(`${scope.message}\nCLI: returnpath <board> --dc <rail>. Pass --force to run the high-frequency check anyway.`);
  process.exit(2);
}
const guess = guessDrivers(board, net);
const drivers = values.driver ? values.driver.split(',').map((d) => d.trim()).filter(Boolean) : guess.confident ? guess.drivers : [];
console.log(`driver candidates: ${guess.candidates.map((c) => `${c.designator} (${c.role}: ${c.why})`).join('; ') || 'none'}`);
if (values.driver) console.log(`driver: ${drivers.join(', ')} (from --driver)`);
else if (guess.confident) console.log(`driver: ${drivers.join(', ')} (guessed)`);
else console.log('driver: not clear from the pin names; pass --driver U1 (or U1,U2 for both directions) to trace the driver supply loop');
const phaseMs = new Map<string, number>();
let analysis: Analysis;
try {
  analysis = analyzeNet(board, net, { ...(values.clearance ? { clearance: Number(values.clearance) } : {}), drivers }, {
    timeBudgetMs: 120_000,
    onPhase: (_p, prev, ms) => prev && phaseMs.set(prev, (phaseMs.get(prev) ?? 0) + ms),
  });
} catch (e) {
  if (!(e instanceof AnalysisAborted)) throw e;
  console.error(`error: ${e.message}`);
  process.exit(2);
}
if (values.verbose) {
  console.log(`phases: ${[...phaseMs].map(([p, ms]) => `${p} ${ms.toFixed(0)} ms`).join(', ')}`);
  console.log(`sizes: ${Object.entries(analysis.stats).map(([k, v]) => `${k}=${typeof v === 'number' ? +v.toFixed(3) : v}`).join(' ')}`);
}
const prefix = values.name ?? `${basename(file).replace(/\.[^.]+$/, '')}-${net.toLowerCase()}`;
mkdirSync(values.out!, { recursive: true });

const layerName = (id: number) => board.stackup.copper.find((l) => l.id === id)?.name ?? `L${id}`;
const views: { suffix: string; title: string; refLayer?: number }[] = [{ suffix: 'overview', title: `${net} return path: overview (${basename(file)})` }];
for (const rl of new Set(analysis.chains.map((c) => c.ref?.layer).filter((x): x is number => x !== undefined))) {
  const sig = [...new Set(analysis.chains.filter((c) => c.ref?.layer === rl).map((c) => layerName(c.chain.layer)))].join(' + ');
  const coplanar = analysis.chains.some((c) => c.ref?.layer === rl && c.ref.coplanar);
  views.push({ suffix: `ref-${layerName(rl).toLowerCase().replace(/\W+/g, '')}`, title: `${net} on ${sig}, referenced to ${layerName(rl)}${coplanar ? ' (coplanar pour)' : ''}`, refLayer: rl });
}

for (const v of views) writeSvg(join(values.out!, `${prefix}-${v.suffix}`), renderOverlay(board, analysis, { title: v.title, refLayer: v.refLayer }));
writeFileSync(join(values.out!, `${prefix}-report.json`), JSON.stringify(report(board, analysis), null, 2));
console.log(`wrote ${join(values.out!, `${prefix}-report.json`)}`);

console.log(`\n${net}: ${analysis.findings.length} finding(s)`);
const kind = classifySignal(net, board.pads.filter((p) => p.net === net).map((p) => p.pinName)) ?? GENERIC;
const hz = values.speed ? parseHz(values.speed) : kind.speeds[kind.dflt].hz;
if (values.speed && !hz) console.warn(`warning: --speed ${values.speed} is not a frequency (try 400k, 12MHz or 115200)`);
if (hz) console.log(`  ${summariseSignal(net, kind, hz, board.tracks.filter((t) => t.net === net).reduce((s, t) => s + Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y), 0)).message}${values.speed ? '' : ' (usual speed; pass --speed to set it)'}`);
for (const f of analysis.findings) console.log(`  [${f.severity}] ${f.message}`);

function report(b: Board, a: Analysis) {
  const r2 = (n: number) => Math.round(n * 1000) / 1000;
  const pt = (p: { x: number; y: number }) => ({ x: r2(p.x), y: r2(p.y) });
  return {
    net: a.net,
    units: 'mm',
    warnings: b.warnings,
    stackup: b.stackup,
    stats: a.stats,
    findings: a.findings.map((f) => ({ ...f, at: pt(f.at) })),
    chains: a.chains.map((c) => ({
      layer: layerName(c.chain.layer),
      reference: c.ref ? { layer: layerName(c.ref.layer), h: r2(c.ref.h), band: r2(3 * c.ref.h), coplanar: !!c.ref.coplanar } : null,
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
