// How a drawn return line is finished, copied from the DC streamlines (dc/field.ts):
// smoothed over a fixed length, and where two lines on the same layer run together they are
// drawn once and the one that leaves curves onto the other. A corner is not how current joins.
import type { Steps } from './budget.js';
import { simplifyLine } from './dc/field.js';
import { dist, distPointSeg } from './geom.js';
import type { Path, Pt } from './types.js';

/** Length, mm, over which a drawn line is smoothed (the Gaussian's sigma; at least one cell). */
const SMOOTH_MM = 0.35;
/** How far, mm, the drawn line may stray from the smoothed curve when its points are thinned. */
const SMOOTH_TOL_MM = 0.03;
/** Lines closer than this, mm, are the same current and are drawn once. */
const MERGE_MM = 0.6;
/** They have to run that close for at least this long, mm. Meeting at a pad or via does not count. */
const MERGE_RUN_MM = 1;
/** A joining line meets the earlier one this far, mm, past the point it came close to. */
const JOIN_MM = 1;
/** And at least this many times as far as the earlier line lies aside, so the curve onto it stays shallow. */
const JOIN_SLOPE = 2.5;

const pathLen = (pts: Path, i0 = 0, i1 = pts.length - 1) => {
  let L = 0;
  for (let i = i0; i < i1; i++) L += dist(pts[i], pts[i + 1]);
  return L;
};

/**
 * Gaussian smoothing over a fixed length along the line, so turns read as bends rather than corners.
 * The ends (pads, vias, joins) stay put, and a point the smoothing would move off the copper moves
 * only as far as the copper allows.
 */
function resample(pts: Path, cell: number): { rs: Path; step: number } {
  const step = Math.min(cell, SMOOTH_MM) / 2;
  const rs: Path = [pts[0]];
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    const n = Math.max(1, Math.round(dist(a, b) / step));
    for (let m = 1; m <= n; m++) rs.push({ x: a.x + ((b.x - a.x) * m) / n, y: a.y + ((b.y - a.y) * m) / n });
  }
  return { rs, step };
}

/** One smoothed point. A point that would leave the copper, or come within a cell of its edge, stays put. */
function smoothAt(rs: Path, i: number, half: number, w: number[], onCopper: (q: Pt) => boolean, cell: number): Pt {
  const p = rs[i];
  const h = Math.min(half, i, rs.length - 1 - i);
  if (!h) return p;
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let k = -h; k <= h; k++) {
    sx += w[Math.abs(k)] * rs[i + k].x;
    sy += w[Math.abs(k)] * rs[i + k].y;
    sw += w[Math.abs(k)];
  }
  const inside = (q: Pt) =>
    onCopper(q) &&
    onCopper({ x: q.x + cell, y: q.y }) &&
    onCopper({ x: q.x - cell, y: q.y }) &&
    onCopper({ x: q.x, y: q.y + cell }) &&
    onCopper({ x: q.x, y: q.y - cell });
  for (const a of [1, 0.75, 0.5, 0.25]) {
    const q = { x: p.x + (sx / sw - p.x) * a, y: p.y + (sy / sw - p.y) * a };
    if (inside(q)) return q;
  }
  return p;
}

/**
 * Gaussian smoothing over a fixed length along the line, so turns read as bends rather than corners.
 * The ends (pads, vias, joins) stay put, and a point the smoothing would move off the copper moves
 * only as far as the copper allows.
 */
export function smoothLine(pts: Path, onCopper: (q: Pt) => boolean, cell: number): Path {
  if (pts.length < 2) return pts;
  const { rs, step } = resample(pts, cell);
  if (rs.length < 3) return rs;
  const sigma = Math.max(SMOOTH_MM, cell);
  const half = Math.ceil((2.5 * sigma) / step);
  const w = Array.from({ length: half + 1 }, (_, k) => Math.exp(-0.5 * ((k * step) / sigma) ** 2));
  return rs.map((_, i) => smoothAt(rs, i, half, w, onCopper, cell));
}

