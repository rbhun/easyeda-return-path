// Which part drives a signal net (D3), guessed from schematic pin names with the pin-hint rules,
// and the driver-side close of the return loop (brief: "rising edge → VDD, falling edge → VSS").
import { isGroundNet, looksLikePowerNet } from './dc/rails.js';
import { dist } from './geom.js';
import type { Board, Component, Pad, Pt } from './types.js';

export type PinRole = 'driver' | 'receiver' | 'bidirectional' | 'unknown';

export interface DriverCandidate {
  designator: string;
  pad: Pad;
  role: PinRole;
  /** Why the role was guessed, for the dialog and the log. */
  why: string;
}

export interface DriverGuess {
  candidates: DriverCandidate[];
  /** Designators guessed to drive the net. */
  drivers: string[];
  /** True when the guess needs no confirmation. */
  confident: boolean;
}

// Pin-hint database (docs/pin-hint-database.md): the part whose pin carries one of these names drives the net.
const DRIVE_RE = /^(?:TXD?\d*|MOSI|COPI|SDO|DOUT|DO|SO|OUT\d*|CLK_?OUT|MCO\d*|XO|XOUT|X(?:TAL)?_?OUT|OSC_?OUT|PWM\w*)$/i;
const RECEIVE_RE = /^(?:RXD?\d*|MISO|CIPO|SDI|DIN|DI|SI|IN\d*|CLK_?IN|XI|XIN|X(?:TAL)?_?IN|OSC_?IN)$/i;
const BIDIR_RE = /^(?:SDA|SCL|SWDIO|MDIO|D[PM+-]|USB_?D[PMN+-]|DATA|IO\d*)$/i;

/** Pin names such as "PA9/USART1_TX" are split into tokens, and peripheral prefixes dropped. */
function tokens(name: string): string[] {
  return name
    .split(/[\s/(),;|]+|-(?=[A-Z])/i)
    .filter(Boolean)
    .map((t) => t.replace(/^(?:U?S?ART|LPUART|UART|SPI|I2C|I2S|QSPI)\d*_/i, ''));
}

export function pinRole(name: string | undefined): { role: PinRole; why: string } {
  if (!name) return { role: 'unknown', why: 'no pin name' };
  const tok = tokens(name);
  const hit = (re: RegExp) => tok.find((t) => re.test(t));
  // A shared pin such as "SDA/MOSI" can do either; the bidirectional name wins.
  const b = hit(BIDIR_RE);
  if (b) return { role: 'bidirectional', why: `pin ${name} (${b} is driven from either end)` };
  const d = hit(DRIVE_RE);
  if (d) return { role: 'driver', why: `pin ${name} (${d} drives)` };
  const r = hit(RECEIVE_RE);
  if (r) return { role: 'receiver', why: `pin ${name} (${r} receives)` };
  return { role: 'unknown', why: `pin ${name}` };
}

export const isPassive = (c: Component) =>
  /^(?:R|RN|C|L|FB|D|LED|TP|F)\d/i.test(c.designator) || (c.padIds.length <= 2 && !/^(?:U|IC|J|P|CN|X|Y|Q)\d/i.test(c.designator));

/**
 * Parts on the net that could drive it (two-pad passives and test points cannot), with a role
 * guessed from the signal pin's name. Confident when exactly the named drivers are found, or when
 * a single part is left once the named receivers are taken out.
 */
export function guessDrivers(board: Board, net: string): DriverGuess {
  const comps = new Map(board.components.map((c) => [c.id, c]));
  const candidates: DriverCandidate[] = [];
  const seen = new Set<string>();
  for (const p of board.pads) {
    if (p.net !== net || !p.componentId || seen.has(p.componentId)) continue;
    const c = comps.get(p.componentId);
    if (!c || isPassive(c)) continue;
    seen.add(c.id);
    candidates.push({ designator: c.designator, pad: p, ...pinRole(p.pinName) });
  }
  // On a bus driven from either end (I2C, SWDIO) the pin names cannot settle it.
  if (pinRole(net).role === 'bidirectional') return { candidates, drivers: [], confident: false };
  const named = candidates.filter((c) => c.role === 'driver').map((c) => c.designator);
  if (named.length) return { candidates, drivers: named, confident: true };
  const rest = candidates.filter((c) => c.role !== 'receiver');
  if (rest.length === 1 && rest[0].role !== 'bidirectional') return { candidates, drivers: [rest[0].designator], confident: true };
  return { candidates, drivers: [], confident: false };
}

export interface DriverLoop {
  designator: string;
  signalPad: Pad;
  /** The net the return arrives on (reference copper at the driver), and the driver's pin on it. */
  refNet: string;
  refPin?: Pad;
  /** The driver's pin on the other net of its supply pair (VDD for a GND-referenced trace). */
  supplyPin?: Pad;
  decap?: { component: Component; refPad: Pad; supplyPad: Pad; length: number };
}

/**
 * The driver's supply pair at the end of the net. One edge returns straight into refPin; the other
 * edge's current must reach supplyPin, through the decap between the two nets with the shortest
 * pin → cap → pin path.
 */
export function driverLoop(board: Board, designator: string, net: string, refNet: string): DriverLoop | null {
  const comp = board.components.find((c) => c.designator === designator);
  if (!comp) return null;
  const own = board.pads.filter((p) => p.componentId === comp.id);
  const signalPad = own.find((p) => p.net === net);
  if (!signalPad) return null;
  const nearest = (ps: Pad[], to: Pt) => [...ps].sort((a, b) => dist(a.at, to) - dist(b.at, to))[0];
  const refPin = nearest(own.filter((p) => p.net === refNet), signalPad.at);
  const partner = (n: string) => (isGroundNet(refNet) ? looksLikePowerNet(n) : isGroundNet(n));
  const supplyPins = own.filter((p) => p.net && p.net !== net && p.net !== refNet && partner(p.net));
  const loop: DriverLoop = { designator, signalPad, refNet, refPin, supplyPin: nearest(supplyPins, signalPad.at) };
  if (!refPin || !supplyPins.length) return loop;
  // The supply pin and decap together: shortest pin → cap → pin path, plus the on-chip distance
  // back to the ground pin, so a large IC's bank-local supply pin wins over a far one.
  const pads = new Map(board.pads.map((p) => [p.id, p]));
  let best = Infinity;
  for (const c of board.components) {
    if (c.id === comp.id) continue;
    const cp = c.padIds.map((id) => pads.get(id)).filter((p): p is Pad => !!p);
    if (cp.length !== 2) continue;
    const refPad = cp.find((p) => p.net === refNet);
    if (!refPad) continue;
    for (const supplyPin of supplyPins) {
      const supplyPad = cp.find((p) => p.net === supplyPin.net);
      if (!supplyPad) continue;
      const length = dist(refPin.at, refPad.at) + dist(supplyPad.at, supplyPin.at);
      const cost = length + dist(supplyPin.at, refPin.at);
      if (cost < best) {
        best = cost;
        loop.supplyPin = supplyPin;
        loop.decap = { component: c, refPad, supplyPad, length };
      }
    }
  }
  return loop;
}
