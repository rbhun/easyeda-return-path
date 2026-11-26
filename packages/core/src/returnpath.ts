// The high-frequency return path as drawable geometry (D7): where the image current runs on each
// reference layer, and the hops it makes off the plane (bridging caps, return vias, decaps, and the
// IC ground pins that close the loop at the ends of the net).
import type { ChainResult, Finding, ReturnRoute, Severity, ViaResult } from './analyze.js';
import { isGroundNet } from './dc/rails.js';
import { driverLoop, isPassive, type DriverLoop } from './driver.js';
import { add, dist, distPointSeg, distToPaths, len, mul, Polyline, sub } from './geom.js';
import type { Steps } from './budget.js';
import { leastInductancePath } from './returnflow.js';
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
  /** Widest trace-edge-to-pour gap a coplanar return is drawn across, mm. */
  maxCoplanarGap: number;
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

/** Sampling step of the drawn return, and how far inside the pour edge a coplanar return is drawn, mm. */
const STEP = 0.05;
const INSET = 0.1;
/** Pieces of a return shorter than this are left out; the line joins across them, mm. */
const MIN_RUN = 0.3;
/** Stretch the other side of a coplanar trace must carry alone before the return is drawn there, mm. */
const TAKE_OVER = 3;
/** How much further than the trace's half width (plus the widest coplanar gap) the return is looked for, mm. */
const FLOW_MARGIN = 1;
/** How far from the end of a trace the copper its return starts in is looked for, mm. */
const ANCHOR_REACH = 1.5;
/** How far along another trace of the net, from a chain's end, the via it reaches may be, mm. */
const T_REACH = 1;
/** How far from a pin on another layer than the return the GND via it goes through may be, mm. */
const PIN_VIA_REACH = 6;
/** Most joins routed through the copper per net; past it the line breaks. */
const MAX_ROUTED_JOINS = 60;

