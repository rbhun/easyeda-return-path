import { netKey } from '@returnpath/core';
import extensionConfig from '../../extension.json' with { type: 'json' };
import { checkNetGeometry, summarizeFindings } from './checker.js';
import {
  clearBoardCache,
  readBoardForCheck,
  readNetSummaries,
  readStackup,
  requireFocusedPcb,
  snapshotToCheckInput,
} from './eda-reader.js';
import { clearFindingMarkers, showFindingMarkers } from './markers.js';
import {
  DEFAULT_CHECK_RULES,
  type CheckNetReplyData,
  type CheckNetRequest,
  type ClearMarkersReplyData,
  type InfoReplyData,
  type ListNetsReplyData,
  type ListNetsRequest,
  type ServiceEnvelope,
  type ShowFindingsReplyData,
  type ShowFindingsRequest,
} from './types.js';

export const SERVICE_NAME = extensionConfig.name;
export const SERVICE_VERSION = extensionConfig.version;

export const RCP_TOPICS = [
  'mcp.rcp.info',
  'mcp.rcp.listNets',
  'mcp.rcp.checkNet',
  'mcp.rcp.showFindings',
  'mcp.rcp.clearMarkers',
] as const;

export type RcpTopic = (typeof RCP_TOPICS)[number];

/** Safe UTF-8 byte ceiling below the bridge's 256 KiB transport limit (leaving room for bridge envelope). */
export const MAX_REPLY_BYTES = 240 * 1024;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

let registeredTopics: string[] = [];
let registeredAt: string | null = null;
let registeredBus: unknown = null;

function utf8ByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Converts any value into strictly plain JSON (no undefined, NaN, Infinity, class instances, or deep cycles). */
export function toPlainJson<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)),
  ) as T;
}

/** Trims an array field on an envelope payload if the serialized JSON would exceed MAX_REPLY_BYTES. */
function enforceReplyBudget<T extends Record<string, unknown>>(
  data: T,
  arrayKey?: 'nets' | 'findings',
): T {
  const plain = toPlainJson(data);
  if (utf8ByteLength({ ok: true, data: plain }) <= MAX_REPLY_BYTES) {
    return plain;
  }

  if (arrayKey && Array.isArray(plain[arrayKey])) {
    const arr = plain[arrayKey] as unknown[];
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const candidate = { ...plain, [arrayKey]: arr.slice(0, mid), truncated: true };
      if (utf8ByteLength({ ok: true, data: candidate }) <= MAX_REPLY_BYTES) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    const trimmed = { ...plain, [arrayKey]: arr.slice(0, lo), truncated: true } as T;
    if (arrayKey === 'nets') {
      (trimmed as unknown as ListNetsReplyData).hasMore = true;
    }
    if (arrayKey === 'findings') {
      (trimmed as unknown as CheckNetReplyData).summary = summarizeFindings(
        (trimmed as unknown as CheckNetReplyData).findings,
      );
    }
    return trimmed;
  }

  throw new Error(`Reply exceeded the ${Math.floor(MAX_REPLY_BYTES / 1024)} KiB payload budget.`);
}

async function handleInfo(): Promise<InfoReplyData> {
  const pcb = await requireFocusedPcb();
  const { stackup, entries } = await readStackup();
  return {
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    pcbUuid: pcb.uuid,
    copperLayers: stackup.copper.length,
    stackup: entries,
    unit: 'mm',
    defaultRules: { ...DEFAULT_CHECK_RULES, skipNets: [...DEFAULT_CHECK_RULES.skipNets] },
    topics: [...RCP_TOPICS],
  };
}

async function handleListNets(message: unknown): Promise<ListNetsReplyData> {
  const req = (message && typeof message === 'object' ? message : {}) as ListNetsRequest;
  const includePower = Boolean(req.includePower);
  const offset =
    typeof req.offset === 'number' && Number.isFinite(req.offset) && req.offset >= 0
      ? Math.floor(req.offset)
      : 0;
  const limit =
    typeof req.limit === 'number' && Number.isFinite(req.limit) && req.limit > 0
      ? Math.min(MAX_LIST_LIMIT, Math.floor(req.limit))
      : DEFAULT_LIST_LIMIT;

  const { nets: all } = await readNetSummaries();
  const filtered = includePower ? all : all.filter((n) => !n.isPower && !n.isGround);
  const page = filtered.slice(offset, offset + limit);

  const payload: ListNetsReplyData = {
    unit: 'mm',
    total: filtered.length,
    totalAll: all.length,
    offset,
    limit,
    includePower,
    hasMore: offset + page.length < filtered.length,
    nets: page,
  };

  return enforceReplyBudget(payload as unknown as Record<string, unknown>, 'nets') as unknown as ListNetsReplyData;
}

