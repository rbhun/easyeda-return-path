// A check on top of the solved return. It does not search for a path: it measures the polyline the
// solver drew, grades the excursions and the hops, and turns that into a score. Lengths are mm.
import { isGroundNet, looksLikePowerNet, returnPads } from './dc/rails.js';
import { driverLoop } from './driver.js';
import { add, dist, distPointSeg, distToPaths, lerp, mul, sub } from './geom.js';
import { sameNet } from './nets.js';
import { DEFAULT_HEIGHT_MM } from './returncost.js';
import type { Analysis, ChainResult } from './analyze.js';
import type { Board, Path, Pt } from './types.js';
import type { ReturnTrace, ReturnVia } from './returnpath.js';

const MIL = 0.0254;

export type EdgeClass = 'fast' | 'normal' | 'slow';
export type DriveType = 'push-pull' | 'open-drain';
export type Grade = 'ok' | 'note' | 'flag';
export type Status = 'Good' | 'Fair' | 'Needs work';

/** fast clocks count three times a GPIO; a reset counts half. */
export const EDGE_WEIGHT: Record<EdgeClass, number> = { fast: 3, normal: 1, slow: 0.5 };

export interface CheckProps {
  /** The end this solve started from. Empty: closure is not graded. */
  driver?: string;
  pin?: string;
  edge: EdgeClass;
  drive: DriveType;
}

/** One penalty, before it is multiplied by the edge-class weight. */
interface Term {
  kind: 'deviation' | 'transition' | 'closure' | 'choke';
  /** Penalty = coef × w. A supply-loop term counts only for a push-pull driver. */
  coef: number;
  supply?: boolean;
  text: string;
  fix: string;
  at: Pt;
  grade: Grade;
}

export interface CheckExcursion {
  grade: 'minor' | 'note' | 'flag';
  /** Loop area, mm². */
  dA: number;
  at: Pt;
  layer: number;
  /** The detour the solver drew, and the forward trace beside it. */
  returnPts: Path;
  forwardPts: Path;
  /** Lines across the area between them, for the overlay hatch. */
  hatch: [Pt, Pt][];
  /** A short tick across the forward trace. Set for a minor excursion. */
  tick?: [Pt, Pt];
  blocker?: string;
}

export interface CheckHop {
  at: Pt;
  /** Lateral distance, mm, from the signal via or from where the return left the trace. */
  distance: number;
  grade: Grade;
  /** True when the distance is measured from a via of the signal. */
  fromSignalVia: boolean;
  near: string;
}

export interface CheckClosure {
  kind: 'gnd' | 'vdd';
  at: Pt;
  /** Path length, mm. */
  length: number;
  grade: Grade;
  text: string;
}

export interface CheckError {
  at: Pt;
  pts: Path;
}

export interface CheckChoke {
  at: Pt;
  nets: string[];
  /** Sum of the nets' edge-class weights. */
  severity: number;
  width: number;
}

export interface NetCheck {
  net: string;
  driver: string;
  pin?: string;
  edge: EdgeClass;
  drive: DriveType;
  w: number;
  /** Dielectric height used for the grades, mm. */
  h: number;
  /** Forward length, mm. */
  length: number;
  /** (sum of excursion areas) / (forward length × h), before the edge-class weight. */
  r: number;
  rW: number;
  deviation: Grade;
  excursions: CheckExcursion[];
  hops: CheckHop[];
  closures: CheckClosure[];
  errors: CheckError[];
  chokes: CheckChoke[];
  /** Return polylines with minor detours and out-of-band stretches left out. */
  kept: ReturnTrace[];
  /** The other driver end, when the net was solved twice. Its score is not this row's score. */
  also?: { driver: string; score: number }[];
  terms: Term[];
  score: number;
  status: Status;
}

export interface PointLine {
  points: number;
  text: string;
  fix: string;
  at: Pt;
}

export interface FindingLine {
  type: string;
  at: Pt;
  value: string;
  grade: string;
  text: string;
}

export interface CheckRow {
  net: string;
  driver: string;
  edge: EdgeClass;
  drive: DriveType;
  lengthMm: number;
  r: number;
  rW: number;
  score: number;
  status: Status;
  points: PointLine[];
  findings: FindingLine[];
  also?: { driver: string; score: number }[];
}

export interface CheckView {
  header: string;
  score: number;
  status: Status;
  rows: CheckRow[];
}

const SLOW = /(^|_)(RESET|NRESET|NRST|RST|UART|I2C|SDA|SCL)(\d|$|_)|(^|_)(TXD?|RXD?)\d*$/i;
const FAST = /(^|_)(SCK|SCLK|BCLK|BCK|WCLK|LRCLK|LRCK|MCLK|MCK|XTAL|OSC|CLK|CLOCK)(\d|$|_)/i;
const OPEN = /(^|_)(I2C|SDA|SCL|IRQ|NIRQ|INT|NINT|ALERT)(\d|$|_)/i;

