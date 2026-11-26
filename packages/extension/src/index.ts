/**
 * Extension entry. Every function exported here can be referenced by name from
 * `headerMenus[*].menuItems[*].registerFn` in extension.json.
 * API guide: https://prodocs.easyeda.com/en/api/guide/
 */
import { analyzeNetSteps, buildDcSetup, hfApplicability, solveDcSteps, traceStreamlines, DRAWN_STREAMS, type Board, type DcSetupInput, type Pad, type Tick } from '@returnpath/core';
import extensionConfig from '../extension.json' with { type: 'json' };
import { carriesCurrent, drawDc } from './dc-overlay';
import { addPinNames, readBoard, selectedNet } from './eda-board';
import { clearOverlay, drawAnalysis, toggleOverlay } from './overlay';
import { boardSizes, cancelRunning, checkpoint, guarded, log, logFilePath, logStartup, readStored, runSteps, savedLog, saveLogAs, timed, toast, writeStored } from './runner';
import { dialogAsk, loggedAsk, runDcWizard, type Ask } from './wizard';

const t = (key: string, ...args: string[]) => eda.sys_I18n.text(key, undefined, undefined, ...args);

const HF_BUDGET_MS = 60_000;
const DC_BUDGET_MS = 120_000;

// eslint-disable-next-line unused-imports/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {
	logStartup();
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(`${t('Return-path overlay v${1}', extensionConfig.version)}\n\n${t('If the editor froze, reopen it and use Return Path > Show Saved Log...')}`, t('About'));
}

function confirm(content: string, title: string, ok: string): Promise<boolean> {
	return new Promise((resolve) => {
		eda.sys_Dialog.showConfirmationMessage(content, title, ok, t('Cancel'), clicked => resolve(!!clicked));
	});
}

/** Progress of the high-frequency analysis: chains carry the bulk of the work. */
function hfPercent() {
	let chainStart = 5;
	let chainSpan = 85;
	let last = 0;
	const within: Record<string, [number, number]> = { 'band coverage': [0, 0.2], 'sampling': [0.2, 0.2], 'gaps': [0.4, 0.6] };
	return (tick: Tick) => {
		const f = tick.fraction ?? 0;
		if (tick.phase === 'reference copper') {
			last = 5 * f;
		}
		else if (tick.phase === 'chains') {
			chainSpan = 85 / (tick.steps || 1);
			chainStart = 5 + 85 * f;
			last = chainStart;
		}
		else if (tick.phase === 'vias') {
			last = 90 + 10 * f;
		}
		else if (within[tick.phase]) {
			const [a, w] = within[tick.phase];
			last = Math.max(last, chainStart + chainSpan * (a + w * f));
		}
		return last;
	};
}

export async function showReturnPath(): Promise<void> {
	await runReturnPath(dialogAsk());
}

export async function runReturnPath(ask: Ask): Promise<void> {
	const title = t('Return path');
	await guarded(title, async () => {
		const net = await selectedNet();
		if (!net) {
			eda.sys_Dialog.showInformationMessage(t('Select a track, via or pad of the net to analyse.'), title);
			return;
		}
		await hfFor(net, ask);
	});
}

async function hfFor(net: string, ask: Ask): Promise<void> {
	const title = t('Return path');
	log(`Show for Selected Net: ${net} (v${extensionConfig.version})`);
	// The name check needs no board, so power and ground nets are turned away before the read.
	const byName = hfApplicability({ pours: [] }, net);
	const board = byName.ok ? await timed('read board', readBoard, boardSizes) : undefined;
	const scope = board ? hfApplicability(board, net) : byName;
	if (!scope.ok) {
		log(`${net}: not a signal net (${scope.kind}); high-frequency check skipped`, 'warn');
		if (await confirm(scope.message!, title, t('Open DC view')))
			await runDcReturn(ask, scope.kind === 'power' ? net : undefined);
		return;
	}
	if (!board)
		return;
	await remember({ kind: 'hf', net });
	const ownTracks = board.tracks.filter(tr => tr.net === net).length;
	log(`${net}: ${ownTracks} track segments, ${board.vias.filter(v => v.net === net).length} vias`);
	const analysis = await runSteps(analyzeNetSteps(board, net), { title, timeBudgetMs: HF_BUDGET_MS, percent: hfPercent() });
	log(`${net}: ${Object.entries(analysis.stats).map(([k, v]) => `${k}=${+Number(v).toFixed(3)}`).join(' ')}`);
	const drawn = await timed('draw markers', () => drawAnalysis(analysis, board), d => `${d.markers} markers`);
	const lines = [
		t('${1}: ${2} finding(s), ${3} overlay marker(s).', net, String(analysis.findings.length), String(drawn.markers)),
		drawn.returnLayers.length
			? t('Return path (thick) on ${1}. Dashed yellow: hop through a via, decap, bridging cap or IC pin. Red: trace over a gap, or band without copper. Thin white: ±3h band edges.', drawn.returnLayers.join(', '))
			: t('No return path drawn: the trace has no reference copper.'),
		...analysis.findings.map(f => `[${f.severity}] ${f.message}`),
		...board.warnings.map(w => `warning: ${w}`),
	];
	eda.sys_Dialog.showInformationMessage(lines.join('\n'), title);
}

