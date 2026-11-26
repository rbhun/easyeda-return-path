// The high-frequency return path as drawable geometry (D7): where the image current runs on each
// reference layer, and the hops it makes off the plane (bridging caps, return vias, decaps, and the
// IC ground pins that close the loop at the ends of the net).
import type { ChainResult, Finding, Severity, ViaResult } from './analyze.js';
import { isGroundNet } from './dc/rails.js';
import { driverLoop, isPassive, type DriverLoop } from './driver.js';
import { add, dist, distPointSeg, distToPaths, len, mul, Polyline, sub } from './geom.js';
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

export interface ReturnPath {
  traces: ReturnTrace[];
  jumps: ReturnJump[];
  /** Driver-side loop closure for each driver that was chosen or guessed. */
  drivers: DriverLoop[];
}

export interface DriverOptions {
  /** Designators of the parts that drive the net; none means only the per-end pins are drawn. */
  drivers?: string[];
  /** Driver pin → decap → driver pin path length, mm. */
  driverDecap: { good: number; warn: number };
}

/** Net of the reference copper at p on a layer, optionally ignoring one net. */
export type NetAt = (p: Pt, layer: number, exclude?: string) => string | null;

const unitNormal = (a: Pt, b: Pt): Pt => {
  const d = sub(b, a);
  const l = len(d) || 1;
  return { x: -d.y / l, y: d.x / l };
};

/** Drops points that lie on the straight line through their neighbours. */
function straighten(path: Path): Path {
  const out: Path = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const [a, b, c] = [out[out.length - 1], path[i], path[i + 1]];
    if (Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) > 1e-4 * dist(a, c)) out.push(b);
  }
  out.push(path[path.length - 1]);
  return out;
}

function padAt(board: Board, p: Pt, net: string, layer: number): Pad | undefined {
  return board.pads.find((pd) => pd.net === net && (pd.layer === layer || pd.layer === MULTI_LAYER) && (dist(pd.at, p) < 0.05 || distToPaths(p, pd.shape) < 0.05));
}

/**
 * Builds the return path from the per-chain results. Also adds one finding per net end, naming
 * the pin where the return leaves the reference copper (or saying the part has none), and one per
 * driver for the edge that has to cross to the other supply net through a decap.
 */