/** Edge class from the net name. A clock is fast, a chip-select is normal, a reset is slow. */
export function guessEdge(net: string): EdgeClass {
  const n = net.toUpperCase().replace(/[\s.-]+/g, '_');
  if (SLOW.test(n)) return 'slow';
  if (FAST.test(n) && !/(^|_)SCL(\d|$|_)/.test(n)) return 'fast';
  return 'normal';
}

/** Push-pull, unless the name is an open-drain bus or a resistor pulls the net up to a rail. */
export function guessDrive(board: Board, net: string): DriveType {
  if (OPEN.test(net.toUpperCase().replace(/[\s.-]+/g, '_'))) return 'open-drain';
  const comps = new Map(board.components.map((c) => [c.id, c]));
  const by = new Map<string, { net?: string }[]>();
  for (const p of board.pads) {
    const c = p.componentId ? comps.get(p.componentId) : undefined;
    if (!c || !/^R\d/i.test(c.designator) || c.padIds.length > 2) continue;
    const list = by.get(c.id) ?? [];
    list.push(p);
    by.set(c.id, list);
  }
  for (const pads of by.values()) {
    if (pads.length !== 2) continue;
    const on = pads.some((p) => p.net && sameNet(p.net, net));
    const other = pads.find((p) => p.net && !sameNet(p.net, net));
    if (on && other?.net && looksLikePowerNet(other.net)) return 'open-drain';
  }
  return 'push-pull';
}

export function statusOf(score: number): Status {
  if (score >= 90) return 'Good';
  if (score >= 70) return 'Fair';
  return 'Needs work';
}

function rwGrade(rw: number): Grade {
  if (rw < 0.25) return 'ok';
  if (rw < 1) return 'note';
  return 'flag';
}

function hopGrade(d: number, h: number): Grade {
  if (d < h) return 'ok';
  if (d <= 3 * h) return 'note';
  return 'flag';
}

interface Seg { a: Pt; b: Pt; dir: Pt }

function forwardSegs(chains: ChainResult[]): Seg[] {
  const out: Seg[] = [];
  for (const c of chains) {
    const pts = c.chain.pts;
    for (let i = 1; i < pts.length; i++) {
      const d = sub(pts[i], pts[i - 1]);
      const l = Math.hypot(d.x, d.y);
      if (l < 1e-9) continue;
      out.push({ a: pts[i - 1], b: pts[i], dir: { x: d.x / l, y: d.y / l } });
    }
  }
  return out;
}

function nearestForward(p: Pt, segs: Seg[]): { d: number; at: Pt; dir: Pt } {
  let bestD = Infinity;
  let at = p;
  let dir = { x: 1, y: 0 };
  for (const s of segs) {
    const ab = sub(s.b, s.a);
    const l2 = ab.x * ab.x + ab.y * ab.y;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - s.a.x) * ab.x + (p.y - s.a.y) * ab.y) / l2)) : 0;
    const q = add(s.a, mul(ab, t));
    const d = dist(p, q);
    if (d < bestD) {
      bestD = d;
      at = q;
      dir = s.dir;
    }
  }
  return { d: bestD, at, dir };
}

function pathLength(pts: Path): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += dist(pts[i - 1], pts[i]);
  return n;
}

interface Rpt extends Pt { layer: number }

/**
 * The drawn return as one or more walks. Vertices of one trace are one segment however far apart
 * they are. A via joins the traces that meet there; a gap of more than 0.4 mm between traces starts
 * a new walk.
 */
function walks(traces: ReturnTrace[]): Rpt[][] {
  const out: Rpt[][] = [];
  let cur: Rpt[] = [];
  const flush = () => {
    if (cur.length > 1) out.push(cur);
    cur = [];
  };
  for (const t of traces) {
    if (!t.pts.length) continue;
    if (cur.length && dist(cur[cur.length - 1], t.pts[0]) > 0.4) flush();
    for (const p of t.pts) {
      if (!cur.length || dist(cur[cur.length - 1], p) > 1e-6) cur.push({ ...p, layer: t.layer });
    }
  }
  flush();
  return out;
}

interface Sample extends Rpt {
  /** Which walk of the return this sample belongs to. Arc length restarts on the next walk. */
  walk: number;
  s: number;
  d: number;
  foot: Pt;
  dir: Pt;
}

