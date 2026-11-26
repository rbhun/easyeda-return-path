import { Clipper, ClipperD, ClipType, EndType, FillRule, JoinType } from '@countertype/clipper2-ts';
import type { Path, Paths, Pt } from './types.js';

/** Decimal places Clipper keeps for mm coordinates (0.1 µm). */
const PREC = 4;

export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
export const cross = (a: Pt, b: Pt) => a.x * b.y - a.y * b.x;
export const len = (a: Pt) => Math.hypot(a.x, a.y);
export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function rotate(p: Pt, deg: number): Pt {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

export function pathLength(p: Path): number {
  let l = 0;
  for (let i = 1; i < p.length; i++) l += dist(p[i - 1], p[i]);
  return l;
}

/** Signed shoelace area, positive for counter-clockwise. */
export function signedArea(p: Path): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j].x + p[i].x) * (p[j].y - p[i].y);
  return -a / 2;
}

export function area(paths: Paths): number {
  return paths.reduce((s, p) => s + signedArea(p), 0);
}

export function circle(c: Pt, r: number, segs = 32): Path {
  const out: Path = [];
  for (let i = 0; i < segs; i++) {
    const t = (2 * Math.PI * i) / segs;
    out.push({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) });
  }
  return out;
}

export function rect(cx: number, cy: number, w: number, h: number, rotDeg = 0): Path {
  const pts = [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ];
  return pts.map((p) => add(rotate(p, rotDeg), { x: cx, y: cy }));
}

/**
 * Points of a circular arc from a to b sweeping `sweepDeg` (positive = counter-clockwise),
 * excluding a, including b.
 */
export function arcPoints(a: Pt, b: Pt, sweepDeg: number, maxSegDeg = 10): Path {
  if (Math.abs(sweepDeg) < 1e-9) return [b];
  const sweep = (sweepDeg * Math.PI) / 180;
  const chord = dist(a, b);
  if (chord < 1e-12) return [b];
  const r = chord / 2 / Math.sin(Math.abs(sweep) / 2);
  const mid = lerp(a, b, 0.5);
  const dir = mul(sub(b, a), 1 / chord);
  const normal = { x: -dir.y, y: dir.x };
  const hDist = Math.sqrt(Math.max(r * r - (chord / 2) ** 2, 0));
  // Counter-clockwise sweeps under 180° have their centre on the left of a->b.
  const side = (sweep > 0 ? 1 : -1) * (Math.abs(sweep) <= Math.PI ? 1 : -1);
  const c = add(mid, mul(normal, side * hDist));
  const a0 = Math.atan2(a.y - c.y, a.x - c.x);
  const n = Math.max(2, Math.ceil(Math.abs(sweepDeg) / maxSegDeg));
  const out: Path = [];
  for (let i = 1; i < n; i++) {
    const t = a0 + (sweep * i) / n;
    out.push({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) });
  }
  out.push(b);
  return out;
}

export function union(...sets: Paths[]): Paths {
  const all = sets.flat();
  if (!all.length) return [];
  // The two-argument overload rounds to 0.01 mm; some real pour fills (R-Com dongle, POUR2)
  // rounded that coarsely send Clipper into an endless loop that exhausts memory.
  return Clipper.unionD(all, [], FillRule.NonZero, PREC);
}

export function intersect(a: Paths, b: Paths): Paths {
  if (!a.length || !b.length) return [];
  return Clipper.intersectD(a, b, FillRule.NonZero, PREC);
}

export function difference(a: Paths, b: Paths): Paths {
  if (!a.length) return [];
  if (!b.length) return union(a);
  return Clipper.differenceD(a, b, FillRule.NonZero, PREC);
}

/** Enclosed area of a closed, possibly self-intersecting path (even-odd). */
export function enclosedArea(path: Path): number {
  if (path.length < 3) return 0;
  return Math.abs(area(Clipper.unionD([path], [], FillRule.EvenOdd, PREC)));
}

export function inflate(paths: Paths, delta: number): Paths {
  if (!paths.length) return [];
  return Clipper.inflatePathsD(paths, delta, JoinType.Round, EndType.Polygon, 2, PREC);
}

/** Outline of an open polyline drawn with a round pen of the given width. */
export function strokePath(path: Path, width: number, butt = false): Paths {
  if (path.length < 2) return path.length ? [circle(path[0], width / 2)] : [];
  return Clipper.inflatePathsD([path], width / 2, JoinType.Round, butt ? EndType.Butt : EndType.Round, 2, PREC);
}

export function clipRect(paths: Paths, minX: number, minY: number, maxX: number, maxY: number): Paths {
  if (!paths.length) return [];
  return Clipper.rectClip({ left: minX, top: minY, right: maxX, bottom: maxY }, paths, PREC) as Paths;
}

export function simplify(paths: Paths, eps: number): Paths {
  return Clipper.simplifyPathsD(paths, eps, true);
}

