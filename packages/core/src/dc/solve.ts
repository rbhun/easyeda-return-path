// DC resistive solve (design decisions D2, D7): Kirchhoff on a resistor network built from the
// rasterised copper of one net. In-plane edges carry the sheet conductance σ·t of the layer's
// copper; via and plated-hole barrels join the layers. The source pads are held at 0 V and the
// load pads draw (rail) or return (ground) their currents. Jacobi-preconditioned conjugate
// gradients, typed arrays only: pure TS for the extension sandbox.
import { bbox } from '../geom.js';
import { runAsync, runSync, type RunOptions, type Steps } from '../budget.js';
import { buildReferenceCopperSteps, type LayerCopper } from '../refcopper.js';
import { MULTI_LAYER, type Board, type Pad, type Pt } from '../types.js';
import { cellCentre, cellOf, inGrid, padCells, rasterNet, type Grid } from './raster.js';
import type { DcBridge, DcSetup } from './rails.js';

/** Conductance of a part joining two nets of one rail, S (1 mΩ: a short next to the copper). */
const BRIDGE_S = 1000;

export interface DcOptions {
  /** Raster cell, mm. Default: picked from maxNodes. */
  cell?: number;
  /** Node budget used to pick the cell size. */
  maxNodes: number;
  minCell: number;
  /** Copper thickness when the stackup has none, mm. */
  outerCopperMm: number;
  innerCopperMm: number;
  /** Via barrel plating, mm. */
  platingMm: number;
  /** Copper conductivity, S/mm. */
  conductivity: number;
  /** Pour clearance for pours without a computed fill, mm. */
  clearance: number;
  tolerance: number;
  maxIterations: number;
}

export const defaultDcOptions: DcOptions = {
  maxNodes: 150_000,
  minCell: 0.1,
  outerCopperMm: 0.035,
  innerCopperMm: 0.0175,
  platingMm: 0.025,
  conductivity: 5.8e4,
  clearance: 0.25,
  tolerance: 1e-7,
  maxIterations: 30_000,
};

export interface DcLayerField {
  layer: number;
  /** Copper fill weight per cell (0 = no copper of this net). */
  weight: Float32Array;
  /** Node voltage per cell, V (NaN off copper or unconnected). */
  v: Float64Array;
  /** Sheet current density per cell, A/mm of copper width, and its magnitude. */
  jx: Float32Array;
  jy: Float32Array;
  j: Float32Array;
  /** Σ |J|·area over the layer, A·mm: how much of the flow this layer carries. */
  flow: number;
  /** Densest cell of the layer away from pads and vias. */
  peak?: { at: Pt; j: number };
}

export interface ViaFlow {
  id: string;
  at: Pt;
  cell: number;
  /** Largest barrel current between two layers, A. */
  current: number;
  /** Current the barrel delivers into each layer's copper, A, keyed by layer id (negative = takes from it). */
  delivered: Map<number, number>;
}

export interface DcNetResult {
  net: string;
  role: 'supply' | 'return';
  layers: DcLayerField[];
  vias: ViaFlow[];
  /** Cells held at 0 V (the source pads), per layer id. */
  sourceCells: Map<number, Set<number>>;
  /**
   * Terminal cells of each load, per layer id. `own` is that load's current solved on its own, so a
   * streamline traced on it is the path of this load's current; the combined field above is every
   * load at once, and a line on it bends towards the others.
   */
  loadCells: { designator: string; current: number; cells: Map<number, number[]>; own?: { layers: DcLayerField[]; vias: ViaFlow[]; fullScale: number } }[];
  /** Highest density away from pads and vias: the bottleneck, and the 100 % of the colour bins. */
  bottleneck?: { layer: number; at: Pt; j: number };
  fullScale: number;
  /** Largest |V| on the net relative to the source pads, V. */
  drop: number;
  /** Loads with no copper path to the source on this net. */
  unconnected: string[];
  /** Parts joining the nets of a rail of several nets: each side's pad cells per layer id, and the side's centre. */
  bridges: { designator: string; sides: { net: string; at: Pt; cells: Map<number, number[]> }[] }[];
  nodes: number;
  iterations: number;
  residual: number;
}

export interface DcResult {
  setup: DcSetup;
  grid: Grid;
  supply: DcNetResult;
  ret?: DcNetResult;
  warnings: string[];
  /** Copper thickness used per layer id, mm. */
  thickness: Map<number, number>;
}

