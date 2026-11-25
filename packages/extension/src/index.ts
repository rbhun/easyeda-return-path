/**
 * Extension entry. Every function exported here can be referenced by name from
 * `headerMenus[*].menuItems[*].registerFn` in extension.json.
 * API guide: https://prodocs.easyeda.com/en/api/guide/
 */
import { analyzeNet, buildDcSetup, solveDc, traceStreamlines } from '@returnpath/core';
import extensionConfig from '../extension.json' with { type: 'json' };
import { drawDc } from './dc-overlay';
import { readBoard, selectedNet } from './eda-board';
import { clearOverlay, drawAnalysis } from './overlay';
import { dialogAsk, runDcWizard, type Ask } from './wizard';

const t = (key: string, ...args: string[]) => eda.sys_I18n.text(key, undefined, undefined, ...args);

// eslint-disable-next-line unused-imports/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(t('Return-path overlay v${1}', extensionConfig.version), t('About'));
}

export async function showReturnPath(): Promise<void> {
	try {
		const net = await selectedNet();
		if (!net) {
			eda.sys_Dialog.showInformationMessage(t('Select a track, via or pad of the net to analyse.'), t('Return path'));
			return;
		}
		const board = await readBoard();
		const analysis = analyzeNet(board, net);
		const drawn = await drawAnalysis(analysis);
		const lines = [
			t('${1}: ${2} finding(s), ${3} overlay marker(s).', net, String(analysis.findings.length), String(drawn)),
			...analysis.findings.map(f => `[${f.severity}] ${f.message}`),
			...board.warnings.map(w => `warning: ${w}`),
		];
		eda.sys_Dialog.showInformationMessage(lines.join('\n'), t('Return path'));
	}
	catch (e) {
		eda.sys_Dialog.showInformationMessage(String(e instanceof Error ? e.message : e), t('Return path'));
	}
}

/** Wizard step 1, DC solve of the chosen rail and its ground, and the DC overlay (D7). */
export async function showDcReturn(): Promise<void> {
	await runDcReturn(dialogAsk());
}

export async function runDcReturn(ask: Ask): Promise<void> {
	try {
		const board = await readBoard();
		const wiz = await runDcWizard(board, ask, await selectedNet());
		if (!wiz)
			return;
		const setup = buildDcSetup(board, wiz.input);
		const res = solveDc(board, setup);
		const streams = { supply: traceStreamlines(res.grid, res.supply), ret: res.ret ? traceStreamlines(res.grid, res.ret) : [] };
		const drawn = await drawDc(res, streams);
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
		eda.sys_Dialog.showInformationMessage(lines.join('\n'), t('DC return current'));
	}
	catch (e) {
		eda.sys_Dialog.showInformationMessage(String(e instanceof Error ? e.message : e), t('DC return current'));
	}
}

export async function clearReturnPath(): Promise<void> {
	await clearOverlay();
}
