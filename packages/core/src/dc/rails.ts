// Wizard step 1 (design decisions D3, D7): guess power rails, their grounds, the source of each
// rail and its loads from net names, part names and designators. The user confirms or corrects.
import { dist } from '../geom.js';
import type { Board, Component, Pad } from '../types.js';

const bare = (net: string) => net.replace(/^[/\\]+/, '').trim();

const GROUND_RE = /^(?:(?:\w*[_-])?[A-Z]{0,2}GND\w*|VSS\w*|0V|EARTH|PE)$/i;
const POWER_RE =
  /^(?:[+-]?\d+(?:\.\d+)?V\d*\w*|P\d+V\d*\w*|V\d+V\d*\w*|\w*_\+?\d+V\d*|[A-Z]?V(?:CC|DD)\w*|V(?:IN|BUS|BAT|BATT|SYS|USB|EXT|DC|IO|CORE|MOT|LED|PP|OUT)\w*|BAT\+?|BATT\+?|DC_?IN\w*)$/i;
const INPUT_RE = /^(?:V(?:IN|BUS|BAT|BATT|USB|SYS|EXT|DC)\w*|BATT?\+?|DC_?IN\w*)$/i;

/** Pin names of a regulator's output and input. */
const OUT_PIN_RE = /^(?:V?OUT\d*|VO|SW|LX|VREG)$/i;
const IN_PIN_RE = /^(?:V?IN\d*|VI|VCC|VDD|PVIN|AVIN)$/i;
const REGULATOR_NAME_RE =
  /LDO|REGULATOR|AMS1117|LM1117|LD1117|NCP1117|LM317|LM78|L78|78[0-9]{2}|XC62|RT90|RT80|AP211|AP736|AP2127|MCP17|TLV7|HT7[0-9]|ME62|SPX3819|TPS[0-9]|LM259|MP[0-9]{4}|SY80|BUCK|BOOST|DC-?DC/i;
const REGULATOR_DES_RE = /^(?:VR|REG|PS)\d/i;
const CONNECTOR_DES_RE = /^(?:J|P|CN|CON|X|USB)\d/i;
const BATTERY_DES_RE = /^(?:BT|BAT)\d/i;
const INDUCTOR_DES_RE = /^(?:L|FB)\d/i;
const SW_NET_RE = /^(?:SW|LX)\w*$/i;
const CAP_DES_RE = /^C\d/i;

export const isGroundNet = (net: string) => GROUND_RE.test(bare(net));
export const isInputRail = (net: string) => INPUT_RE.test(bare(net));
export const looksLikePowerNet = (net: string) => !isGroundNet(net) && POWER_RE.test(bare(net));

/** Nominal voltage from a net name: 3V3 → 3.3, +5V → 5, 1.8V → 1.8, VBUS → 5, VBAT → 3.7. */
export function railVoltage(net: string): number | undefined {
  const n = bare(net).toUpperCase();
  let m = /(\d+)V(\d+)/.exec(n);
  if (m) return Number(`${m[1]}.${m[2]}`);
  m = /(\d+(?:\.\d+)?)V/.exec(n);
  if (m) return Number(m[1]);
  if (/^V(?:BUS|USB)/.test(n)) return 5;
  if (/^V?BATT?/.test(n)) return 3.7;
  return undefined;
}

export type SourceKind = 'regulator' | 'connector' | 'battery' | 'other';

export interface SourceCandidate {
  componentId: string;
  designator: string;
  kind: SourceKind;
  reason: string;
}

export interface LoadGuess {
  componentId: string;
  designator: string;
  /** Connector or battery on the rail acting as a load (D7: connectors can be either). */
  connector: boolean;
}

export interface RailGuess {
  net: string;
  /** Why it was taken for a power rail. */
  reason: 'name' | 'pour';
  voltage?: number;
  ground?: string;
  /** Guessed active source; undefined means the wizard must ask. */
  source?: SourceCandidate;
  /** Every component that could be the source; the wizard offers these first. */
  candidates: SourceCandidate[];
  rule: 'regulator' | 'connector' | 'ask';
  askReason?: string;
  /** Loads for the guessed source (or for no source when asking). */
  loads: LoadGuess[];
  /** Components on the rail left out of the DC solve: decaps (block DC) and the other candidate sources. */
  excluded: { designator: string; why: string }[];
}

