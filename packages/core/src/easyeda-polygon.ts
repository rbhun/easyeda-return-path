import { arcPoints, circle, difference, rect, union } from './geom.js';
import type { Path, Paths, Pt } from './types.js';

type Conv = (x: number, y: number) => Pt;

/**
 * Decode one EasyEDA Pro "single polygon":
 *   x y L x y x y ... ARC angle x y ... CARC angle x y ... C x1 y1 x2 y2 x3 y3 ...
 *   ["R", x, y, w, h, rot, isCCW?, round?]   (x, y = top-left)
 *   ["CIRCLE", cx, cy, r, isCCW?]
 * `scale` converts file units to mm, `conv` maps file coordinates to board mm.
 */
export function decodeSingle(src: unknown[], conv: Conv, scale: number): Path {
  if (!src.length) return [];
  if (src[0] === 'CIRCLE') {
    const [, cx, cy, r] = src as [string, number, number, number];
    return circle(conv(cx, cy), r * scale, 48);
  }
  if (src[0] === 'R') {
    const [, x, y, w, h, rot = 0] = src as [string, number, number, number, number, number];
    // Top-left anchored rectangle rotated around its anchor.
    const tl = conv(x, y);
    const W = w * scale;
    const H = h * scale;
    const r = rect(W / 2, -H / 2, W, H, 0).map((p) => {
      const a = ((rot as number) * Math.PI) / 180;
      return { x: tl.x + p.x * Math.cos(a) - p.y * Math.sin(a), y: tl.y + p.x * Math.sin(a) + p.y * Math.cos(a) };
    });
    return r;
  }
  const out: Path = [];
  let mode = 'L';
  let i = 0;
  const num = () => Number(src[i++]);
  while (i < src.length) {
    const tok = src[i];
    if (typeof tok === 'string') {
      mode = tok;
      i++;
      continue;
    }
    if (!out.length) {
      out.push(conv(num(), num()));
      continue;
    }
    if (mode === 'ARC' || mode === 'CARC') {
      const angle = num();
      const end = conv(num(), num());
      out.push(...arcPoints(out[out.length - 1], end, angle));
    } else if (mode === 'C') {
      const p0 = out[out.length - 1];
      const p1 = conv(num(), num());
      const p2 = conv(num(), num());
      const p3 = conv(num(), num());
      for (let k = 1; k <= 12; k++) {
        const t = k / 12;
        const u = 1 - t;
        out.push({
          x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
          y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
        });
      }
    } else {
      out.push(conv(num(), num()));
    }
  }
  return out;
}

function isComplex(src: unknown[]): src is unknown[][] {
  return Array.isArray(src[0]);
}

/** Complex polygon: first single polygon is the outer frame, the rest are holes. */
export function decodeComplex(src: unknown, conv: Conv, scale: number): Paths {
  if (!Array.isArray(src) || !src.length) return [];
  if (!isComplex(src)) return union([decodeSingle(src, conv, scale)]);
  const rings = src.map((s) => decodeSingle(s as unknown[], conv, scale)).filter((r) => r.length >= 3);
  if (!rings.length) return [];
  return difference(union([rings[0]]), union(rings.slice(1)));
}

/** Raw rings without hole semantics (for strokes and outlines). */
export function decodeRings(src: unknown, conv: Conv, scale: number): Path[] {
  if (!Array.isArray(src) || !src.length) return [];
  if (!isComplex(src)) return [decodeSingle(src, conv, scale)];
  return src.map((s) => decodeSingle(s as unknown[], conv, scale));
}
