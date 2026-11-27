/**
 * Public message-bus API so other EasyEDA Pro extensions (e.g. an MCP bridge) can run HF and DC
 * return-path analyses non-interactively with zero dialogs.
 *
 * Bus contract (`eda.sys_MessageBus`):
 * - Request topic: `returnpath.run`
 *   Accepted via:
 *   1. Pub/Sub: `publishPublic('returnpath.run', payload)` -> replies on `replyTopic`
 *      (default `returnpath.result`) via both `publishPublic` and `pushPublic`.
 *   2. Queue:   `pushPublic('returnpath.run', payload)` -> replies on `replyTopic`
 *      (default `returnpath.result`) via both `publishPublic` and `pushPublic`.
 *   3. RPC:     `await rpcCallPublic('returnpath.run', payload, timeoutMs)` -> resolves
 *      directly to the reply object (and also posts to `replyTopic` if one was explicitly set).
 * - Request payload (object or JSON string):
 *   - Common: `{ kind: 'hf' | 'dc', requestId?, replyTopic?, draw?: boolean, timeoutMs?: number }`
 *   - HF:     `{ kind: 'hf', net, speed?: number | string, speedHz?: number, drivers?: string | string[], source?: string }`
 *   - DC:     `{ kind: 'dc', rail (or net), railNets?: string[], ground?, source?, loads?: string[], currents?: Record<string, number | string> | string, focus?: string }`
 * - Reply payload:
 *   `{ requestId?, ok, version, kind?, durationMs, summary?, lines?, findings?, hf?, dc?, logPath?, resultsPath?, error? }`
 */
import { AnalysisAborted, parseCurrents, parseHz, type AnalysisStats, type Finding, type Pt } from '@returnpath/core';
import extensionConfig from '../extension.json' with { type: 'json' };
import { isPanelBusy, setPanelBusy } from './panel';
import { beginRun, checkpoint, endRun, failRun, isRunning, log, logFilePath, recordResult, TimedOut, withTimeout } from './runner';

export const TOPIC_PUBLIC_RUN = 'returnpath.run';
export const TOPIC_PUBLIC_RESULT = 'returnpath.result';

const TOPIC_CLAIM = 'returnpath.bus.claim';
const PCB_DOCUMENT_TYPE = 3;
const FOCUS_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 300_000;
const CLAIM_TTL_MS = 1000;

export interface PublicRunRequest {
	kind: 'hf' | 'dc';
	requestId?: string;
	replyTopic?: string;
	net?: string;
	speed?: number | string;
	speedHz?: number;
	drivers?: string | string[];
	source?: string;
	rail?: string;
	railNets?: string[];
	ground?: string;
	loads?: string[];
	currents?: Record<string, number | string> | string;
	focus?: string;
	draw?: boolean;
	timeoutMs?: number;
}

export interface PublicHfResult {
	net: string;
	drivers: string[];
	signal: {
		type: string;
		hz: number;
		kneeHz: number;
		criticalMm: number;
		lengthMm: number;
		transmissionLine: boolean;
	};
	stats: AnalysisStats;
	forwardLayers: string[];
	returnLayers: string[];
	markers: number;
	warnings: string[];
	/** 0–100. Present once the return-path check has scored the net. */
	score?: number;
	status?: 'Good' | 'Fair' | 'Needs work';
	r?: number;
	rW?: number;
}

export interface PublicDcResult {
	rail: string;
	railNets?: string[];
	bridges?: string[];
	ground: string;
	source: string;
	focus?: string;
	loads: { designator: string; current: number }[];
	normalised: boolean;
	grid: { nx: number; ny: number; cellMm: number };
	nets: {
		net: string;
		role: 'supply' | 'return';
		dropV: number;
		loadDrops: { designator: string; dropV: number }[];
		bottleneck?: { at: Pt; layer: number; layerName: string; j: number };
		unconnected: string[];
		nodes: number;
		iterations: number;
		residual: number;
	}[];
	streamlines: { supply: number; ret: number };
	markers: number;
	warnings: string[];
}

export interface PublicRunResult {
	requestId?: string;
	ok: boolean;
	version: string;
	kind?: 'hf' | 'dc';
	durationMs: number;
	summary?: string;
	lines?: string[];
	findings?: Finding[];
	hf?: PublicHfResult;
	dc?: PublicDcResult;
	logPath?: string;
	resultsPath?: string;
	error?: string;
}

export interface ParsedHfRequest {
	net: string;
	hz?: number;
	drivers?: string[];
	draw: boolean;
	timeoutMs?: number;
}