export interface RailsGuess {
  grounds: string[];
  rails: RailGuess[];
}

export function padsOf(board: Board, c: Component): Pad[] {
  const ids = new Set(c.padIds);
  return board.pads.filter((p) => ids.has(p.id));
}

function netsOf(board: Board): string[] {
  return [...new Set([...board.nets, ...board.pads.map((p) => p.net), ...board.pours.map((p) => p.net)].filter(Boolean))].sort();
}

/** Components with at least one pad on the net. */
export function componentsOnNet(board: Board, net: string): Component[] {
  const comps = new Set(board.pads.filter((p) => p.net === net && p.componentId).map((p) => p.componentId!));
  return board.components.filter((c) => comps.has(c.id));
}

/** Ground for a rail: name match (AVDD → AGND, PVIN → PGND, *_ISO → GND_ISO, 48V → 48V_PGND), else GND, else the busiest ground. */
export function pairGround(board: Board, rail: string, grounds: string[]): string | undefined {
  if (grounds.length <= 1) return grounds[0];
  const r = bare(rail).toUpperCase();
  const g = (pred: (n: string) => boolean) => grounds.find((n) => pred(bare(n).toUpperCase()));
  if (/ISO/.test(r)) {
    const iso = g((n) => n.includes('ISO'));
    if (iso) return iso;
  }
  const prefix = /^(?:(A|D|P)V(?:DD|CC)|V(?:DD|CC)(A|D|P)$)/.exec(r);
  const letter = prefix?.[1] ?? prefix?.[2];
  if (letter) {
    const lg = g((n) => n.startsWith(`${letter}GND`));
    if (lg) return lg;
  }
  const named = g((n) => n.split(/[_-]/).includes(r));
  if (named) return named;
  const plain = g((n) => n === 'GND');
  if (plain) return plain;
  const count = (n: string) => board.pads.filter((p) => p.net === n).length + 10 * board.pours.filter((p) => p.net === n).length;
  return [...grounds].sort((a, b) => count(b) - count(a))[0];
}

/** A two-terminal capacitor straight across the rail and a ground carries no DC. */
function isDecap(board: Board, c: Component, rail: string): boolean {
  if (!CAP_DES_RE.test(c.designator)) return false;
  return padsOf(board, c).every((p) => p.net === rail || isGroundNet(p.net) || !p.net);
}

function regulatorRole(board: Board, c: Component, rail: string, powerNets: Set<string>): 'out' | 'in' | 'unknown' | null {
  const pads = padsOf(board, c);
  const named = pads.filter((p) => p.net === rail && p.pinName);
  if (named.some((p) => OUT_PIN_RE.test(p.pinName!))) return 'out';
  if (named.some((p) => IN_PIN_RE.test(p.pinName!))) return 'in';
  if (!REGULATOR_NAME_RE.test(c.name ?? '') && !REGULATOR_DES_RE.test(c.designator)) return null;
  const v = railVoltage(rail);
  const others = [...new Set(pads.map((p) => p.net))].filter((n) => n !== rail && powerNets.has(n));
  if (!others.length) return 'unknown';
  const higher = (a: string, b: string) => {
    if (isInputRail(a) && !isInputRail(b)) return true;
    if (isInputRail(b) && !isInputRail(a)) return false;
    const va = railVoltage(a);
    const vb = railVoltage(b);
    return va !== undefined && vb !== undefined && va > vb;
  };
  if (others.some((o) => higher(o, rail))) return 'out';
  if (others.some((o) => higher(rail, o)) || (v === undefined && isInputRail(rail))) return 'in';
  return 'unknown';
}

/** A switcher's output inductor: one pad on the rail, the other on a SW/LX net or on a regulator pin. */
function isOutputInductor(board: Board, c: Component, rail: string): boolean {
  if (!INDUCTOR_DES_RE.test(c.designator)) return false;
  const pads = padsOf(board, c);
  if (pads.length !== 2 || !pads.some((p) => p.net === rail)) return false;
  const other = pads.find((p) => p.net !== rail)?.net;
  if (!other) return false;
  if (SW_NET_RE.test(bare(other))) return true;
  return componentsOnNet(board, other).some((o) => o.id !== c.id && (REGULATOR_NAME_RE.test(o.name ?? '') || REGULATOR_DES_RE.test(o.designator)));
}