function copperThickness(board: Board, opts: DcOptions, warnings: string[]): Map<number, number> {
  const out = new Map<number, number>();
  const n = board.stackup.copper.length;
  const missing: string[] = [];
  for (const l of board.stackup.copper) {
    const outer = l.index === 0 || l.index === n - 1;
    if (l.thicknessMm && l.thicknessMm > 0) out.set(l.id, l.thicknessMm);
    else {
      out.set(l.id, outer ? opts.outerCopperMm : opts.innerCopperMm);
      missing.push(l.name);
    }
  }
  if (missing.length) warnings.push(`No copper thickness for ${missing.join(', ')}; assumed ${opts.outerCopperMm * 1000} µm outer, ${opts.innerCopperMm * 1000} µm inner.`);
  return out;
}

function chooseGrid(board: Board, setup: DcSetup, opts: DcOptions): Grid {
  const nets = new Set([...(setup.railNets ?? [setup.rail]), setup.ground]);
  const parts = [
    ...board.outline,
    ...board.tracks.filter((t) => nets.has(t.net)).map((t) => [t.a, t.b]),
    ...board.pours.filter((p) => nets.has(p.net)).flatMap((p) => p.poured ?? p.outline),
    ...board.pads.filter((p) => nets.has(p.net)).flatMap((p) => p.shape),
  ];
  const b = bbox(parts);
  const pad = 0.5;
  const w = b.maxX - b.minX + 2 * pad;
  const h = b.maxY - b.minY + 2 * pad;
  let cell = opts.cell;
  if (!cell) {
    const layers = new Set<number>();
    for (const t of board.tracks) if (nets.has(t.net)) layers.add(t.layer);
    for (const p of board.pours) if (nets.has(p.net)) layers.add(p.layer);
    const k = Math.max(1, Math.min(layers.size + (board.vias.length ? 1 : 0), 2 * board.stackup.copper.length));
    cell = Math.max(opts.minCell, Math.ceil(Math.sqrt((w * h * k) / opts.maxNodes) * 20) / 20);
  }
  return { x0: b.minX - pad, y0: b.minY - pad, cell, nx: Math.ceil(w / cell), ny: Math.ceil(h / cell) };
}

interface Barrel {
  id: string;
  at: Pt;
  diameter: number;
}

/** Solve both halves of the loop: the rail from the source to the loads, the ground back. */
export function solveDc(board: Board, setup: DcSetup, options: Partial<DcOptions> = {}, run: RunOptions = {}): DcResult {
  return runSync(solveDcSteps(board, setup, options), run);
}

/** Same as solveDc, in time slices that hand control back to the host between slices. */
export function solveDcAsync(board: Board, setup: DcSetup, options: Partial<DcOptions> = {}, run: RunOptions = {}): Promise<DcResult> {
  return runAsync(solveDcSteps(board, setup, options), run);
}

export function* solveDcSteps(board: Board, setup: DcSetup, options: Partial<DcOptions> = {}): Steps<DcResult> {
  const opts = { ...defaultDcOptions, ...options };
  const warnings = [...setup.warnings];
  const thickness = copperThickness(board, opts, warnings);
  const grid = chooseGrid(board, setup, opts);
  yield { phase: 'reference copper', fraction: 0 };
  const refCopper = yield* buildReferenceCopperSteps(board, { clearance: opts.clearance });

  const solveNet = (nets: string[], role: 'supply' | 'return'): Steps<DcNetResult> => {
    const sourcePads = role === 'supply' ? setup.source.railPads : setup.source.groundPads;
    const loads = setup.loads.map((l) => ({ designator: l.designator, current: l.current, pads: role === 'supply' ? l.railPads : l.groundPads }));
    return solveNetField(board, grid, refCopper, thickness, nets, role, sourcePads, loads, opts, role === 'supply' ? setup.bridges ?? [] : []);
  };
  const supply = yield* solveNet(setup.railNets ?? [setup.rail], 'supply');
  const ret = setup.source.groundPads.length ? yield* solveNet([setup.ground], 'return') : undefined;
  for (const r of [supply, ret]) {
    if (!r) continue;
    for (const u of r.unconnected) warnings.push(`${u} has no copper path to ${setup.source.designator} on ${r.net}; left out.`);
    if (r.residual > 1e-6) warnings.push(`${r.net}: solver stopped at relative residual ${r.residual.toExponential(1)} after ${r.iterations} iterations.`);
  }
  return { setup, grid, supply, ret, warnings, thickness };
}

