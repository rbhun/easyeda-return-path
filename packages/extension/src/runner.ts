// Runs analyses without blocking the editor, and makes what they do visible inside EasyEDA Pro.
// The desktop client has no handy console, so every phase is written to the app's log panel
// (bottom panel → Log, shortcut S) through eda.sys_Log, and failures end in a dialog.
import { AnalysisAborted, runAsync, type Board, type Steps, type Tick } from '@returnpath/core';

const t = (key: string, ...args: string[]) => eda.sys_I18n.text(key, undefined, undefined, ...args);

const PREFIX = '[ReturnPath]';
const PROGRESS_LISTENER = 'returnpath-progress';

export type LogLevel = 'info' | 'warn' | 'error';

/** Writes to the EasyEDA log panel when the API has it, and to the console otherwise. */
export function log(message: string, level: LogLevel = 'info'): void {
	const line = `${PREFIX} ${message}`;
	try {
		const sysLog = (eda as unknown as { sys_Log?: { add: (m: string, type?: string) => void } }).sys_Log;
		if (sysLog?.add) {
			sysLog.add(line, level);
			return;
		}
	}
	catch {}
	if (typeof console !== 'undefined')
		(level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Times an async step and logs it. */
export async function timed<T>(label: string, fn: () => Promise<T>, sizes?: (r: T) => string): Promise<T> {
	const t0 = now();
	log(`${label}…`);
	const r = await fn();
	log(`${label}: ${Math.round(now() - t0)} ms${sizes ? `; ${sizes(r)}` : ''}`);
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

function hostYield(): Promise<void> {
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
		throw new AnalysisAborted('cancelled', t('${1} is still running. Cancel it first (Return Path > Cancel Running Analysis).', running.title));
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
	try {
		bar?.showProgressBar(0, o.title);
		const result = await runAsync(steps, {
			timeBudgetMs: o.timeBudgetMs,
			sliceMs: 30,
			signal,
			now,
			yieldFn: hostYield,
			onPhase: (next, prev, ms) => {
				if (prev)
					phaseMs.set(prev, (phaseMs.get(prev) ?? 0) + ms);
				if (next !== 'done' && !phaseMs.has(next)) {
					phaseMs.set(next, 0);
					log(`${o.title}: phase "${next}" at ${Math.round(now() - t0)} ms`);
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
		log(`${o.title}: finished in ${Math.round(now() - t0)} ms (${[...phaseMs].map(([p, ms]) => `${p} ${Math.round(ms)} ms`).join(', ')})`);
		return result;
	}
	catch (e) {
		log(`${o.title}: stopped after ${Math.round(now() - t0)} ms in phase "${phase}" (${[...phaseMs].map(([p, ms]) => `${p} ${Math.round(ms)} ms`).join(', ')})`, 'warn');
		throw e;
	}
	finally {
		running = undefined;
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
			if (e.reason === 'cancelled')
				toast(e.message);
			else
				eda.sys_Dialog.showInformationMessage(`${e.message}\n\n${t('Details are in the log panel (bottom panel, shortcut S, Log tab).')}`, title);
			return;
		}
		const err = e instanceof Error ? e : new Error(String(e));
		log(`${title}: error: ${err.message}${err.stack ? `\n${err.stack}` : ''}`, 'error');
		eda.sys_Dialog.showInformationMessage(`${t('Error')}: ${err.message}\n\n${t('Details are in the log panel (bottom panel, shortcut S, Log tab).')}`, title);
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