const cand = (c: Component, kind: SourceKind, reason: string): SourceCandidate => ({ componentId: c.id, designator: c.designator, kind, reason });

/** Guess every rail on the board. */
export function guessRails(board: Board): RailsGuess {
  const nets = netsOf(board);
  const grounds = nets.filter(isGroundNet);
  const pourNets = new Set(board.pours.map((p) => p.net));
  const rails: { net: string; reason: 'name' | 'pour' }[] = [];
  for (const n of nets) {
    if (isGroundNet(n)) continue;
    if (looksLikePowerNet(n)) rails.push({ net: n, reason: 'name' });
    else if (pourNets.has(n)) rails.push({ net: n, reason: 'pour' });
  }
  const powerNets = new Set(rails.map((r) => r.net));
  return { grounds, rails: rails.map((r) => guessRail(board, r.net, r.reason, grounds, powerNets)) };
}

export function guessRail(board: Board, net: string, reason: 'name' | 'pour', grounds: string[], powerNets: Set<string>): RailGuess {
  const comps = componentsOnNet(board, net);
  const regs: SourceCandidate[] = [];
  const conns: SourceCandidate[] = [];
  const unknownRegs: SourceCandidate[] = [];
  for (const c of comps) {
    if (isDecap(board, c, net)) continue;
    const role = regulatorRole(board, c, net, powerNets);
    if (role === 'out') regs.push(cand(c, 'regulator', 'regulator output'));
    else if (role === 'unknown') unknownRegs.push(cand(c, 'regulator', 'regulator, direction unknown'));
    else if (role === null && isOutputInductor(board, c, net)) regs.push(cand(c, 'regulator', 'switcher output inductor'));
    else if (role === null && BATTERY_DES_RE.test(c.designator)) conns.push(cand(c, 'battery', 'battery'));
    else if (role === null && CONNECTOR_DES_RE.test(c.designator)) conns.push(cand(c, 'connector', 'connector'));
  }

  const input = isInputRail(net);
  let source: SourceCandidate | undefined;
  let candidates: SourceCandidate[];
  let rule: RailGuess['rule'] = 'ask';
  let askReason: string | undefined;
  if (regs.length === 1 && !(input && conns.length)) {
    source = regs[0];
    candidates = [...regs, ...unknownRegs];
    rule = 'regulator';
  } else if (regs.length > 1) {
    candidates = [...regs, ...unknownRegs];
    askReason = `${regs.length} regulator outputs on ${net}: pick the active source.`;
  } else if (regs.length === 1) {
    candidates = [...regs, ...conns];
    askReason = `${net} has a regulator output and a connector/battery: pick the active source.`;
  } else if (input && conns.length === 1 && !unknownRegs.length) {
    source = conns[0];
    candidates = conns;
    rule = 'connector';
  } else if (input && conns.length > 1) {
    candidates = [...conns, ...unknownRegs];
    askReason = `${conns.length} connectors/batteries on ${net}: pick the active source.`;
  } else {
    candidates = [...unknownRegs, ...conns];
    askReason = candidates.length ? `No clear source on ${net}: confirm which part supplies it.` : `No regulator, connector or battery found on ${net}: pick the source.`;
  }

  const ground = pairGround(board, net, grounds);
  const { loads, excluded } = loadsFor(board, net, source?.componentId, candidates.map((c) => c.componentId));
  return { net, reason, voltage: railVoltage(net), ground, source, candidates, rule, askReason, loads, excluded };
}

/**
 * Loads of a rail once its source is chosen: every other part on the rail, except decaps and the
 * other candidate sources (D7: one active source, the others are left out of the solve).
 * Connectors that were not candidates are loads (a header breaking out 3V3).
 */