/** A cubic from p, heading the way `pts` was going, onto `piece` far enough ahead that the curve stays shallow. */
function curveOnto(pts: Path, p: Pt, piece: Path, hitIdx: number, hitPt: Pt, cell: number): Path | null {
  const want = Math.max(JOIN_MM, 3 * cell, JOIN_SLOPE * dist(hitPt, p));
  const fine = cell / 4;
  const walk = (dir: 1 | -1) => {
    let at = hitPt;
    let i = hitIdx + (dir > 0 ? 1 : 0);
    const step = () => {
      while (dir > 0 ? i < piece.length : i > 0) {
        const nxt = dir > 0 ? i : i - 1;
        const d = dist(piece[nxt], at);
        const n = Math.max(1, Math.ceil(d / fine));
        const from = at;
        for (let m = 1; m <= n; m++) {
          at = { x: from.x + ((piece[nxt].x - from.x) * m) / n, y: from.y + ((piece[nxt].y - from.y) * m) / n };
          if (dist(at, p) >= want) return true;
        }
        i += dir;
        at = piece[Math.max(0, Math.min(piece.length - 1, dir > 0 ? i - 1 : i))];
      }
      return false;
    };
    step();
    const k = Math.max(0, Math.min(piece.length - 1, dir > 0 ? i : i));
    return { at, k };
  };
  const fwd = walk(1);
  const back = walk(-1);
  const reached = (w: { at: Pt }) => dist(w.at, p) >= want - 1e-6;
  const pick = reached(fwd) && reached(back) ? (dist(fwd.at, p) <= dist(back.at, p) ? fwd : back) : reached(fwd) ? fwd : back;
  const prev = pts.length > 1 ? pts[pts.length - 2] : undefined;
  const unit = (x: number, y: number) => {
    const m = Math.hypot(x, y);
    return m > 1e-9 ? { x: x / m, y: y / m } : undefined;
  };
  const d0 = (prev && unit(p.x - prev.x, p.y - prev.y)) ?? unit(pick.at.x - p.x, pick.at.y - p.y);
  const k0 = Math.max(0, pick.k - 1);
  const d3 = unit(piece[pick.k].x - piece[k0].x, piece[pick.k].y - piece[k0].y) ?? d0;
  const span = dist(pick.at, p);
  if (!d0 || !d3 || span < 1e-6) return null;
  const c1 = { x: p.x + d0.x * span * 0.4, y: p.y + d0.y * span * 0.4 };
  const c2 = { x: pick.at.x - d3.x * span * 0.4, y: pick.at.y - d3.y * span * 0.4 };
  const out: Path = [];
  for (let n = 0; n <= 8; n++) {
    const u = n / 8;
    const v = 1 - u;
    out.push({
      x: v * v * v * p.x + 3 * v * v * u * c1.x + 3 * v * u * u * c2.x + u * u * u * pick.at.x,
      y: v * v * v * p.y + 3 * v * v * u * c1.y + 3 * v * u * u * c2.y + u * u * u * pick.at.y,
    });
  }
  return out;
}

interface Hit {
  piece: Path;
  idx: number;
  pt: Pt;
  d: number;
}

function nearestOn(p: Pt, piece: Path): Hit | null {
  let best: Hit | null = null;
  for (let i = 0; i < piece.length - 1; i++) {
    const d = distPointSeg(p, piece[i], piece[i + 1]);
    if (!best || d < best.d) {
      const ab = { x: piece[i + 1].x - piece[i].x, y: piece[i + 1].y - piece[i].y };
      const l2 = ab.x * ab.x + ab.y * ab.y || 1;
      const t = Math.max(0, Math.min(1, ((p.x - piece[i].x) * ab.x + (p.y - piece[i].y) * ab.y) / l2));
      best = { piece, idx: i, pt: { x: piece[i].x + ab.x * t, y: piece[i].y + ab.y * t }, d };
    }
  }
  return best;
}