function samplesOf(pts: Rpt[], segs: Seg[], step: number, walk: number): Sample[] {
  const out: Sample[] = [];
  const addAt = (p: Rpt, s: number) => {
    const n = nearestForward(p, segs);
    out.push({ ...p, walk, s, d: n.d, foot: n.at, dir: n.dir });
  };
  if (!pts.length) return out;
  addAt(pts[0], 0);
  let acc = 0;
  let next = step;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const L = dist(a, b);
    while (next <= acc + L + 1e-9) {
      const t = L ? (next - acc) / L : 0;
      addAt({ ...lerp(a, b, Math.max(0, Math.min(1, t))), layer: t < 0.5 ? a.layer : b.layer }, next);
      next += step;
    }
    acc += L;
  }
  if (dist(out[out.length - 1], pts[pts.length - 1]) > 1e-6) addAt(pts[pts.length - 1], acc);
  return out;
}

function areaOf(s: Sample[], i: number, j: number): number {
  let a = 0;
  for (let k = i; k < j - 1; k++) a += 0.5 * (s[k].d + s[k + 1].d) * Math.max(0, s[k + 1].s - s[k].s);
  return a;
}

function nearPart(board: Board, at: Pt): string {
  let best = '';
  let d = 12;
  for (const c of board.components) {
    const dd = dist(c.at, at);
    if (dd < d) {
      d = dd;
      best = c.designator;
    }
  }
  return best;
}

/**
 * A foreign trace the detour runs along, so the report can name what to move. A single crossing
 * is a nearer point but not the trace the return is going around, so a net that stays beside the
 * detour wins over the one closest point.
 */
function blockerOf(board: Board, net: string, pts: Pt[]): string | undefined {
  const stride = Math.max(1, Math.floor(pts.length / 80));
  const acc = new Map<string, { best: number; along: number }>();
  for (const t of board.tracks) {
    if (!t.net || sameNet(t.net, net) || isGroundNet(t.net)) continue;
    let row = acc.get(t.net);
    for (let i = 0; i < pts.length; i += stride) {
      const d = distPointSeg(pts[i], t.a, t.b);
      if (d > 1.2 && row === undefined) continue;
      if (!row) {
        row = { best: Infinity, along: 0 };
        acc.set(t.net, row);
      }
      if (d < row.best) row.best = d;
      if (d < 0.5) row.along++;
    }
  }
  let beside: { net: string; along: number } | undefined;
  let near: { net: string; d: number } | undefined;
  for (const [name, row] of acc) {
    if (row.best < 1.2 && (!near || row.best < near.d)) near = { net: name, d: row.best };
    if (row.along >= 3 && (!beside || row.along > beside.along)) beside = { net: name, along: row.along };
  }
  return beside?.net ?? near?.net;
}

function heightOf(chains: ChainResult[]): number {
  let best = 0;
  let h = 0;
  for (const c of chains) {
    const len = pathLength(c.chain.pts);
    if (c.ref && len >= best) {
      best = len;
      h = c.ref.h;
    }
  }
  return h > 0 ? h : DEFAULT_HEIGHT_MM;
}

function forwardLength(chains: ChainResult[]): number {
  return chains.reduce((s, c) => s + pathLength(c.chain.pts), 0);
}

interface Built {
  excursions: CheckExcursion[];
  errors: CheckError[];
  samples: Sample[];
}

function measure(board: Board, net: string, chains: ChainResult[], traces: ReturnTrace[], h: number, pin?: Pt): Built {
  const segs = forwardSegs(chains);
  const step = Math.min(0.1, Math.max(0.04, h / 20));
  const leave = 0.25 * h;
  const excursions: CheckExcursion[] = [];
  const errors: CheckError[] = [];
  const samples: Sample[] = [];
  for (const [wi, walk] of walks(traces).entries()) samples.push(...samplesOf(walk, segs, step, wi));
  // The solve starts at the driver ground pad. Up to the driver pin that lead is the closure,
  // graded on its own, so it is not also a loop-area excursion.
  let i = 0;
  if (pin && samples.length) {
    let best = Infinity;
    for (let k = 0; k < samples.length; k++) {
      const d = dist(samples[k], pin);
      if (d < best) {
        best = d;
        i = k;
      }
    }
  }
  while (i < samples.length) {
      if (samples[i].d <= leave) {
        i++;
        continue;
      }
      let j = i;
      const walk = samples[i].walk;
      while (j < samples.length && samples[j].walk === walk && samples[j].d > leave) j++;
      const rejoins = j < samples.length && samples[j].walk === walk;
      if (rejoins) {
        const slice = samples.slice(i, j);
        const dA = areaOf(samples, i, j);
        const h2 = h * h;
        const grade: CheckExcursion['grade'] = dA < h2 ? 'minor' : dA < 9 * h2 ? 'note' : 'flag';
        let peak = slice[0];
        for (const p of slice) if (p.d > peak.d) peak = p;
        const layer = peak.layer;
        const returnPts = slice.map((p) => ({ x: p.x, y: p.y }));
        const forwardPts = slice.map((p) => p.foot);
        const hatch: [Pt, Pt][] = [];
        let acc = 0;
        for (let k = 1; k < slice.length && hatch.length < 60; k++) {
          acc += Math.abs(slice[k].s - slice[k - 1].s);
          if (acc >= 0.45) {
            hatch.push([slice[k], slice[k].foot]);
            acc = 0;
          }
        }
        const n = { x: -peak.dir.y, y: peak.dir.x };
        const tick: [Pt, Pt] | undefined = grade === 'minor'
          ? [add(peak.foot, mul(n, 0.35)), add(peak.foot, mul(n, -0.35))]
          : undefined;
        excursions.push({
          grade,
          dA,
          at: peak.foot,
          layer,
          returnPts,
          forwardPts,
          hatch,
          tick,
          blocker: blockerOf(board, net, returnPts),
        });
      }
      else {
        const out = samples.slice(i, j).filter((p) => p.d > h);
        if (out.length > 1) errors.push({ at: out[Math.floor(out.length / 2)], pts: out.map((p) => ({ x: p.x, y: p.y })) });
      }
      i = Math.max(j, i + 1);
    }
  return { excursions, errors, samples };
}

