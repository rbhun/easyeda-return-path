/**
 * Extension entry. Every function exported here can be referenced by name from
 * `headerMenus[*].menuItems[*].registerFn` in extension.json.
 * API guide: https://prodocs.easyeda.com/en/api/guide/
 */
import { analyzeNetSteps, buildDcSetup, hfApplicability, solveDcSteps, traceStreamlines, type Tick } from '@returnpath/core';
import extensionConfig from '../extension.json' with { type: 'json' };
import { drawDc } from './dc-overlay';
import { readBoard, selectedNet } from './eda-board';
import { clearOverlay, drawAnalysis } from './overlay';
import { boardSizes, cancelRunning, guarded, log, runSteps, timed, toast } from './runner';
import { dialogAsk, runDcWizard, type Ask } from './wizard';

const t = (key: string, ...args: string[]) => eda.sys_I18n.text(key, undefined, undefined, ...args);

const HF_BUDGET_MS = 60_000;
const DC_BUDGET_MS = 120_000;

// eslint-disable-next-line unused-imports/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(t('Return-path overlay v${1}', extensionConfig.version), t('About'));
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
		log(`Show for Selected Net: ${net}`);
		const board = await timed('read board', readBoard, boardSizes);
		const scope = hfApplicability(board, net);
		if (!scope.ok) {
			log(`${net}: not a signal net (${scope.kind}); high-frequency check skipped`, 'warn');
			if (await confirm(scope.message!, title, t('Open DC view')))
				await runDcReturn(ask, scope.kind === 'power' ? net : undefined);
			return;
		}
		const ownTracks = board.tracks.filter(tr => tr.net === net).length;
		log(`${net}: ${ownTracks} track segments, ${board.vias.filter(v => v.net === net).length} vias`);
		const analysis = await runSteps(analyzeNetSteps(board, net), { title, timeBudgetMs: HF_BUDGET_MS, percent: hfPercent() });
		log(`${net}: ${Object.entries(analysis.stats).map(([k, v]) => `${k}=${+Number(v).toFixed(3)}`).join(' ')}`);
		const drawn = await timed('draw markers', () => drawAnalysis(analysis), n => `${n} markers`);
		const lines = [
			t('${1}: ${2} finding(s), ${3} overlay marker(s).', net, String(analysis.findings.length), String(drawn)),
			...analysis.findings.map(f => `[${f.severity}] ${f.message}`),
			...board.warnings.map(w => `warning: ${w}`),
		];
		eda.sys_Dialog.showInformationMessage(lines.join('\n'), title);
	});
}

/** Wizard step 1, DC solve of the chosen rail and its ground, and the DC overlay (D7). */
export async function showDcReturn(): Promise<void> {
	await runDcReturn(dialogAsk());
}

export async function runDcReturn(ask: Ask, preferredRail?: string): Promise<void> {
	const title = t('DC return current');
	await guarded(title, async () => {
		const board = await timed('read board', readBoard, boardSizes);
		const wiz = await runDcWizard(board, ask, preferredRail ?? await selectedNet());
		if (!wiz)
			return;
		const setup = buildDcSetup(board, wiz.input);
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
		const streams = await timed('streamlines', async () => ({ supply: traceStreamlines(res.grid, res.supply), ret: res.ret ? traceStreamlines(res.grid, res.ret) : [] }), s => `${s.supply.length + s.ret.length} lines`);
		const drawn = await timed('draw markers', () => drawDc(res, streams), d => `${d.markers} markers`);
		const layerName = (id: number) => board.stackup.copper.find(l => l.id === id)?.name ?? `L${id}`;
		const vUnit = setup.normalised ? 'mV/A' : 'mV';
		const jUnit = setup.normalised ? 'A/mm per A' : 'A/mm';
		const lines = [
			t('${1} / ${2}: source ${3}, loads ${4}.', setup.rail, setup.ground, setup.source.designator, setup.loads.map(l => l.designator).join(', ')),
			setup.normalised ? t('No load currents given: 1 A total split equally; values are per amp.') : '',
			...[res.supply, res.ret].filter(n => !!n).map(n => t('${1}: drop ${2} ${3}, bottleneck ${4} ${5} on ${6}.', n!.net, (n!.drop * 1000).toFixed(2), vUnit, (n!.bottleneck?.j ?? 0).toFixed(3), jUnit, n!.bottleneck ? layerName(n!.bottleneck.layer) : '-')),
			t('Contours drawn on: ${1}.', drawn.contourLayers.map(c => `${c.net} ${layerName(c.layer)}`).join(', ')),
			t('${1} overlay marker(s).', String(drawn.markers)),
			...[...board.warnings, ...res.warnings].map(w => `warning: ${w}`),
		].filter(Boolean);
		eda.sys_Dialog.showInformationMessage(lines.join('\n'), title);
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