export function loadsFor(board: Board, net: string, sourceId: string | undefined, candidateIds: string[]): { loads: LoadGuess[]; excluded: RailGuess['excluded'] } {
  const loads: LoadGuess[] = [];
  const excluded: RailGuess['excluded'] = [];
  const hasGround = board.pads.some((p) => isGroundNet(p.net));
  for (const c of componentsOnNet(board, net)) {
    if (c.id === sourceId) continue;
    if (isDecap(board, c, net)) excluded.push({ designator: c.designator, why: 'decap (blocks DC)' });
    else if (sourceId && candidateIds.includes(c.id)) excluded.push({ designator: c.designator, why: 'inactive source' });
    // A pull-up, an LED to a GPIO or a series part returns its current through another part, not to ground.
    else if (hasGround && !padsOf(board, c).some((p) => isGroundNet(p.net))) excluded.push({ designator: c.designator, why: 'no ground pad' });
    else loads.push({ componentId: c.id, designator: c.designator, connector: CONNECTOR_DES_RE.test(c.designator) || BATTERY_DES_RE.test(c.designator) });
  }
  return { loads, excluded };
}

export interface DcTerminal {
  componentId: string;
  designator: string;
  railPads: Pad[];
  groundPads: Pad[];
  /** Load current, A (loads only). */
  current: number;
}

/** A part with pads on two or more nets of one rail (a fuse, ferrite, series diode): it joins them. */
export interface DcBridge {
  designator: string;
  /** Its pads on the rail's nets. */
  pads: Pad[];
}

export interface DcSetup {
  rail: string;
  /** Every net of the rail, `rail` first: further nets join it through the bridges (default: `rail` alone). */
  railNets?: string[];
  bridges?: DcBridge[];
  ground: string;
  source: DcTerminal;
  loads: DcTerminal[];
  /** True when no load currents were given: the result is per amp of total load, shown normalised. */
  normalised: boolean;
  warnings: string[];
}

export interface DcSetupInput {
  rail: string;
  /** Further nets of the same rail, joined to it through the parts between them (VBUS_R → fuse → VBUS_RAW). */
  railNets?: string[];
  ground: string;
  /** Designator or component id of the active source. */
  source: string;
  /** Designators or ids of the loads; default: loadsFor() of the source. */
  loads?: string[];
  /** Load currents in A by designator; loads without one share what is left equally (1 A total when none is given). */
  currents?: Record<string, number>;
}

/** Ground pin names that carry a part's supply current; other ground pads (A0 tied low) carry none. */
const SUPPLY_GROUND_PIN_RE = /^(?:[ADPS]?GND\w*|V(?:SS|EE)\w*|0V|E?PAD|EP\d*|THERMAL\w*|TAB|SLUG)$/i;
const isSupplyGroundPin = (name: string) => name.split(/[\s/(),;|]+/).some((tok) => SUPPLY_GROUND_PIN_RE.test(tok));

/**
 * A part's pads on the ground that carry its return current. With pin names, only ground pins
 * (GND, VSS, EP…) count, so address and strap pins tied to ground start no return; without names,
 * or when no name matches, every pad on the ground counts.
 */
export function returnPads(pads: Pad[], ground: string): { pads: Pad[]; tied: Pad[] } {
  const on = pads.filter((p) => p.net === ground);
  const supply = on.filter((p) => p.pinName && isSupplyGroundPin(p.pinName));
  if (!supply.length || !on.every((p) => p.pinName)) return { pads: on, tied: [] };
  return { pads: supply, tied: on.filter((p) => !supply.includes(p)) };
}

/** Ground pads that close the loop at the source: its own, else those of the nearest part sharing another net with it (a switcher's IC behind its inductor). */
function sourceGroundPads(board: Board, c: Component, rail: string, ground: string): { pads: Pad[]; from?: { designator: string; net: string } } {
  const own = returnPads(padsOf(board, c), ground).pads;
  if (own.length) return { pads: own };
  const otherNets = new Set(padsOf(board, c).map((p) => p.net).filter((n) => n && n !== rail && n !== ground));
  let best: { pads: Pad[]; from?: { designator: string; net: string } } = { pads: [] };
  let bestD = Infinity;
  for (const n of otherNets) {
    for (const o of componentsOnNet(board, n)) {
      if (o.id === c.id) continue;
      const g = returnPads(padsOf(board, o), ground).pads;
      const d = dist(o.at, c.at);
      if (g.length && d < bestD) {
        best = { pads: g, from: { designator: o.designator, net: n } };
        bestD = d;
      }
    }
  }
  return best;
}

/** The rail's nets, `rail` first, without repeats. */
export function railNetsOf(input: Pick<DcSetupInput, 'rail' | 'railNets'>): string[] {
  return [...new Set([input.rail, ...(input.railNets ?? [])].filter(Boolean))];
}

