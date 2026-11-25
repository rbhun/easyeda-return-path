/**
 * Extension entry. Every function exported here can be referenced by name from
 * `headerMenus[*].menuItems[*].registerFn` in extension.json.
 * API guide: https://prodocs.easyeda.com/en/api/guide/
 */
import { analyzeNet } from '@returnpath/core';
import extensionConfig from '../extension.json' with { type: 'json' };
import { readBoard, selectedNet } from './eda-board';
import { clearOverlay, drawAnalysis } from './overlay';

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

export async function clearReturnPath(): Promise<void> {
	await clearOverlay();
}
