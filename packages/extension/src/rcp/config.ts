import {
  emptyBoardInfo,
  mergeBoardInfo,
  NET_KINDS,
  parseAmps,
  parseCurrents,
  parseHz,
  parseNetKind,
  parseVolts,
  uniqueNets,
  type BoardInfo,
  type LayerInfo,
  type LoadInfo,
  type NetInfo,
} from '@returnpath/core';
import { currentProject, readBoardInfo, writeBoardInfo, type Project } from '../board-info.js';
import { log, readStored, writeStored } from '../runner.js';
import { currentStyle, MAX_WIDTH, PALETTE, ROLES, saveStyle, type ColourName, type Role, type RoleStyle } from '../style.js';
import {
  DEFAULT_CHECK_RULES,
  type ActiveJobSummary,
  type BoardInfoInput,
  type CheckRules,
  type LoadInfoInput,
  type NetInfoInput,
  type PartialCheckRules,
  type RcpConfigData,
  type RcpDcConfig,
  type RcpHfConfig,
  type RcpHost,
  type SetConfigReplyData,
  type SetConfigRequest,
} from './types.js';

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
export const DEFAULT_HF_TIMEOUT_MS = 60_000;
export const DEFAULT_DC_TIMEOUT_MS = 120_000;

export interface StoredRcpProjectConfig {
  rules: CheckRules;
  hf: RcpHfConfig;
  dc: RcpDcConfig;
}

export function defaultCheckRules(): CheckRules {
  return {
    referenceNets: DEFAULT_CHECK_RULES.referenceNets ? [...DEFAULT_CHECK_RULES.referenceNets] : null,
    returnViaRadiusMm: DEFAULT_CHECK_RULES.returnViaRadiusMm,
    planeEdgeClearanceFactor: DEFAULT_CHECK_RULES.planeEdgeClearanceFactor,
    minSegmentLengthMm: DEFAULT_CHECK_RULES.minSegmentLengthMm,
    skipNets: [...DEFAULT_CHECK_RULES.skipNets],
  };
}

export function defaultHfConfig(): RcpHfConfig {
  return {
    nets: [],
    draw: true,
    timeoutMs: DEFAULT_HF_TIMEOUT_MS,
  };
}

export function defaultDcConfig(): RcpDcConfig {
  return {
    draw: true,
    timeoutMs: DEFAULT_DC_TIMEOUT_MS,
  };
}

function projectIdOf(project: Project): string {
  return project.key.replace(/^boardInfo:/, '');
}

function configStorageKey(project: Project): string {
  return `rcpConfig:${projectIdOf(project)}`;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid "${field}": expected an array of strings.`);
  }
  const out: string[] = [];
  for (const item of value) {
    const s = nonEmptyString(item);
    if (!s) {
      throw new Error(`Invalid "${field}": every entry must be a non-empty string.`);
    }
    out.push(s);
  }
  return out;
}

export function parseSpeedHzInput(value: unknown, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Invalid "${field}": expected a positive finite number in Hz.`);
    }
    return value;
  }
  if (typeof value === 'string') {
    const hz = parseHz(value);
    if (!hz) {
      throw new Error(`Invalid "${field}" ("${value}"): expected a frequency like "16 MHz", "400k", or Hz number.`);
    }
    return hz;
  }
  throw new Error(`Invalid "${field}": expected a positive Hz number or frequency string like "16 MHz".`);
}

