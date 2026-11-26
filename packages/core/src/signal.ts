// What kind of data line a net is (I²C, SPI, UART, USB, I²S…), recognised from its name and the
// names of the pins on it, with the speeds that kind of line usually runs at. The speed sets the
// edge time, and the edge time decides whether the trace acts as a transmission line.

import { hfApplicability } from './analyze.js';
import type { Board } from './types.js';

export interface Speed {
  /** Bit rate or clock frequency, Hz. */
  hz: number;
  label: string;
  /** Typical 10–90 % edge time at this speed, ns. */
  riseNs: number;
}

export interface SignalKind {
  type: string;
  /** "I²C clock", "SPI data"… */
  label: string;
  speeds: Speed[];
  /** Index into speeds of the usual speed. */
  dflt: number;
  /** How the edge time is set, for the report. */
  edges: string;
}

const k = (hz: number) => hz * 1e3;
const M = (hz: number) => hz * 1e6;
const sp = (hz: number, label: string, riseNs: number): Speed => ({ hz, label, riseNs });

const PUSH_PULL = 'push-pull outputs, so the edges are set by the driver, not the data rate';

const I2C = {
  speeds: [sp(k(100), '100 kHz (Standard-mode)', 1000), sp(k(400), '400 kHz (Fast-mode)', 300), sp(M(1), '1 MHz (Fast-mode Plus)', 120), sp(M(3.4), '3.4 MHz (High-speed mode)', 40)],
  dflt: 1,
  edges: 'open-drain: the rising edge is set by the pull-up resistor and the bus capacitance',
};
const SPI = { speeds: [sp(M(1), '1 MHz', 5), sp(M(4), '4 MHz', 5), sp(M(10), '10 MHz', 3), sp(M(20), '20 MHz', 2), sp(M(50), '50 MHz', 1.5)], dflt: 2, edges: PUSH_PULL };
const UART = { speeds: [sp(9600, '9600 baud', 10), sp(115200, '115200 baud', 10), sp(M(1), '1 Mbaud', 10), sp(M(3), '3 Mbaud', 5)], dflt: 1, edges: PUSH_PULL };
const USB = {
  speeds: [sp(M(1.5), 'Low Speed, 1.5 Mb/s', 75), sp(M(12), 'Full Speed, 12 Mb/s', 10), sp(M(480), 'High Speed, 480 Mb/s', 0.5)],
  dflt: 1,
  edges: 'set by the USB speed (the transceiver limits them)',
};
const I2S_BIT = { speeds: [sp(M(1.536), '1.536 MHz (48 kHz, 16-bit stereo)', 3), sp(M(3.072), '3.072 MHz (48 kHz, 32-bit stereo)', 3), sp(M(6.144), '6.144 MHz (96 kHz)', 3), sp(M(12.288), '12.288 MHz (192 kHz)', 2)], dflt: 1, edges: PUSH_PULL };
const I2S_WORD = { speeds: [sp(k(44.1), '44.1 kHz', 3), sp(k(48), '48 kHz', 3), sp(k(96), '96 kHz', 3), sp(k(192), '192 kHz', 3)], dflt: 1, edges: PUSH_PULL };
const MCLK = { speeds: [sp(M(11.2896), '11.2896 MHz', 2), sp(M(12.288), '12.288 MHz', 2), sp(M(24.576), '24.576 MHz', 2)], dflt: 1, edges: PUSH_PULL };
const SWD = { speeds: [sp(M(1), '1 MHz', 5), sp(M(4), '4 MHz', 3), sp(M(10), '10 MHz', 3)], dflt: 1, edges: PUSH_PULL };
const CAN = {
  speeds: [sp(k(125), '125 kb/s', 50), sp(k(250), '250 kb/s', 50), sp(k(500), '500 kb/s', 50), sp(M(1), '1 Mb/s', 50), sp(M(5), 'CAN FD 5 Mb/s', 20)],
  dflt: 2,
  edges: 'set by the transceiver, which slows them on purpose',
};
const CLOCK = {
  speeds: [sp(32768, '32.768 kHz', 10), sp(M(8), '8 MHz', 2), sp(M(12), '12 MHz', 2), sp(M(16), '16 MHz', 2), sp(M(25), '25 MHz', 2), sp(M(50), '50 MHz', 1)],
  dflt: 3,
  edges: 'set by the oscillator or clock output',
};
const ETHERNET = { speeds: [sp(M(10), '10BASE-T, 10 Mb/s', 10), sp(M(125), '100BASE-TX, 125 Mbaud', 3)], dflt: 1, edges: 'set by the PHY' };
const SDIO = { speeds: [sp(M(25), '25 MHz (default speed)', 2), sp(M(50), '50 MHz (high speed)', 1)], dflt: 0, edges: PUSH_PULL };
const PWM = { speeds: [sp(k(1), '1 kHz', 10), sp(k(20), '20 kHz', 10), sp(k(100), '100 kHz', 10), sp(M(1), '1 MHz', 5)], dflt: 1, edges: PUSH_PULL };
export const GENERIC: SignalKind = {
  type: 'other',
  label: 'signal',
  speeds: [sp(k(100), '100 kHz', 10), sp(M(1), '1 MHz', 5), sp(M(10), '10 MHz', 3), sp(M(100), '100 MHz', 1)],
  dflt: 1,
  edges: 'assumed from a typical push-pull output',
};

