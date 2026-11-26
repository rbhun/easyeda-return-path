// Loop inductance of a return path, to choose between the ways a return can take round a gap: at
// high frequency the current takes the path of least inductance, not the shortest one.
import { dist, Polyline } from './geom.js';
import type { Path } from './types.js';

/** μ0 / 2π in nH/mm. */
const MU = 0.2;

/**
 * Loop inductance a return path adds against the signal trace it returns, nH. Each piece of the
 * path at lateral distance s from the trace and height h from its layer counts as a pair of
 * parallel conductors: (μ0/2π)·ln(1 + (s² + h²)/r²) per mm, which tends to (μ0/π)·ln(d/r) far from
 * the trace and to zero right under it. r is the trace's half width.
 */
export function pathInductance(path: Path, signal: Polyline, r: number, h: number): number {
  const r2 = Math.max(r, 0.05) ** 2;
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const [a, b] = [path[i - 1], path[i]];
    const d = dist(a, b);
    const n = Math.max(1, Math.ceil(d / 0.1));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const s = dist(p, signal.at(signal.project(p)));
      total += MU * (d / n) * Math.log(1 + (s * s + h * h) / r2);
    }
  }
  return total;
}

/** Partial inductance of a via barrel of the given height and drill, nH: (μ0/2π)·h·(ln(4h/d) + 1). */
export function viaInductance(height: number, drill: number): number {
  if (height <= 0) return 0;
  return MU * height * (Math.log((4 * height) / Math.max(drill, 0.05)) + 1);
}