export function parseCurrentsInput(value: unknown, field = 'currents'): Record<string, number> {
  if (typeof value === 'string') {
    const parsed = parseCurrents(value);
    if (!parsed || !Object.keys(parsed).length) {
      throw new Error(`Invalid "${field}": expected e.g. "U2=150mA, U3=0.2A" or an object map.`);
    }
    return parsed;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid "${field}": expected an object map (e.g. { "U2": 0.15 }) or string (e.g. "U2=150mA").`);
  }
  const out: Record<string, number> = {};
  for (const [rawKey, rawVal] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key) {
      throw new Error(`Invalid "${field}": designator keys must be non-empty strings.`);
    }
    if (typeof rawVal === 'number') {
      if (!Number.isFinite(rawVal) || rawVal < 0) {
        throw new Error(`Invalid current for "${key}": expected a non-negative finite number in amps.`);
      }
      out[key] = rawVal;
    } else if (typeof rawVal === 'string') {
      const a = parseAmps(rawVal);
      if (a === undefined || !Number.isFinite(a) || a < 0) {
        throw new Error(`Invalid current "${rawVal}" for "${key}": use amps (e.g. 0.15) or e.g. "150mA".`);
      }
      out[key] = a;
    } else {
      throw new Error(`Invalid current for "${key}": expected a number in amps or string like "150mA".`);
    }
  }
  return out;
}

export function parseTimeoutMsInput(value: unknown, field = 'timeoutMs'): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid "${field}": expected a positive finite number in ms.`);
  }
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(value)));
}

function parseRulesPatch(raw: unknown, base: CheckRules): CheckRules {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid "rules": expected an object or null.');
  }
  const obj = raw as Record<string, unknown>;
  const next: CheckRules = {
    referenceNets: base.referenceNets ? [...base.referenceNets] : null,
    returnViaRadiusMm: base.returnViaRadiusMm,
    planeEdgeClearanceFactor: base.planeEdgeClearanceFactor,
    minSegmentLengthMm: base.minSegmentLengthMm,
    skipNets: [...base.skipNets],
  };

  if ('referenceNets' in obj) {
    if (obj.referenceNets === null) {
      next.referenceNets = null;
    } else {
      const list = uniqueNets(parseStringArray(obj.referenceNets, 'rules.referenceNets'));
      next.referenceNets = list.length ? list : null;
    }
  }
  if ('returnViaRadiusMm' in obj) {
    if (typeof obj.returnViaRadiusMm !== 'number' || !Number.isFinite(obj.returnViaRadiusMm) || obj.returnViaRadiusMm < 0) {
      throw new Error('Invalid "rules.returnViaRadiusMm": expected a non-negative finite number in mm.');
    }
    next.returnViaRadiusMm = obj.returnViaRadiusMm;
  }
  if ('planeEdgeClearanceFactor' in obj) {
    if (
      typeof obj.planeEdgeClearanceFactor !== 'number' ||
      !Number.isFinite(obj.planeEdgeClearanceFactor) ||
      obj.planeEdgeClearanceFactor < 0
    ) {
      throw new Error('Invalid "rules.planeEdgeClearanceFactor": expected a non-negative finite number.');
    }
    next.planeEdgeClearanceFactor = obj.planeEdgeClearanceFactor;
  }
  if ('minSegmentLengthMm' in obj) {
    if (
      typeof obj.minSegmentLengthMm !== 'number' ||
      !Number.isFinite(obj.minSegmentLengthMm) ||
      obj.minSegmentLengthMm < 0
    ) {
      throw new Error('Invalid "rules.minSegmentLengthMm": expected a non-negative finite number in mm.');
    }
    next.minSegmentLengthMm = obj.minSegmentLengthMm;
  }
  if ('skipNets' in obj) {
    if (obj.skipNets === null) {
      next.skipNets = [];
    } else {
      next.skipNets = uniqueNets(parseStringArray(obj.skipNets, 'rules.skipNets'));
    }
  }
  return next;
}