const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
const ptKey = (p: Pt) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;

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
export function* buildReturnPath(board: Board, net: string, chains: ChainResult[], vias: ViaResult[], probe: CopperProbe, findings: Finding[], opts: DriverOptions): Steps<ReturnPath> {
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
      if (s < 0.05 || s > line.length - 0.05 || distToPaths(line.at(s), pd.shape) > 0.05) continue;
      const comp = board.components.find((x) => x.id === pd.componentId);
      if (!comp || isPassive(comp)) continue;
      ends.push([line.at(s), line.at(s < line.length / 2 ? Math.min(line.length, s + 1) : Math.max(0, s - 1)), pd, s]);
    }
    for (const [end, inward, onPad, at] of ends) {
      if (!onPad && ownVias.some((v) => dist(v.at, end) <= v.diameter / 2 + 0.01)) continue;
      const pad = onPad ?? padAt(board, end, net, c.chain.layer);
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
      const pin = candidates.sort((a, b) => dist(a.at, pad.at) - dist(b.at, pad.at))[0];
      const where = `${comp.designator} pad ${pad.number}`;
      if (endNet && !endNets.has(comp.designator)) endNets.set(comp.designator, endNet);
      pinOf.set(pad.id, pin ?? null);
      if (pin) {
        close(c, at, pin);
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

  // Where each end of a chain's return goes: the GND pin of the part it ends on, the GND via where it changes
  // layer, the via between a pour beside the trace and the plane, or else the copper nearest the end.
  type Anchor = { at: Pt; leg?: { layer: number; path: Path; pin: Pt } };
  const cutViaAt = new Map(chains.filter((c) => c.chain.cut?.[0] && c.chain.cutVia).map((c) => [ptKey(c.chain.pts[0]), c.chain.cutVia!.at]));
  // A chain that ends where it meets another (a T) reaches the via on that one's line as well.
  const onOneLine = (p: Pt, q: Pt) => chains.some((o) => [p, q].every((r) => o.chain.pts.slice(1).some((b, i) => distPointSeg(r, o.chain.pts[i], b) <= 0.01)));
  const changeVia = (p: Pt, layer: number): Pt | null => {
    for (const v of vias)
      if (dist(v.via.at, p) <= v.via.diameter / 2 + 0.01 || (dist(v.via.at, p) <= T_REACH && onOneLine(p, v.via.at)))
        for (const t of v.transitions) if (t.kind === 'stitching-via' && t.target && (t.fromLayer === layer || t.toLayer === layer)) return t.target.at;
    return null;
  };
  const nearestCopper = new Map<string, Pt | null>();
  const anchors = new Set<string>();
  const missed = new Set<string>();
  const reached = new Set<string>();

  let routedJoins = 0;
  for (const [ci, c] of chains.entries()) {
    yield { phase: 'return path', fraction: ci / chains.length };
    const ref = c.ref;
    if (!ref) continue;
    const line = new Polyline(c.chain.pts);
    const L = line.length;
    const halfWidth = (trackById.get(c.chain.trackIds[0])?.width ?? 0.2) / 2;
    // Gaps whose way round adds next to nothing lie within the corridor of the least-inductance path.
    const breaks = c.gaps.filter((g) => g.kind !== 'via-antipad').sort((a, b) => a.s0 - b.s0);
    const exclude = ref.coplanar ? net : undefined;
    const maxGap = opts.maxCoplanarGap;
    const inCopper = (q: Pt) => !!probe.netAt(q, ref.layer, exclude) && !probe.blockedAt(q, ref.layer);
    const joins = (a: Pt, b: Pt) => {
      const n = Math.max(2, Math.ceil(dist(a, b) / STEP));
      for (let i = 1; i < n; i++) if (!inCopper(add(a, mul(sub(b, a), i / n)))) return false;
      return true;
    };
    const draw = (layer: number, pts: Path, detour?: boolean) => traces.push({ layer, signalLayer: c.chain.layer, pts, ...(detour ? { detour } : {}) });
    const solid = (q: Pt) => inCopper(q) && [0, 1, 2, 3].every((k) => inCopper(add(q, mul({ x: Math.cos((k * Math.PI) / 2), y: Math.sin((k * Math.PI) / 2) }, STEP))));
    const copperNear = (p: Pt): Pt | null => {
      const k = `${ref.layer}|${ptKey(p)}`;
      if (!nearestCopper.has(k)) {
        let found: Pt | null = null;
        for (let r = 0; r <= ANCHOR_REACH && !found; r += STEP)
          for (let i = 0; i < (r ? 32 : 1) && !found; i++) {
            const q = add(p, mul({ x: Math.cos((i * Math.PI) / 16), y: Math.sin((i * Math.PI) / 16) }, r));
            if (solid(q)) found = q;
          }
        nearestCopper.set(k, found);
      }
      return nearestCopper.get(k)!;
    };
    // A pin on the reference layer (or through-hole) takes the return itself; one on another layer through the GND via
    // nearest the way from the trace to it, and that layer's copper from there.
    const pinAnchor = (pin: Pad, from: Pt): Anchor | null => {
      if (pin.layer === ref.layer || pin.layer === MULTI_LAYER) return { at: pin.at };
      const stops = [...board.vias.filter((v) => v.net === pin.net).map((v) => v.at), ...board.pads.filter((p) => p.net === pin.net && p.layer === MULTI_LAYER).map((p) => p.at)]
        .filter((v) => dist(v, pin.at) <= PIN_VIA_REACH && solid(v))
        .sort((u, v) => dist(from, u) + dist(u, pin.at) - (dist(from, v) + dist(v, pin.at)))
        .slice(0, 3);
      for (const v of stops) {
        const path = probe.copperPath(pin.layer, pin.net, v, pin.at);
        if (path) return { at: v, leg: { layer: pin.layer, path, pin: pin.at } };
      }
      return null;
    };
    const anchorAt = (s: number): Anchor | null => {
      const p = line.at(s);
      const pin = closures.get(c)?.find((x) => Math.abs(x.s - s) < 1e-6)?.pin;
      const viaPin = pin && pinAnchor(pin, p);
      if (viaPin) return viaPin;
      if (pin) missed.add(ptKey(pin.at));
      const change = changeVia(p, c.chain.layer) ?? cutViaAt.get(ptKey(p));
      if (change && solid(change)) return { at: change };
      if (change) missed.add(ptKey(change));
      const near = copperNear(p);
      return near && { at: near };
    };
    const legs: Anchor[] = [];
    const got = new Set<string>();
    const arrive = (a: Anchor | null) => {
      if (!a) return;
      reached.add(ptKey(a.at));
      if (a.leg) legs.push(a);
    };

    // The return is one line: each piece starts where the last one ended. A short step through the
    // copper joins them straight; anything else takes the way that adds least loop inductance.
    let end: Pt | null = null;
    const link = (next: Pt) => {
      const a = end;
      end = null;
      if (!a || dist(a, next) < 0.02) return;
      if (dist(a, next) <= 0.6 && joins(a, next)) return draw(ref.layer, [a, next]);
      const refNet = probe.netAt(a, ref.layer, exclude);
      if (!refNet || refNet !== probe.netAt(next, ref.layer, exclude) || routedJoins >= MAX_ROUTED_JOINS) return;
      routedJoins++;
      const route = probe.returnRoute(c, refNet, a, next);
      if (!route) return;
      for (const leg of route.legs) if (leg.path.length > 1) draw(leg.layer, leg.path, true);
      for (const v of route.vias) jumps.push({ kind: 'via', from: v, to: v, label: `${refNet} via`, distance: 0, severity: 'ok' });
    };
    const lay = (layer: number, pts: Path, detour?: boolean) => {
      link(pts[0]);
      draw(layer, pts, detour);
      end = pts[pts.length - 1];
    };

    // Where the return can run between s0 and s1: under the trace on a plane; beside it on either side
    // in a coplanar pour. Each candidate side gives runs of points joined through copper.
    const piece = function* (s0: number, s1: number, to: Pt | null): Steps<void> {
      if (s1 - s0 < 1e-6) return;
      const flowFrom = (from: Pt | null, until: Pt | null) =>
        leastInductancePath({
          inCopper,
          line,
          s0,
          s1,
          halfWidth,
          h: ref.coplanar ? 0 : ref.h,
          corridor: halfWidth + (ref.coplanar ? maxGap : 0) + FLOW_MARGIN,
          from,
          to: until,
        });
      let flow = yield* flowFrom(end, to);
      // An anchor the copper near the trace does not reach is left to its hop: the return is drawn under the trace alone.
      if (!flow && end && anchors.has(ptKey(end))) end = null;
      if (!flow && (!end || (to && anchors.has(ptKey(to))))) flow = yield* flowFrom(end, null);
      if (!flow && end) flow = yield* flowFrom(null, null);
      if (flow && flow.length > 1) {
        end = null;
        const pulled = straighten(flow);
        if (pulled.slice(1).some((p, i) => dist(p, pulled[i]) > 0.01)) draw(ref.layer, pulled);
        got.add(ptKey(flow[0]));
        end = flow[flow.length - 1];
        got.add(ptKey(end));
        return;
      }
      const k = Math.max(1, Math.ceil((s1 - s0) / STEP));
      const sides: ((at: number) => Pt | null)[] = [];
      if (!ref.coplanar) {
        // Under the trace; where the plane has a hole there, beside it within the trace's footprint,
        // keeping to the side it took unless the other is clearly nearer.
        let lastSide = 1;
        sides.push((at) => {
          const p = line.at(at);
          if (inCopper(p)) return p;
          const n = unitNormal({ x: 0, y: 0 }, line.dirAt(at));
          const nearest = (side: number) => {
            for (let d = STEP; d <= halfWidth + 1e-9; d += STEP) if (inCopper(add(p, mul(n, side * d)))) return d;
            return Infinity;
          };
          const [same, other] = [nearest(lastSide), nearest(-lastSide)];
          if (same === Infinity && other === Infinity) return null;
          let d = same;
          if (other + 0.3 < same) {
            lastSide = -lastSide;
            d = other;
          }
          return add(p, mul(n, lastSide * d));
        });
      } else
        for (const side of [1, -1])
          sides.push((at) => {
            // Along the pour edge, just inside it.
            const p = line.at(at);
            const n = mul(unitNormal({ x: 0, y: 0 }, line.dirAt(at)), side);
            const edge = probe.pourBeside(p, n, halfWidth, ref.layer, net, maxGap, true);
            if (!edge) return null;
            for (const inset of [INSET, INSET / 2, 0.025]) {
              const q = add(p, mul(n, halfWidth + edge.d + inset));
              if (inCopper(q)) return q;
            }
            return null;
          });
      type Run = { i0: number; i1: number; pts: Path; idx: number[]; side: number; off: number };
      const runs: Run[] = [];
      for (const [side, pointAt] of sides.entries()) {
        let run: Run | null = null;
        let last: Pt | undefined;
        const close = () => {
          if (run && run.pts.length > 1) runs.push(run);
          run = null;
        };
        for (let i = 0; i <= k; i++) {
          const at = s0 + ((s1 - s0) * i) / k;
          const q = pointAt(at);
          // Offset points fold back inside a bend; the return does not run backwards there.
          if (q && last && dot(sub(q, last), line.dirAt(at)) < 0) continue;
          if (!q || (run && !joins(run.pts[run.pts.length - 1], q))) close();
          if (!q) continue;
          run ??= { i0: i, i1: i, pts: [], idx: [], side, off: 0 };
          run.pts.push((last = q));
          run.idx.push(i);
          run.i1 = i;
          run.off += dist(q, line.at(at));
        }
        close();
      }
      // One line, on one side: the side with the most copper beside the trace (on a tie the nearer one).
      // Holes in it are joined across; the other side takes over only for a long stretch before or after it.
      const share = (side: number) => runs.filter((r) => r.side === side).reduce((t, r) => [t[0] + r.pts.length, t[1] + r.off], [0, 0]);
      const main = [...new Set(runs.map((r) => r.side))].sort((x, y) => {
        const [sx, sy] = [share(x), share(y)];
        return sy[0] - sx[0] || sx[1] / sx[0] - sy[1] / sy[0];
      })[0];
      if (main === undefined) return;
      const own = runs.filter((r) => r.side === main).sort((x, y) => x.i0 - y.i0);
      const [first, last] = [own[0].i0, own[own.length - 1].i1];
      const longest = (from: number, to: number) => {
        const parts = runs
          .filter((r) => r.side !== main)
          .map((r) => r.pts.filter((_, j) => r.idx[j] >= from && r.idx[j] <= to))
          .filter((pts) => pts.length > 1 && dist(pts[0], pts[pts.length - 1]) >= TAKE_OVER);
        return parts.sort((x, y) => y.length - x.length)[0];
      };
      const head = longest(0, first - 1);
      const tail = longest(last + 1, k);
      for (const pts of [head, ...own.map((r) => r.pts), tail]) if (pts && pts.length > 1 && dist(pts[0], pts[pts.length - 1]) >= MIN_RUN) lay(ref.layer, straighten(pts));
    };

    // Pins the trace passes through close the loop there: the return of each side runs into the pin.
    const mids = (closures.get(c) ?? [])
      .filter((x) => x.s > 1e-6 && x.s < L - 1e-6)
      .map((x) => {
        const anchor = pinAnchor(x.pin, line.at(x.s));
        if (!anchor) missed.add(ptKey(x.pin.at));
        return { s: x.s, anchor };
      });
    const first = anchorAt(0);
    const last = anchorAt(L);
    for (const a of [first, last, ...mids.map((m) => m.anchor)]) if (a) anchors.add(ptKey(a.at));
    end = first?.at ?? null;
    let s = 0;
    const events = [...breaks.map((g) => ({ s: g.s0, g })), ...mids.map((m) => ({ s: m.s, m }))].sort((a, b) => a.s - b.s);
    for (const e of events) {
      if ('m' in e) {
        if (!e.m.anchor) continue;
        yield* piece(s, e.s, e.m.anchor.at);
        if (got.has(ptKey(e.m.anchor.at))) arrive(e.m.anchor);
        end = e.m.anchor.at;
        s = e.s;
        continue;
      }
      const g = e.g;
      yield* piece(s, g.s0, g.viaRoute?.legs.find((leg) => leg.path.length > 1)?.path[0] ?? (g.detour ? (g.drawn ?? g.detour.path)[0] : null));
      s = g.s1;
      if (g.viaRoute) {
        const legs = g.viaRoute.legs.filter((leg) => leg.path.length > 1);
        if (legs.length) link(legs[0].path[0]);
        for (const leg of legs) draw(leg.layer, leg.path, true);
        for (const v of g.viaRoute.vias) jumps.push({ kind: 'via', from: v, to: v, label: `${g.netBefore} via`, distance: 0, severity: 'ok' });
        end = legs.length ? legs[legs.length - 1].path[legs[legs.length - 1].path.length - 1] : null;
      } else if (g.detour) lay(ref.layer, g.drawn ?? g.detour.path, true);
      else {
        // Across a split or a stretch without reference copper the current leaves the copper (bridging cap, pins): no line joins it.
        end = null;
        if (g.bridge) {
          const b = g.bridge;
          const label = b.component.designator;
          jumps.push({ kind: 'bridge', from: g.a, to: b.at, label, distance: b.distance, severity: b.severity });
          jumps.push({ kind: 'bridge', from: b.at, to: g.b, label, distance: dist(b.at, g.b), severity: b.severity });
        }
      }
    }
    yield* piece(s, L, last?.at ?? null);
    for (const a of [first, last, ...mids.map((m) => m.anchor)]) if (a && !got.has(ptKey(a.at))) missed.add(ptKey(a.at));
    for (const a of [first, last]) if (a && got.has(ptKey(a.at))) arrive(a);
    for (const k of got) reached.add(k);
    for (const a of legs) {
      draw(a.leg!.layer, a.leg!.path);
      reached.add(ptKey(a.leg!.pin));
      jumps.push({ kind: 'via', from: a.at, to: a.at, label: `${probe.netAt(a.at, ref.layer) ?? ''} via`.trim(), distance: 0, severity: 'ok' });
    }
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

  // A hop whose end the drawn return reaches is no longer a jump through the air: only its end is marked.
  for (const j of jumps) if ((j.kind === 'pin' || j.kind === 'via') && reached.has(ptKey(j.to)) && !missed.has(ptKey(j.to))) j.from = j.to;

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