/** "VBUS_R + VBUS_RAW" for a rail of several nets. */
export function railLabel(input: Pick<DcSetupInput, 'rail' | 'railNets'>): string {
  return railNetsOf(input).join(' + ');
}

/** Parts with pads on two or more of the nets: they carry the rail's current from one net to the next. */
export function railBridges(board: Board, nets: string[]): DcBridge[] {
  if (nets.length < 2) return [];
  const out: DcBridge[] = [];
  for (const c of board.components) {
    const pads = padsOf(board, c).filter((p) => nets.includes(p.net));
    if (new Set(pads.map((p) => p.net)).size >= 2) out.push({ designator: c.designator, pads });
  }
  return out;
}

/** Two-pad parts that pass a rail's current on to another net: fuses, ferrites, inductors, diodes, resistors (a 0 Ω link or shunt). */
const SERIES_DES_RE = /^(?:F|FB|L|D|R)\d/i;

/**
 * Nets that continue a rail through a series part (VBUS_R → fuse → VBUS_RAW → diode → VBUS), the
 * candidates to solve with it as one rail: power-like nets (by name or pour) reached through
 * two-pad series parts, also further along, each with the part it is reached through.
 */
export function railNeighbours(board: Board, rail: string): { net: string; via: string }[] {
  const pourNets = new Set(board.pours.map((p) => p.net));
  const powerLike = (n: string) => !!n && !isGroundNet(n) && (looksLikePowerNet(n) || pourNets.has(n));
  const out: { net: string; via: string }[] = [];
  const seen = new Set([rail]);
  for (let k = 0; k < seen.size; k++) {
    const from = [...seen][k];
    for (const c of componentsOnNet(board, from)) {
      if (!SERIES_DES_RE.test(c.designator)) continue;
      const pads = padsOf(board, c);
      const nets = [...new Set(pads.map((p) => p.net))];
      if (pads.length !== 2 || nets.length !== 2) continue;
      const other = nets.find((n) => n !== from)!;
      if (seen.has(other) || !powerLike(other)) continue;
      seen.add(other);
      out.push({ net: other, via: c.designator });
    }
  }
  return out;
}

/** loadsFor() over every net of the rail, without the parts that bridge its nets. */
export function railLoadsFor(board: Board, nets: string[], sourceId: string | undefined, candidateIds: string[]): { loads: LoadGuess[]; excluded: RailGuess['excluded'] } {
  const bridges = new Set(railBridges(board, nets).map((b) => b.designator));
  const loads: LoadGuess[] = [];
  const excluded: RailGuess['excluded'] = [...bridges].map((d) => ({ designator: d, why: `joins ${nets.join(' and ')}` }));
  const seen = new Set<string>([...bridges]);
  for (const n of nets) {
    const r = loadsFor(board, n, sourceId, candidateIds);
    for (const l of r.loads) if (!seen.has(l.designator)) (seen.add(l.designator), loads.push(l));
    for (const e of r.excluded) if (!seen.has(e.designator)) (seen.add(e.designator), excluded.push(e));
  }
  return { loads, excluded };
}

