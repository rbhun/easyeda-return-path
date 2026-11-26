// `returnpath --dc <rail>`: wizard step 1 without the dialogs (guess, overridable by flags), the DC
// solve, and the renders. Pure apart from the returned file list; cli.ts does the writing.
import { buildDcSetup, DRAWN_STREAMS, guessRailGroup, guessRails, parseCurrents, railLabel, solveDc, traceStreamlines, type Board, type DcResult, type RailsGuess, type Streamline } from '@returnpath/core';
import { renderDc } from './render/dc-svg.js';

export interface DcCliOptions {
  rail: string;
  /** Further nets of the same rail (`--dc VBUS_R,VBUS_RAW`). */
  railNets?: string[];
  ground?: string;
  source?: string;
  loads?: string[];
  /** "U2=0.15,U3=0.02" (A). */
  currents?: string;
  cell?: number;
}

export function describeGuess(g: RailsGuess): string {
  const lines = [`grounds: ${g.grounds.join(', ') || '(none)'}`];
  for (const r of g.rails) {
    lines.push(`${r.net}${r.voltage !== undefined ? ` (${r.voltage} V)` : ''} / ${r.ground ?? '?'}: source ${r.source ? `${r.source.designator} (${r.source.reason})` : 'ASK'}${r.askReason ? ` - ${r.askReason}` : ''}`);
    if (r.candidates.length) lines.push(`  candidates: ${r.candidates.map((c) => `${c.designator} (${c.reason})`).join(', ')}`);
    lines.push(`  loads: ${r.loads.map((l) => l.designator + (l.connector ? ' (connector)' : '')).join(', ') || '(none)'}`);
    if (r.excluded.length) lines.push(`  left out: ${r.excluded.map((e) => `${e.designator} (${e.why})`).join(', ')}`);
  }
  return lines.join('\n');
}

export interface DcRun {
  result: DcResult;
  streamlines: { supply: Streamline[]; ret: Streamline[] };
}

export function runDc(board: Board, o: DcCliOptions): DcRun {
  const guess = o.railNets?.length ? guessRailGroup(board, [o.rail, ...o.railNets]) : guessRails(board).rails.find((r) => r.net === o.rail);
  const ground = o.ground ?? guess?.ground;
  if (!ground) throw new Error(`no ground found for ${o.rail}; pass --ground`);
  const source = o.source ?? guess?.source?.designator;
  if (!source) {
    const cands = guess?.candidates.map((c) => c.designator).join(', ');
    throw new Error(`${guess?.askReason ?? `no source guessed for ${o.rail}.`} Pass --source${cands ? ` (candidates: ${cands})` : ''}.`);
  }
  const setup = buildDcSetup(board, { rail: o.rail, railNets: o.railNets, ground, source, loads: o.loads, currents: parseCurrents(o.currents) });
  const result = solveDc(board, setup, o.cell ? { cell: o.cell } : {});
  return {
    result,
    streamlines: { supply: traceStreamlines(result.grid, result.supply, DRAWN_STREAMS), ret: result.ret ? traceStreamlines(result.grid, result.ret, DRAWN_STREAMS) : [] },
  };
}

/** SVG views: an overview, then each layer carrying at least 2 % of a net's flow. */
export function dcViews(board: Board, run: DcRun, fileLabel: string): { suffix: string; svg: string }[] {
  const { result } = run;
  const layerName = (id: number) => board.stackup.copper.find((l) => l.id === id)?.name ?? `L${id}`;
  const slug = (s: string) => s.toLowerCase().replace(/\W+/g, '');
  const views = [{ suffix: 'overview', svg: renderDc(board, result, { title: `DC ${railLabel(result.setup)} / ${result.setup.ground}: overview (${fileLabel})`, streamlines: run.streamlines }) }];
  for (const net of [result.supply, result.ret]) {
    if (!net) continue;
    const total = net.layers.reduce((a, l) => a + l.flow, 0) || 1;
    for (const l of net.layers) {
      if (l.flow / total < 0.02) continue;
      views.push({
        suffix: `${slug(net.net)}-${slug(layerName(l.layer))}`,
        svg: renderDc(board, result, { title: `DC ${net.role === 'supply' ? 'forward' : 'return'} current: ${net.net} on ${layerName(l.layer)}`, net: net.role, layer: l.layer, streamlines: run.streamlines }),
      });
    }
  }
  return views;
}

export function dcReport(board: Board, run: DcRun) {
  const { result: r } = run;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const layerName = (id: number) => board.stackup.copper.find((l) => l.id === id)?.name ?? `L${id}`;
  const net = (n: DcResult['supply'] | undefined, sl: Streamline[]) =>
    n && {
      net: n.net,
      role: n.role,
      dropMv: r3(n.drop * 1000),
      bottleneck: n.bottleneck && { layer: layerName(n.bottleneck.layer), at: { x: r3(n.bottleneck.at.x), y: r3(n.bottleneck.at.y) }, aPerMm: r3(n.bottleneck.j) },
      layers: n.layers.filter((l) => l.flow > 0).map((l) => ({ layer: layerName(l.layer), flow: r3(l.flow), peakAPerMm: r3(l.peak?.j ?? 0) })),
      vias: n.vias.filter((v) => v.current > 1e-6).map((v) => ({ id: v.id, at: { x: r3(v.at.x), y: r3(v.at.y) }, currentA: r3(v.current) })),
      streamlines: sl.map((s) => ({ load: s.load, complete: s.complete, layers: s.segments.map((x) => layerName(x.layer)) })),
      unconnected: n.unconnected,
      nodes: n.nodes,
      iterations: n.iterations,
    };
  return {
    rail: r.setup.rail,
    ...(r.setup.railNets && r.setup.railNets.length > 1 ? { railNets: r.setup.railNets, bridges: (r.setup.bridges ?? []).map((b) => b.designator) } : {}),
    ground: r.setup.ground,
    source: r.setup.source.designator,
    loads: r.setup.loads.map((l) => ({ designator: l.designator, currentA: r3(l.current) })),
    normalised: r.setup.normalised,
    units: { length: 'mm', density: r.setup.normalised ? 'A/mm per A of total load' : 'A/mm', drop: r.setup.normalised ? 'mV per A' : 'mV' },
    cellMm: r.grid.cell,
    copperThicknessMm: Object.fromEntries([...r.thickness].map(([id, t]) => [layerName(id), t])),
    warnings: r.warnings,
    supply: net(r.supply, run.streamlines.supply),
    return: net(r.ret, run.streamlines.ret),
  };
}