export interface ParsedDcRequest {
	rail: string;
	railNets?: string[];
	ground?: string;
	source?: string;
	loads?: string[];
	currents?: Record<string, number>;
	focus?: string;
	draw: boolean;
	timeoutMs?: number;
}

export interface PublicRunExecutor {
	runHf: (req: ParsedHfRequest) => Promise<{ summary: string; lines: string[]; findings: Finding[]; hf: PublicHfResult }>;
	runDc: (req: ParsedDcRequest) => Promise<{ summary: string; lines: string[]; dc: PublicDcResult }>;
}

type PublicBusApi = {
	subscribe?: (topic: string, fn: (message: unknown) => void) => { cancel?: () => void };
	publish?: (topic: string, message: unknown) => void;
	subscribePublic?: (topic: string, fn: (message: unknown) => void) => { cancel?: () => void };
	publishPublic?: (topic: string, message: unknown) => void;
	pushPublic?: (topic: string, message: unknown) => void;
	pullPublic?: (topic: string, fn: (message: unknown) => void) => { cancel?: () => void };
	rpcServicePublic?: (topic: string, fn: (message: unknown) => unknown | Promise<unknown>) => void;
};

type ClaimMessage = { key: string; from: string };

const me = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let currentExecutor: PublicRunExecutor | undefined;
let subscribed: unknown;
const claimedByOther = new Map<string, number>();

function bus(): PublicBusApi | undefined {
	return (eda as unknown as { sys_MessageBus?: PublicBusApi }).sys_MessageBus;
}

function nowMs(): number {
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function pruneClaims(now: number): void {
	for (const [k, ts] of claimedByOther) {
		if (now - ts > CLAIM_TTL_MS)
			claimedByOther.delete(k);
	}
}

function extractRequestMeta(raw: unknown): { requestId?: string; replyTopic: string; explicitReplyTopic: boolean } {
	let obj: Record<string, unknown> | undefined;
	if (typeof raw === 'string') {
		try {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
				obj = parsed as Record<string, unknown>;
		}
		catch {}
	}
	else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
		obj = raw as Record<string, unknown>;
	}
	const rawId = obj?.requestId;
	const requestId = typeof rawId === 'string' ? rawId.trim() || undefined : typeof rawId === 'number' && Number.isFinite(rawId) ? String(rawId) : undefined;
	const rawReply = obj?.replyTopic;
	const explicit = typeof rawReply === 'string' && rawReply.trim().length > 0;
	return { requestId, replyTopic: explicit ? rawReply.trim() : TOPIC_PUBLIC_RESULT, explicitReplyTopic: explicit };
}

function claimKey(raw: unknown): string {
	const { requestId } = extractRequestMeta(raw);
	if (requestId)
		return `id:${requestId}`;
	try {
		return `raw:${typeof raw === 'string' ? raw : JSON.stringify(raw ?? null)}`;
	}
	catch {
		return `raw:${String(raw)}`;
	}
}

function claimBroadcast(b: PublicBusApi, raw: unknown): boolean {
	const now = Date.now();
	pruneClaims(now);
	const key = claimKey(raw);
	if (claimedByOther.has(key))
		return false;
	try {
		b.publish?.(TOPIC_CLAIM, { key, from: me } satisfies ClaimMessage);
	}
	catch {}
	return true;
}

function sendReply(b: PublicBusApi, replyTopic: string, result: PublicRunResult): void {
	if (typeof b.publishPublic === 'function') {
		try {
			b.publishPublic(replyTopic, result);
		}
		catch (e) {
			log(`bus: publishPublic(${replyTopic}) failed: ${e instanceof Error ? e.message : String(e)}`, 'warn');
		}
	}
	if (typeof b.pushPublic === 'function') {
		try {
			b.pushPublic(replyTopic, result);
		}
		catch (e) {
			log(`bus: pushPublic(${replyTopic}) failed: ${e instanceof Error ? e.message : String(e)}`, 'warn');
		}
	}
}

function armPull(b: PublicBusApi): void {
	if (subscribed !== b || typeof b.pullPublic !== 'function')
		return;
	try {
		b.pullPublic(TOPIC_PUBLIC_RUN, (raw: unknown) => {
			queueMicrotask(() => armPull(b));
			void runAndReply(b, raw);
		});
	}
	catch (e) {
		log(`bus: pullPublic(${TOPIC_PUBLIC_RUN}) failed: ${e instanceof Error ? e.message : String(e)}`, 'warn');
	}
}