/** Most specific first: the first rule whose pattern matches the net name, or failing that a pin name, wins. */
const RULES: [RegExp, Omit<SignalKind, 'speeds' | 'dflt' | 'edges'>, Pick<SignalKind, 'speeds' | 'dflt' | 'edges'>][] = [
  [/USB.*D[PMN+-]$|^D[+-]$|^USB_?D[PN]?[+-]?$|^U?D[PM]$/, { type: 'usb', label: 'USB data' }, USB],
  [/SWDIO|SWCLK|SWO$|^T(CK|MS|DI|DO)$|JTAG/, { type: 'swd', label: 'SWD / JTAG debug' }, SWD],
  [/(^|_)(I2C\d*_?)?SCL\d*$|^I2C\d*_?CLK$|^SC\d+$/, { type: 'i2c-clock', label: 'I²C clock' }, I2C],
  [/(^|_)(I2C\d*_?)?SDA\d*$|^I2C\d*_?DATA?$|^SD\d+$/, { type: 'i2c-data', label: 'I²C data' }, I2C],
  [/MCLK|MCK$/, { type: 'i2s-mclk', label: 'audio master clock' }, MCLK],
  [/BCLK|BCK$|I2S.*(SCK|CLK)$/, { type: 'i2s-clock', label: 'I²S bit clock' }, I2S_BIT],
  [/LRCLK|LRCK|WCLK|(^|_)(WS|FS)$|I2S.*WS/, { type: 'i2s-word', label: 'I²S word clock' }, I2S_WORD],
  [/I2S|PCM|SDIN$|SDOUT$|DACDAT|ADCDAT|^(RAD|AUD).*(DIN|DOUT)$/, { type: 'i2s-data', label: 'I²S data' }, I2S_BIT],
  [/SDIO|SDMMC|SD_?(CMD|CLK|D\d)$/, { type: 'sdio', label: 'SD card' }, SDIO],
  [/(^|_)(SPI\d*_?)?(SCK|SCLK)$|SPI.*CLK$/, { type: 'spi-clock', label: 'SPI clock' }, SPI],
  [/MOSI|MISO|COPI|CIPO|(^|_)SD[IO]$|SPI.*(DO|DI|IO\d)$|QSPI|^(Q|QSPI_)?IO[0-3]$/, { type: 'spi-data', label: 'SPI data' }, SPI],
  [/(^|_)(N?CS|CSN|N?SS|NSS|CE)\d*$|SPI.*(CS|SS)/, { type: 'spi-select', label: 'SPI chip select' }, SPI],
  [/(^|_)(TX|RX)[NP]$|(^|_)(TD|RD)[+-]$|ETH.*(TX|RX)/, { type: 'ethernet', label: 'Ethernet pair' }, ETHERNET],
  [/CAN_?[HL]$|CAN.*(TX|RX)/, { type: 'can', label: 'CAN' }, CAN],
  [/(^|_)(U?S?ART\d*_?)?(TXD?|RXD?|RTS|CTS)\d*$|UART|USART/, { type: 'uart', label: 'UART' }, UART],
  [/XTAL|OSC|XIN|XOUT|MCO|HSE|LSE|(^|_)CLK(OUT|IN)?\d*$|CLK$/, { type: 'clock', label: 'clock' }, CLOCK],
  [/PWM/, { type: 'pwm', label: 'PWM' }, PWM],
];

const norm = (s: string) => s.toUpperCase().replace(/^[/\\]+/, '').replace(/[\s.-]+(?=[A-Z0-9])/g, '_');

/** The kind of data line a net is, or undefined when neither its name nor its pins say. */
export function classifySignal(net: string, pinNames: (string | undefined)[] = []): SignalKind | undefined {
  const name = norm(net);
  const pins = pinNames.filter((p): p is string => !!p).map(norm);
  for (const by of [[name], pins]) {
    for (const [re, kind, rates] of RULES) {
      if (by.some((n) => re.test(n))) return { ...kind, ...rates };
    }
  }
  return undefined;
}

