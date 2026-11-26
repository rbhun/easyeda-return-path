// Board info: what the designer knows about a board's nets that the copper cannot say (the kind
// of signal, its protocol and speed, which part drives it, what each load on a rail draws, which
// pours and splits are intended). Kept per project, loaded from and saved to one CSV format, and
// used to prefill the HF and DC checks. Imported and manual values both win over recognition.

import { sameNet, uniqueNets } from './nets.js';
import { formatHz, parseHz } from './signal.js';

export const NET_KINDS = ['clock', 'data', 'bus', 'diff pair', 'power', 'ground', 'analog', 'control'] as const;
export type NetKind = typeof NET_KINDS[number];

export interface NetInfo {
  net: string;
  kind?: NetKind;
  protocol?: string;
  /** Bit rate or clock frequency, Hz. */
  speedHz?: number;
  /** The parts that drive the net (several when it is driven from either end); empty: no driver loop. */
  driver?: { parts: string[]; pin?: string; pinName?: string };
  /** Parts, or `part.pin`, that receive the net. */
  receivers?: string[];
  diffPartner?: string;
  /** Intended reference, e.g. `GND on In1`. */
  reference?: string;
  /** Impedance or length target, e.g. `90 Ω diff, ±0.5 mm`. */
  target?: string;
  notes?: string;
}

/** One load on a rail; a row without a load part carries the rail's voltage and source only. */
export interface LoadInfo {
  net: string;
  voltage?: number;
  source?: { part: string; pin?: string };
  load?: { part: string; pin?: string };
  /** Typical and peak current, A. */
  typicalA?: number;
  peakA?: number;
  notes?: string;
}

export interface LayerInfo {
  layer: string;
  pours?: string;
  /** Intentional splits and star grounds. */
  splits?: string;
  notes?: string;
}

export interface BoardInfo {
  nets: NetInfo[];
  loads: LoadInfo[];
  layers: LayerInfo[];
}

export const emptyBoardInfo = (): BoardInfo => ({ nets: [], loads: [], layers: [] });

export const BOARD_INFO_COLUMNS = [
  'row', 'net', 'kind', 'protocol', 'speed', 'driver_part', 'driver_pin', 'driver_pin_name', 'receivers', 'diff_partner', 'reference', 'target',
  'voltage', 'source_part', 'source_pin', 'load_part', 'load_pin', 'typical_current', 'peak_current',
  'layer', 'pours', 'splits', 'notes',
] as const;
type Column = typeof BOARD_INFO_COLUMNS[number];

/** Header spellings that name a column: case, spaces, dashes and a few synonyms do not matter. */
const ALIASES: Record<string, Column> = {
  type: 'row', rowtype: 'row', speedhz: 'speed', frequency: 'speed', bitrate: 'speed', driver: 'driver_part', driverpart: 'driver_part', driverpin: 'driver_pin',
  driverpinname: 'driver_pin_name', diffpair: 'diff_partner', diffpartner: 'diff_partner', diffpairpartner: 'diff_partner', reference: 'reference',
  intendedreference: 'reference', target: 'target', impedancelengthtarget: 'target', impedance: 'target', source: 'source_part', sourcepart: 'source_part',
  sourcepin: 'source_pin', load: 'load_part', loadpart: 'load_part', loadpin: 'load_pin', typical: 'typical_current', typicalcurrent: 'typical_current',
  peak: 'peak_current', peakcurrent: 'peak_current', splits: 'splits', splitsstargrounds: 'splits', stargrounds: 'splits', note: 'notes',
};
const columnOf = (header: string): Column | undefined => {
  const key = header.toLowerCase().replace(/[^a-z0-9]/g, '');
  return BOARD_INFO_COLUMNS.find(c => c.replace(/_/g, '') === key) ?? ALIASES[key];
};