async function runAndReply(b: PublicBusApi, raw: unknown): Promise<void> {
	const { replyTopic } = extractRequestMeta(raw);
	const exec = currentExecutor;
	if (!exec)
		return;
	const result = await handlePublicRunRequest(raw, exec);
	sendReply(b, replyTopic, result);
}

/** Registers the public message-bus listeners on `returnpath.run`; safe to call more than once. */
export function initPublicBus(executor: PublicRunExecutor): void {
	currentExecutor = executor;
	const b = bus();
	if (!b || subscribed === b)
		return;
	claimedByOther.clear();
	try {
		b.subscribe?.(TOPIC_CLAIM, (m: unknown) => {
			const claim = m as ClaimMessage | null;
			if (!claim || typeof claim !== 'object' || claim.from === me || typeof claim.key !== 'string')
				return;
			const now = Date.now();
			pruneClaims(now);
			claimedByOther.set(claim.key, now);
		});
	}
	catch {}
	let registered = false;
	if (typeof b.subscribePublic === 'function') {
		try {
			b.subscribePublic(TOPIC_PUBLIC_RUN, (raw: unknown) => {
				if (!claimBroadcast(b, raw))
					return;
				void runAndReply(b, raw);
			});
			registered = true;
		}
		catch (e) {
			log(`bus: subscribePublic(${TOPIC_PUBLIC_RUN}) failed: ${e instanceof Error ? e.message : String(e)}`, 'warn');
		}
	}
	subscribed = b;
	if (typeof b.pullPublic === 'function') {
		armPull(b);
		registered = true;
	}
	if (typeof b.rpcServicePublic === 'function') {
		try {
			b.rpcServicePublic(TOPIC_PUBLIC_RUN, async (raw: unknown) => {
				const exec = currentExecutor;
				if (!exec) {
					return { ok: false, version: extensionConfig.version, durationMs: 0, error: 'Return Path executor is not initialized.' } satisfies PublicRunResult;
				}
				const result = await handlePublicRunRequest(raw, exec);
				const meta = extractRequestMeta(raw);
				if (meta.explicitReplyTopic)
					sendReply(b, meta.replyTopic, result);
				return result;
			});
			registered = true;
		}
		catch (e) {
			log(`bus: rpcServicePublic(${TOPIC_PUBLIC_RUN}) failed: ${e instanceof Error ? e.message : String(e)}`, 'warn');
		}
	}
	if (registered)
		log(`bus: listening on public topic ${TOPIC_PUBLIC_RUN}`);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseStringList(value: unknown, field: string): string[] | undefined {
	if (value === undefined)
		return undefined;
	if (!Array.isArray(value))
		throw new Error(`Invalid "${field}": expected an array of strings.`);
	const out: string[] = [];
	for (const item of value) {
		const s = nonEmptyString(item);
		if (!s)
			throw new Error(`Invalid "${field}": every entry must be a non-empty string.`);
		out.push(s);
	}
	return out;
}

function parseSpeedHz(obj: Record<string, unknown>): number | undefined {
	if (obj.speedHz !== undefined) {
		if (typeof obj.speedHz !== 'number' || !Number.isFinite(obj.speedHz) || obj.speedHz <= 0)
			throw new Error('Invalid "speedHz": expected a positive finite number in Hz.');
		return obj.speedHz;
	}
	if (obj.speed === undefined)
		return undefined;
	if (typeof obj.speed === 'number') {
		if (!Number.isFinite(obj.speed) || obj.speed <= 0)
			throw new Error('Invalid "speed": expected a positive finite number in Hz or a frequency string like "16 MHz".');
		return obj.speed;
	}
	if (typeof obj.speed === 'string') {
		const hz = parseHz(obj.speed);
		if (!hz)
			throw new Error(`Invalid "speed" ("${obj.speed}"): expected a frequency like "16 MHz", "400k", or Hz number.`);
		return hz;
	}
	throw new Error('Invalid "speed": expected a positive Hz number or frequency string like "16 MHz".');
}

function parseDrivers(obj: Record<string, unknown>): string[] | undefined {
	if (obj.drivers !== undefined) {
		if (typeof obj.drivers === 'string') {
			const s = obj.drivers.trim();
			return s ? [s] : [];
		}
		if (Array.isArray(obj.drivers))
			return parseStringList(obj.drivers, 'drivers');
		throw new Error('Invalid "drivers": expected a designator string or array of designator strings.');
	}
	if (obj.source !== undefined) {
		if (typeof obj.source !== 'string')
			throw new Error('Invalid "source": expected a component designator string.');
		const s = obj.source.trim();
		return s ? [s] : [];
	}
	return undefined;
}

function parseDcCurrents(value: unknown): Record<string, number> | undefined {
	if (value === undefined)
		return undefined;
	if (typeof value === 'string')
		return parseCurrents(value);
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid "currents": expected an object map (e.g. { "U2": 0.15 }) or string (e.g. "U2=150mA").');
	const out: Record<string, number> = {};
	for (const [rawKey, rawVal] of Object.entries(value as Record<string, unknown>)) {
		const key = rawKey.trim();
		if (!key)
			throw new Error('Invalid "currents": designator keys must be non-empty strings.');
		if (typeof rawVal === 'number') {
			if (!Number.isFinite(rawVal) || rawVal < 0)
				throw new Error(`Invalid current for "${key}": expected a non-negative finite number in amps.`);
			out[key] = rawVal;
		}
		else if (typeof rawVal === 'string') {
			const parsed = parseCurrents(`${key}=${rawVal.trim()}`);
			if (!parsed || parsed[key] === undefined)
				throw new Error(`Invalid current "${rawVal}" for "${key}": use amps (e.g. 0.15) or e.g. "150mA".`);
			out[key] = parsed[key];
		}
		else {
			throw new Error(`Invalid current for "${key}": expected a number in amps or string like "150mA".`);
		}
	}
	return Object.keys(out).length ? out : undefined;
}

function parseTimeoutMs(value: unknown): number | undefined {
	if (value === undefined)
		return undefined;
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
		throw new Error('Invalid "timeoutMs": expected a positive finite number.');
	return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(value)));
}