/** Wizard step 1, DC solve of the chosen rail and its ground, and the DC overlay (D7). */
export async function showDcReturn(): Promise<void> {
	await runDcReturn(dialogAsk());
}

export async function runDcReturn(ask: Ask, preferredRail?: string): Promise<void> {
	const title = t('DC return current');
	await guarded(title, async () => {
		log(`DC Return Current (v${extensionConfig.version})`);
		const rail = preferredRail ?? await timed('read selection', selectedNet, n => n ?? 'nothing selected');
		const board = await timed('read board', readBoard, boardSizes);
		await addPinNames(board);
		const wiz = await runDcWizard(board, loggedAsk(ask), rail);
		if (!wiz)
			return;
		await remember({ kind: 'dc', input: wiz.input });
		await dcFor(board, wiz.input);
	});
}

async function dcFor(board: Board, input: DcSetupInput): Promise<void> {
	const title = t('DC return current');
	log(`DC setup: ${JSON.stringify(input)}`);
	await checkpoint();
	const setup = buildDcSetup(board, input);
	log(`DC ${setup.rail}/${setup.ground}: source ${setup.source.designator}, loads ${setup.loads.map(l => `${l.designator}=${l.current} A`).join(', ')}`);
	const percent = (tick: Tick) => {
		const f = tick.fraction ?? 0;
		const at: Record<string, [number, number]> = {
			'reference copper': [0, 5],
			[`raster ${setup.rail}`]: [5, 10],
			[`network ${setup.rail}`]: [15, 0],
			[`solve ${setup.rail}`]: [15, 35],
			[`raster ${setup.ground}`]: [50, 10],
			[`network ${setup.ground}`]: [60, 0],
			[`solve ${setup.ground}`]: [60, 35],
		};
		const r = at[tick.phase];
		return r ? r[0] + r[1] * f : undefined;
	};
	const res = await runSteps(solveDcSteps(board, setup), { title, timeBudgetMs: DC_BUDGET_MS, percent });
	log(`DC grid ${res.grid.nx}×${res.grid.ny} cells of ${res.grid.cell} mm; ${[res.supply, res.ret].filter(n => !!n).map(n => `${n!.net}: ${n!.nodes} nodes, ${n!.iterations} CG iterations, residual ${n!.residual.toExponential(1)}`).join('; ')}`);
	for (const n of [res.supply, res.ret]) {
		if (!n?.unconnected.length)
			continue;
		const pads = (ps: Pad[]) => ps.map(p => `${p.id} L${p.layer} (${p.at.x.toFixed(2)}, ${p.at.y.toFixed(2)})`).join(' ') || 'none';
		const which = n.role === 'supply' ? 'railPads' : 'groundPads';
		log(`${n.net}: ${n.unconnected.join(', ')} not reached from ${setup.source.designator}; source pads ${pads(setup.source[which])}; load pads ${setup.loads.map(l => `${l.designator}: ${pads(l[which])}`).join('; ')}; pours on ${n.net}: ${board.pours.filter(p => p.net === n.net).map(p => `${p.id} L${p.layer}`).join(', ') || 'none'}`, 'warn');
	}
	const streams = await timed('streamlines', async () => ({ supply: traceStreamlines(res.grid, res.supply, DRAWN_STREAMS), ret: res.ret ? traceStreamlines(res.grid, res.ret, DRAWN_STREAMS) : [] }), s => `${s.supply.length + s.ret.length} lines`);
	const drawn = await timed('draw markers', () => drawDc(res, streams), d => `${d.markers} markers`);
	const layerName = (id: number) => board.stackup.copper.find(l => l.id === id)?.name ?? `L${id}`;
	const vUnit = setup.normalised ? 'mV/A' : 'mV';
	const jUnit = setup.normalised ? 'A/mm per A' : 'A/mm';
	const lines = [
		t('${1} / ${2}: source ${3}, loads ${4}.', setup.rail, setup.ground, setup.source.designator, setup.loads.map(l => l.designator).join(', ')),
		setup.normalised ? t('No load currents given: 1 A total split equally; values are per amp.') : '',
		...[res.supply, res.ret].filter(n => !!n).map(n => carriesCurrent(n!)
			? t('${1}: drop ${2} ${3}, bottleneck ${4} ${5} on ${6}.', n!.net, (n!.drop * 1000).toFixed(2), vUnit, (n!.bottleneck?.j ?? 0).toFixed(3), jUnit, n!.bottleneck ? layerName(n!.bottleneck.layer) : '-')
			: t('${1}: no load has a copper path to ${2}; nothing is drawn for it.', n!.net, setup.source.designator)),
		t('Streamlines: ${1} supply thin yellow; ${2} return thick, magenta on ${3} and cyan on other layers, with a circle where it changes layer.', setup.rail, setup.ground, layerName(board.stackup.copper[0].id)),
		t('${1} overlay marker(s).', String(drawn.markers)),
		...[...board.warnings, ...res.warnings].map(w => `warning: ${w}`),
	].filter(Boolean);
	eda.sys_Dialog.showInformationMessage(lines.join('\n'), title);
}