/** "400k", "12 MHz", "115200", "3.072M" → Hz; undefined when it is not a frequency. */
export function parseHz(text: string): number | undefined {
  const m = text.trim().match(/^(\d+(?:[.,]\d+)?)\s*([kKmMgG]?)(?:hz|Hz|HZ|b\/s|bps|baud)?$/);
  if (!m) return undefined;
  const v = Number(m[1].replace(',', '.')) * ({ '': 1, k: 1e3, m: 1e6, g: 1e9 }[m[2].toLowerCase() as '' | 'k' | 'm' | 'g'] ?? 1);
  return v > 0 ? v : undefined;
}

export function formatHz(hz: number): string {
  if (hz >= 1e9) return `${+(hz / 1e9).toPrecision(4)} GHz`;
  if (hz >= 1e6) return `${+(hz / 1e6).toPrecision(4)} MHz`;
  if (hz >= 1e3) return `${+(hz / 1e3).toPrecision(4)} kHz`;
  return `${hz} Hz`;
}

/** Signal speed in FR-4 (a microstrip's effective εr of about 3), mm per ns. */
const MM_PER_NS = 170;

/** The edge time at a speed: the nearest listed speed's, or for a speed between two, the slower one's. */
export function riseAt(kind: SignalKind, hz: number): number {
  const listed = kind.speeds.find((s) => Math.abs(s.hz - hz) / s.hz < 0.01);
  if (listed) return listed.riseNs;
  const below = [...kind.speeds].reverse().find((s) => s.hz <= hz) ?? kind.speeds[0];
  // A rate this high cannot have edges slower than a fifth of its period.
  return Math.min(below.riseNs, 1e9 / hz / 5);
}

export interface SignalSummary {
  kneeHz: number;
  /** Trace length above which the trace acts as a transmission line (one sixth of the edge's length on the board), mm. */
  criticalMm: number;
  transmissionLine: boolean;
  message: string;
}

/** What the speed means for this trace: the highest frequency in the edges, and whether the trace acts as a transmission line. */
export function summariseSignal(net: string, kind: SignalKind, hz: number, lengthMm: number): SignalSummary {
  const riseNs = riseAt(kind, hz);
  const kneeHz = 0.35 / (riseNs * 1e-9);
  const criticalMm = (riseNs * MM_PER_NS) / 6;
  const transmissionLine = lengthMm > criticalMm;
  const len = (mm: number) => (mm >= 1000 ? `${(mm / 1000).toFixed(1)} m` : `${mm.toFixed(0)} mm`);
  const what = kind.type === 'other' ? '' : `${kind.label} `;
  const message =
    `${net}: ${what}at ${formatHz(hz)}. Edges ≈ ${riseNs < 10 ? riseNs.toFixed(1) : riseNs.toFixed(0)} ns (${kind.edges}), so the signal has content up to ≈ ${formatHz(Number(kneeHz.toPrecision(2)))}. ` +
    (transmissionLine
      ? `At ${len(lengthMm)} the trace is longer than ${len(criticalMm)}, so it acts as a transmission line: a broken return path also causes reflections and ringing, besides crosstalk and emission.`
      : `At ${len(lengthMm)} the trace is shorter than the ${len(criticalMm)} at which it would act as a transmission line, so a broken return path matters for crosstalk and emission rather than for the signal's own shape.`);
  return { kneeHz, criticalMm, transmissionLine, message };
}

export interface HfCandidate {
  net: string;
  kind?: SignalKind;
  /** Total track length, mm. */
  lengthMm: number;
}

const naturally = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/**
 * The nets the high-frequency check applies to (routed, not ground, supply, plane or bias nets):
 * recognised data lines first, longest first (a long line is the likelier trouble), then the other
 * signal nets in natural order.
 */
export function hfCandidates(board: Board): HfCandidate[] {
  const length = new Map<string, number>();
  for (const t of board.tracks) if (t.net) length.set(t.net, (length.get(t.net) ?? 0) + Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y));
  const pins = new Map<string, (string | undefined)[]>();
  for (const p of board.pads) if (p.net && p.pinName) pins.set(p.net, [...(pins.get(p.net) ?? []), p.pinName]);
  return [...length.keys()]
    .filter((net) => hfApplicability(board, net).ok)
    .map((net) => ({ net, kind: classifySignal(net, pins.get(net)), lengthMm: length.get(net)! }))
    .sort((a, b) => Number(!a.kind) - Number(!b.kind) || (a.kind && b.kind ? b.lengthMm - a.lengthMm : 0) || naturally(a.net, b.net));
}