function parsePayload(raw: unknown): { kind: 'hf'; req: ParsedHfRequest } | { kind: 'dc'; req: ParsedDcRequest } {
	let data = raw;
	if (typeof data === 'string') {
		try {
			data = JSON.parse(data);
		}
		catch (e) {
			throw new Error(`Invalid JSON payload: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	if (!data || typeof data !== 'object' || Array.isArray(data))
		throw new Error('Invalid payload: expected a JSON object with { kind: "hf" | "dc", ... }.');
	const obj = data as Record<string, unknown>;
	const rawKind = typeof obj.kind === 'string' ? obj.kind.trim().toLowerCase() : '';
	if (rawKind !== 'hf' && rawKind !== 'dc')
		throw new Error('Missing or invalid "kind": expected "hf" or "dc".');
	if (obj.draw !== undefined && typeof obj.draw !== 'boolean')
		throw new Error('Invalid "draw": expected a boolean.');
	const draw = obj.draw !== false;
	const timeoutMs = parseTimeoutMs(obj.timeoutMs);

	if (rawKind === 'hf') {
		const net = nonEmptyString(obj.net);
		if (!net)
			throw new Error('Missing required "net" for HF analysis.');
		return {
			kind: 'hf',
			req: {
				net,
				hz: parseSpeedHz(obj),
				drivers: parseDrivers(obj),
				draw,
				timeoutMs,
			},
		};
	}

	const rail = nonEmptyString(obj.rail) ?? nonEmptyString(obj.net);
	if (!rail)
		throw new Error('Missing required "rail" for DC analysis.');
	const railNets = parseStringList(obj.railNets, 'railNets');
	const ground = obj.ground === undefined ? undefined : nonEmptyString(obj.ground);
	if (obj.ground !== undefined && !ground)
		throw new Error('Invalid "ground": expected a non-empty net name string.');
	const source = obj.source === undefined ? undefined : nonEmptyString(obj.source);
	if (obj.source !== undefined && !source)
		throw new Error('Invalid "source": expected a non-empty component designator string.');
	const loads = parseStringList(obj.loads, 'loads');
	const currents = parseDcCurrents(obj.currents);
	const focus = obj.focus === undefined ? undefined : nonEmptyString(obj.focus);
	if (obj.focus !== undefined && !focus)
		throw new Error('Invalid "focus": expected a non-empty component designator string.');
	return {
		kind: 'dc',
		req: { rail, railNets, ground, source, loads, currents, focus, draw, timeoutMs },
	};
}

async function ensurePcbFocused(): Promise<void> {
	const ctrl = (eda as unknown as { dmt_SelectControl?: { getCurrentDocumentInfo?: () => Promise<{ documentType?: number; uuid?: string } | undefined> } }).dmt_SelectControl;
	if (typeof ctrl?.getCurrentDocumentInfo !== 'function')
		return;
	const doc = await withTimeout(ctrl.getCurrentDocumentInfo(), FOCUS_TIMEOUT_MS, 'dmt_SelectControl.getCurrentDocumentInfo');
	if (!doc)
		throw new Error('No PCB document is focused in EasyEDA. Open and focus a PCB tab first.');
	if (doc.documentType !== undefined && doc.documentType !== PCB_DOCUMENT_TYPE)
		throw new Error(`Active EasyEDA document is not a PCB (documentType=${doc.documentType}; expected ${PCB_DOCUMENT_TYPE}). Focus a PCB tab first.`);
}

async function resolveLogPaths(resultsPath: string | null): Promise<{ logPath?: string; resultsPath?: string }> {
	if (resultsPath) {
		return {
			resultsPath,
			logPath: resultsPath.endsWith('.results.json') ? resultsPath.replace(/\.results\.json$/, '.log') : resultsPath,
		};
	}
	const fallback = await logFilePath().catch(() => null);
	return fallback ? { logPath: fallback } : {};
}

/** Executes one public-bus request end-to-end with zero dialogs; never throws. */
export async function handlePublicRunRequest(raw: unknown, executor: PublicRunExecutor): Promise<PublicRunResult> {
	const t0 = nowMs();
	const { requestId } = extractRequestMeta(raw);
	let parsed: { kind: 'hf'; req: ParsedHfRequest } | { kind: 'dc'; req: ParsedDcRequest };
	try {
		parsed = parsePayload(raw);
	}
	catch (e) {
		const error = e instanceof Error ? e.message : String(e);
		log(`bus: rejected request${requestId ? ` (${requestId})` : ''}: ${error}`, 'warn');
		return {
			...(requestId ? { requestId } : {}),
			ok: false,
			version: extensionConfig.version,
			durationMs: Math.round(nowMs() - t0),
			error,
		};
	}

	if (isRunning() || isPanelBusy()) {
		const error = 'Another return-path analysis is already running.';
		log(`bus: rejected ${parsed.kind} request${requestId ? ` (${requestId})` : ''}: ${error}`, 'warn');
		return {
			...(requestId ? { requestId } : {}),
			ok: false,
			version: extensionConfig.version,
			kind: parsed.kind,
			durationMs: Math.round(nowMs() - t0),
			error,
		};
	}

	const command = parsed.kind === 'hf' ? 'Bus HF check' : 'Bus DC check';
	const busyLabel = parsed.kind === 'hf' ? 'HF check' : 'DC check';
	beginRun(command);
	if (requestId)
		recordResult('requestId', requestId);
	setPanelBusy(busyLabel);
	let resultsPath: string | null = null;
	let outcome: Omit<PublicRunResult, 'requestId' | 'version' | 'kind' | 'durationMs' | 'logPath' | 'resultsPath'>;
	try {
		log(`${command} (v${extensionConfig.version})${requestId ? ` [${requestId}]` : ''}`);
		await ensurePcbFocused();
		if (parsed.kind === 'hf') {
			const res = await executor.runHf(parsed.req);
			outcome = { ok: true, summary: res.summary, lines: res.lines, findings: res.findings, hf: res.hf };
		}
		else {
			const res = await executor.runDc(parsed.req);
			outcome = { ok: true, summary: res.summary, lines: res.lines, dc: res.dc };
		}
	}
	catch (e) {
		if (e instanceof AnalysisAborted) {
			log(`${command}: ${e.reason}: ${e.message}`, 'warn');
			failRun(e.reason === 'cancelled' ? 'cancelled' : 'stopped', `${e.reason}: ${e.message}`);
			outcome = { ok: false, error: e.message };
		}
		else if (e instanceof TimedOut) {
			log(`${command}: timed out: ${e.message}`, 'warn');
			failRun('stopped', e.message);
			outcome = { ok: false, error: e.message };
		}
		else {
			const err = e instanceof Error ? e : new Error(String(e));
			log(`${command}: error: ${err.message}${err.stack ? `\n${err.stack}` : ''}`, 'error');
			failRun('error', err.message, err.stack);
			outcome = { ok: false, error: err.message };
		}
	}
	finally {
		setPanelBusy(undefined);
		await checkpoint();
		resultsPath = await endRun();
	}

	const paths = await resolveLogPaths(resultsPath);
	return {
		...(requestId ? { requestId } : {}),
		...outcome,
		version: extensionConfig.version,
		kind: parsed.kind,
		durationMs: Math.round(nowMs() - t0),
		...paths,
	};
}
