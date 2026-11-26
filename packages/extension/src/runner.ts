// Runs analyses without blocking the editor, and makes what they do visible inside EasyEDA Pro.
// The desktop client has no handy console, so every phase is written to the app's log panel
// (bottom panel → Log, shortcut S) through eda.sys_Log, and failures end in a dialog.
// The log panel dies with the window if the editor hangs or crashes, so the same lines are also
// kept in the extension's stored config (survives a restart; Return Path → Show Saved Log...) and,
// when the extension may use the file system ("Allow External Interaction"), in a text file.
// checkpoint() waits for both writes; call it before any step that could block.
import { AnalysisAborted, runAsync, type Board, type Steps, type Tick } from '@returnpath/core';
import extensionConfig from '../extension.json' with { type: 'json' };
import { t } from './i18n';

const PREFIX = '[ReturnPath]';
const PROGRESS_LISTENER = 'returnpath-progress';
const STORE_KEY = 'log';
const MAX_LINES = 1000;
const LOG_FILE = 'returnpath-log.txt';

export type LogLevel = 'info' | 'warn' | 'error';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

type Api = {
	sys_Log?: { add: (m: string, type?: string) => void };
	sys_Storage?: { getExtensionUserConfig: (k: string) => unknown; setExtensionUserConfig: (k: string, v: unknown) => Promise<boolean> };
	sys_FileSystem?: {
		getEdaPath?: () => Promise<string>;
		createDirectoryInFileSystem?: (p: string) => Promise<boolean>;
		saveFileToFileSystem?: (uri: string, data: Blob, name?: string) => Promise<boolean>;
		saveFile?: (data: Blob, name?: string) => Promise<void>;
	};
};
const api = () => eda as unknown as Api;

let lines: string[] | undefined;
let owner: unknown;
let dirty = false;
let writing: Promise<void> = Promise.resolve();
/** undefined = not tried yet, null = not available (browser or no permission). */
let logPath: string | null | undefined;
let storageOff = false;
/** Time limit for each log write; tests shorten it. */
export const saveTimeouts = { ms: 2000 };

export class TimedOut extends Error {}

/** Rejects with TimedOut when `p` has not settled after `ms`; API calls that never answer must not stall a run. */
export function withTimeout<T>(p: Promise<T> | T, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const cancel = after(ms, () => reject(new TimedOut(`${what} did not answer within ${Math.round(ms / 1000)} s`)));
		Promise.resolve(p).then(
			(v) => {
				cancel();
				resolve(v);
			},
			(e) => {
				cancel();
				reject(e);
			},
		);
	});
}

type SysTimer = { setTimeoutTimer: (id: string, ms: number, fn: () => void) => boolean; clearTimeoutTimer?: (id: string) => boolean };
let timerSeq = 0;

/** Runs `fn` after `ms` with setTimeout, or EasyEDA's timer where the sandbox has no setTimeout; returns a cancel function. */
function after(ms: number, fn: () => void): () => void {
	if (typeof setTimeout === 'function') {
		const id = setTimeout(fn, ms);
		return () => clearTimeout(id);
	}
	const timer = (eda as unknown as { sys_Timer?: SysTimer }).sys_Timer;
	const id = `returnpath-timeout-${++timerSeq}`;
	if (!timer?.setTimeoutTimer(id, ms, fn))
		return () => {};
	return () => void timer.clearTimeoutTimer?.(id);
}

function buffer(): string[] {
	// A new API object means a new editor session (or test host): start from what that one stored.
	if (owner !== eda) {
		owner = eda;
		lines = undefined;
		logPath = undefined;
		logProblem = undefined;
		unwritten = undefined;
		storageOff = false;
	}
	if (!lines) {
		let saved: unknown;
		try {
			saved = api().sys_Storage?.getExtensionUserConfig(STORE_KEY);
		}
		catch {}
		lines = typeof saved === 'string' && saved ? saved.split('\n') : Array.isArray(saved) ? saved.filter((l): l is string => typeof l === 'string') : [];
	}
	return lines;
}