async function handleCheckNet(message: unknown): Promise<CheckNetReplyData> {
  const req = (message && typeof message === 'object' ? message : {}) as Partial<CheckNetRequest>;
  const net = typeof req.net === 'string' ? req.net.trim() : '';
  if (!net) {
    throw new Error('Request must include a non-empty "net" string (e.g. { "net": "USB_DP" }).');
  }

  const snap = await readBoardForCheck(Boolean(req.refresh));
  const resolved = snap.knownNets.get(netKey(net));
  if (!resolved) {
    throw new Error(`Net "${net}" not found on the focused PCB.`);
  }

  const res = checkNetGeometry(snapshotToCheckInput(snap), resolved, req.rules ?? null);
  const payload: CheckNetReplyData = {
    net: res.net,
    unit: 'mm',
    ...(res.skipped ? { skipped: true, reason: res.reason } : {}),
    segmentsChecked: res.segmentsChecked,
    viasChecked: res.viasChecked,
    referenceNetsUsed: res.referenceNetsUsed,
    rulesApplied: res.rulesApplied,
    summary: res.summary,
    findings: res.findings,
    ...(res.warnings.length ? { warnings: res.warnings } : {}),
  };

  return enforceReplyBudget(
    payload as unknown as Record<string, unknown>,
    'findings',
  ) as unknown as CheckNetReplyData;
}

async function handleShowFindings(message: unknown): Promise<ShowFindingsReplyData> {
  const req = (message && typeof message === 'object' ? message : null) as ShowFindingsRequest | null;
  if (!req) {
    throw new Error('Request must be an object containing a "findings" array.');
  }
  return showFindingMarkers(req);
}

async function handleClearMarkers(): Promise<ClearMarkersReplyData> {
  return clearFindingMarkers();
}

function serve<T>(topic: RcpTopic, handler: (message: unknown) => Promise<T> | T): void {
  eda.sys_MessageBus.rpcServicePublic(topic, async (message: unknown): Promise<ServiceEnvelope<T>> => {
    try {
      const data = toPlainJson(await handler(message ?? null));
      const envelope: ServiceEnvelope<T> = { ok: true, data };
      if (utf8ByteLength(envelope) > MAX_REPLY_BYTES) {
        return {
          ok: false,
          error: `Reply for ${topic} exceeded the ${Math.floor(MAX_REPLY_BYTES / 1024)} KiB limit.`,
        };
      }
      return envelope;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  registeredTopics.push(topic);
}

/** Registers the mcp.rcp.* services once per editor message-bus object; a new editor session registers again. */
export function registerRcpServices(): void {
  const bus = eda.sys_MessageBus;
  if (registeredAt && registeredBus === bus) return;
  if (typeof bus?.rpcServicePublic !== 'function') {
    throw new Error('eda.sys_MessageBus.rpcServicePublic is not available in this EasyEDA Pro version.');
  }
  registeredBus = bus;
  registeredTopics = [];
  serve('mcp.rcp.info', handleInfo);
  serve('mcp.rcp.listNets', handleListNets);
  serve('mcp.rcp.checkNet', handleCheckNet);
  serve('mcp.rcp.showFindings', handleShowFindings);
  serve('mcp.rcp.clearMarkers', handleClearMarkers);
  registeredAt = new Date().toISOString();
}

export function getServiceStatus(): {
  service: string;
  version: string;
  registeredAt: string | null;
  topics: string[];
} {
  return {
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    registeredAt,
    topics: [...registeredTopics],
  };
}

/** Test helper to reset module-level registration and board cache between test cases. */
export function resetRcpServiceState(): void {
  registeredTopics = [];
  registeredAt = null;
  registeredBus = null;
  clearBoardCache();
}