export function buildDcSetup(board: Board, input: DcSetupInput): DcSetup {
  const warnings: string[] = [];
  const nets = railNetsOf(input);
  const label = railLabel(input);
  const onRail = (p: Pad) => nets.includes(p.net);
  const find = (key: string) => board.components.find((c) => c.designator === key || c.id === key);
  const src = find(input.source);
  if (!src) throw new Error(`source "${input.source}" not found`);
  const bridges = railBridges(board, nets);
  const loadComps = input.loads
    ? input.loads.map((k) => {
        const c = find(k);
        if (!c) throw new Error(`load "${k}" not found`);
        return c;
      })
    : railLoadsFor(board, nets, src.id, guessRails(board).rails.filter((r) => nets.includes(r.net)).flatMap((r) => r.candidates.map((x) => x.componentId))).loads.map((l) => find(l.componentId)!);

  for (const n of nets)
    if (!looksLikePowerNet(n) && !board.pours.some((p) => p.net === n))
      warnings.push(`${n} does not look like a power rail. The DC view treats ${src.designator} as a supply whose current the loads draw at their ${label} pins and return through their ${input.ground} pins; for a signal's return path use Show for Selected Net.`);
  if (nets.length > 1) {
    if (bridges.length) warnings.push(`${bridges.map((b) => b.designator).join(', ')} join${bridges.length > 1 ? '' : 's'} ${label}, taken as a short: ${bridges.length > 1 ? 'their' : 'its'} own drop is not included.`);
    const linked = new Set([nets[0]]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const b of bridges) {
        const ns = b.pads.map((p) => p.net);
        if (ns.some((n) => linked.has(n)) && ns.some((n) => !linked.has(n))) (ns.forEach((n) => linked.add(n)), (grew = true));
      }
    }
    const apart = nets.filter((n) => !linked.has(n));
    if (apart.length) warnings.push(`No part joins ${apart.join(', ')} to ${nets[0]}; their copper is solved as part of the rail but carries current only where it touches.`);
  }
  const srcRail = padsOf(board, src).filter(onRail);
  if (!srcRail.length) throw new Error(`source ${src.designator} has no pad on ${label}`);
  const { pads: srcGnd, from } = sourceGroundPads(board, src, input.rail, input.ground);
  if (!srcGnd.length) warnings.push(`Source ${src.designator} has no ${input.ground} pad nearby; the return half is not solved.`);
  else if (from) warnings.push(`Source ${src.designator} has no ${input.ground} pad; the return ends at the ${input.ground} pads of ${from.designator}, the nearest part on ${from.net}.`);
  const currents = input.currents ?? {};
  const given = loadComps.filter((c) => currents[c.designator] !== undefined);
  const normalised = given.length === 0;
  const rest = loadComps.length - given.length;
  const restTotal = normalised ? 1 : 0;
  const loads: DcTerminal[] = loadComps.map((c) => {
    const railPads = padsOf(board, c).filter(onRail);
    const { pads: groundPads, tied } = returnPads(padsOf(board, c), input.ground);
    if (tied.length)
      warnings.push(`${c.designator}: ${tied.map((p) => p.pinName).join(', ')} ${tied.length > 1 ? 'are' : 'is'} tied to ${input.ground} but carr${tied.length > 1 ? 'y' : 'ies'} no supply current; the return starts at ${groundPads.map((p) => p.pinName).join(', ')}.`);
    if (!railPads.length) warnings.push(`Load ${c.designator} has no pad on ${label}.`);
    if (!groundPads.length) warnings.push(`Load ${c.designator} has no ${input.ground} pad; its return current is not modelled.`);
    const current = currents[c.designator] ?? (rest ? restTotal / rest : 0);
    return { componentId: c.id, designator: c.designator, railPads, groundPads, current };
  });
  if (!normalised && given.length < loadComps.length)
    warnings.push(`No current given for ${loadComps.filter((c) => currents[c.designator] === undefined).map((c) => c.designator).join(', ')}; they draw 0 A.`);
  return {
    rail: input.rail,
    railNets: nets,
    bridges,
    ground: input.ground,
    source: { componentId: src.id, designator: src.designator, railPads: srcRail, groundPads: srcGnd, current: 0 },
    loads,
    normalised,
    warnings,
  };
}

/**
 * The same rail with only one part drawing current. The copper is linear, so its paths are exactly
 * its share of the full solve; with no current given for it, the result is per amp of its own current.
 */
export function focusInput(input: DcSetupInput, designator: string): DcSetupInput {
  const current = input.currents?.[designator];
  return { rail: input.rail, ...(input.railNets?.length ? { railNets: input.railNets } : {}), ground: input.ground, source: input.source, loads: [designator], ...(current !== undefined ? { currents: { [designator]: current } } : {}) };
}

/** "U2=0.15, U3=20mA" → { U2: 0.15, U3: 0.02 } (A). Empty → undefined (equal split). */
export function parseCurrents(s: string | undefined): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const part of (s ?? '').split(/[,;\s]+/).filter(Boolean)) {
    const m = /^([^=:]+)[=:]([\d.]+)\s*(m?)A?$/i.exec(part);
    if (!m || !isFinite(Number(m[2]))) throw new Error(`cannot read the current "${part}"; use e.g. U2=0.15 or U2=150mA`);
    out[m[1]] = Number(m[2]) * (m[3] ? 1e-3 : 1);
  }
  return Object.keys(out).length ? out : undefined;
}