function closest(p: Pt, accepted: Path[]): Hit | null {
  let best: Hit | null = null;
  for (const piece of accepted) {
    const h = nearestOn(p, piece);
    if (h && (!best || h.d < best.d)) best = h;
  }
  return best && best.d <= MERGE_MM ? best : null;
}

/** Arc-length samples, so a long straight piece is tested along its length and not only at its ends. */
function samples(pts: Path, step: number): { p: Pt; s: number }[] {
  const out = [{ p: pts[0], s: 0 }];
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i]);
    const n = Math.max(1, Math.ceil(d / step));
    for (let m = 1; m <= n; m++) {
      s += d / n;
      out.push({ p: { x: pts[i - 1].x + ((pts[i].x - pts[i - 1].x) * m) / n, y: pts[i - 1].y + ((pts[i].y - pts[i - 1].y) * m) / n }, s });
    }
  }
  return out;
}

function sliceArc(pts: Path, s0: number, s1: number): Path {
  const out: Path = [];
  const push = (p: Pt) => {
    const last = out[out.length - 1];
    if (!last || dist(last, p) > 1e-6) out.push(p);
  };
  let s = 0;
  for (let i = 1; i < pts.length && s < s1 - 1e-9; i++) {
    const d = dist(pts[i - 1], pts[i]);
    const sNext = s + d;
    if (sNext > s0 + 1e-9 && s < s1 - 1e-9) {
      const u0 = d ? Math.max(0, (s0 - s) / d) : 0;
      const u1 = d ? Math.min(1, (s1 - s) / d) : 1;
      push({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * u0, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * u0 });
      push({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * u1, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * u1 });
    }
    s = sNext;
  }
  return out;
}

/** Arc length along pts of the point nearest p. */
function arcOf(pts: Path, p: Pt): number {
  let s = 0;
  let best = 0;
  let bd = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i]);
    const ab = { x: pts[i].x - pts[i - 1].x, y: pts[i].y - pts[i - 1].y };
    const l2 = ab.x * ab.x + ab.y * ab.y || 1;
    const t = Math.max(0, Math.min(1, ((p.x - pts[i - 1].x) * ab.x + (p.y - pts[i - 1].y) * ab.y) / l2));
    const q = { x: pts[i - 1].x + ab.x * t, y: pts[i - 1].y + ab.y * t };
    const dd = dist(p, q);
    if (dd < bd) {
      bd = dd;
      best = s + t * d;
    }
    s += d;
  }
  return best;
}

/**
 * Drops the parts of a line that already run along an earlier line, and curves the rest onto it.
 * Null when the whole line is already drawn. The line is unchanged when it only passes close for
 * a short way (two lines meeting at a pad or via).
 */
function cutShared(pts: Path, accepted: Path[], onCopper: (q: Pt) => boolean, cell: number): Path | null {
  const samp = samples(pts, 0.2);
  const hitAt = samp.map((s) => closest(s.p, accepted));
  let firstOff = samp.findIndex((_, i) => !hitAt[i]);
  let lastOff = samp.length - 1;
  while (lastOff >= 0 && hitAt[lastOff]) lastOff--;
  if (firstOff < 0) return null;
  const headShared = samp[firstOff].s;
  const tailShared = samp[samp.length - 1].s - samp[lastOff].s;
  const keepHead = headShared >= MERGE_RUN_MM;
  const keepTail = tailShared >= MERGE_RUN_MM;
  if (!keepHead && !keepTail) return pts;
  const s0 = keepHead ? samp[firstOff].s : 0;
  const s1 = keepTail ? samp[lastOff].s : samp[samp.length - 1].s;
  if (s1 - s0 < 0.3) return null;
  let out = sliceArc(pts, s0, s1);
  if (out.length < 2) return null;
  if (keepHead) {
    const hit = hitAt[Math.max(0, firstOff - 1)];
    const seg = hit && { x: hit.piece[hit.idx + 1].x - hit.piece[hit.idx].x, y: hit.piece[hit.idx + 1].y - hit.piece[hit.idx].y };
    if (hit && seg) {
      const forward = { x: out[1].x - out[0].x, y: out[1].y - out[0].y };
      const sign = seg.x * forward.x + seg.y * forward.y >= 0 ? 1 : -1;
      const prev = { x: hit.pt.x - sign * seg.x, y: hit.pt.y - sign * seg.y };
      const curve = curveOnto([prev, hit.pt], hit.pt, out, 0, out[0], cell);
      if (!curve || curve.some((q) => !onCopper(q))) return pts;
      const rest = sliceArc(out, arcOf(out, curve[curve.length - 1]), pathLen(out));
      out = [...curve, ...rest.slice(1)];
    }
  }
  if (keepTail) {
    const hit = hitAt[Math.min(samp.length - 1, lastOff + 1)];
    if (hit) {
      const curve = curveOnto(out, out[out.length - 1], hit.piece, hit.idx, hit.pt, cell);
      if (!curve || curve.some((q) => !onCopper(q))) return pts;
      out = [...out.slice(0, -1), ...curve];
    }
  }
  return out.length > 1 ? out : null;
}

