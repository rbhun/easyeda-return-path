import { uniqueNets } from '@returnpath/core';
import { handlePublicRunRequest, type PublicRunRequest, type PublicRunResult } from '../bus.js';
import { isPanelBusy } from '../panel.js';
import { after, cancelRunning, isRunning, log } from '../runner.js';
import {
  parseCurrentsInput,
  parseSpeedHzInput,
  parseTimeoutMsInput,
  readCurrentProjectConfig,
} from './config.js';
import { requireFocusedPcb } from './eda-reader.js';
import type {
  ActiveJobSummary,
  AnalysisJobListItem,
  AnalysisJobProgress,
  AnalysisJobReplyData,
  AnalysisJobResult,
  AnalysisJobStatus,
  CancelAnalysisReplyData,
  CancelAnalysisRequest,
  DcAnalysisResult,
  GetAnalysisRequest,
  HfBatchAnalysisResult,
  HfBatchNetItem,
  HfSingleAnalysisResult,
  ListAnalysisJobsReplyData,
  RcpHost,
  StartAnalysisRequest,
} from './types.js';

export const MAX_BATCH_NETS = 10;
export const DEFAULT_START_WAIT_MS = 5_000;
export const MAX_WAIT_MS = 55_000;
const MAX_STORED_JOBS = 20;

interface JobRecord {
  jobId: string;
  requestId?: string;
  kind: 'hf' | 'dc';
  status: AnalysisJobStatus;
  startedAt: string;
  startedMs: number;
  finishedAt?: string;
  finishedMs?: number;
  progress: AnalysisJobProgress;
  result?: AnalysisJobResult;
  error?: string;
  cancelRequested: boolean;
  done: Promise<void>;
  resolveDone: () => void;
}

let jobSeq = 0;
let activeJob: JobRecord | null = null;
const jobsById = new Map<string, JobRecord>();
const jobsByRequestId = new Map<string, JobRecord>();
const jobOrder: string[] = [];

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseRequestId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) throw new Error('Invalid "requestId": expected a non-empty string.');
    return trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  throw new Error('Invalid "requestId": expected a non-empty string.');
}

function parseWaitMs(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('Invalid "waitMs": expected a non-negative finite number in ms.');
  }
  return Math.min(MAX_WAIT_MS, Math.round(value));
}

function parseStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid "${field}": expected an array of strings.`);
  }
  const out: string[] = [];
  for (const item of value) {
    const s = nonEmptyString(item);
    if (!s) throw new Error(`Invalid "${field}": every entry must be a non-empty string.`);
    out.push(s);
  }
  return out;
}

function parseDrivers(obj: Record<string, unknown>): string[] | undefined {
  if (obj.drivers !== undefined) {
    if (typeof obj.drivers === 'string') {
      const s = obj.drivers.trim();
      return s ? [s] : [];
    }
    return parseStringList(obj.drivers, 'drivers');
  }
  if (obj.source !== undefined) {
    if (typeof obj.source !== 'string') {
      throw new Error('Invalid "source": expected a component designator string.');
    }
    const s = obj.source.trim();
    return s ? [s] : [];
  }
  return undefined;
}

function waitForJob(job: JobRecord, waitMs: number): Promise<void> {
  if (job.status !== 'running' || waitMs <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      cancelTimer();
      resolve();
    };
    const cancelTimer = after(waitMs, finish);
    void job.done.then(finish, finish);
  });
}

function pruneStoredJobs(): void {
  while (jobOrder.length > MAX_STORED_JOBS) {
    const idx = jobOrder.findIndex((id) => {
      const rec = jobsById.get(id);
      return rec && rec.status !== 'running';
    });
    if (idx < 0) break;
    const [evictedId] = jobOrder.splice(idx, 1);
    const evicted = jobsById.get(evictedId);
    jobsById.delete(evictedId);
    if (evicted?.requestId && jobsByRequestId.get(evicted.requestId) === evicted) {
      jobsByRequestId.delete(evicted.requestId);
    }
  }
}

function createJob(kind: 'hf' | 'dc', total: number, currentNet: string | undefined, requestId?: string): JobRecord {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const jobId = `rcp-${++jobSeq}-${Math.random().toString(36).slice(2, 8)}`;
  const job: JobRecord = {
    jobId,
    ...(requestId ? { requestId } : {}),
    kind,
    status: 'running',
    startedAt: new Date().toISOString(),
    startedMs: nowMs(),
    progress: { completed: 0, total, ...(currentNet ? { currentNet } : {}) },
    cancelRequested: false,
    done,
    resolveDone,
  };
  jobsById.set(jobId, job);
  if (requestId) jobsByRequestId.set(requestId, job);
  jobOrder.push(jobId);
  pruneStoredJobs();
  return job;
}

function finishJob(job: JobRecord, status: Exclude<AnalysisJobStatus, 'running'>): void {
  job.status = status;
  job.finishedMs = nowMs();
  job.finishedAt = new Date().toISOString();
  if (activeJob === job) {
    activeJob = null;
  }
  job.resolveDone();
}

function wasCancelled(job: JobRecord, res: PublicRunResult): boolean {
  return job.cancelRequested || /\bcancell?ed\b/i.test(res.error ?? '');
}

async function runSingleHfJob(
  job: JobRecord,
  host: RcpHost,
  req: PublicRunRequest,
): Promise<void> {
  try {
    const res = await handlePublicRunRequest(req, host.executor);
    if (!res.ok || !res.hf) {
      job.error = res.error ?? 'HF analysis failed.';
      finishJob(job, wasCancelled(job, res) ? 'cancelled' : 'failed');
      return;
    }
    const boardScore = host.getBoardScore?.();
    const result: HfSingleAnalysisResult = {
      batch: false,
      summary: res.summary ?? `${res.hf.net}: ${(res.findings ?? []).length} finding(s).`,
      ...(res.lines ? { lines: res.lines } : {}),
      findings: res.findings ?? [],
      hf: res.hf,
      ...(boardScore ? { boardScore } : {}),
      ...(res.logPath ? { logPath: res.logPath } : {}),
      ...(res.resultsPath ? { resultsPath: res.resultsPath } : {}),
    };
    job.progress = { completed: 1, total: 1 };
    job.result = result;
    finishJob(job, job.cancelRequested ? 'cancelled' : 'completed');
  } catch (err) {
    job.error = err instanceof Error ? err.message : String(err);
    finishJob(job, job.cancelRequested ? 'cancelled' : 'failed');
  }
}

async function runBatchHfJob(
  job: JobRecord,
  host: RcpHost,
  opts: {
    nets: string[];
    speedHz?: number;
    drivers?: string[];
    draw: boolean;
    timeoutMs: number;
  },
): Promise<void> {
  const items: HfBatchNetItem[] = [];
  let succeeded = 0;
  let failed = 0;
  let cancelled = false;

  try {
    for (let i = 0; i < opts.nets.length; i++) {
      if (job.cancelRequested) {
        cancelled = true;
        break;
      }
      const net = opts.nets[i];
      job.progress = { completed: i, total: opts.nets.length, currentNet: net };
      const res = await handlePublicRunRequest(
        {
          kind: 'hf',
          net,
          ...(opts.speedHz !== undefined ? { speedHz: opts.speedHz } : {}),
          ...(opts.drivers !== undefined ? { drivers: opts.drivers } : {}),
          draw: opts.draw && i === opts.nets.length - 1,
          timeoutMs: opts.timeoutMs,
        },
        host.executor,
      );

      if (wasCancelled(job, res)) {
        cancelled = true;
        job.error = res.error ?? 'Analysis cancelled.';
        break;
      }

      if (res.ok && res.hf) {
        succeeded++;
        items.push({
          net: res.hf.net,
          ok: true,
          durationMs: res.durationMs,
          summary: res.summary,
          ...(res.hf.score !== undefined ? { score: res.hf.score } : {}),
          ...(res.hf.status ? { status: res.hf.status } : {}),
          findingsCount: (res.findings ?? []).length,
          findings: res.findings ?? [],
          hf: res.hf,
          ...(res.lines ? { lines: res.lines } : {}),
          ...(res.logPath ? { logPath: res.logPath } : {}),
          ...(res.resultsPath ? { resultsPath: res.resultsPath } : {}),
        });
      } else {
        failed++;
        items.push({
          net,
          ok: false,
          durationMs: res.durationMs,
          error: res.error ?? 'HF analysis failed.',
        });
      }
      job.progress = { completed: i + 1, total: opts.nets.length };
    }

    const boardScore = host.getBoardScore?.();
    const summary = cancelled
      ? `Cancelled after ${items.length}/${opts.nets.length} net(s) (${succeeded} ok, ${failed} failed).`
      : `Checked ${opts.nets.length} net(s): ${succeeded} completed, ${failed} failed.${boardScore ? ` ${boardScore.header}` : ''}`;

    const result: HfBatchAnalysisResult = {
      batch: true,
      total: opts.nets.length,
      completed: succeeded,
      failed,
      summary,
      ...(boardScore ? { boardScore } : {}),
      nets: items,
    };
    job.result = result;

    if (cancelled) {
      finishJob(job, 'cancelled');
    } else if (succeeded === 0 && failed > 0) {
      job.error = items.find((x) => x.error)?.error ?? 'All nets in batch failed.';
      finishJob(job, 'failed');
    } else {
      finishJob(job, 'completed');
    }
  } catch (err) {
    job.error = err instanceof Error ? err.message : String(err);
    finishJob(job, job.cancelRequested ? 'cancelled' : 'failed');
  }
}

async function runDcJob(
  job: JobRecord,
  host: RcpHost,
  req: PublicRunRequest,
): Promise<void> {
  try {
    const res = await handlePublicRunRequest(req, host.executor);
    if (!res.ok || !res.dc) {
      job.error = res.error ?? 'DC analysis failed.';
      finishJob(job, wasCancelled(job, res) ? 'cancelled' : 'failed');
      return;
    }
    const result: DcAnalysisResult = {
      summary: res.summary ?? `${res.dc.rail}/${res.dc.ground} solved.`,
      ...(res.lines ? { lines: res.lines } : {}),
      dc: res.dc,
      ...(res.logPath ? { logPath: res.logPath } : {}),
      ...(res.resultsPath ? { resultsPath: res.resultsPath } : {}),
    };
    job.progress = { completed: 1, total: 1 };
    job.result = result;
    finishJob(job, job.cancelRequested ? 'cancelled' : 'completed');
  } catch (err) {
    job.error = err instanceof Error ? err.message : String(err);
    finishJob(job, job.cancelRequested ? 'cancelled' : 'failed');
  }
}

function byteLen(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function plainCopy<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)),
  ) as T;
}

function cloneResult(result: AnalysisJobResult, includeLines: boolean): AnalysisJobResult {
  const copy = plainCopy(result);
  if (!includeLines) {
    if ('lines' in copy) {
      delete copy.lines;
    }
    if ('batch' in copy && copy.batch) {
      for (const item of copy.nets) {
        delete item.lines;
      }
    }
  }
  return copy;
}

export function formatJobReply(
  job: JobRecord,
  includeLines: boolean,
  maxBytes: number,
): AnalysisJobReplyData {
  const durationMs = Math.max(0, Math.round((job.finishedMs ?? nowMs()) - job.startedMs));
  const base: AnalysisJobReplyData = {
    jobId: job.jobId,
    ...(job.requestId ? { requestId: job.requestId } : {}),
    kind: job.kind,
    status: job.status,
    unit: 'mm',
    startedAt: job.startedAt,
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    durationMs,
    progress: { ...job.progress },
    ...(job.status === 'running' ? { pollTopic: 'mcp.rcp.getAnalysis' as const } : {}),
    ...(job.result ? { result: cloneResult(job.result, includeLines) } : {}),
    ...(job.error ? { error: job.error } : {}),
  };

  if (byteLen({ ok: true, data: base }) <= maxBytes) {
    return base;
  }

  // Budget step 1: drop human-readable lines.
  const trimmed: AnalysisJobReplyData = {
    ...base,
    ...(job.result ? { result: cloneResult(job.result, false) } : {}),
    truncated: true,
  };
  if (byteLen({ ok: true, data: trimmed }) <= maxBytes) {
    return trimmed;
  }

  // Budget step 2: trim findings on single HF result.
  if (trimmed.result && 'batch' in trimmed.result && !trimmed.result.batch) {
    const res = trimmed.result;
    const all = res.findings;
    let lo = 0;
    let hi = all.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const candidate: AnalysisJobReplyData = {
        ...trimmed,
        result: { ...res, findings: all.slice(0, mid) },
      };
      if (byteLen({ ok: true, data: candidate }) <= maxBytes) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return {
      ...trimmed,
      result: { ...res, findings: all.slice(0, lo) },
    };
  }

  // Budget step 3: trim per-net details on HF batch result.
  if (trimmed.result && 'batch' in trimmed.result && trimmed.result.batch) {
    const res = trimmed.result;
    const compactNets: HfBatchNetItem[] = res.nets.map((item) => ({
      net: item.net,
      ok: item.ok,
      durationMs: item.durationMs,
      ...(item.summary ? { summary: item.summary } : {}),
      ...(item.score !== undefined ? { score: item.score } : {}),
      ...(item.status ? { status: item.status } : {}),
      ...(item.findingsCount !== undefined ? { findingsCount: item.findingsCount } : {}),
      ...(item.error ? { error: item.error } : {}),
    }));
    const compactCandidate: AnalysisJobReplyData = {
      ...trimmed,
      result: { ...res, nets: compactNets },
    };
    if (byteLen({ ok: true, data: compactCandidate }) <= maxBytes) {
      return compactCandidate;
    }

    let lo = 0;
    let hi = compactNets.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const candidate: AnalysisJobReplyData = {
        ...trimmed,
        result: { ...res, nets: compactNets.slice(0, mid) },
      };
      if (byteLen({ ok: true, data: candidate }) <= maxBytes) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return {
      ...trimmed,
      result: { ...res, nets: compactNets.slice(0, lo) },
    };
  }

  // Budget step 4: trim warnings on DC result if oversized.
  if (trimmed.result && 'dc' in trimmed.result) {
    const res = trimmed.result;
    const reduced: AnalysisJobReplyData = {
      ...trimmed,
      result: { ...res, dc: { ...res.dc, warnings: res.dc.warnings.slice(0, 20) } },
    };
    if (byteLen({ ok: true, data: reduced }) <= maxBytes) {
      return reduced;
    }
  }

  throw new Error(`Analysis reply exceeded the ${Math.floor(maxBytes / 1024)} KiB payload budget.`);
}

export function getActiveJobSummary(): ActiveJobSummary | null {
  if (!activeJob || activeJob.status !== 'running') return null;
  return {
    jobId: activeJob.jobId,
    ...(activeJob.requestId ? { requestId: activeJob.requestId } : {}),
    kind: activeJob.kind,
    status: 'running',
    startedAt: activeJob.startedAt,
  };
}

export async function startAnalysisJob(
  message: unknown,
  host: RcpHost | undefined,
  maxBytes: number,
): Promise<AnalysisJobReplyData> {
  if (!host?.executor) {
    throw new Error('Return Path analysis executor is not initialized.');
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('Request must be a JSON object with { kind: "hf" | "dc", ... }.');
  }
  const req = message as StartAnalysisRequest & Record<string, unknown>;
  const requestId = parseRequestId(req.requestId);
  const waitMs = parseWaitMs(req.waitMs, DEFAULT_START_WAIT_MS);
  const includeLines = req.includeLines !== false;

  // Idempotency: retrying with the same requestId returns the existing job.
  if (requestId) {
    const existing = jobsByRequestId.get(requestId);
    if (existing) {
      await waitForJob(existing, waitMs);
      return formatJobReply(existing, includeLines, maxBytes);
    }
  }

  const rawKind = typeof req.kind === 'string' ? req.kind.trim().toLowerCase() : '';
  if (rawKind !== 'hf' && rawKind !== 'dc') {
    throw new Error('Missing or invalid "kind": expected "hf" or "dc".');
  }
  if (req.draw !== undefined && typeof req.draw !== 'boolean') {
    throw new Error('Invalid "draw": expected a boolean.');
  }
  if (req.includeLines !== undefined && typeof req.includeLines !== 'boolean') {
    throw new Error('Invalid "includeLines": expected a boolean.');
  }

  const { stored } = await readCurrentProjectConfig();

  if (rawKind === 'hf') {
    if (req.net !== undefined && req.nets !== undefined) {
      throw new Error('Pass either "net" or "nets" for HF analysis, not both.');
    }
    let nets: string[];
    if (req.net !== undefined) {
      const n = nonEmptyString(req.net);
      if (!n) throw new Error('Invalid "net": expected a non-empty net name string.');
      nets = [n];
    } else if (req.nets !== undefined) {
      nets = uniqueNets(parseStringList(req.nets, 'nets'));
      if (!nets.length) throw new Error('Invalid "nets": expected at least one net name.');
    } else {
      nets = uniqueNets(stored.hf.nets);
      if (!nets.length) {
        throw new Error('Missing "net" (or "nets") for HF analysis, and no default hf.nets are configured via mcp.rcp.setConfig.');
      }
    }
    if (nets.length > MAX_BATCH_NETS) {
      throw new Error(
        `Batch size ${nets.length} exceeds the maximum of ${MAX_BATCH_NETS} nets per call. Split into smaller batches of up to ${MAX_BATCH_NETS} nets.`,
      );
    }

    const speedHz =
      req.speedHz !== undefined
        ? parseSpeedHzInput(req.speedHz, 'speedHz')
        : req.speed !== undefined
          ? parseSpeedHzInput(req.speed, 'speed')
          : stored.hf.speedHz;
    const drivers = parseDrivers(req) ?? (stored.hf.drivers ? [...stored.hf.drivers] : undefined);
    const draw = req.draw ?? stored.hf.draw;
    const timeoutMs = req.timeoutMs !== undefined ? parseTimeoutMsInput(req.timeoutMs) : stored.hf.timeoutMs;

    await requireFocusedPcb();

    if (activeJob && activeJob.status === 'running') {
      throw new Error(
        `Another analysis job is already running (jobId: ${activeJob.jobId}). Poll with mcp.rcp.getAnalysis or cancel with mcp.rcp.cancelAnalysis.`,
      );
    }
    if (isRunning() || isPanelBusy()) {
      throw new Error('Another return-path analysis is already running in EasyEDA.');
    }

    const job = createJob('hf', nets.length, nets[0], requestId);
    activeJob = job;
    log(`mcp.rcp.startAnalysis: started HF job ${job.jobId} (${nets.join(', ')})`);

    if (nets.length === 1) {
      void runSingleHfJob(job, host, {
        kind: 'hf',
        net: nets[0],
        ...(speedHz !== undefined ? { speedHz } : {}),
        ...(drivers !== undefined ? { drivers } : {}),
        draw,
        timeoutMs,
        ...(requestId ? { requestId } : {}),
      });
    } else {
      void runBatchHfJob(job, host, {
        nets,
        ...(speedHz !== undefined ? { speedHz } : {}),
        ...(drivers !== undefined ? { drivers } : {}),
        draw,
        timeoutMs,
      });
    }

    await waitForJob(job, waitMs);
    return formatJobReply(job, includeLines, maxBytes);
  }

  // DC analysis
  const rail = nonEmptyString(req.rail) ?? nonEmptyString(req.net) ?? stored.dc.rail;
  if (!rail) {
    throw new Error('Missing "rail" for DC analysis (and no default dc.rail is configured via mcp.rcp.setConfig).');
  }
  const railNets = req.railNets !== undefined ? uniqueNets(parseStringList(req.railNets, 'railNets')) : stored.dc.railNets;
  const ground = req.ground !== undefined ? nonEmptyString(req.ground) : stored.dc.ground;
  if (req.ground !== undefined && !ground) {
    throw new Error('Invalid "ground": expected a non-empty net name string.');
  }
  const source = req.source !== undefined ? nonEmptyString(req.source) : stored.dc.source;
  if (req.source !== undefined && !source) {
    throw new Error('Invalid "source": expected a non-empty component designator string.');
  }
  const loads = req.loads !== undefined ? parseStringList(req.loads, 'loads') : stored.dc.loads;
  const currents = req.currents !== undefined ? parseCurrentsInput(req.currents) : stored.dc.currents;
  const focus = req.focus !== undefined ? nonEmptyString(req.focus) : stored.dc.focus;
  if (req.focus !== undefined && !focus) {
    throw new Error('Invalid "focus": expected a non-empty component designator string.');
  }
  const draw = req.draw ?? stored.dc.draw;
  const timeoutMs = req.timeoutMs !== undefined ? parseTimeoutMsInput(req.timeoutMs) : stored.dc.timeoutMs;

  await requireFocusedPcb();

  if (activeJob && activeJob.status === 'running') {
    throw new Error(
      `Another analysis job is already running (jobId: ${activeJob.jobId}). Poll with mcp.rcp.getAnalysis or cancel with mcp.rcp.cancelAnalysis.`,
    );
  }
  if (isRunning() || isPanelBusy()) {
    throw new Error('Another return-path analysis is already running in EasyEDA.');
  }

  const job = createJob('dc', 1, rail, requestId);
  activeJob = job;
  log(`mcp.rcp.startAnalysis: started DC job ${job.jobId} (${rail})`);

  void runDcJob(job, host, {
    kind: 'dc',
    rail,
    ...(railNets?.length ? { railNets } : {}),
    ...(ground ? { ground } : {}),
    ...(source ? { source } : {}),
    ...(loads ? { loads } : {}),
    ...(currents ? { currents } : {}),
    ...(focus ? { focus } : {}),
    draw,
    timeoutMs,
    ...(requestId ? { requestId } : {}),
  });

  await waitForJob(job, waitMs);
  return formatJobReply(job, includeLines, maxBytes);
}

function findJob(jobId?: string, requestId?: string): JobRecord | undefined {
  if (jobId) return jobsById.get(jobId);
  if (requestId) return jobsByRequestId.get(requestId);
  if (activeJob) return activeJob;
  const latestId = jobOrder[jobOrder.length - 1];
  return latestId ? jobsById.get(latestId) : undefined;
}

export async function getAnalysisJob(
  message: unknown,
  maxBytes: number,
): Promise<AnalysisJobReplyData | ListAnalysisJobsReplyData> {
  const req = (message && typeof message === 'object' && !Array.isArray(message) ? message : {}) as GetAnalysisRequest;

  if (req.list) {
    const jobs: AnalysisJobListItem[] = [...jobOrder]
      .reverse()
      .map((id) => jobsById.get(id))
      .filter((j): j is JobRecord => Boolean(j))
      .map((j) => ({
        jobId: j.jobId,
        ...(j.requestId ? { requestId: j.requestId } : {}),
        kind: j.kind,
        status: j.status,
        startedAt: j.startedAt,
        ...(j.finishedAt ? { finishedAt: j.finishedAt } : {}),
        durationMs: Math.max(0, Math.round((j.finishedMs ?? nowMs()) - j.startedMs)),
        progress: { ...j.progress },
        ...(j.error ? { error: j.error } : {}),
      }));
    return {
      unit: 'mm',
      activeJobId: activeJob?.status === 'running' ? activeJob.jobId : null,
      jobs,
    };
  }

  const jobId = req.jobId !== undefined ? nonEmptyString(req.jobId) : undefined;
  if (req.jobId !== undefined && !jobId) {
    throw new Error('Invalid "jobId": expected a non-empty string.');
  }
  const requestId = parseRequestId(req.requestId);
  const waitMs = parseWaitMs(req.waitMs, 0);
  const includeLines = req.includeLines !== false;

  const job = findJob(jobId, requestId);
  if (!job) {
    if (jobId || requestId) {
      throw new Error(`Analysis job "${jobId ?? requestId}" not found.`);
    }
    throw new Error('No analysis job found. Start one with mcp.rcp.startAnalysis.');
  }

  await waitForJob(job, waitMs);
  return formatJobReply(job, includeLines, maxBytes);
}

export function cancelAnalysisJob(message: unknown): CancelAnalysisReplyData {
  const req = (message && typeof message === 'object' && !Array.isArray(message) ? message : {}) as CancelAnalysisRequest;
  const jobId = req.jobId !== undefined ? nonEmptyString(req.jobId) : undefined;
  if (req.jobId !== undefined && !jobId) {
    throw new Error('Invalid "jobId": expected a non-empty string.');
  }
  const requestId = parseRequestId(req.requestId);

  if (jobId || requestId) {
    const job = findJob(jobId, requestId);
    if (!job) {
      return { unit: 'mm', cancelled: false, jobId: jobId ?? null, status: 'not_found' };
    }
    if (job.status !== 'running') {
      return { unit: 'mm', cancelled: false, jobId: job.jobId, status: job.status };
    }
    job.cancelRequested = true;
    cancelRunning();
    return { unit: 'mm', cancelled: true, jobId: job.jobId, status: 'cancelling' };
  }

  if (activeJob && activeJob.status === 'running') {
    activeJob.cancelRequested = true;
    cancelRunning();
    return { unit: 'mm', cancelled: true, jobId: activeJob.jobId, status: 'cancelling' };
  }

  if (isRunning()) {
    const cancelled = cancelRunning();
    return { unit: 'mm', cancelled, jobId: null, status: cancelled ? 'cancelling' : 'idle' };
  }

  return { unit: 'mm', cancelled: false, jobId: null, status: 'idle' };
}

export function resetJobState(): void {
  activeJob = null;
  jobsById.clear();
  jobsByRequestId.clear();
  jobOrder.length = 0;
  jobSeq = 0;
}