function onPath(pts: Path, p: Pt, tol: number): boolean {
  for (let i = 1; i < pts.length; i++) if (distPointSeg(p, pts[i - 1], pts[i]) <= tol) return true;
  return dist(pts[0], p) <= tol;
}

function keptTraces(traces: ReturnTrace[], excursions: CheckExcursion[], errors: CheckError[], segs: Seg[], h: number): ReturnTrace[] {
  const minors = excursions.filter((e) => e.grade === 'minor').map((e) => e.returnPts);
  const bad = errors.map((e) => e.pts);
  const drop = (p: Pt) => {
    const d = nearestForward(p, segs).d;
    if (d > h && bad.some((pts) => onPath(pts, p, 0.15))) return true;
    return d > 0.2 * h && minors.some((pts) => onPath(pts, p, 0.15));
  };
  const out: ReturnTrace[] = [];
  for (const t of traces) {
    let run: Path = [];
    const flush = () => {
      if (run.length > 1) out.push({ ...t, pts: run });
      run = [];
    };
    for (const p of t.pts) {
      if (drop(p)) flush();
      else run.push(p);
    }
    flush();
  }
  return out;
}

function signalVias(board: Board, net: string): Pt[] {
  return [
    ...board.vias.filter((v) => sameNet(v.net, net)).map((v) => v.at),
    ...board.pads.filter((p) => sameNet(p.net, net) && p.holeDiameter > 0).map((p) => p.at),
  ];
}

function hopsOf(board: Board, net: string, transitions: ReturnVia[], samples: Sample[], h: number): CheckHop[] {
  if (!samples.length) return [];
  const vias = signalVias(board, net);
  return transitions.map((v) => {
    let leave: Pt = v.at;
    let best = Infinity;
    let idx = 0;
    for (let i = 0; i < samples.length; i++) {
      const d = dist(samples[i], v.at);
      if (d < best) {
        best = d;
        idx = i;
      }
    }
    let found = false;
    for (let i = idx; i >= 0 && samples[i].walk === samples[idx].walk; i--) {
      if (samples[i].d <= 0.25 * h) {
        leave = samples[i];
        found = true;
        break;
      }
    }
    // Never on the trace before the hop: the lateral distance is from the via to the forward path.
    if (!found) leave = samples[idx].foot;
    let from = leave;
    let fromSignalVia = false;
    let sigD = Infinity;
    for (const s of vias) {
      const d = dist(s, v.at);
      if (d < sigD) {
        sigD = d;
        from = s;
      }
    }
    // A signal via only counts when it is this hop's via. Farther than 3h, measure from where the return left the trace.
    if (sigD <= 3 * h) fromSignalVia = true;
    else from = leave;
    const near = nearPart(board, v.at);
    return { at: v.at, distance: dist(from, v.at), grade: hopGrade(dist(from, v.at), h), fromSignalVia, near };
  });
}

function groundTargets(board: Board, driver: string): Pt[] {
  const comp = board.components.find((c) => c.designator === driver);
  if (!comp) return [];
  const own = board.pads.filter((p) => p.componentId === comp.id);
  const grounds = [...new Set(own.map((p) => p.net).filter((n): n is string => !!n && isGroundNet(n)))];
  const pads = grounds.flatMap((g) => returnPads(own, g).pads);
  const targets = pads.map((p) => p.at);
  for (const p of pads) {
    for (const v of board.vias) if (sameNet(v.net, p.net) && dist(v.at, p.at) < 2) targets.push(v.at);
    for (const q of own) if (q.holeDiameter > 0 && q.net && isGroundNet(q.net)) targets.push(q.at);
  }
  return targets;
}