function* solveNetField(
  board: Board,
  g: Grid,
  refCopper: Map<number, LayerCopper>,
  thickness: Map<number, number>,
  nets: string[],
  role: 'supply' | 'return',
  sourcePads: Pad[],
  loads: { designator: string; current: number; pads: Pad[] }[],
  opts: DcOptions,
  bridgeParts: DcBridge[] = [],
): Steps<DcNetResult> {
  const { copper, dielectrics } = board.stackup;
  const L = copper.length;
  const NC = g.nx * g.ny;
  const net = nets.join(' + ');
  const weights: Float32Array[] = [];
  for (const [li, l] of copper.entries()) {
    yield { phase: `raster ${net}`, fraction: li / L };
    const w = rasterNet(board, g, nets[0], l.id, refCopper.get(l.id)?.byNet.get(nets[0]));
    for (const n of nets.slice(1)) {
      const more = rasterNet(board, g, n, l.id, refCopper.get(l.id)?.byNet.get(n));
      for (let c = 0; c < NC; c++) if (more[c] > w[c]) w[c] = more[c];
    }
    weights.push(w);
  }
  yield { phase: `network ${net}` };

  // Node numbering: copper cells of every layer.
  const nodeOf = weights.map(() => new Int32Array(NC).fill(-1));
  const nodeLayer: number[] = [];
  const nodeCell: number[] = [];
  for (let li = 0; li < L; li++)
    for (let c = 0; c < NC; c++)
      if (weights[li][c] > 0) {
        nodeOf[li][c] = nodeLayer.length;
        nodeLayer.push(li);
        nodeCell.push(c);
      }
  const N = nodeLayer.length;

  // Edges.
  const ea: number[] = [];
  const eb: number[] = [];
  const eg: number[] = [];
  const edge = (a: number, b: number, gv: number) => {
    ea.push(a);
    eb.push(b);
    eg.push(gv);
  };
  for (let li = 0; li < L; li++) {
    const w = weights[li];
    const sheet = opts.conductivity * thickness.get(copper[li].id)!;
    for (let j = 0; j < g.ny; j++)
      for (let i = 0; i < g.nx; i++) {
        const c = j * g.nx + i;
        if (!(w[c] > 0)) continue;
        if (i + 1 < g.nx && w[c + 1] > 0) edge(nodeOf[li][c], nodeOf[li][c + 1], (sheet * 2 * w[c] * w[c + 1]) / (w[c] + w[c + 1]));
        if (j + 1 < g.ny && w[c + g.nx] > 0) edge(nodeOf[li][c], nodeOf[li][c + g.nx], (sheet * 2 * w[c] * w[c + g.nx]) / (w[c] + w[c + g.nx]));
      }
  }
  const inPlaneEdges = ea.length;

  const barrels: Barrel[] = [
    ...board.vias.filter((v) => nets.includes(v.net)).map((v) => ({ id: v.id, at: v.at, diameter: v.drill > 0 ? v.drill : v.diameter / 2 })),
    ...board.pads.filter((p) => nets.includes(p.net) && p.layer === MULTI_LAYER && p.holeDiameter > 0).map((p) => ({ id: p.id, at: p.at, diameter: p.holeDiameter })),
  ];
  const barrelEdges: { barrel: number; e: number; upper: number; lower: number }[] = [];
  barrels.forEach((b, bi) => {
    const [i, j] = cellOf(g, b.at);
    if (!inGrid(g, i, j)) return;
    const c = j * g.nx + i;
    const r = b.diameter / 2;
    const ri = Math.max(0, r - opts.platingMm);
    const area = Math.PI * (r * r - ri * ri);
    let prev = -1;
    for (let li = 0; li < L; li++) {
      if (nodeOf[li][c] < 0) continue;
      if (prev >= 0) {
        const dz = copper[li].z - copper[prev].z + (thickness.get(copper[li].id)! + thickness.get(copper[prev].id)!) / 2;
        barrelEdges.push({ barrel: bi, e: ea.length, upper: prev, lower: li });
        edge(nodeOf[prev][c], nodeOf[li][c], (opts.conductivity * area) / Math.max(dz, dielectrics[prev]?.thicknessMm ?? 0.1, 1e-3));
      }
      prev = li;
    }
  });

  // Terminals.
  const layerIdx = new Map(copper.map((l, i) => [l.id, i]));
  const terminalCells = (pads: Pad[]): Map<number, number[]> => {
    const out = new Map<number, number[]>();
    for (const p of pads) {
      const layers = p.layer === MULTI_LAYER ? copper.map((_, i) => i) : [layerIdx.get(p.layer)].filter((x): x is number => x !== undefined);
      const cells = padCells(g, p.shape, p.at);
      for (const li of layers) {
        const own = cells.filter((c) => nodeOf[li][c] >= 0);
        if (!own.length) continue;
        const id = copper[li].id;
        out.set(id, [...(out.get(id) ?? []), ...own]);
      }
    }
    return out;
  };
  // A part joining two nets of the rail: a short from the pads on one net to those on the next.
  const bridges: DcNetResult['bridges'] = [];
  for (const bp of bridgeParts) {
    const sides = [...new Set(bp.pads.map((p) => p.net))].map((n) => {
      const pads = bp.pads.filter((p) => p.net === n);
      const at = { x: pads.reduce((sum, p) => sum + p.at.x, 0) / pads.length, y: pads.reduce((sum, p) => sum + p.at.y, 0) / pads.length };
      return { net: n, at, cells: terminalCells(pads) };
    });
    const nodeOfSide = (side: (typeof sides)[number]) => {
      for (const [layer, cs] of side.cells) for (const c of cs) return nodeOf[layerIdx.get(layer)!][c];
      return -1;
    };
    const ends = sides.map(nodeOfSide);
    if (ends.filter((n) => n >= 0).length < 2) continue;
    for (let k = 1; k < ends.length; k++) if (ends[0] >= 0 && ends[k] >= 0) edge(ends[0], ends[k], BRIDGE_S);
    bridges.push({ designator: bp.designator, sides });
  }

  const fixed = new Uint8Array(N);
  const sourceCells = new Map<number, Set<number>>();
  for (const [layer, cells] of terminalCells(sourcePads)) {
    sourceCells.set(layer, new Set(cells));
    for (const c of cells) fixed[nodeOf[layerIdx.get(layer)!][c]] = 1;
  }

  // Adjacency (CSR).
  const deg = new Int32Array(N + 1);
  for (let e = 0; e < ea.length; e++) {
    deg[ea[e] + 1]++;
    deg[eb[e] + 1]++;
  }
  for (let n = 0; n < N; n++) deg[n + 1] += deg[n];
  const nbr = new Int32Array(deg[N]);
  const ng = new Float64Array(deg[N]);
  const fillPos = deg.slice(0, N);
  for (let e = 0; e < ea.length; e++) {
    nbr[fillPos[ea[e]]] = eb[e];
    ng[fillPos[ea[e]]++] = eg[e];
    nbr[fillPos[eb[e]]] = ea[e];
    ng[fillPos[eb[e]]++] = eg[e];
  }

  // Reachability from the source.
  const reach = new Uint8Array(N);
  const stack: number[] = [];
  for (let n = 0; n < N; n++) if (fixed[n]) {
    reach[n] = 1;
    stack.push(n);
  }
  while (stack.length) {
    const n = stack.pop()!;
    for (let k = deg[n]; k < deg[n + 1]; k++) if (!reach[nbr[k]]) {
      reach[nbr[k]] = 1;
      stack.push(nbr[k]);
    }
  }

  // Right-hand side: current injected into the net, A. The rail delivers current out at the loads,
  // the ground takes it in at the loads.
  const b = new Float64Array(N);
  const sign = role === 'supply' ? -1 : 1;
  const unconnected: string[] = [];
  const loadCells: DcNetResult['loadCells'] = [];
  /** Each load's own injection, kept so its current can be solved on its own. */
  const injected: { designator: string; nodes: number[]; share: number }[] = [];
  for (const ld of loads) {
    const cells = terminalCells(ld.pads);
    loadCells.push({ designator: ld.designator, current: ld.current, cells });
    const nodes: number[] = [];
    for (const [layer, cs] of cells) for (const c of cs) {
      const n = nodeOf[layerIdx.get(layer)!][c];
      if (reach[n] && !fixed[n]) nodes.push(n);
    }
    if (!nodes.length) {
      if (ld.pads.length && ld.current > 0) unconnected.push(ld.designator);
      continue;
    }
    const share = (sign * ld.current) / nodes.length;
    injected.push({ designator: ld.designator, nodes, share });
    for (const n of nodes) b[n] += share;
  }

  // Jacobi-preconditioned CG on the reachable, non-fixed nodes (fixed nodes are 0 V).
  const active = new Uint8Array(N);
  const diag = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    if (!reach[n] || fixed[n]) continue;
    active[n] = 1;
    let d = 0;
    for (let k = deg[n]; k < deg[n + 1]; k++) d += ng[k];
    diag[n] = d;
  }
  const apply = (src: Float64Array, dst: Float64Array) => {
    for (let n = 0; n < N; n++) {
      if (!active[n]) continue;
      let s = diag[n] * src[n];
      for (let k = deg[n]; k < deg[n + 1]; k++) {
        const m = nbr[k];
        if (active[m]) s -= ng[k] * src[m];
      }
      dst[n] = s;
    }
  };
  function* runCg(rhs: Float64Array, from: number, to: number): Steps<{ x: Float64Array; it: number; res: number }> {
    const x = new Float64Array(N);
    const r = new Float64Array(N);
    const z = new Float64Array(N);
    const pv = new Float64Array(N);
    const q = new Float64Array(N);
    let bnorm = 0;
    for (let n = 0; n < N; n++) if (active[n]) {
      r[n] = rhs[n];
      bnorm += rhs[n] * rhs[n];
    }
    bnorm = Math.sqrt(bnorm);
    let rz = 0;
    for (let n = 0; n < N; n++) if (active[n]) {
      z[n] = r[n] / diag[n];
      pv[n] = z[n];
      rz += r[n] * z[n];
    }
    let it = 0;
    let res = bnorm ? 1 : 0;
    const logTol = Math.log(opts.tolerance);
    while (bnorm && it < opts.maxIterations) {
      const done = Math.min(1, Math.max(0, Math.log(Math.max(res, 1e-300)) / logTol));
      yield { phase: `solve ${net}`, fraction: from + (to - from) * done };
      apply(pv, q);
      let pq = 0;
      for (let n = 0; n < N; n++) if (active[n]) pq += pv[n] * q[n];
      const alpha = rz / pq;
      let rr = 0;
      for (let n = 0; n < N; n++) if (active[n]) {
        x[n] += alpha * pv[n];
        r[n] -= alpha * q[n];
        rr += r[n] * r[n];
      }
      it++;
      res = Math.sqrt(rr) / bnorm;
      if (res < opts.tolerance) break;
      let rzNew = 0;
      for (let n = 0; n < N; n++) if (active[n]) {
        z[n] = r[n] / diag[n];
        rzNew += r[n] * z[n];
      }
      const beta = rzNew / rz;
      rz = rzNew;
      for (let n = 0; n < N; n++) if (active[n]) pv[n] = z[n] + beta * pv[n];
    }
    return { x, it, res };
  }

  /** Voltages, current density and via current for one solved right-hand side. */
  function fieldsOf(x: Float64Array): { layers: DcLayerField[]; vias: ViaFlow[]; drop: number; bottleneck: DcNetResult['bottleneck']; fullScale: number } {
    const layers: DcLayerField[] = copper.map((l, li) => ({
      layer: l.id,
      weight: weights[li],
      v: new Float64Array(NC).fill(NaN),
      jx: new Float32Array(NC),
      jy: new Float32Array(NC),
      j: new Float32Array(NC),
      flow: 0,
    }));
    let drop = 0;
    for (let n = 0; n < N; n++) {
      if (!reach[n]) continue;
      layers[nodeLayer[n]].v[nodeCell[n]] = x[n];
      drop = Math.max(drop, Math.abs(x[n]));
    }
    const sx = new Float64Array(L * NC);
    const sy = new Float64Array(L * NC);
    const cx = new Uint8Array(L * NC);
    const cy = new Uint8Array(L * NC);
    for (let e = 0; e < inPlaneEdges; e++) {
      const a = ea[e];
      const bn = eb[e];
      if (!reach[a]) continue;
      const I = eg[e] * (x[a] - x[bn]);
      const li = nodeLayer[a];
      const horizontal = nodeCell[bn] - nodeCell[a] === 1;
      for (const c of [nodeCell[a], nodeCell[bn]]) {
        const k = li * NC + c;
        if (horizontal) {
          sx[k] += I;
          cx[k]++;
        } else {
          sy[k] += I;
          cy[k]++;
        }
      }
    }
    for (let li = 0; li < L; li++) {
      const f = layers[li];
      for (let c = 0; c < NC; c++) {
        const w = f.weight[c];
        if (!(w > 0)) continue;
        const k = li * NC + c;
        const jx = cx[k] ? sx[k] / cx[k] / (g.cell * w) : 0;
        const jy = cy[k] ? sy[k] / cy[k] / (g.cell * w) : 0;
        f.jx[c] = jx;
        f.jy[c] = jy;
        f.j[c] = Math.hypot(jx, jy);
        f.flow += f.j[c] * w * g.cell * g.cell;
      }
    }
    const vias: ViaFlow[] = barrels.map((br) => {
      const [i, j] = cellOf(g, br.at);
      return { id: br.id, at: br.at, cell: inGrid(g, i, j) ? j * g.nx + i : -1, current: 0, delivered: new Map<number, number>() };
    });
    for (const be of barrelEdges) {
      const I = eg[be.e] * (x[ea[be.e]] - x[eb[be.e]]);
      const v = vias[be.barrel];
      v.current = Math.max(v.current, Math.abs(I));
      const up = copper[be.upper].id;
      const lo = copper[be.lower].id;
      v.delivered.set(lo, (v.delivered.get(lo) ?? 0) + I);
      v.delivered.set(up, (v.delivered.get(up) ?? 0) - I);
    }
    // Bottleneck: densest copper away from terminal pads and vias (their entry crowding is expected).
    const exclude = layers.map(() => new Uint8Array(NC));
    const guard = 2;
    const markAround = (li: number, c: number) => {
      const ci = c % g.nx;
      const cj = (c - ci) / g.nx;
      for (let dj = -guard; dj <= guard; dj++)
        for (let di = -guard; di <= guard; di++) if (inGrid(g, ci + di, cj + dj)) exclude[li][(cj + dj) * g.nx + ci + di] = 1;
    };
    for (const [layer, cells] of sourceCells) for (const c of cells) markAround(layerIdx.get(layer)!, c);
    for (const lc of loadCells) for (const [layer, cells] of lc.cells) for (const c of cells) markAround(layerIdx.get(layer)!, c);
    for (const v of vias) if (v.cell >= 0) for (let li = 0; li < L; li++) markAround(li, v.cell);
    for (const br of bridges) for (const side of br.sides) for (const [layer, cells] of side.cells) for (const c of cells) markAround(layerIdx.get(layer)!, c);
    let bottleneck: DcNetResult['bottleneck'];
    let maxAny = 0;
    for (let li = 0; li < L; li++) {
      const f = layers[li];
      for (let c = 0; c < NC; c++) {
        const jv = f.j[c];
        if (jv > maxAny) maxAny = jv;
        if (exclude[li][c] || !(jv > (f.peak?.j ?? 0))) continue;
        const ci = c % g.nx;
        // Partly covered cells at copper edges give noisy J; keep them only as the core of a thin track.
        const w = f.weight[c];
        if (w < 0.5 && [c - 1, c + 1, c - g.nx, c + g.nx].some((k) => k >= 0 && k < NC && f.weight[k] > w)) continue;
        f.peak = { at: cellCentre(g, ci, (c - ci) / g.nx), j: jv };
      }
      if (f.peak && f.peak.j > (bottleneck?.j ?? 0)) bottleneck = { layer: f.layer, ...f.peak };
    }
    return { layers, vias, drop, bottleneck, fullScale: bottleneck?.j || maxAny || 1 };
  }

  // The combined field gives the drop and the bottleneck. Each load is also solved alone: a streamline
  // of the combined field follows the sum of every load's current, so one load's line bends towards the
  // others even across an unbroken pour.
  const live = injected.filter((i) => i.share !== 0);
  const separate = live.length > 1;
  const total = yield* runCg(b, 0, separate ? 1 / (1 + live.length) : 1);
  const built = fieldsOf(total.x);
  if (separate) {
    for (let k = 0; k < live.length; k++) {
      const inj = live[k];
      const rhs = new Float64Array(N);
      for (const n of inj.nodes) rhs[n] = inj.share;
      const one = yield* runCg(rhs, (1 + k) / (1 + live.length), (2 + k) / (1 + live.length));
      const own = fieldsOf(one.x);
      const lc = loadCells.find((l) => l.designator === inj.designator);
      if (lc) lc.own = { layers: own.layers, vias: own.vias, fullScale: own.fullScale };
    }
  }

  return {
    net,
    role,
    layers: built.layers,
    vias: built.vias,
    sourceCells,
    loadCells,
    bottleneck: built.bottleneck,
    fullScale: built.fullScale,
    drop: built.drop,
    unconnected,
    bridges,
    nodes: N,
    iterations: total.it,
    residual: total.res,
  };
}