/** Splits CSV text into rows of cells: quoted cells, doubled quotes, and `,` or `;` as the separator (Excel uses `;` in many locales). */
export function splitCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    }
    else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const csvCell = (v: string) => (/[",;\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** `150mA`, `0.15`, `0.15 A`, `1.2A` → A. */
export function parseAmps(text: string): number | undefined {
  const m = /^(\d+(?:[.,]\d+)?)\s*(m|µ|u)?a?$/i.exec(text.trim());
  if (!m) return undefined;
  const scale = !m[2] ? 1 : m[2].toLowerCase() === 'm' ? 1e-3 : 1e-6;
  return Number(m[1].replace(',', '.')) * scale;
}

export const formatAmps = (a: number) => (a < 1 ? `${+(a * 1000).toFixed(3)}mA` : `${+a.toFixed(4)}A`);

/** `3.3`, `3.3V`, `3V3`, `1V8` → V. */
export function parseVolts(text: string): number | undefined {
  const t = text.trim();
  const rail = /^(\d+)V(\d+)$/i.exec(t);
  if (rail) return Number(`${rail[1]}.${rail[2]}`);
  const m = /^(-?\d+(?:[.,]\d+)?)\s*(m)?v?$/i.exec(t);
  return m ? Number(m[1].replace(',', '.')) * (m[2] ? 1e-3 : 1) : undefined;
}

export function parseNetKind(text: string): NetKind | undefined {
  const t = text.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (/^(diff|differential)( pair)?$|^diffpair$/.test(t)) return 'diff pair';
  if (/^(gnd|ground)$/.test(t)) return 'ground';
  if (/^(power|supply|rail)$/.test(t)) return 'power';
  return (NET_KINDS as readonly string[]).includes(t) ? t as NetKind : undefined;
}

const list = (text: string) => text.split(/[;|\s]+/).map(s => s.trim()).filter(Boolean);

export interface ParsedBoardInfo {
  info: BoardInfo;
  /** Cells that could not be read, by line number; the rest of the row is still used. */
  warnings: string[];
}

/** Reads a board-info CSV: a header row naming the columns, then one `net`, `load` or `layer` row each. Blank cells: not applicable. */
export function parseBoardInfoCsv(text: string): ParsedBoardInfo {
  const rows = splitCsv(text);
  const warnings: string[] = [];
  const info = emptyBoardInfo();
  const headerAt = rows.findIndex(r => r.some(c => columnOf(c) === 'row'));
  if (headerAt < 0) {
    warnings.push('no header row with a "row" column: the first column must be "row" (net, load or layer)');
    return { info, warnings };
  }
  const columns = rows[headerAt].map(columnOf);
  for (const [i, h] of rows[headerAt].entries()) {
    if (h.trim() && !columns[i]) warnings.push(`line ${headerAt + 1}: column "${h.trim()}" is not known and is ignored`);
  }
  for (let r = headerAt + 1; r < rows.length; r++) {
    const line = r + 1;
    const cells: Partial<Record<Column, string>> = {};
    rows[r].forEach((v, i) => {
      const col = columns[i];
      if (col && v.trim()) cells[col] = v.trim();
    });
    const type = (cells.row ?? '').toLowerCase();
    if (!type || type.startsWith('#'))
      continue;
    const notes = cells.notes;
    const amps = (col: 'typical_current' | 'peak_current') => {
      if (!cells[col]) return undefined;
      const a = parseAmps(cells[col]!);
      if (a === undefined) warnings.push(`line ${line}: ${col} "${cells[col]}" is not a current (use 150mA or 0.15)`);
      return a;
    };
    if (type === 'net') {
      if (!cells.net) { warnings.push(`line ${line}: a net row needs a net`); continue; }
      const n: NetInfo = { net: cells.net };
      if (cells.kind) {
        n.kind = parseNetKind(cells.kind);
        if (!n.kind) warnings.push(`line ${line}: kind "${cells.kind}" is not one of ${NET_KINDS.join(', ')}`);
      }
      if (cells.protocol) n.protocol = cells.protocol;
      if (cells.speed) {
        n.speedHz = parseHz(cells.speed);
        if (!n.speedHz) warnings.push(`line ${line}: speed "${cells.speed}" is not a frequency (use 400k, 12 MHz or 115200)`);
      }
      if (cells.driver_part) {
        const parts = /^(none|-)$/i.test(cells.driver_part) ? [] : list(cells.driver_part);
        n.driver = { parts, ...(cells.driver_pin ? { pin: cells.driver_pin } : {}), ...(cells.driver_pin_name ? { pinName: cells.driver_pin_name } : {}) };
      }
      if (cells.receivers) n.receivers = list(cells.receivers);
      if (cells.diff_partner) n.diffPartner = cells.diff_partner;
      if (cells.reference) n.reference = cells.reference;
      if (cells.target) n.target = cells.target;
      if (notes) n.notes = notes;
      info.nets = [...info.nets.filter(x => !sameNet(x.net, n.net)), n];
    }
    else if (type === 'load') {
      if (!cells.net) { warnings.push(`line ${line}: a load row needs the rail in the net column`); continue; }
      const l: LoadInfo = { net: cells.net };
      if (cells.voltage) {
        l.voltage = parseVolts(cells.voltage);
        if (l.voltage === undefined) warnings.push(`line ${line}: voltage "${cells.voltage}" is not a voltage (use 3.3 or 3V3)`);
      }
      if (cells.source_part) l.source = { part: cells.source_part, ...(cells.source_pin ? { pin: cells.source_pin } : {}) };
      if (cells.load_part) l.load = { part: cells.load_part, ...(cells.load_pin ? { pin: cells.load_pin } : {}) };
      const typ = amps('typical_current');
      const peak = amps('peak_current');
      if (typ !== undefined) l.typicalA = typ;
      if (peak !== undefined) l.peakA = peak;
      if (notes) l.notes = notes;
      info.loads = [...info.loads.filter(x => !sameLoad(x, l)), l];
    }
    else if (type === 'layer') {
      if (!cells.layer) { warnings.push(`line ${line}: a layer row needs a layer`); continue; }
      const l: LayerInfo = { layer: cells.layer };
      if (cells.pours) l.pours = cells.pours;
      if (cells.splits) l.splits = cells.splits;
      if (notes) l.notes = notes;
      info.layers = [...info.layers.filter(x => x.layer !== l.layer), l];
    }
    else {
      warnings.push(`line ${line}: row "${cells.row}" is not net, load or layer`);
    }
  }
  return { info, warnings };
}

const sameLoad = (a: LoadInfo, b: LoadInfo) => sameNet(a.net, b.net) && (a.load?.part ?? '') === (b.load?.part ?? '');

/** Writes the board info as CSV in the format parseBoardInfoCsv reads, with every column. */
export function formatBoardInfoCsv(info: BoardInfo): string {
  const line = (cells: Partial<Record<Column, string | undefined>>) => BOARD_INFO_COLUMNS.map(c => csvCell(cells[c] ?? '')).join(',');
  const out = [BOARD_INFO_COLUMNS.join(',')];
  for (const n of info.nets) {
    out.push(line({
      row: 'net', net: n.net, kind: n.kind, protocol: n.protocol, speed: n.speedHz ? formatHz(n.speedHz) : undefined,
      driver_part: n.driver ? (n.driver.parts.length ? n.driver.parts.join(';') : 'none') : undefined, driver_pin: n.driver?.pin, driver_pin_name: n.driver?.pinName,
      receivers: n.receivers?.join(';'), diff_partner: n.diffPartner, reference: n.reference, target: n.target, notes: n.notes,
    }));
  }
  for (const l of info.loads) {
    out.push(line({
      row: 'load', net: l.net, voltage: l.voltage !== undefined ? String(l.voltage) : undefined, source_part: l.source?.part, source_pin: l.source?.pin,
      load_part: l.load?.part, load_pin: l.load?.pin, typical_current: l.typicalA !== undefined ? formatAmps(l.typicalA) : undefined,
      peak_current: l.peakA !== undefined ? formatAmps(l.peakA) : undefined, notes: l.notes,
    }));
  }
  for (const l of info.layers)
    out.push(line({ row: 'layer', layer: l.layer, pours: l.pours, splits: l.splits, notes: l.notes }));
  return `${out.join('\n')}\n`;
}

/** Adds `more` to `base`: a net, load (rail and load part) or layer in both takes the filled-in fields of `more`. */
export function mergeBoardInfo(base: BoardInfo, more: BoardInfo): BoardInfo {
  const nets = [...base.nets];
  for (const n of more.nets) {
    const i = nets.findIndex(x => sameNet(x.net, n.net));
    if (i < 0) nets.push(n);
    else nets[i] = { ...nets[i], ...n };
  }
  const loads = [...base.loads];
  for (const l of more.loads) {
    const i = loads.findIndex(x => sameLoad(x, l));
    if (i < 0) loads.push(l);
    else loads[i] = { ...loads[i], ...l };
  }
  const layers = [...base.layers];
  for (const l of more.layers) {
    const i = layers.findIndex(x => x.layer === l.layer);
    if (i < 0) layers.push(l);
    else layers[i] = { ...layers[i], ...l };
  }
  return { nets, loads, layers };
}

export const netInfo = (info: BoardInfo, net: string) => info.nets.find(n => sameNet(n.net, net));

/** A rail as the board info gives it: voltage, source part and the loads with their currents. */
export interface RailInfo {
  voltage?: number;
  source?: string;
  loads: { part: string; typicalA?: number; peakA?: number }[];
}

export function railInfo(info: BoardInfo, rail: string): RailInfo | undefined {
  const rows = info.loads.filter(l => sameNet(l.net, rail));
  if (!rows.length) return undefined;
  return {
    voltage: rows.find(r => r.voltage !== undefined)?.voltage,
    source: rows.find(r => r.source)?.source?.part,
    loads: rows.filter(r => r.load).map(r => ({ part: r.load!.part, typicalA: r.typicalA, peakA: r.peakA })),
  };
}

/** Rails the board info names: nets with load rows, and nets of kind power. */
export function infoRails(info: BoardInfo): string[] {
  return uniqueNets([...info.loads.map(l => l.net), ...info.nets.filter(n => n.kind === 'power').map(n => n.net)]);
}

/** Sets a net's fields (a manual change in the wizard), keeping the others. */
export function withNet(info: BoardInfo, net: string, patch: Partial<Omit<NetInfo, 'net'>>): BoardInfo {
  return mergeBoardInfo(info, { nets: [{ ...netInfo(info, net), net, ...patch }], loads: [], layers: [] });
}

/**
 * Sets a rail's source and loads (a manual change in the DC wizard): load rows of parts no longer
 * loads are dropped, kept loads keep their pins, peak current and notes, new loads get a row.
 */
export function withRail(info: BoardInfo, rail: string, setup: { source: string; loads: { part: string; typicalA?: number }[] }): BoardInfo {
  const rows = info.loads.filter(l => sameNet(l.net, rail));
  const voltage = rows.find(r => r.voltage !== undefined)?.voltage;
  const sourcePin = rows.find(r => r.source?.part === setup.source)?.source?.pin;
  const source = { part: setup.source, ...(sourcePin ? { pin: sourcePin } : {}) };
  const kept: LoadInfo[] = rows.filter(r => !r.load).map(r => ({ ...r, source }));
  for (const l of setup.loads) {
    const old = rows.find(r => r.load?.part === l.part);
    const row: LoadInfo = { ...old, net: rail, source, load: old?.load ?? { part: l.part } };
    if (voltage !== undefined) row.voltage = voltage;
    if (l.typicalA !== undefined) row.typicalA = l.typicalA;
    kept.push(row);
  }
  return { ...info, loads: [...info.loads.filter(l => !sameNet(l.net, rail)), ...kept] };
}