function parseHfPatch(raw: unknown, base: RcpHfConfig): RcpHfConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid "hf": expected an object or null.');
  }
  const obj = raw as Record<string, unknown>;
  const next: RcpHfConfig = {
    nets: [...base.nets],
    ...(base.speedHz !== undefined ? { speedHz: base.speedHz } : {}),
    ...(base.drivers !== undefined ? { drivers: [...base.drivers] } : {}),
    draw: base.draw,
    timeoutMs: base.timeoutMs,
  };

  if ('nets' in obj) {
    next.nets = obj.nets === null ? [] : uniqueNets(parseStringArray(obj.nets, 'hf.nets'));
  }
  if ('speedHz' in obj) {
    if (obj.speedHz === null) {
      delete next.speedHz;
    } else {
      next.speedHz = parseSpeedHzInput(obj.speedHz, 'hf.speedHz');
    }
  } else if ('speed' in obj) {
    if (obj.speed === null) {
      delete next.speedHz;
    } else {
      next.speedHz = parseSpeedHzInput(obj.speed, 'hf.speed');
    }
  }
  if ('drivers' in obj) {
    if (obj.drivers === null) {
      delete next.drivers;
    } else if (typeof obj.drivers === 'string') {
      const s = obj.drivers.trim();
      next.drivers = s ? [s] : [];
    } else {
      next.drivers = parseStringArray(obj.drivers, 'hf.drivers');
    }
  }
  if ('draw' in obj) {
    if (typeof obj.draw !== 'boolean') {
      throw new Error('Invalid "hf.draw": expected a boolean.');
    }
    next.draw = obj.draw;
  }
  if ('timeoutMs' in obj) {
    next.timeoutMs = parseTimeoutMsInput(obj.timeoutMs, 'hf.timeoutMs');
  }
  return next;
}

function parseDcPatch(raw: unknown, base: RcpDcConfig): RcpDcConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid "dc": expected an object or null.');
  }
  const obj = raw as Record<string, unknown>;
  const next: RcpDcConfig = {
    ...(base.rail !== undefined ? { rail: base.rail } : {}),
    ...(base.railNets !== undefined ? { railNets: [...base.railNets] } : {}),
    ...(base.ground !== undefined ? { ground: base.ground } : {}),
    ...(base.source !== undefined ? { source: base.source } : {}),
    ...(base.loads !== undefined ? { loads: [...base.loads] } : {}),
    ...(base.currents !== undefined ? { currents: { ...base.currents } } : {}),
    ...(base.focus !== undefined ? { focus: base.focus } : {}),
    draw: base.draw,
    timeoutMs: base.timeoutMs,
  };

  for (const field of ['rail', 'ground', 'source', 'focus'] as const) {
    if (field in obj) {
      if (obj[field] === null) {
        delete next[field];
      } else {
        const s = nonEmptyString(obj[field]);
        if (!s) throw new Error(`Invalid "dc.${field}": expected a non-empty string or null.`);
        next[field] = s;
      }
    }
  }
  if ('railNets' in obj) {
    if (obj.railNets === null) {
      delete next.railNets;
    } else {
      const list = uniqueNets(parseStringArray(obj.railNets, 'dc.railNets'));
      if (list.length) next.railNets = list;
      else delete next.railNets;
    }
  }
  if ('loads' in obj) {
    if (obj.loads === null) {
      delete next.loads;
    } else {
      const list = parseStringArray(obj.loads, 'dc.loads');
      if (list.length) next.loads = list;
      else delete next.loads;
    }
  }
  if ('currents' in obj) {
    if (obj.currents === null) {
      delete next.currents;
    } else {
      const parsed = parseCurrentsInput(obj.currents, 'dc.currents');
      if (Object.keys(parsed).length) next.currents = parsed;
      else delete next.currents;
    }
  }
  if ('draw' in obj) {
    if (typeof obj.draw !== 'boolean') {
      throw new Error('Invalid "dc.draw": expected a boolean.');
    }
    next.draw = obj.draw;
  }
  if ('timeoutMs' in obj) {
    next.timeoutMs = parseTimeoutMsInput(obj.timeoutMs, 'dc.timeoutMs');
  }
  return next;
}