export function buildReturnPath(board: Board, net: string, chains: ChainResult[], vias: ViaResult[], netAt: NetAt, findings: Finding[], opts: DriverOptions): ReturnPath {
  const traces: ReturnTrace[] = [];
  const jumps: ReturnJump[] = [];
  const trackById = new Map(board.tracks.map((t) => [t.id, t]));
  const ownVias = board.vias.filter((v) => v.net === net);

  for (const c of chains) {
    const ref = c.ref;
    if (!ref) continue;
    const line = new Polyline(c.chain.pts);
    const L = line.length;
    const halfWidth = (trackById.get(c.chain.trackIds[0])?.width ?? 0.2) / 2;
    const breaks = c.gaps.filter((g) => g.kind !== 'via-antipad').sort((a, b) => a.s0 - b.s0);
    const exclude = ref.coplanar ? net : undefined;
    const push = (s0: number, s1: number) => {
      if (s1 - s0 < 1e-6) return;
      const centre = line.slice(s0, s1);
      if (!ref.coplanar) {
        traces.push({ layer: ref.layer, signalLayer: c.chain.layer, pts: centre });
        return;
      }
      // Coplanar return crowds the pour edges on either side of the trace, along the stretches with pour
      // on that side within the band (a meander's pour clearance is wider than the gap elsewhere). The
      // edge is sampled rather than offset as a polyline, which would fold back inside tight bends.
      const o = halfWidth + ref.h;
      const reach = halfWidth + 4.25 * ref.h + 0.05;
      const k = Math.max(1, Math.ceil((s1 - s0) / 0.1));
      for (const side of [1, -1]) {
        let run: Path = [];
        const flush = () => {
          if (run.length > 1 && dist(run[0], run[run.length - 1]) > 0.3) traces.push({ layer: ref.layer, signalLayer: c.chain.layer, pts: straighten(run) });
          run = [];
        };
        for (let i = 0; i <= k; i++) {
          const at = s0 + ((s1 - s0) * i) / k;
          const p = line.at(at);
          const n = unitNormal({ x: 0, y: 0 }, line.dirAt(at));
          // Other legs of the same trace nearby: the edge point must stay clear of them, and they block the pour behind them.
          const near: [Pt, Pt][] = [];
          for (let j = 1; j < line.pts.length; j++)
            if (line.cum[j] > at - 2 * reach && line.cum[j - 1] < at + 2 * reach && (line.cum[j] < at - 1e-9 || line.cum[j - 1] > at + 1e-9)) near.push([line.pts[j - 1], line.pts[j]]);
          const q = add(p, mul(n, side * o));
          let ok = near.every(([a, b]) => distPointSeg(q, a, b) >= 0.9 * o);
          if (ok) {
            ok = false;
            for (let d = halfWidth + 0.05; d <= reach && !ok; d += 0.05) {
              const r = add(p, mul(n, side * d));
              if (d > 2 * halfWidth && near.some(([a, b]) => distPointSeg(r, a, b) < halfWidth)) break;
              ok = !!netAt(r, ref.layer, exclude);
            }
          }
          if (ok) run.push(q);
          else flush();
        }
        flush();
      }
    };
    let s = 0;
    for (const g of breaks) {
      push(s, g.s0);
      s = g.s1;
      if (g.detour) traces.push({ layer: ref.layer, signalLayer: c.chain.layer, pts: g.detour.path, detour: true });
      else if (g.bridge) {
        const b = g.bridge;
        const label = b.component.designator;
        jumps.push({ kind: 'bridge', from: g.a, to: b.at, label, distance: b.distance, severity: b.severity });
        jumps.push({ kind: 'bridge', from: b.at, to: g.b, label, distance: dist(b.at, g.b), severity: b.severity });
      }
    }
    push(s, L);
  }

  // Where the return moves between a pour beside the trace and the plane below, it goes through a via.
  for (const c of chains)
    if (c.chain.cut?.[0] && c.chain.cutVia) {
      const v = c.chain.cutVia;
      jumps.push({ kind: 'via', from: c.chain.pts[0], to: v.at, label: `${v.net} via`, distance: dist(c.chain.pts[0], v.at), severity: 'ok' });
    }

  for (const v of vias)
    for (const t of v.transitions)
      if (t.target && t.distance !== undefined)
        jumps.push({ kind: t.kind === 'decap' ? 'decap' : 'via', from: v.via.at, to: t.target.at, label: t.target.label, distance: t.distance, severity: t.severity });

  // Loop closure: where the trace ends on a part's pad, the return leaves the reference copper
  // through that part's pin on the reference net (ground, or the supply for a VCC-referenced trace).
  const seen = new Set<string>();
  const endNets = new Map<string, string>();
  for (const c of chains) {
    if (!c.ref) continue;
    const ends: [Pt, Pt][] = [
      [c.chain.pts[0], c.chain.pts[1]],
      [c.chain.pts[c.chain.pts.length - 1], c.chain.pts[c.chain.pts.length - 2]],
    ];
    for (const [end, inward] of ends) {
      if (ownVias.some((v) => dist(v.at, end) <= v.diameter / 2 + 0.01)) continue;
      const pad = padAt(board, end, net, c.chain.layer);
      if (!pad?.componentId || seen.has(pad.id)) continue;
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
      const endNet = sides.map((p) => netAt(p, c.ref!.layer, coplanar ? net : undefined)).find(Boolean) ?? c.refNets[0] ?? null;
      const candidates = board.pads.filter((p) => p.componentId === comp.id && p.id !== pad.id && p.net && (p.net === endNet || (!endNet && c.refNets.includes(p.net))));
      const pin = candidates.sort((a, b) => dist(a.at, pad.at) - dist(b.at, pad.at))[0];
      const where = `${comp.designator} pad ${pad.number}`;
      if (endNet && !endNets.has(comp.designator)) endNets.set(comp.designator, endNet);
      if (pin) {
        const d = dist(pin.at, pad.at);
        jumps.push({ kind: 'pin', from: pad.at, to: pin.at, label: `${comp.designator}.${pin.number}`, distance: d, severity: 'ok' });
        findings.push({ severity: 'ok', kind: 'loop-closure', message: `${where}: the return leaves ${pin.net} copper through ${comp.designator} pad ${pin.number} (${pin.net}), ${d.toFixed(2)} mm from the signal pad`, at: pad.at });
      } else if (isPassive(comp) || /^[XY]\d/i.test(comp.designator)) {
        findings.push({ severity: 'ok', kind: 'loop-closure', message: `${where}: the signal continues through ${comp.designator} onto another net, and its return goes on with it (not traced past ${comp.designator})`, at: pad.at });
      } else {
        findings.push({ severity: 'warn', kind: 'loop-closure', message: `${where}: ${comp.designator} has no pad on ${endNet ?? 'the reference net'}, so the return path cannot close at this end`, at: pad.at });
      }
    }
  }

  const drivers: DriverLoop[] = [];
  for (const d of opts.drivers ?? []) {
    const refNet = endNets.get(d);
    if (!refNet) {
      findings.push({ severity: 'warn', kind: 'driver-loop', message: `${d} (driver): not at an end of the routed trace over reference copper, so its supply loop is not traced`, at: chains[0]?.chain.pts[0] ?? { x: 0, y: 0 } });
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
    const { component, refPad, supplyPad, length } = loop.decap;
    const t = opts.driverDecap;
    const severity: Severity = length <= t.good ? 'ok' : length <= t.warn ? 'warn' : 'error';
    jumps.push({ kind: 'supply', from: loop.refPin.at, to: refPad.at, label: component.designator, distance: dist(loop.refPin.at, refPad.at), severity });
    jumps.push({ kind: 'supply', from: supplyPad.at, to: loop.supplyPin.at, label: component.designator, distance: dist(supplyPad.at, loop.supplyPin.at), severity });
    findings.push({ severity, kind: 'driver-loop', message: `${first}; the ${other} edge through decap ${component.designator} into ${d} pad ${loop.supplyPin.number} (${supplyNet}), ${length.toFixed(2)} mm pin to cap to pin`, at });
  }
  return { traces, jumps, drivers };
}