export interface ShapedLine {
  layer: number;
  pts: Path;
}

/**
 * Finishes drawn return lines the way DC streamlines are finished. Each line is smoothed on its own
 * copper. The longest on a layer is drawn whole; a later one that runs beside it is drawn only where
 * it leaves, on a shallow curve. Lines on different layers are never joined.
 */
export function* shapeReturns<T extends ShapedLine>(traces: T[], copper: (trace: T, q: Pt) => boolean, cell = 0.05): Steps<T[]> {
  const tick = { phase: 'return path' } as const;
  const smoothed: { t: T; i: number }[] = [];
  for (let i = 0; i < traces.length; i++) {
    const t = traces[i];
    if (t.pts.length < 2 || pathLen(t.pts) <= 0.05) continue;
    yield tick;
    const on = (q: Pt) => copper(t, q);
    const { rs, step } = resample(t.pts, cell);
    if (rs.length < 3) {
      smoothed.push({ t, i });
      continue;
    }
    const sigma = Math.max(SMOOTH_MM, cell);
    const half = Math.ceil((2.5 * sigma) / step);
    const w = Array.from({ length: half + 1 }, (_, k) => Math.exp(-0.5 * ((k * step) / sigma) ** 2));
    const pts: Path = [];
    for (let k = 0; k < rs.length; k++) {
      if (k % 150 === 0) yield tick;
      pts.push(smoothAt(rs, k, half, w, on, cell));
    }
    smoothed.push({ t: { ...t, pts }, i });
  }
  // Longest first, so a shorter line joins the longer one. The drawn list keeps the original order.
  const order = [...smoothed].sort((a, b) => pathLen(b.t.pts) - pathLen(a.t.pts));
  const accepted = new Map<number, Path[]>();
  const placed: (T | undefined)[] = [];
  for (const { t, i } of order) {
    yield tick;
    const acc = accepted.get(t.layer) ?? [];
    const on = (q: Pt) => copper(t, q);
    const pts = acc.length ? cutShared(t.pts, acc, on, cell) : t.pts;
    if (!pts || pathLen(pts) < 0.05) continue;
    const thin = simplifyLine(pts, SMOOTH_TOL_MM);
    // A chord that would cross a hole is left as the smoothed points, which went around it.
    const chordOk = (a: Pt, b: Pt) => [0.25, 0.5, 0.75].every((u) => on({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }));
    const kept: Path = [thin[0]];
    for (let i = 1; i < thin.length; i++) {
      if (chordOk(thin[i - 1], thin[i])) kept.push(thin[i]);
      else {
        const mid = sliceArc(pts, arcOf(pts, thin[i - 1]), arcOf(pts, thin[i]));
        kept.push(...mid.slice(1));
      }
    }
    acc.push(kept);
    accepted.set(t.layer, acc);
    placed[i] = { ...t, pts: kept };
  }
  return placed.filter((t): t is T => !!t);
}