function nearestSample(samples: Sample[], at: Pt): Sample | undefined {
  let best: Sample | undefined;
  let d = Infinity;
  for (const s of samples) {
    const dd = dist(s, at);
    if (dd < d) {
      d = dd;
      best = s;
    }
  }
  return best;
}

function closuresOf(board: Board, net: string, driver: string | undefined, drive: DriveType, samples: Sample[], h: number): CheckClosure[] {
  if (!driver) return [];
  const comp = board.components.find((c) => c.designator === driver);
  const pin = comp && board.pads.find((p) => p.componentId === comp.id && sameNet(p.net, net));
  const out: CheckClosure[] = [];
  const gnds = groundTargets(board, driver);
  if (pin && gnds.length && samples.length) {
    const atPin = nearestSample(samples, pin.at)!;
    const here = samples.filter((s) => s.walk === atPin.walk);
    let gap = Infinity;
    let atGnd = atPin;
    let gndAt = gnds[0];
    for (const g of gnds) {
      const s = nearestSample(here, g) ?? atPin;
      const d = dist(s, g);
      if (d < gap) {
        gap = d;
        atGnd = s;
        gndAt = g;
      }
    }
    const length = Math.abs(atPin.s - atGnd.s) + gap;
    const grade = hopGrade(length, h);
    out.push({
      kind: 'gnd',
      at: gndAt,
      length,
      grade,
      text: `${driver} ground is ${length.toFixed(1)} mm from the pin`,
    });
  }
  else if (driver) {
    out.push({ kind: 'gnd', at: pin?.at ?? { x: 0, y: 0 }, length: Infinity, grade: 'flag', text: `${driver} has no ground pad on the reference copper` });
  }
  // Computed for both drive types. The score counts it only for push-pull, so a stored check
  // can be rescored when the user changes the drive type without solving again.
  if (!pin) return out;
  const refNet = comp && board.pads.find((p) => p.componentId === comp.id && p.net && isGroundNet(p.net))?.net;
  if (!refNet) return out;
  const loop = driverLoop(board, driver, net, refNet);
  if (!loop?.supplyPin) return out;
  if (!loop.decap) {
    out.push({ kind: 'vdd', at: loop.supplyPin.at, length: Infinity, grade: 'flag', text: `No decap from ${driver} ${loop.supplyPin.net} to ${refNet}` });
    return out;
  }
  const pours = board.pours.filter((p) => sameNet(p.net, refNet)).flatMap((p) => (p.poured?.length ? p.poured : p.outline));
  const gap = loop.decap.refPad.net && sameNet(loop.decap.refPad.net, refNet) ? 0 : (pours.length ? distToPaths(loop.decap.refPad.at, pours) : 0);
  const length = dist(loop.supplyPin.at, loop.decap.supplyPad.at) + gap;
  out.push({
    kind: 'vdd',
    at: loop.decap.component.at,
    length,
    grade: hopGrade(length, h),
    text: `${driver} supply decap ${loop.decap.component.designator} is ${length.toFixed(1)} mm from the pin`,
  });
  return out;
}

function mil2(mm2: number): number {
  return mm2 / (MIL * MIL);
}

function deviationText(e: CheckExcursion, near: string): string {
  const area = `${e.dA.toFixed(1)} mm²`;
  const where = near ? ` near ${near}` : '';
  return e.blocker
    ? `Return detours around ${e.blocker}${where} (${area} extra loop)`
    : `Return leaves the trace${where} (${area} extra loop)`;
}

function termsOf(check: Omit<NetCheck, 'terms' | 'score' | 'status' | 'rW' | 'deviation'> & { r: number }): Term[] {
  const hTxt = check.h.toFixed(1);
  const terms: Term[] = [];
  const share = check.length * check.h;
  for (const e of check.excursions) {
    const near = '';
    terms.push({
      kind: 'deviation',
      coef: share > 0 ? e.dA / share : 0,
      text: deviationText(e, near),
      fix: e.blocker ? `move ${e.blocker} or stitch GND across it` : 'stitch GND across the gap',
      at: e.at,
      grade: e.grade === 'flag' ? 'flag' : e.grade === 'note' ? 'note' : 'ok',
    });
  }
  for (const hop of check.hops) {
    if (hop.grade === 'ok') continue;
    const from = hop.fromSignalVia ? 'signal via' : 'where the return leaves the trace';
    const place = hop.near ? ` near ${hop.near}` : '';
    terms.push({
      kind: 'transition',
      coef: hop.grade === 'flag' ? 0.5 : 0.1,
      text: `Return via ${hop.distance.toFixed(1)} mm from ${from}${place}`,
      fix: `add a GND via within ~${hTxt} mm`,
      at: hop.at,
      grade: hop.grade,
    });
  }
  for (const c of check.closures) {
    if (c.grade === 'ok') continue;
    const flagged = c.grade === 'flag';
    terms.push({
      kind: 'closure',
      coef: flagged ? 0.5 : 0.1,
      supply: c.kind === 'vdd',
      text: c.text,
      fix: c.kind === 'gnd' ? `add GND vias at ${check.driver} pad` : `add a decap within ~${hTxt} mm of ${check.driver}`,
      at: c.at,
      grade: c.grade,
    });
  }
  return terms;
}

