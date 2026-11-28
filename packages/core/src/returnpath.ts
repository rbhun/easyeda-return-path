// The high-frequency return path as drawable geometry: one line, the least loop area between the
// signal and the ground copper. It follows the trace (that costs almost nothing) and leaves it only
// to go round copper it cannot cross. It changes layer only at a ground via that touches ground on
// both layers. The line is the raster path, drawn straight, with no spline.
import type { ChainResult, Finding, ReturnRoute, Severity, ViaResult } from './analyze.js';
import { isGroundNet, returnPads } from './dc/rails.js';
import { driverLoop, isPassive, type DriverLoop } from './driver.js';
import { add, dist, distToPaths, len, mul, Polyline, sub } from './geom.js';
import type { Steps } from './budget.js';
import { solveReturnCost } from './returncost.js';
import type { LayerCopper } from './refcopper.js';
import { MULTI_LAYER, type Board, type Pad, type Path, type Pt } from './types.js';

export interface ReturnTrace {
  /** Reference layer the current runs on. */
  layer: number;
  /** Layer of the signal trace whose return this is. */
  signalLayer: number;
  pts: Path;
  /** Part of a detour around a slot. */
  detour?: boolean;
}

/** `supply`: the driver's other edge, from its reference-net pin through the decap to its supply pin. */
export type ReturnJumpKind = 'via' | 'decap' | 'bridge' | 'pin' | 'supply';

export interface ReturnJump {
  kind: ReturnJumpKind;
  from: Pt;
  to: Pt;
  label: string;
  distance: number;
  severity: Severity;
}

/** A small cut drawn back on the trace, or a detour large enough to flag. */
export interface ReturnMark {
  at: Pt;
  kind: 'minor' | 'flagged';
  /** Extra enclosed area, mm². */
  area: number;
}

/** The return changed layer at a ground via. */
export interface ReturnVia {
  at: Pt;
  fromLayer: number;
  toLayer: number;
  /** Lateral distance from the signal, mm. */
  distance: number;
}

export interface ReturnPath {
  traces: ReturnTrace[];
  jumps: ReturnJump[];
  /** Driver-side loop closure for each driver that was chosen or guessed. */
  drivers: DriverLoop[];
  /** Minor cuts and flagged detours. */
  marks: ReturnMark[];
  /** Layer changes of the solved return, with how far the via sits from the signal. */
  transitions: ReturnVia[];
  /** Drawn length, mm. */
  length: number;
  /** Ground via the solved return leaves the reference through. */
  closureAt?: Pt;
}

export interface DriverOptions {
  /** Designators of the parts that drive the net; none means only the per-end pins are drawn. */
  drivers?: string[];
  /** Driver pin → decap → driver pin path length, mm. */
  driverDecap: { good: number; warn: number };
  /** Widest trace-edge-to-pour gap a coplanar return is drawn across, mm. */
  maxCoplanarGap: number;
  /** Raster pitch of the return solve, mm. */
  returnGridMm: number;
  /** Dielectric height for the loop-area cost, mm. 0: the stackup, else 1.6 mm. */
  returnHeightMm: number;
  /** Length penalty in the return cost (added to d/h). */
  returnEps: number;
}

/** Copper lookups on the board's reference copper (see analyze.ts Context). */
export interface CopperProbe {
  /** Net of the reference copper at p on a layer, optionally ignoring one net. */
  netAt(p: Pt, layer: number, exclude?: string): string | null;
  /** p lies on a conductor the return cannot flow through (a track, pad or via of a net without a pour there). */
  blockedAt(p: Pt, layer: number): boolean;
  /** Gap from the trace edge to the first pour copper of another net along n, unless another conductor comes first. */
  pourBeside(p: Pt, n: Pt, halfWidth: number, layer: number, net: string, maxGap: number, ownBlocks?: boolean): { d: number; net: string } | null;
  /** The chain's return from a to b in `net` copper: round through it or through vias, whichever adds less loop inductance. */
  returnRoute(c: ChainResult, net: string, a: Pt, b: Pt): ReturnRoute | null;
  /** Path from a to b through `net` copper on a layer, around every hole, or null. */
  copperPath(layer: number, net: string, a: Pt, b: Pt): Path | null;
}

const unitNormal = (a: Pt, b: Pt): Pt => {
  const d = sub(b, a);
  const l = len(d) || 1;
  return { x: -d.y / l, y: d.x / l };
};

/** How far a chain end may sit from a pad and still be that pad. Measured to the copper, so a track that stops on the pad edge matches. */
const PAD_SNAP_MM = 0.4;

function padGap(pd: Pad, p: Pt): number {
  return pd.shape.length ? distToPaths(p, pd.shape) : dist(pd.at, p);
}

