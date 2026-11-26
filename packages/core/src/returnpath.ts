// The high-frequency return path as drawable geometry (D7): where the image current runs on each
// reference layer, and the hops it makes off the plane (bridging caps, return vias, decaps, and the
// IC ground pins that close the loop at the ends of the net).
import type { ChainResult, Finding, Severity, ViaResult } from './analyze.js';
import { add, dist, distToPaths, dot, len, mul, Polyline, sub } from './geom.js';
import { MULTI_LAYER, type Board, type Pad, type Path, type Pt } from './types.js';

export interface ReturnTrace {
  /** Reference layer the current runs on. */
  layer: number;
  pts: Path;
  /** Part of a detour around a slot. */
  detour?: boolean;
}

export type ReturnJumpKind = 'via' | 'decap' | 'bridge' | 'pin';

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
}

/** Net of the reference copper at p on a layer, optionally ignoring one net. */
export type NetAt = (p: Pt, layer: number, exclude?: string) => string | null;

const unitNormal = (a: Pt, b: Pt): Pt => {
  const d = sub(b, a);
  const l = len(d) || 1;
  return { x: -d.y / l, y: d.x / l };
};

/** Polyline shifted sideways by d (left of the direction of travel for d > 0), mitred at the corners. */
export function offsetPolyline(path: Path, d: number): Path {
  const pts = path.filter((p, i) => i === 0 || dist(p, path[i - 1]) > 1e-9);
  if (pts.length < 2) return pts;
  return pts.map((p, i) => {
    const n1 = i > 0 ? unitNormal(pts[i - 1], p) : null;
    const n2 = i < pts.length - 1 ? unitNormal(p, pts[i + 1]) : null;
    if (!n1 || !n2) return add(p, mul((n1 ?? n2)!, d));
    const m = add(n1, n2);
    const l = len(m);
    if (l < 1e-6) return add(p, mul(n1, d));
    const u = mul(m, 1 / l);
    return add(p, mul(u, d / Math.max(0.2, dot(u, n1))));
  });
}

function padAt(board: Board, p: Pt, net: string, layer: number): Pad | undefined {
  return board.pads.find((pd) => pd.net === net && (pd.layer === layer || pd.layer === MULTI_LAYER) && (dist(pd.at, p) < 0.05 || distToPaths(p, pd.shape) < 0.05));
}

/**
 * Builds the return path from the per-chain results. Also adds one finding per net end, naming
 * the pin where the return leaves the reference copper (or saying the part has none).
 */
export function buildReturnPath(board: Board, net: string, chains: ChainResult[], vias: ViaResult[], netAt: NetAt, findings: Finding[]): ReturnPath {
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
        traces.push({ layer: ref.layer, pts: centre });
        return;
      }
      // Coplanar return crowds the pour edges on either side of the trace, where there is pour.
      const o = halfWidth + ref.h;
      const probe = halfWidth + 1.5 * ref.h + 0.05;
      const mid = line.at((s0 + s1) / 2);
      const n = unitNormal({ x: 0, y: 0 }, line.dirAt((s0 + s1) / 2));
      for (const side of [1, -1])
        if (netAt(add(mid, mul(n, side * probe)), ref.layer, exclude)) traces.push({ layer: ref.layer, pts: offsetPolyline(centre, side * o) });
    };
    let s = 0;
    for (const g of breaks) {
      push(s, g.s0);
      s = g.s1;
      if (g.detour) traces.push({ layer: ref.layer, pts: g.detour.path, detour: true });
      else if (g.bridge) {
        const b = g.bridge;
        const label = b.component.designator;
        jumps.push({ kind: 'bridge', from: g.a, to: b.at, label, distance: b.distance, severity: b.severity });
        jumps.push({ kind: 'bridge', from: b.at, to: g.b, label, distance: dist(b.at, g.b), severity: b.severity });
      }
    }
    push(s, L);
  }

  for (const v of vias)
    for (const t of v.transitions)
      if (t.target && t.distance !== undefined)
        jumps.push({ kind: t.kind === 'decap' ? 'decap' : 'via', from: v.via.at, to: t.target.at, label: t.target.label, distance: t.distance, severity: t.severity });

  // Loop closure: where the trace ends on a part's pad, the return leaves the reference copper
  // through that part's pin on the reference net (ground, or the supply for a VCC-referenced trace).
  const seen = new Set<string>();
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
      if (!comp) continue;
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
      if (pin) {
        const d = dist(pin.at, pad.at);
        jumps.push({ kind: 'pin', from: pad.at, to: pin.at, label: `${comp.designator}.${pin.number}`, distance: d, severity: 'ok' });
        findings.push({ severity: 'ok', kind: 'loop-closure', message: `${where}: the return leaves ${pin.net} copper through ${comp.designator} pad ${pin.number} (${pin.net}), ${d.toFixed(2)} mm from the signal pad`, at: pad.at });
      } else {
        findings.push({ severity: 'warn', kind: 'loop-closure', message: `${where}: ${comp.designator} has no pad on ${endNet ?? 'the reference net'}, so the return path cannot close at this end`, at: pad.at });
      }
    }
  }
  return { traces, jumps };
}