function parseNetInfoEntry(raw: unknown, idx: number): NetInfo {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid "boardInfo.nets[${idx}]": expected an object.`);
  }
  const obj = raw as NetInfoInput & Record<string, unknown>;
  const net = nonEmptyString(obj.net);
  if (!net) {
    throw new Error(`Invalid "boardInfo.nets[${idx}].net": expected a non-empty net name.`);
  }
  const out: NetInfo = { net };

  if (obj.kind !== undefined) {
    if (typeof obj.kind !== 'string') {
      throw new Error(`Invalid "boardInfo.nets[${idx}].kind": expected one of ${NET_KINDS.join(', ')}.`);
    }
    const kind = parseNetKind(obj.kind);
    if (!kind) {
      throw new Error(`Invalid "boardInfo.nets[${idx}].kind" ("${obj.kind}"): expected one of ${NET_KINDS.join(', ')}.`);
    }
    out.kind = kind;
  }
  if (obj.protocol !== undefined) {
    const p = nonEmptyString(obj.protocol);
    if (!p) throw new Error(`Invalid "boardInfo.nets[${idx}].protocol": expected a non-empty string.`);
    out.protocol = p;
  }
  if (obj.speedHz !== undefined) {
    out.speedHz = parseSpeedHzInput(obj.speedHz, `boardInfo.nets[${idx}].speedHz`);
  } else if (obj.speed !== undefined) {
    out.speedHz = parseSpeedHzInput(obj.speed, `boardInfo.nets[${idx}].speed`);
  }
  if (obj.driver !== undefined && obj.driver !== null) {
    if (typeof obj.driver === 'string') {
      const s = obj.driver.trim();
      out.driver = { parts: /^(none|-)$/i.test(s) || !s ? [] : [s] };
    } else if (Array.isArray(obj.driver)) {
      out.driver = { parts: parseStringArray(obj.driver, `boardInfo.nets[${idx}].driver`) };
    } else if (typeof obj.driver === 'object') {
      const d = obj.driver as Record<string, unknown>;
      const parts = parseStringArray(d.parts ?? [], `boardInfo.nets[${idx}].driver.parts`);
      const pin = d.pin !== undefined ? nonEmptyString(d.pin) : undefined;
      const pinName = d.pinName !== undefined ? nonEmptyString(d.pinName) : undefined;
      out.driver = { parts, ...(pin ? { pin } : {}), ...(pinName ? { pinName } : {}) };
    } else {
      throw new Error(`Invalid "boardInfo.nets[${idx}].driver": expected designator string, string[], or { parts, pin?, pinName? }.`);
    }
  }
  if (obj.receivers !== undefined) {
    out.receivers = parseStringArray(obj.receivers, `boardInfo.nets[${idx}].receivers`);
  }
  if (obj.diffPartner !== undefined) {
    const dp = nonEmptyString(obj.diffPartner);
    if (!dp) throw new Error(`Invalid "boardInfo.nets[${idx}].diffPartner": expected a non-empty string.`);
    out.diffPartner = dp;
  }
  if (obj.reference !== undefined) {
    const ref = nonEmptyString(obj.reference);
    if (!ref) throw new Error(`Invalid "boardInfo.nets[${idx}].reference": expected a non-empty string.`);
    out.reference = ref;
  }
  if (obj.target !== undefined) {
    const tgt = nonEmptyString(obj.target);
    if (!tgt) throw new Error(`Invalid "boardInfo.nets[${idx}].target": expected a non-empty string.`);
    out.target = tgt;
  }
  if (obj.edge !== undefined) {
    const e = typeof obj.edge === 'string' ? obj.edge.trim().toLowerCase() : '';
    if (e !== 'fast' && e !== 'normal' && e !== 'slow') {
      throw new Error(`Invalid "boardInfo.nets[${idx}].edge": expected "fast", "normal", or "slow".`);
    }
    out.edge = e;
  }
  if (obj.drive !== undefined) {
    const dr = typeof obj.drive === 'string' ? obj.drive.trim().toLowerCase().replace(/[\s_]+/g, '-') : '';
    if (dr !== 'push-pull' && dr !== 'open-drain') {
      throw new Error(`Invalid "boardInfo.nets[${idx}].drive": expected "push-pull" or "open-drain".`);
    }
    out.drive = dr;
  }
  if (obj.notes !== undefined) {
    if (typeof obj.notes !== 'string') throw new Error(`Invalid "boardInfo.nets[${idx}].notes": expected a string.`);
    if (obj.notes.trim()) out.notes = obj.notes.trim();
  }
  return out;
}

function parsePartPin(raw: unknown, field: string): { part: string; pin?: string } {
  if (typeof raw === 'string') {
    const part = nonEmptyString(raw);
    if (!part) throw new Error(`Invalid "${field}": expected a non-empty designator string.`);
    return { part };
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const part = nonEmptyString(obj.part);
    if (!part) throw new Error(`Invalid "${field}.part": expected a non-empty designator string.`);
    const pin = obj.pin !== undefined ? nonEmptyString(obj.pin) : undefined;
    return { part, ...(pin ? { pin } : {}) };
  }
  throw new Error(`Invalid "${field}": expected a designator string or { part, pin? }.`);
}

function parseAmpValue(raw: unknown, field: string): number {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) {
      throw new Error(`Invalid "${field}": expected a non-negative finite number in amps.`);
    }
    return raw;
  }
  if (typeof raw === 'string') {
    const a = parseAmps(raw);
    if (a === undefined || !Number.isFinite(a) || a < 0) {
      throw new Error(`Invalid "${field}" ("${raw}"): use amps (e.g. 0.15) or e.g. "150mA".`);
    }
    return a;
  }
  throw new Error(`Invalid "${field}": expected a number in amps or string like "150mA".`);
}

function parseLoadInfoEntry(raw: unknown, idx: number): LoadInfo {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid "boardInfo.loads[${idx}]": expected an object.`);
  }
  const obj = raw as LoadInfoInput & Record<string, unknown>;
  const net = nonEmptyString(obj.net);
  if (!net) {
    throw new Error(`Invalid "boardInfo.loads[${idx}].net": expected a non-empty rail net name.`);
  }
  const out: LoadInfo = { net };
  if (obj.voltage !== undefined) {
    if (typeof obj.voltage === 'number') {
      if (!Number.isFinite(obj.voltage)) {
        throw new Error(`Invalid "boardInfo.loads[${idx}].voltage": expected a finite number in volts.`);
      }
      out.voltage = obj.voltage;
    } else if (typeof obj.voltage === 'string') {
      const v = parseVolts(obj.voltage);
      if (v === undefined) {
        throw new Error(`Invalid "boardInfo.loads[${idx}].voltage" ("${obj.voltage}"): use e.g. 3.3 or "3V3".`);
      }
      out.voltage = v;
    } else {
      throw new Error(`Invalid "boardInfo.loads[${idx}].voltage": expected a number or voltage string like "3V3".`);
    }
  }
  if (obj.source !== undefined) {
    out.source = parsePartPin(obj.source, `boardInfo.loads[${idx}].source`);
  }
  if (obj.load !== undefined) {
    out.load = parsePartPin(obj.load, `boardInfo.loads[${idx}].load`);
  }
  if (obj.typicalA !== undefined) {
    out.typicalA = parseAmpValue(obj.typicalA, `boardInfo.loads[${idx}].typicalA`);
  } else if (obj.typicalCurrent !== undefined) {
    out.typicalA = parseAmpValue(obj.typicalCurrent, `boardInfo.loads[${idx}].typicalCurrent`);
  }
  if (obj.peakA !== undefined) {
    out.peakA = parseAmpValue(obj.peakA, `boardInfo.loads[${idx}].peakA`);
  } else if (obj.peakCurrent !== undefined) {
    out.peakA = parseAmpValue(obj.peakCurrent, `boardInfo.loads[${idx}].peakCurrent`);
  }
  if (obj.notes !== undefined) {
    if (typeof obj.notes !== 'string') throw new Error(`Invalid "boardInfo.loads[${idx}].notes": expected a string.`);
    if (obj.notes.trim()) out.notes = obj.notes.trim();
  }
  return out;
}