function active(terms: Term[], drive: DriveType): Term[] {
  return terms.filter((t) => t.coef > 0 && !(t.supply && drive === 'open-drain'));
}

function scored(terms: Term[], w: number, drive: DriveType): { P: number; score: number; lines: PointLine[] } {
  const use = active(terms, drive);
  const ps = use.map((t) => t.coef * w);
  const P = ps.reduce((s, p) => s + p, 0);
  const score = Math.round(100 / (1 + P));
  const lost = 100 - score;
  const raw = ps.map((p) => (P > 0 ? (lost * p) / P : 0));
  const floors = raw.map((r) => Math.floor(r));
  let left = lost - floors.reduce((s, n) => s + n, 0);
  const order = raw.map((r, i) => ({ i, f: r - floors[i] })).sort((a, b) => b.f - a.f);
  for (const o of order) {
    if (left <= 0) break;
    floors[o.i]++;
    left--;
  }
  const lines = use.map((t, i) => ({ points: floors[i], text: t.text, fix: t.fix, at: t.at }))
    .filter((l) => l.points > 0)
    .sort((a, b) => b.points - a.points);
  return { P, score, lines };
}

function finish(check: Omit<NetCheck, 'score' | 'status' | 'rW' | 'deviation'>): NetCheck {
  const rW = check.r * check.w;
  const { score } = scored(check.terms, check.w, check.drive);
  return { ...check, rW, deviation: rwGrade(rW), score, status: statusOf(score) };
}

/**
 * Grades one solved return. `props.driver` is the end the solve started from; a bidirectional net
 * is solved once per end and the worse score is kept by `worseEnd`.
 */
function driverPinAt(board: Board, net: string, driver: string | undefined): Pt | undefined {
  if (!driver) return undefined;
  const comp = board.components.find((c) => c.designator === driver);
  return comp && board.pads.find((p) => p.componentId === comp.id && sameNet(p.net, net))?.at;
}

export function checkReturn(board: Board, analysis: Analysis, props: CheckProps): NetCheck {
  const h = heightOf(analysis.chains);
  const length = forwardLength(analysis.chains);
  const pinAt = driverPinAt(board, analysis.net, props.driver);
  const built = measure(board, analysis.net, analysis.chains, analysis.returnPath.traces, h, pinAt);
  const segs = forwardSegs(analysis.chains);
  const hops = hopsOf(board, analysis.net, analysis.returnPath.transitions, built.samples, h);
  const closures = closuresOf(board, analysis.net, props.driver, props.drive, built.samples, h);
  const kept = keptTraces(analysis.returnPath.traces, built.excursions, built.errors, segs, h);
  const sumA = built.excursions.reduce((s, e) => s + e.dA, 0);
  const r = length > 0 && h > 0 ? sumA / (length * h) : 0;
  const pin = props.pin;
  const partial = {
    net: analysis.net,
    driver: props.driver ?? '',
    pin,
    edge: props.edge,
    drive: props.drive,
    w: EDGE_WEIGHT[props.edge],
    h,
    length,
    r,
    excursions: built.excursions,
    hops,
    closures,
    errors: built.errors,
    chokes: [] as CheckChoke[],
    kept,
  };
  // The place name is filled once the terms exist, from the same point.
  const terms = termsOf({ ...partial, excursions: partial.excursions }).map((t) => {
    if (t.kind !== 'deviation') return t;
    const e = partial.excursions.find((x) => x.at === t.at);
    const near = e ? nearPart(board, e.at) : '';
    return e ? { ...t, text: deviationText(e, near) } : t;
  });
  return finish({ ...partial, terms });
}

/** Keeps the worse driver end as the net's score, and names the other end beside it. */
export function worseEnd(checks: NetCheck[]): NetCheck {
  if (checks.length <= 1) return checks[0];
  const worst = checks.reduce((a, b) => (a.score <= b.score ? a : b));
  const also = checks.filter((c) => c !== worst).map((c) => ({ driver: c.driver, score: c.score }));
  return { ...worst, driver: checks.map((c) => c.driver).filter(Boolean).join(' / '), also };
}