/** Even-odd point-in-region; valid for Clipper output where holes never overlap. */
export function pointInPaths(p: Pt, paths: Paths): boolean {
  let inside = false;
  for (const path of paths) {
    for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
      const a = path[i];
      const b = path[j];
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

export function distPointSeg(p: Pt, a: Pt, b: Pt): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return dist(p, add(a, mul(ab, t)));
}

/** Distance from a point to a region (0 inside). */
export function distToPaths(p: Pt, paths: Paths): number {
  if (pointInPaths(p, paths)) return 0;
  let best = Infinity;
  for (const path of paths) {
    for (let i = 0, j = path.length - 1; i < path.length; j = i++) best = Math.min(best, distPointSeg(p, path[j], path[i]));
  }
  return best;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function bbox(paths: Paths): BBox {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of paths)
    for (const q of p) {
      b.minX = Math.min(b.minX, q.x);
      b.minY = Math.min(b.minY, q.y);
      b.maxX = Math.max(b.maxX, q.x);
      b.maxY = Math.max(b.maxY, q.y);
    }
  return b;
}

/** Proper intersection of segments ab and cd (touching endpoints do not count). */
export function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross(sub(b, a), sub(c, a));
  const d2 = cross(sub(b, a), sub(d, a));
  const d3 = cross(sub(d, c), sub(a, c));
  const d4 = cross(sub(d, c), sub(b, c));
  const eps = 1e-12;
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

/** Polyline walker: point at arc length s. */
export class Polyline {
  readonly cum: number[] = [0];
  constructor(readonly pts: Path) {
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + dist(pts[i - 1], pts[i]));
  }
  get length() {
    return this.cum[this.cum.length - 1];
  }
  private segIndex(s: number): number {
    let lo = 1;
    let hi = this.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] < s) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  at(s: number): Pt {
    s = Math.max(0, Math.min(this.length, s));
    if (this.pts.length < 2) return this.pts[0];
    const i = this.segIndex(s);
    const seg = this.cum[i] - this.cum[i - 1];
    return lerp(this.pts[i - 1], this.pts[i], seg ? (s - this.cum[i - 1]) / seg : 0);
  }
  /** Unit tangent at arc length s. */
  dirAt(s: number): Pt {
    if (this.pts.length < 2) return { x: 1, y: 0 };
    const i = this.segIndex(Math.max(0, Math.min(this.length, s)));
    const d = sub(this.pts[i], this.pts[i - 1]);
    const l = Math.hypot(d.x, d.y) || 1;
    return { x: d.x / l, y: d.y / l };
  }
  /** Sub-polyline between arc lengths s0 < s1. */
  slice(s0: number, s1: number): Path {
    const out: Path = [this.at(s0)];
    for (let i = 1; i < this.pts.length - 1; i++) if (this.cum[i] > s0 && this.cum[i] < s1) out.push(this.pts[i]);
    out.push(this.at(s1));
    return out;
  }
}

/** Region of the paths as a list of polygons with their holes (outer first). */
export function splitIslands(paths: Paths): Paths[] {
  const areas = paths.map(signedArea);
  // Smallest first, so the first outer that contains a hole is the tightest one.
  const outers = paths.map((p, i) => ({ p, a: areas[i], b: bbox([p]), group: [p] as Paths })).filter((o) => o.a > 0);
  const bySize = [...outers].sort((x, y) => x.a - y.a);
  for (let i = 0; i < paths.length; i++) {
    if (areas[i] > 0) continue;
    const q = paths[i][0];
    if (!q) continue;
    const o = bySize.find((o) => q.x >= o.b.minX && q.x <= o.b.maxX && q.y >= o.b.minY && q.y <= o.b.maxY && pointInPaths(q, [o.p]));
    if (o) o.group.push(paths[i]);
  }
  return outers.map((o) => o.group);
}

export function scalePaths(paths: Paths, k: number): Paths {
  return k === 1 ? paths : paths.map((p) => p.map((q) => ({ x: q.x * k, y: q.y * k })));
}

/**
 * Factor that brings a pour's computed fill onto its outline. EasyEDA Pro 3.2 stores pour fills
 * (POURED, and what the API returns for them) in units of 10 mil while everything else is in mil;
 * decoded as mil, the fill shrinks towards the origin. Picks 1 or 10, whichever overlaps the outline's
 * bounding box best.
 */
export function pouredScale(outline: Paths, fill: Paths): number {
  const o = bbox(outline);
  const f = bbox(fill);
  if (!Number.isFinite(o.minX) || !Number.isFinite(f.minX)) return 1;
  const overlap = (k: number) => {
    const w = Math.min(o.maxX, f.maxX * k) - Math.max(o.minX, f.minX * k);
    const h = Math.min(o.maxY, f.maxY * k) - Math.max(o.minY, f.minY * k);
    const inter = w > 0 && h > 0 ? w * h : 0;
    const area = (b: BBox) => (b.maxX - b.minX) * (b.maxY - b.minY);
    return inter / (area(o) + area({ minX: f.minX * k, minY: f.minY * k, maxX: f.maxX * k, maxY: f.maxY * k }) - inter || 1);
  };
  return overlap(10) > overlap(1) ? 10 : 1;
}