function parseLayerInfoEntry(raw: unknown, idx: number): LayerInfo {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid "boardInfo.layers[${idx}]": expected an object.`);
  }
  const obj = raw as Record<string, unknown>;
  const layer = nonEmptyString(obj.layer);
  if (!layer) {
    throw new Error(`Invalid "boardInfo.layers[${idx}].layer": expected a non-empty layer name.`);
  }
  const out: LayerInfo = { layer };
  if (obj.pours !== undefined) {
    if (typeof obj.pours !== 'string') throw new Error(`Invalid "boardInfo.layers[${idx}].pours": expected a string.`);
    if (obj.pours.trim()) out.pours = obj.pours.trim();
  }
  if (obj.splits !== undefined) {
    if (typeof obj.splits !== 'string') throw new Error(`Invalid "boardInfo.layers[${idx}].splits": expected a string.`);
    if (obj.splits.trim()) out.splits = obj.splits.trim();
  }
  if (obj.notes !== undefined) {
    if (typeof obj.notes !== 'string') throw new Error(`Invalid "boardInfo.layers[${idx}].notes": expected a string.`);
    if (obj.notes.trim()) out.notes = obj.notes.trim();
  }
  return out;
}

function parseBoardInfoInput(raw: unknown): BoardInfo {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid "boardInfo": expected an object { nets?, loads?, layers? } or null.');
  }
  const obj = raw as BoardInfoInput & Record<string, unknown>;
  const nets = obj.nets === undefined ? [] : (Array.isArray(obj.nets) ? obj.nets.map(parseNetInfoEntry) : (() => { throw new Error('Invalid "boardInfo.nets": expected an array.'); })());
  const loads = obj.loads === undefined ? [] : (Array.isArray(obj.loads) ? obj.loads.map(parseLoadInfoEntry) : (() => { throw new Error('Invalid "boardInfo.loads": expected an array.'); })());
  const layers = obj.layers === undefined ? [] : (Array.isArray(obj.layers) ? obj.layers.map(parseLayerInfoEntry) : (() => { throw new Error('Invalid "boardInfo.layers": expected an array.'); })());
  return { nets, loads, layers };
}

function parseOverlayStylePatch(raw: unknown): Partial<Record<Role, Partial<RoleStyle>>> | 'reset' {
  if (raw === 'reset') return 'reset';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid "overlayStyle": expected an object mapping role names to { colour?, width?, visible? } or "reset".');
  }
  const roleSet = new Set<string>(ROLES);
  const out: Partial<Record<Role, Partial<RoleStyle>>> = {};
  for (const [role, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!roleSet.has(role)) {
      throw new Error(`Invalid "overlayStyle.${role}": unknown role (valid roles: ${ROLES.join(', ')}).`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Invalid "overlayStyle.${role}": expected an object { colour?, width?, visible? }.`);
    }
    const obj = value as Record<string, unknown>;
    const patch: Partial<RoleStyle> = {};
    const rawColour = obj.colour ?? obj.color;
    if (rawColour !== undefined) {
      if (typeof rawColour !== 'string' || !(rawColour in PALETTE)) {
        throw new Error(`Invalid "overlayStyle.${role}.colour": expected one of ${Object.keys(PALETTE).join(', ')}.`);
      }
      patch.colour = rawColour as ColourName;
    }
    if (obj.width !== undefined) {
      if (typeof obj.width !== 'number' || !Number.isFinite(obj.width) || obj.width < 1 || obj.width > MAX_WIDTH) {
        throw new Error(`Invalid "overlayStyle.${role}.width": expected a number between 1 and ${MAX_WIDTH}.`);
      }
      patch.width = Math.round(obj.width);
    }
    if (obj.visible !== undefined) {
      if (typeof obj.visible !== 'boolean') {
        throw new Error(`Invalid "overlayStyle.${role}.visible": expected a boolean.`);
      }
      patch.visible = obj.visible;
    }
    out[role as Role] = patch;
  }
  return out;
}