function pourPaths(board: Board, layer: number): Path[] {
  return board.pours.filter((p) => p.layer === layer && isGroundNet(p.net)).flatMap((p) => (p.poured?.length ? p.poured : p.outline));
}

function copperWidth(paths: Path[], at: Pt, dir: Pt): number {
  if (!paths.length || distToPaths(at, paths) > 0.05) return Infinity;
  const n = { x: -dir.y, y: dir.x };
  let width = 0;
  for (const sign of [-1, 1]) {
    for (let s = 0.05; s < 40; s += 0.05) {
      const q = { x: at.x + n.x * sign * s, y: at.y + n.y * sign * s };
      if (distToPaths(q, paths) > 0.05) break;
      width += 0.05;
    }
  }
  return width;
}

/**
 * Excursions of two or more nets that share a copper neck narrower than h. Replaces any choke
 * terms already on the checks, then rescores.
 */
export function assignChokes(board: Board, checks: NetCheck[]): NetCheck[] {
  const h = checks.reduce((m, c) => Math.min(m, c.h), checks[0]?.h ?? DEFAULT_HEIGHT_MM);
  const cell = Math.max(0.3, h / 2);
  interface Hit { net: string; w: number; x: number; y: number; layer: number; dx: number; dy: number }
  const hits: Hit[] = [];
  for (const c of checks) {
    for (const e of c.excursions) {
      const pts = e.returnPts;
      for (let i = 0; i < pts.length; i += Math.max(1, Math.floor(pts.length / 40))) {
        const p = pts[i];
        const q = pts[Math.min(pts.length - 1, i + 1)];
        const d = sub(q, p);
        const l = Math.hypot(d.x, d.y) || 1;
        hits.push({ net: c.net, w: c.w, x: p.x, y: p.y, layer: e.layer, dx: d.x / l, dy: d.y / l });
      }
    }
  }
  const key = (h: Hit) => `${h.layer}:${Math.round(h.x / cell)}:${Math.round(h.y / cell)}`;
  const groups = new Map<string, Hit[]>();
  for (const h of hits) {
    const k = key(h);
    const list = groups.get(k) ?? [];
    list.push(h);
    groups.set(k, list);
  }
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    const p = parent.get(k);
    if (!p || p === k) return k;
    const r = find(p);
    parent.set(k, r);
    return r;
  };
  const unite = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const k of groups.keys()) parent.set(k, k);
  for (const k of groups.keys()) {
    const [layer, ix, iy] = k.split(':').map(Number);
    for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) {
      const n = `${layer}:${ix + dx}:${iy + dy}`;
      if (groups.has(n)) unite(k, n);
    }
  }
  const clusters = new Map<string, Hit[]>();
  for (const [k, list] of groups) {
    const r = find(k);
    const cur = clusters.get(r) ?? [];
    cur.push(...list);
    clusters.set(r, cur);
  }
  const chokes: CheckChoke[] = [];
  for (const list of clusters.values()) {
    const nets = [...new Set(list.map((h) => h.net))];
    if (nets.length < 2) continue;
    let dx = 0;
    let dy = 0;
    for (const h of list) {
      dx += h.dx;
      dy += h.dy;
    }
    const l = Math.hypot(dx, dy) || 1;
    const dir = { x: dx / l, y: dy / l };
    let best = Infinity;
    let at = { x: list[0].x, y: list[0].y };
    const seen = new Set<string>();
    for (const h of list) {
      const id = `${h.layer}:${h.x.toFixed(2)}:${h.y.toFixed(2)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const w = copperWidth(pourPaths(board, h.layer), h, dir);
      if (w < best) {
        best = w;
        at = h;
      }
    }
    if (!(best < h)) continue;
    const weights = new Map<string, number>();
    for (const h of list) weights.set(h.net, h.w);
    const severity = [...weights.values()].reduce((s, w) => s + w, 0);
    if (chokes.some((c) => dist(c.at, at) < h)) continue;
    chokes.push({ at, nets, severity, width: best });
  }
  return checks.map((c) => {
    const mine = chokes.filter((k) => k.nets.includes(c.net));
    const terms = c.terms.filter((t) => t.kind !== 'choke');
    for (const k of mine) {
      const others = k.nets.filter((n) => n !== c.net);
      terms.push({
        kind: 'choke',
        coef: 0.2,
        text: `Shares a narrow spot with ${others.join(', ')}`,
        fix: 'separate these returns or widen the copper',
        at: k.at,
        grade: 'note',
      });
    }
    return finish({ ...c, chokes: mine, terms });
  });
}

/** A stored check after the user changes the edge class or the drive type. The path is not re-solved. */
export function withProps(check: NetCheck, patch: { edge?: EdgeClass; drive?: DriveType }): NetCheck {
  const edge = patch.edge ?? check.edge;
  const drive = patch.drive ?? check.drive;
  return finish({ ...check, edge, drive, w: EDGE_WEIGHT[edge] });
}

function place(p: Pt): string {
  return `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`;
}

export function findingsOf(check: NetCheck): FindingLine[] {
  const out: FindingLine[] = [];
  for (const e of check.excursions) {
    out.push({
      type: e.grade === 'minor' ? 'minor' : 'excursion',
      at: e.at,
      value: `${e.dA.toFixed(1)} mm² (${mil2(e.dA).toFixed(0)} mil²)`,
      grade: e.grade,
      text: deviationText(e, nearFrom(check, e.at)),
    });
  }
  for (const hop of check.hops) {
    if (hop.grade === 'ok') continue;
    out.push({
      type: hop.grade === 'flag' ? 'missing return via' : 'return via',
      at: hop.at,
      value: `${hop.distance.toFixed(2)} mm`,
      grade: hop.grade,
      text: check.terms.find((t) => t.kind === 'transition' && t.at === hop.at)?.text ?? `Return via ${hop.distance.toFixed(1)} mm`,
    });
  }
  for (const c of check.closures) {
    if (c.grade === 'ok') continue;
    if (c.kind === 'vdd' && check.drive === 'open-drain') continue;
    out.push({
      type: c.kind === 'gnd' ? 'driver ground' : 'driver supply',
      at: c.at,
      value: Number.isFinite(c.length) ? `${c.length.toFixed(2)} mm` : 'none',
      grade: c.grade,
      text: c.text,
    });
  }
  for (const e of check.errors) {
    out.push({ type: 'solver error', at: e.at, value: `${e.pts.length} points`, grade: 'flag', text: 'Return runs outside ±h and is not an excursion' });
  }
  for (const k of check.chokes) {
    out.push({
      type: 'choke point',
      at: k.at,
      value: `${k.nets.length} nets, severity ${k.severity.toFixed(1)}`,
      grade: 'note',
      text: `Shares a narrow spot with ${k.nets.filter((n) => n !== check.net).join(', ')}`,
    });
  }
  return out;
}

function nearFrom(check: NetCheck, at: Pt): string {
  const t = check.terms.find((x) => x.kind === 'deviation' && dist(x.at, at) < 1e-6);
  const m = t?.text.match(/near ([A-Z]+\d+)/);
  return m?.[1] ?? '';
}

export function pointsOf(check: NetCheck): PointLine[] {
  return scored(check.terms, check.w, check.drive).lines;
}

/** Board score: the average of the net scores weighted by edge class, and the three worst nets. */
export function viewOf(checks: NetCheck[]): CheckView {
  const wsum = checks.reduce((s, c) => s + c.w, 0);
  const score = wsum ? Math.round(checks.reduce((s, c) => s + c.score * c.w, 0) / wsum) : 100;
  const status = statusOf(score);
  const worst = [...checks].sort((a, b) => a.score - b.score || b.w - a.w).slice(0, 3);
  const header = `Return paths: ${score}/100 — ${status}. Worst: ${worst.map((c) => `${c.net} ${c.score}`).join(', ')}.`;
  const rows: CheckRow[] = [...checks]
    .sort((a, b) => a.score - b.score || a.net.localeCompare(b.net))
    .map((c) => ({
      net: c.net,
      driver: c.driver,
      edge: c.edge,
      drive: c.drive,
      lengthMm: c.length,
      r: c.r,
      rW: c.rW,
      score: c.score,
      status: c.status,
      points: pointsOf(c),
      findings: findingsOf(c),
      also: c.also,
    }));
  return { header, score, status, rows };
}

/** The lines under a net in the text report: the deductions, then each finding. */
export function reportLines(check: NetCheck): string[] {
  const lines = [`${check.net}: ${check.score}/100 ${check.status}, r ${check.r.toFixed(3)}, r_w ${check.rW.toFixed(3)}, driver ${check.driver || '—'}, ${check.edge}, ${check.drive}.`];
  for (const p of pointsOf(check)) lines.push(`-${p.points}  ${p.text}`, `    ${p.fix}`);
  for (const f of findingsOf(check)) lines.push(`${f.grade} ${f.type} ${place(f.at)}: ${f.value} — ${f.text}`);
  for (const a of check.also ?? []) lines.push(`Other end ${a.driver}: ${a.score}/100.`);
  return lines;
}