function padAt(board: Board, p: Pt, net: string, layer: number): Pad | undefined {
  let best: Pad | undefined;
  let gap = PAD_SNAP_MM;
  for (const pd of board.pads) {
    if (pd.net !== net || (pd.layer !== layer && pd.layer !== MULTI_LAYER)) continue;
    const g = padGap(pd, p);
    if (g > PAD_SNAP_MM) continue;
    if (!best || g < gap - 1e-6 || (Math.abs(g - gap) <= 1e-6 && dist(pd.at, p) < dist(best.at, p))) {
      best = pd;
      gap = g;
    }
  }
  return best;
}

/**
 * Builds the return path from the per-chain results. Also adds one finding per net end, naming
 * the pin where the return leaves the reference copper (or saying the part has none), and one per
 * driver for the edge that has to cross to the other supply net through a decap.
 */
export function* buildReturnPath(board: Board, net: string, chains: ChainResult[], vias: ViaResult[], probe: CopperProbe, findings: Finding[], opts: DriverOptions, refCopper: Map<number, LayerCopper>): Steps<ReturnPath> {
  const traces: ReturnTrace[] = [];
  const jumps: ReturnJump[] = [];
  const trackById = new Map(board.tracks.map((t) => [t.id, t]));
  const ownVias = board.vias.filter((v) => v.net === net);

  // Loop closure: where the trace ends on (or passes through) a part's pad, the return leaves the reference copper
  // through that part's pin on the reference net (ground, or the supply for a VCC-referenced trace).
  const seen = new Set<string>();
  const endNets = new Map<string, string>();
  const pinOf = new Map<string, Pad | null>();
  /** Per chain, the pins its return leaves the copper through: at an end (s = 0 or its length) or where it passes through a pad. */
  const closures = new Map<ChainResult, { s: number; pin: Pad }[]>();
  const close = (c: ChainResult, s: number, pin: Pad) => closures.set(c, [...(closures.get(c) ?? []), { s, pin }]);
  for (const c of chains) {
    if (!c.ref) continue;
    const L = new Polyline(c.chain.pts).length;
    const ends: [Pt, Pt, Pad | undefined, number][] = [
      [c.chain.pts[0], c.chain.pts[1], undefined, 0],
      [c.chain.pts[c.chain.pts.length - 1], c.chain.pts[c.chain.pts.length - 2], undefined, L],
    ];
    // A part the trace passes through on the way (a connector pin with a pull-up beyond it) closes the loop there too.
    const line = new Polyline(c.chain.pts);
    for (const pd of board.pads) {
      if (pd.net !== net || !pd.componentId || (pd.layer !== c.chain.layer && pd.layer !== MULTI_LAYER)) continue;
      const s = line.project(pd.at);
      if (s < 0.05 || s > line.length - 0.05 || padGap(pd, line.at(s)) > PAD_SNAP_MM) continue;
      const comp = board.components.find((x) => x.id === pd.componentId);
      if (!comp || isPassive(comp)) continue;
      ends.push([line.at(s), line.at(s < line.length / 2 ? Math.min(line.length, s + 1) : Math.max(0, s - 1)), pd, s]);
    }
    for (const [end, inward, onPad, at] of ends) {
      const pad = onPad ?? padAt(board, end, net, c.chain.layer);
      if (!onPad && !pad && ownVias.some((v) => dist(v.at, end) <= v.diameter / 2 + 0.01)) continue;
      if (!pad?.componentId) continue;
      if (seen.has(pad.id)) {
        const pin = pinOf.get(pad.id);
        if (pin) close(c, at, pin);
        continue;
      }
      seen.add(pad.id);
      const comp = board.components.find((x) => x.id === pad.componentId);
      // Single-pad parts are test points or labels: the net just ends there.
      if (!comp || comp.padIds.length < 2) continue;
      // The reference net under the trace just before it reaches the pad (the pad's own antipad hides it at the pad).
      const step = Math.min(dist(end, inward), Math.max(0.5, 3 * c.ref.h));
      const probeAt = add(end, mul(sub(inward, end), step / (dist(end, inward) || 1)));
      const coplanar = c.ref.coplanar;
      const halfWidth = (trackById.get(c.chain.trackIds[0])?.width ?? 0.2) / 2;
      const sides = coplanar ? [1, -1].map((k) => add(probeAt, mul(unitNormal(end, inward), k * (halfWidth + 1.5 * c.ref!.h + 0.05)))) : [probeAt];
      const endNet = sides.map((p) => probe.netAt(p, c.ref!.layer, coplanar ? net : undefined)).find(Boolean) ?? c.refNets[0] ?? null;
      const candidates = board.pads.filter((p) => p.componentId === comp.id && p.id !== pad.id && p.net && (p.net === endNet || (!endNet && c.refNets.includes(p.net))));
      // The same pins as the DC return: GND, EP, −Vo, or a pin with VSS in its name. An enable or
      // address pin tied to that net (SD, EN, A0) does not take the return. With no such name,
      // every pad on the net counts, including a header pin whose name is only its number.
      const named = endNet && isGroundNet(endNet) ? returnPads(candidates, endNet) : { pads: candidates, tied: [] as Pad[] };
      const pin = [...named.pads].sort((a, b) => dist(a.at, pad.at) - dist(b.at, pad.at))[0];
      const where = `${comp.designator} pad ${pad.number}`;
      if (endNet && !endNets.has(comp.designator)) endNets.set(comp.designator, endNet);
      pinOf.set(pad.id, pin ?? null);
      if (pin) {
        close(c, at, pin);
        const d = dist(pin.at, pad.at);
        // A dot on the ground pin. The return line itself is the solved path, not a chord across the part.
        jumps.push({ kind: 'pin', from: pin.at, to: pin.at, label: `${comp.designator}.${pin.number}`, distance: d, severity: 'ok' });
        const tied = named.tied.map((p) => p.pinName || `pad ${p.number}`);
        const aside = tied.length ? `; ${tied.join(', ')} ${tied.length > 1 ? 'are' : 'is'} tied to ${pin.net} but ${tied.length > 1 ? 'do' : 'does'} not take the return` : '';
        findings.push({ severity: 'ok', kind: 'loop-closure', message: `${where}: the return leaves ${pin.net} copper through ${comp.designator} pad ${pin.number} (${pin.net}), ${d.toFixed(2)} mm from the signal pad${aside}`, at: pad.at });
      } else if (isPassive(comp) || /^[XY]\d/i.test(comp.designator)) {
        findings.push({ severity: 'ok', kind: 'loop-closure', message: `${where}: the signal continues through ${comp.designator} onto another net, and its return goes on with it (not traced past ${comp.designator})`, at: pad.at });
      } else {
        findings.push({ severity: 'warn', kind: 'loop-closure', message: `${where}: ${comp.designator} has no pad on ${endNet ?? 'the reference net'}, so the return path cannot close at this end`, at: pad.at });
      }
    }
  }

  const solved = yield* solveReturnCost(board, net, refCopper, {
    gridMm: opts.returnGridMm,
    heightMm: opts.returnHeightMm,
    eps: opts.returnEps,
    drivers: opts.drivers,
  });
  const marks = solved?.marks ?? [];
  const transitions = solved?.vias ?? [];
  if (solved) {
    traces.push(...solved.traces);
    for (const note of solved.notes) findings.push(note);
  } else findings.push({ severity: 'error', kind: 'return-path', message: `${net}: the ground copper does not join the two ends, so no return is drawn`, at: chains[0]?.chain.pts[0] ?? { x: 0, y: 0 } });


  const drivers: DriverLoop[] = [];
  for (const d of opts.drivers ?? []) {
    const refNet = endNets.get(d);
    if (!refNet) {
      findings.push({ severity: 'ok', kind: 'driver-loop', message: `${d} (driver): supply loop unknown`, at: chains[0]?.chain.pts[0] ?? { x: 0, y: 0 } });
      continue;
    }
    const loop = driverLoop(board, d, net, refNet);
    if (!loop?.refPin) continue;
    drivers.push(loop);
    const toGround = isGroundNet(refNet);
    const [direct, other] = toGround ? ['falling', 'rising'] : ['rising', 'falling'];
    const at = loop.signalPad.at;
    const first = `${d} (driver): the ${direct} edge returns into ${d} pad ${loop.refPin.number} (${refNet})`;
    if (!loop.supplyPin) {
      findings.push({ severity: 'warn', kind: 'driver-loop', message: `${first}; ${d} has no ${toGround ? 'supply' : 'ground'} pin on this board, so the ${other}-edge return is not traced`, at });
      continue;
    }
    const supplyNet = loop.supplyPin.net;
    if (!loop.decap) {
      findings.push({ severity: 'error', kind: 'driver-loop', message: `${first}; the ${other} edge must reach ${d} pad ${loop.supplyPin.number} (${supplyNet}), but no decap between ${refNet} and ${supplyNet} was found`, at });
      continue;
    }
    const { component, refPad, supplyPad } = loop.decap;
    const netMm = chains.reduce((s, c) => s + new Polyline(c.chain.pts).length, 0);
    const supplyMm = dist(loop.supplyPin.at, supplyPad.at);
    const frac = netMm > 0 ? supplyMm / netMm : Infinity;
    const severity: Severity = frac > 0.5 ? 'error' : frac > 0.25 ? 'warn' : 'ok';
    jumps.push({ kind: 'supply', from: loop.refPin.at, to: refPad.at, label: component.designator, distance: dist(loop.refPin.at, refPad.at), severity });
    jumps.push({ kind: 'supply', from: supplyPad.at, to: loop.supplyPin.at, label: component.designator, distance: supplyMm, severity });
    findings.push({ severity, kind: 'driver-loop', message: `${first}; the ${other} edge through decap ${component.designator} into ${d} pad ${loop.supplyPin.number} (${supplyNet}), ${supplyMm.toFixed(2)} mm from the supply pin`, at });
  }
  return { traces, jumps, drivers, marks, transitions, length: solved?.length ?? 0, ...(solved?.closureAt ? { closureAt: solved.closureAt } : {}) };
}