export function readStoredRcpProjectConfig(project: Project): StoredRcpProjectConfig {
  const raw = readStored(configStorageKey(project));
  let parsed: Record<string, unknown> | undefined;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        parsed = obj as Record<string, unknown>;
      }
    } catch {
      parsed = undefined;
    }
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    parsed = raw as Record<string, unknown>;
  }

  let rules = defaultCheckRules();
  let hf = defaultHfConfig();
  let dc = defaultDcConfig();

  if (parsed?.rules) {
    try {
      rules = parseRulesPatch(parsed.rules, rules);
    } catch {}
  }
  if (parsed?.hf) {
    try {
      hf = parseHfPatch(parsed.hf, hf);
    } catch {}
  }
  if (parsed?.dc) {
    try {
      dc = parseDcPatch(parsed.dc, dc);
    } catch {}
  }

  return { rules, hf, dc };
}

async function writeStoredRcpProjectConfig(project: Project, config: StoredRcpProjectConfig): Promise<void> {
  await writeStored(configStorageKey(project), JSON.stringify(config));
}

export async function getEffectiveCheckRules(override?: PartialCheckRules | null): Promise<CheckRules> {
  const project = await currentProject();
  const stored = readStoredRcpProjectConfig(project).rules;
  if (!override) return stored;
  return parseRulesPatch(override, stored);
}