const stamp = () => {
	const d = new Date();
	const p = (n: number, w = 2) => String(n).padStart(w, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

/** Writes to the EasyEDA log panel (or the console) and to the saved log. */
export function log(message: string, level: LogLevel = 'info'): void {
	const line = `${PREFIX} ${message}`;
	const b = buffer();
	const stamped = `${stamp()} ${level.toUpperCase().padEnd(5)} ${message}`;
	b.push(stamped);
	currentRun?.lines.push(stamped);
	if (b.length > MAX_LINES)
		b.splice(0, b.length - MAX_LINES);
	dirty = true;
	try {
		const sysLog = api().sys_Log;
		if (sysLog?.add) {
			sysLog.add(line, level);
			return;
		}
	}
	catch {}
	if (typeof console !== 'undefined')
		(level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const NO_SAVE = 'sys_FileSystem.saveFileToFileSystem is not available (allow "External Interaction" for this extension in Advanced > Extension Manager; desktop client only)';

/** Why files cannot be written at all, or undefined when the write API is there. */
function noFileApi(): string | undefined {
	return api().sys_FileSystem?.saveFileToFileSystem ? undefined : NO_SAVE;
}

type Folder = { dir: string; reason?: undefined } | { dir: null; reason: string };

let edaPathOwner: unknown;
let edaPath: Promise<Folder> | undefined;

/** The EasyEDA documents folder from sys_FileSystem.getEdaPath (@beta), or why it is not known; asked once per session. */
function edaFolder(): Promise<Folder> {
	if (edaPathOwner !== eda || !edaPath) {
		edaPathOwner = eda;
		edaPath = (async (): Promise<Folder> => {
			const fs = api().sys_FileSystem;
			if (!fs?.getEdaPath)
				return { dir: null, reason: 'sys_FileSystem.getEdaPath is not available in this EasyEDA version' };
			try {
				const base = await withTimeout(fs.getEdaPath(), saveTimeouts.ms, 'sys_FileSystem.getEdaPath');
				if (typeof base !== 'string' || !base.trim())
					return { dir: null, reason: `sys_FileSystem.getEdaPath returned ${typeof base === 'string' ? 'an empty path' : String(base)}` };
				return { dir: base.trim().replace(/[/\\]+$/, '') };
			}
			catch (e) {
				return { dir: null, reason: e instanceof TimedOut ? e.message : `sys_FileSystem.getEdaPath failed: ${message(e)}` };
			}
		})();
	}
	return edaPath;
}

const sepOf = (dir: string) => (dir.includes('\\') && !dir.includes('/') ? '\\' : '/');

/** Why the log file is not written, when it is not. */
let logProblem: string | undefined;

async function resolveLogPath(): Promise<string | null> {
	logProblem = noFileApi();
	if (logProblem) {
		log(`log file not written: ${logProblem}`, 'warn');
		return null;
	}
	const docs = await edaFolder();
	let dir: string;
	if (docs.dir !== null) {
		dir = `${docs.dir}${sepOf(docs.dir)}ReturnPath`;
	}
	else {
		const chosen = chosenRunFolder();
		if (!chosen) {
			logProblem = `${docs.reason}; choose a Run folder in the panel to have the log written there`;
			log(`log file not written: ${logProblem}`, 'warn');
			return null;
		}
		dir = chosen.replace(/[/\\]+$/, '');
		log(`log file goes to the Run folder: ${docs.reason}`, 'warn');
	}
	await withTimeout(api().sys_FileSystem!.createDirectoryInFileSystem?.(dir), saveTimeouts.ms, 'sys_FileSystem.createDirectoryInFileSystem').catch(() => {});
	return `${dir}${sepOf(dir)}${LOG_FILE}`;
}

async function persist(): Promise<void> {
	if (!dirty)
		return;
	dirty = false;
	const snapshot = [...buffer()];
	const store = api().sys_Storage;
	if (store && !storageOff) {
		try {
			await withTimeout(store.setExtensionUserConfig(STORE_KEY, snapshot.join('\n')), saveTimeouts.ms, 'sys_Storage.setExtensionUserConfig');
		}
		catch (e) {
			if (e instanceof TimedOut) {
				storageOff = true;
				log(`saved log disabled: ${e.message}`, 'warn');
			}
		}
	}
	if (logPath === undefined)
		logPath = await resolveLogPath();
	if (logPath) {
		try {
			const ok = await withTimeout(api().sys_FileSystem!.saveFileToFileSystem!(logPath, new Blob([`${snapshot.join('\n')}\n`], { type: 'text/plain' })), saveTimeouts.ms, 'sys_FileSystem.saveFileToFileSystem');
			if (!ok)
				throw new Error('sys_FileSystem.saveFileToFileSystem returned false');
		}
		catch (e) {
			logProblem = `writing ${logPath} failed: ${message(e)}`;
			logPath = null;
			log(`log file disabled: ${logProblem}`, 'warn');
		}
	}
}

/** Reads a value the extension stored earlier (survives a restart). */
export function readStored(key: string): unknown {
	try {
		return api().sys_Storage?.getExtensionUserConfig(key);
	}
	catch {
		return undefined;
	}
}

/** Stores a value and waits (at most the log-write limit) until it is saved. */
export async function writeStored(key: string, value: unknown): Promise<void> {
	try {
		await withTimeout(api().sys_Storage?.setExtensionUserConfig(key, value), saveTimeouts.ms, 'sys_Storage.setExtensionUserConfig');
	}
	catch {}
}

/** Waits until the log so far is stored (and written to the log file, if allowed). */
export function checkpoint(): Promise<void> {
	writing = writing.then(persist, persist);
	return writing;
}

/** Where the log file is written, or null when the extension may not write files. */
export async function logFilePath(): Promise<string | null> {
	await checkpoint();
	return logPath ?? null;
}

/** Why the log file is not written (after logFilePath() returned null). */
export function logFileProblem(): string | undefined {
	return logPath ? undefined : logProblem;
}

export function savedLog(): string[] {
	return [...buffer()];
}

/** Lets the user save the log anywhere through the system save dialog. */
export async function saveLogAs(): Promise<void> {
	await checkpoint();
	await api().sys_FileSystem?.saveFile?.(new Blob([`${buffer().join('\n')}\n`], { type: 'text/plain' }), LOG_FILE);
}

// Run files: each analysis also writes `<base>.log` (its own log lines) and `<base>.results.json`
// (what it found) to the run folder, named `return-path_<YYYYMMDD-HHMMSS>_<id>` so they sort by time
// and pair up. scripts/agent-sync.mjs ships them to the agent-runs branch. Needs the same
// "External Interaction" permission as the log file.

const RUN_FOLDER_KEY = 'runFolder';

export type RunStatus = 'ok' | 'cancelled' | 'stopped' | 'error';

interface RunRecord {
	base: string;
	command: string;
	startedAt: Date;
	t0: number;
	lines: string[];
	data: Record<string, unknown>;
	status: RunStatus;
	error?: { message: string; stack?: string };
	depth: number;
}

let currentRun: RunRecord | undefined;

const runBase = (d: Date) => {
	const p = (n: number) => String(n).padStart(2, '0');
	const id = Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
	return `return-path_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${id}`;
};

/** Starts collecting a run; a run started inside another one (e.g. the DC hand-off) joins the outer run. */
export function beginRun(command: string): void {
	if (currentRun) {
		currentRun.depth++;
		return;
	}
	const startedAt = new Date();
	currentRun = { base: runBase(startedAt), command, startedAt, t0: now(), lines: [], data: {}, status: 'ok', depth: 0 };
}

/** Adds a top-level field to the running run's results file. */
export function recordResult(key: string, value: unknown): void {
	if (currentRun)
		currentRun.data[key] = value;
}

function failRun(status: RunStatus, message: string, stack?: string): void {
	if (!currentRun)
		return;
	currentRun.status = status;
	currentRun.error = { message, stack };
}

/** The folder chosen with Set Run Folder..., if any. */
export function chosenRunFolder(): string | undefined {
	const v = readStored(RUN_FOLDER_KEY);
	return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export async function setRunFolder(folder: string | undefined): Promise<void> {
	await writeStored(RUN_FOLDER_KEY, folder ?? '');
	// A log file that had nowhere to go may have a place now.
	if (!logPath)
		logPath = undefined;
}

export type RunFolder = Folder & { /** Choosing a Run folder would fix it (the write API is there). */ askable?: boolean };

/** The chosen run folder, else `ReturnPath/runs` in the EasyEDA documents folder; otherwise why there is none. */
export async function runFolderStatus(): Promise<RunFolder> {
	const missing = noFileApi();
	if (missing)
		return { dir: null, reason: missing, askable: false };
	const chosen = chosenRunFolder();
	if (chosen)
		return { dir: chosen.replace(/[/\\]+$/, '') };
	const docs = await edaFolder();
	if (docs.dir === null)
		return { dir: null, reason: docs.reason, askable: true };
	const sep = sepOf(docs.dir);
	return { dir: `${docs.dir}${sep}ReturnPath${sep}runs` };
}

export async function runFolder(): Promise<string | null> {
	return (await runFolderStatus()).dir;
}

interface UnwrittenRun {
	base: string;
	log: string;
	results: string;
	reason: string;
	askable: boolean;
}

/** The last run whose files had no folder; written by writeUnwrittenRun() once a Run folder is chosen. */
let unwritten: UnwrittenRun | undefined;

export function unwrittenRun(): Readonly<UnwrittenRun> | undefined {
	return unwritten && { ...unwritten };
}

async function writeRunFiles(dir: string, base: string, logText: string, resultsText: string): Promise<string> {
	const fs = api().sys_FileSystem!;
	const sep = sepOf(dir);
	await withTimeout(fs.createDirectoryInFileSystem?.(dir), saveTimeouts.ms, 'sys_FileSystem.createDirectoryInFileSystem').catch(() => {});
	const write = async (name: string, text: string, type: string) => {
		const ok = await withTimeout(fs.saveFileToFileSystem!(`${dir}${sep}${name}`, new Blob([text], { type })), saveTimeouts.ms, 'sys_FileSystem.saveFileToFileSystem');
		if (!ok)
			throw new Error(`could not write ${dir}${sep}${name}`);
	};
	await write(`${base}.log`, logText, 'text/plain');
	await write(`${base}.results.json`, resultsText, 'application/json');
	log(`run files written: ${dir}${sep}${base}.log, .results.json`);
	return `${dir}${sep}${base}.results.json`;
}

/** Writes the files of the last run that had no folder, now that there may be one; returns the results path. */
export async function writeUnwrittenRun(): Promise<string | null> {
	const run = unwritten;
	if (!run)
		return null;
	const folder = await runFolderStatus();
	if (folder.dir === null)
		return null;
	try {
		const path = await writeRunFiles(folder.dir, run.base, run.log, run.results);
		unwritten = undefined;
		return path;
	}
	catch (e) {
		log(`run files not written to ${folder.dir}: ${message(e)}`, 'warn');
		return null;
	}
	finally {
		await checkpoint();
	}
}

/** Ends the run and writes its two files; returns the results path, or null when they could not be written. */
export async function endRun(): Promise<string | null> {
	const run = currentRun;
	if (!run)
		return null;
	if (run.depth > 0) {
		run.depth--;
		return null;
	}
	const finishedAt = new Date();
	log(`${run.command}: run ${run.base} ${run.status} in ${Math.round(now() - run.t0)} ms`);
	currentRun = undefined;
	const results = {
		schema: 'returnpath-run/v1',
		version: extensionConfig.version,
		command: run.command,
		status: run.status,
		startedAt: run.startedAt.toISOString(),
		finishedAt: finishedAt.toISOString(),
		durationMs: finishedAt.getTime() - run.startedAt.getTime(),
		...(run.error ? { error: run.error } : {}),
		...run.data,
	};
	const logText = `${run.lines.join('\n')}\n`;
	const resultsText = `${JSON.stringify(results, null, 2)}\n`;
	try {
		const folder = await runFolderStatus();
		if (folder.dir === null) {
			const askable = !!folder.askable;
			log(`run files not written: ${folder.reason}${askable ? '; choose a Run folder in the panel to have them written there' : ''}`, 'warn');
			unwritten = { base: run.base, log: logText, results: resultsText, reason: folder.reason, askable };
			return null;
		}
		try {
			return await writeRunFiles(folder.dir, run.base, logText, resultsText);
		}
		catch (e) {
			log(`run files not written to ${folder.dir}: ${message(e)}`, 'warn');
			return null;
		}
	}
	finally {
		await checkpoint();
	}
}

export function logStartup(): void {
	log(`extension v${extensionConfig.version} loaded`);
	void checkpoint();
}

/** Times an async step and logs it. */
export async function timed<T>(label: string, fn: () => Promise<T>, sizes?: (r: T) => string): Promise<T> {
	const t0 = now();
	log(`${label}…`);
	await checkpoint();
	const r = await fn();
	log(`${label}: ${Math.round(now() - t0)} ms${sizes ? `; ${sizes(r)}` : ''}`);
	await checkpoint();
	return r;
}

export function boardSizes(b: Board): string {
	let fillVertices = 0;
	for (const p of b.pours) for (const r of p.poured ?? p.outline) fillVertices += r.length;
	return `${b.stackup.copper.length} copper layers, ${b.nets.length} nets, ${b.tracks.length} track segments, ${b.vias.length} vias, ${b.pads.length} pads, ${b.components.length} components, ${b.pours.length} pours/fills (${fillVertices} vertices), ${b.keepouts.length} keepouts`;
}

let running: { title: string; signal: { aborted: boolean } } | undefined;

export function isRunning(): boolean {
	return !!running;
}

/** Stops the running analysis at its next slice. */
export function cancelRunning(): boolean {
	if (!running)
		return false;
	running.signal.aborted = true;
	log(`${running.title}: cancel requested`);
	return true;
}

/** Hands control back to the editor so it can repaint and handle input. */
export function yieldToEditor(): Promise<void> {
	return new Promise<void>((resolve) => {
		if (typeof setTimeout === 'function') {
			setTimeout(resolve, 0);
			return;
		}
		const timer = (eda as unknown as { sys_Timer?: { setTimeoutTimer: (id: string, ms: number, fn: () => void) => boolean } }).sys_Timer;
		if (!timer?.setTimeoutTimer('returnpath-yield', 0, resolve))
			resolve();
	});
}

export interface StepRunOptions {
	title: string;
	timeBudgetMs: number;
	/** Maps a progress tick to 0–100 for the progress bar. */
	percent: (tick: Tick) => number | undefined;
}

/**
 * Runs analysis steps in ~30 ms slices, yielding to the editor between slices, with a progress bar
 * (closing it cancels), a time budget and a log line for every phase.
 */
export async function runSteps<T>(steps: Steps<T>, o: StepRunOptions): Promise<T> {
	if (running)
		throw new AnalysisAborted('cancelled', t('${1} is still running. Cancel it first: the Selected trace button turns into Cancel while an analysis runs.', running.title));
	const signal = { aborted: false };
	running = { title: o.title, signal };
	const bar = (eda as unknown as { sys_LoadingAndProgressBar?: { showProgressBar: (p?: number, title?: string) => void; destroyProgressBar: () => void } }).sys_LoadingAndProgressBar;
	const events = (eda as unknown as { sys_Event?: { addProgressBarEventListener?: (id: string, fn: (p: { action: string }) => void, once?: boolean) => void; removeEventListener?: (id: string) => boolean } }).sys_Event;
	try {
		events?.addProgressBarEventListener?.(PROGRESS_LISTENER, (p) => {
			if (p.action === 'close')
				cancelRunning();
		});
	}
	catch {}

	const phaseMs = new Map<string, number>();
	let shown = -1;
	let phase = '';
	const t0 = now();
	log(`${o.title}: started (time budget ${Math.round(o.timeBudgetMs / 1000)} s)`);
	await checkpoint();
	try {
		bar?.showProgressBar(0, o.title);
		const result = await runAsync(steps, {
			timeBudgetMs: o.timeBudgetMs,
			sliceMs: 30,
			signal,
			now,
			yieldFn: yieldToEditor,
			onPhase: (next, prev, ms) => {
				if (prev)
					phaseMs.set(prev, (phaseMs.get(prev) ?? 0) + ms);
				if (next !== 'done' && !phaseMs.has(next)) {
					phaseMs.set(next, 0);
					log(`${o.title}: phase "${next}" at ${Math.round(now() - t0)} ms`);
					void checkpoint();
				}
			},
			onProgress: (tick) => {
				const p = o.percent(tick);
				if (p === undefined)
					return;
				// 100 closes the bar by itself.
				const pct = Math.max(0, Math.min(99, Math.floor(p)));
				if (pct !== shown || tick.phase !== phase) {
					shown = pct;
					phase = tick.phase;
					bar?.showProgressBar(pct, `${o.title}: ${tick.phase}`);
				}
			},
		});
		void checkpoint();
		log(`${o.title}: finished in ${Math.round(now() - t0)} ms (${[...phaseMs].map(([p, ms]) => `${p} ${Math.round(ms)} ms`).join(', ')})`);
		return result;
	}
	catch (e) {
		log(`${o.title}: stopped after ${Math.round(now() - t0)} ms in phase "${phase}" (${[...phaseMs].map(([p, ms]) => `${p} ${Math.round(ms)} ms`).join(', ')})`, 'warn');
		throw e;
	}
	finally {
		running = undefined;
		void checkpoint();
		try {
			events?.removeEventListener?.(PROGRESS_LISTENER);
			bar?.destroyProgressBar();
		}
		catch {}
	}
}

/** Runs a menu action; logs and shows any error in a dialog instead of letting it vanish. */
export async function guarded(title: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
	}
	catch (e) {
		if (e instanceof AnalysisAborted) {
			log(`${title}: ${e.reason}: ${e.message}`, 'warn');
			failRun(e.reason === 'cancelled' ? 'cancelled' : 'stopped', `${e.reason}: ${e.message}`);
			if (e.reason === 'cancelled')
				toast(e.message);
			else
				eda.sys_Dialog.showInformationMessage(`${e.message}\n\n${t('Details are in the log panel (bottom panel, shortcut S, Log tab).')}`, title);
			return;
		}
		const err = e instanceof Error ? e : new Error(String(e));
		log(`${title}: error: ${err.message}${err.stack ? `\n${err.stack}` : ''}`, 'error');
		failRun('error', err.message, err.stack);
		await checkpoint();
		eda.sys_Dialog.showInformationMessage(`${t('Error')}: ${err.message}\n\n${t('Details are in the log panel (bottom panel, shortcut S, Log tab).')}`, title);
	}
	finally {
		await checkpoint();
	}
}

export function toast(message: string): void {
	try {
		const msg = (eda as unknown as { sys_Message?: { showToastMessage?: (m: string, type?: string, timer?: number, panel?: string) => void } }).sys_Message;
		if (msg?.showToastMessage) {
			msg.showToastMessage(message, 'info', 4, 'log');
			return;
		}
		eda.sys_ToastMessage.showMessage(message, 'info' as never, 4);
	}
	catch {
		log(message);
	}
}
