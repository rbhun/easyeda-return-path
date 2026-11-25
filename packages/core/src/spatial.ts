// Spatial indexes over polygon edges, so that point-in-region and "does this segment cross the
// boundary" queries do not scan every vertex of a plane with hundreds of antipads.
import { distPointSeg } from './geom.js';
import type { Paths, Pt } from './types.js';

/** Uniform grid of the boundary edges of a region (Clipper-style paths, even-odd). */
export class EdgeGrid {
  readonly edgeCount: number;
  private readonly ex0: Float64Array;
  private readonly ey0: Float64Array;
  private readonly ex1: Float64Array;
  private readonly ey1: Float64Array;
  private readonly x0: number;
  private readonly y0: number;
  private readonly cell: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly cells: Int32Array[];
  private readonly stamp: Int32Array;
  private query = 0;

  constructor(paths: Paths) {
    let n = 0;
    for (const p of paths) n += p.length;
    this.edgeCount = n;
    this.ex0 = new Float64Array(n);
    this.ey0 = new Float64Array(n);
    this.ex1 = new Float64Array(n);
    this.ey1 = new Float64Array(n);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let k = 0;
    for (const p of paths)
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        this.ex0[k] = p[j].x;
        this.ey0[k] = p[j].y;
        this.ex1[k] = p[i].x;
        this.ey1[k] = p[i].y;
        minX = Math.min(minX, p[i].x);
        minY = Math.min(minY, p[i].y);
        maxX = Math.max(maxX, p[i].x);
        maxY = Math.max(maxY, p[i].y);
        k++;
      }
    if (!n) minX = minY = maxX = maxY = 0;
    const side = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(n) / 2)));
    this.cell = Math.max((maxX - minX) / side, (maxY - minY) / side, 1e-6);
    this.x0 = minX - this.cell * 1e-3;
    this.y0 = minY - this.cell * 1e-3;
    this.nx = Math.ceil((maxX - this.x0) / this.cell) + 1;
    this.ny = Math.ceil((maxY - this.y0) / this.cell) + 1;
    const lists: number[][] = Array.from({ length: this.nx * this.ny }, () => []);
    for (let e = 0; e < n; e++) {
      const i0 = this.ci(Math.min(this.ex0[e], this.ex1[e]));
      const i1 = this.ci(Math.max(this.ex0[e], this.ex1[e]));
      const j0 = this.cj(Math.min(this.ey0[e], this.ey1[e]));
      const j1 = this.cj(Math.max(this.ey0[e], this.ey1[e]));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) lists[j * this.nx + i].push(e);
    }
    this.cells = lists.map((l) => Int32Array.from(l));
    this.stamp = new Int32Array(n);
  }

  private ci(x: number) {
    return Math.max(0, Math.min(this.nx - 1, Math.floor((x - this.x0) / this.cell)));
  }
  private cj(y: number) {
    return Math.max(0, Math.min(this.ny - 1, Math.floor((y - this.y0) / this.cell)));
  }

  private visitSegment(a: Pt, b: Pt, fn: (e: number) => boolean): boolean {
    const q = ++this.query;
    // Exact grid traversal (Amanatides–Woo): every cell the segment passes through.
    let i = this.ci(a.x);
    let j = this.cj(a.y);
    const iEnd = this.ci(b.x);
    const jEnd = this.cj(b.y);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const si = dx > 0 ? 1 : -1;
    const sj = dy > 0 ? 1 : -1;
    const tdx = dx ? Math.abs(this.cell / dx) : Infinity;
    const tdy = dy ? Math.abs(this.cell / dy) : Infinity;
    let tx = dx ? ((this.x0 + (i + (si > 0 ? 1 : 0)) * this.cell - a.x) / dx) : Infinity;
    let ty = dy ? ((this.y0 + (j + (sj > 0 ? 1 : 0)) * this.cell - a.y) / dy) : Infinity;
    for (let guard = this.nx + this.ny + 2; guard > 0; guard--) {
      for (const e of this.cells[j * this.nx + i]) {
        if (this.stamp[e] === q) continue;
        this.stamp[e] = q;
        if (fn(e)) return true;
      }
      if (i === iEnd && j === jEnd) break;
      if (tx < ty) {
        i += si;
        tx += tdx;
      } else {
        j += sj;
        ty += tdy;
      }
      if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) break;
    }
    return false;
  }

  /** True if segment ab properly crosses any boundary edge. */
  crosses(a: Pt, b: Pt): boolean {
    const ax = a.x;
    const ay = a.y;
    const ux = b.x - ax;
    const uy = b.y - ay;
    const eps = 1e-12;
    return this.visitSegment(a, b, (e) => {
      const cx = this.ex0[e];
      const cy = this.ey0[e];
      const dx = this.ex1[e];
      const dy = this.ey1[e];
      const d1 = ux * (cy - ay) - uy * (cx - ax);
      const d2 = ux * (dy - ay) - uy * (dx - ax);
      if (!((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps))) return false;
      const vx = dx - cx;
      const vy = dy - cy;
      const d3 = vx * (ay - cy) - vy * (ax - cx);
      const d4 = vx * (b.y - cy) - vy * (b.x - cx);
      return (d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps);
    });
  }

  /** True if p lies within eps of the boundary. */
  nearBoundary(p: Pt, eps: number): boolean {
    const q = ++this.query;
    const i0 = this.ci(p.x - eps);
    const i1 = this.ci(p.x + eps);
    const j0 = this.cj(p.y - eps);
    const j1 = this.cj(p.y + eps);
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: 0 };
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++)
        for (const e of this.cells[j * this.nx + i]) {
          if (this.stamp[e] === q) continue;
          this.stamp[e] = q;
          a.x = this.ex0[e];
          a.y = this.ey0[e];
          b.x = this.ex1[e];
          b.y = this.ey1[e];
          if (distPointSeg(p, a, b) < eps) return true;
        }
    return false;
  }

  /** Even-odd containment: a ray to +x, counting crossings only in the cells of p's row. */
  contains(p: Pt): boolean {
    if (!this.edgeCount) return false;
    const j = Math.floor((p.y - this.y0) / this.cell);
    if (j < 0 || j >= this.ny) return false;
    const q = ++this.query;
    let inside = false;
    for (let i = Math.max(0, this.ci(p.x)); i < this.nx; i++)
      for (const e of this.cells[j * this.nx + i]) {
        if (this.stamp[e] === q) continue;
        this.stamp[e] = q;
        const ay = this.ey1[e];
        const by = this.ey0[e];
        if (ay > p.y !== by > p.y) {
          const ax = this.ex1[e];
          const bx = this.ex0[e];
          if (p.x < ((bx - ax) * (p.y - ay)) / (by - ay) + ax) inside = !inside;
        }
      }
    return inside;
  }
}