export async function readCurrentProjectConfig(): Promise<{ project: Project; stored: StoredRcpProjectConfig; boardInfo: BoardInfo }> {
  const project = await currentProject();
  return {
    project,
    stored: readStoredRcpProjectConfig(project),
    boardInfo: readBoardInfo(project),
  };
}

export async function getRcpConfig(
  host: RcpHost | undefined,
  activeJob: ActiveJobSummary | null,
): Promise<RcpConfigData> {
  const { project, stored, boardInfo } = await readCurrentProjectConfig();
  return {
    unit: 'mm',
    project: { id: projectIdOf(project), name: project.name },
    boardInfo,
    rules: stored.rules,
    hf: stored.hf,
    dc: stored.dc,
    overlayStyle: currentStyle(),
    lastRun: host?.getLastRun?.() ?? null,
    activeJob,
  };
}

export async function setRcpConfig(
  message: unknown,
  host: RcpHost | undefined,
  activeJob: ActiveJobSummary | null,
): Promise<SetConfigReplyData> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('Request must be a JSON object with one or more config fields (boardInfo, rules, hf, dc, overlayStyle, reset).');
  }
  const req = message as SetConfigRequest & Record<string, unknown>;
  const mode = req.mode ?? 'merge';
  if (mode !== 'merge' && mode !== 'replace') {
    throw new Error('Invalid "mode": expected "merge" or "replace".');
  }
  if (req.reset !== undefined && typeof req.reset !== 'boolean') {
    throw new Error('Invalid "reset": expected a boolean.');
  }

  const project = await currentProject();
  const prevBoardInfo = readBoardInfo(project);
  const prevStored = readStoredRcpProjectConfig(project);

  let nextStored: StoredRcpProjectConfig = req.reset
    ? { rules: defaultCheckRules(), hf: defaultHfConfig(), dc: defaultDcConfig() }
    : {
        rules: { ...prevStored.rules, referenceNets: prevStored.rules.referenceNets ? [...prevStored.rules.referenceNets] : null, skipNets: [...prevStored.rules.skipNets] },
        hf: { ...prevStored.hf, nets: [...prevStored.hf.nets], ...(prevStored.hf.drivers ? { drivers: [...prevStored.hf.drivers] } : {}) },
        dc: { ...prevStored.dc, ...(prevStored.dc.railNets ? { railNets: [...prevStored.dc.railNets] } : {}), ...(prevStored.dc.loads ? { loads: [...prevStored.dc.loads] } : {}), ...(prevStored.dc.currents ? { currents: { ...prevStored.dc.currents } } : {}) },
      };

  const updated: string[] = [];
  if (req.reset) {
    updated.push('rules', 'hf', 'dc');
  }

  let nextBoardInfo = prevBoardInfo;
  let boardInfoChanged = false;
  let propChanges: { net: string; edge?: 'fast' | 'normal' | 'slow'; drive?: 'push-pull' | 'open-drain' }[] = [];

  if ('boardInfo' in req) {
    if (req.boardInfo === null) {
      nextBoardInfo = emptyBoardInfo();
    } else {
      const incoming = parseBoardInfoInput(req.boardInfo);
      nextBoardInfo = mode === 'replace' ? incoming : mergeBoardInfo(prevBoardInfo, incoming);
      propChanges = incoming.nets
        .filter((n) => n.edge !== undefined || n.drive !== undefined)
        .map((n) => ({ net: n.net, ...(n.edge ? { edge: n.edge } : {}), ...(n.drive ? { drive: n.drive } : {}) }));
    }
    boardInfoChanged = true;
    updated.push('boardInfo');
  }

  let storedChanged = Boolean(req.reset);
  if ('rules' in req) {
    nextStored.rules =
      req.rules === null
        ? defaultCheckRules()
        : parseRulesPatch(req.rules, mode === 'replace' ? defaultCheckRules() : nextStored.rules);
    storedChanged = true;
    if (!updated.includes('rules')) updated.push('rules');
  }
  if ('hf' in req) {
    nextStored.hf =
      req.hf === null
        ? defaultHfConfig()
        : parseHfPatch(req.hf, mode === 'replace' ? defaultHfConfig() : nextStored.hf);
    storedChanged = true;
    if (!updated.includes('hf')) updated.push('hf');
  }
  if ('dc' in req) {
    nextStored.dc =
      req.dc === null
        ? defaultDcConfig()
        : parseDcPatch(req.dc, mode === 'replace' ? defaultDcConfig() : nextStored.dc);
    storedChanged = true;
    if (!updated.includes('dc')) updated.push('dc');
  }

  let stylePatch: Partial<Record<Role, Partial<RoleStyle>>> | 'reset' | undefined;
  if ('overlayStyle' in req && req.overlayStyle !== undefined) {
    stylePatch = parseOverlayStylePatch(req.overlayStyle);
    updated.push('overlayStyle');
  }

  if (boardInfoChanged) {
    await writeBoardInfo(project, nextBoardInfo);
    if (propChanges.length && host?.onNetPropsChanged) {
      await host.onNetPropsChanged(propChanges);
    }
  }
  if (storedChanged) {
    await writeStoredRcpProjectConfig(project, nextStored);
  }
  if (stylePatch !== undefined) {
    await saveStyle(stylePatch);
  }

  if (updated.length) {
    log(`mcp.rcp.setConfig (${project.name}): updated ${updated.join(', ')}`);
  }

  return {
    unit: 'mm',
    updated,
    config: {
      unit: 'mm',
      project: { id: projectIdOf(project), name: project.name },
      boardInfo: nextBoardInfo,
      rules: nextStored.rules,
      hf: nextStored.hf,
      dc: nextStored.dc,
      overlayStyle: currentStyle(),
      lastRun: host?.getLastRun?.() ?? null,
      activeJob,
    },
  };
}