type LastRun = { kind: 'hf'; net: string } | { kind: 'dc'; input: DcSetupInput };
const LAST_RUN = 'lastRun';

/** Stored, so Rerun Last Analysis works after a restart too. */
async function remember(run: LastRun): Promise<void> {
	await writeStored(LAST_RUN, JSON.stringify(run));
}

function lastRun(): LastRun | undefined {
	try {
		const v = readStored(LAST_RUN);
		const run = (typeof v === 'string' ? JSON.parse(v) : v) as LastRun | undefined;
		return run && (run.kind === 'hf' ? typeof run.net === 'string' : run.kind === 'dc' && !!run.input?.rail) ? run : undefined;
	}
	catch {
		return undefined;
	}
}

/** Repeats the last analysis on the board as it is now, with the same net or wizard answers. */
export async function rerunAnalysis(): Promise<void> {
	const run = lastRun();
	if (!run) {
		eda.sys_Dialog.showInformationMessage(t('No analysis to rerun yet: run Show for Selected Net or DC Return Current first.'), t('Rerun last analysis'));
		return;
	}
	if (run.kind === 'hf') {
		await guarded(t('Return path'), () => hfFor(run.net, dialogAsk()));
		return;
	}
	await guarded(t('DC return current'), async () => {
		log(`Rerun DC Return Current (v${extensionConfig.version})`);
		const board = await timed('read board', readBoard, boardSizes);
		await addPinNames(board);
		await dcFor(board, run.input);
	});
}

/** Hides the overlay, or shows it again. */
export async function toggleReturnPath(): Promise<void> {
	await guarded(t('Return path'), async () => {
		const visible = await toggleOverlay();
		toast(visible === undefined ? t('No overlay to show: run an analysis first.') : visible ? t('Overlay shown.') : t('Overlay hidden. Use Hide/Show Overlay again to show it.'));
	});
}

/** Stops a running analysis (closing its progress bar does the same). */
export function cancelAnalysis(): void {
	if (!cancelRunning())
		toast(t('No analysis is running.'));
}

export async function clearReturnPath(): Promise<void> {
	cancelRunning();
	await guarded(t('Return path'), clearOverlay);
}

/** Shows the saved log, which survives an editor freeze or crash, and offers to save it as a file. */
export async function showSavedLog(): Promise<void> {
	await guarded(t('Saved log'), async () => {
		const path = await logFilePath();
		const all = savedLog();
		const where = path
			? t('The full log is also written to: ${1}', path)
			: t('To have the log written to a file as well, allow "External Interaction" for this extension in Advanced > Extension Manager.');
		const body = [where, '', ...all.slice(-40)].join('\n');
		if (await confirm(body, t('Saved log (last ${1} of ${2} lines)', String(Math.min(40, all.length)), String(all.length)), t('Save as file...')))
			await saveLogAs();
	});
}
