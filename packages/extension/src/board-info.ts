// The board info of the open project (packages/core/src/boardinfo.ts), kept in the extension's
// settings under the project's uuid: loaded from a CSV, saved to one, read by the HF and DC checks
// to prefill their questions, and updated with what the user changes there.
import { emptyBoardInfo, formatBoardInfoCsv, mergeBoardInfo, NET_KINDS, parseBoardInfoCsv, type BoardInfo } from '@returnpath/core';
import { BOARD_INFO_SAMPLE_CSV } from './board-info-sample';
import { guarded, log, readStored, toast, withTimeout, writeStored } from './runner';
import { dialogAsk } from './wizard';
import { t } from './i18n';

export const boardInfoTimeouts = { projectMs: 5_000 };

export interface Project {
	/** Settings key of the project's board info. */
	key: string;
	name: string;
}

const NO_PROJECT: Project = { key: 'boardInfo:no-project', name: 'board' };

/** The open project; without one (or without the project API), one shared entry is used. */
export async function currentProject(): Promise<Project> {
	try {
		const api = (eda as unknown as { dmt_Project?: { getCurrentProjectInfo?: () => Promise<{ uuid?: string; friendlyName?: string; name?: string } | undefined> } }).dmt_Project;
		const p = await withTimeout(api?.getCurrentProjectInfo?.(), boardInfoTimeouts.projectMs, 'dmt_Project.getCurrentProjectInfo');
		if (p?.uuid)
			return { key: `boardInfo:${p.uuid}`, name: p.friendlyName || p.name || p.uuid };
		log('board info: no project is open; using the shared entry', 'warn');
	}
	catch (e) {
		log(`board info: project not known (${e instanceof Error ? e.message : String(e)}); using the shared entry`, 'warn');
	}
	return NO_PROJECT;
}

export function readBoardInfo(project: Project): BoardInfo {
	const v = readStored(project.key);
	try {
		const info = typeof v === 'string' ? JSON.parse(v) as BoardInfo : undefined;
		if (info && Array.isArray(info.nets) && Array.isArray(info.loads) && Array.isArray(info.layers))
			return info;
	}
	catch {}
	return emptyBoardInfo();
}

export async function writeBoardInfo(project: Project, info: BoardInfo): Promise<void> {
	await writeStored(project.key, JSON.stringify(info));
}

/** The open project's board info, and a writer for what the checks learn from the user. */
export async function boardInfo(): Promise<{ project: Project; info: BoardInfo; save: (next: BoardInfo, what: string) => Promise<void> }> {
	const project = await currentProject();
	const info = readBoardInfo(project);
	const count = info.nets.length + info.loads.length + info.layers.length;
	if (count)
		log(`board info of ${project.name}: ${info.nets.length} nets, ${info.loads.length} loads, ${info.layers.length} layers`);
	return {
		project,
		info,
		save: async (next, what) => {
			await writeBoardInfo(project, next);
			log(`board info of ${project.name}: saved ${what}`);
		},
	};
}

const isEmpty = (i: BoardInfo) => !i.nets.length && !i.loads.length && !i.layers.length;
const fileName = (p: Project) => `${p.name.replace(/[^\w.-]+/g, '_')}-board-info.csv`;

/** What Load Board Info shows before the file is picked: the CSV format and what Replace and Add do. */
export function boardInfoCsvHelp(project: Project, stored: BoardInfo): string {
	const cols = (...c: string[]) => `    ${c.join(', ')}`;
	return [
		t('Choose a CSV file with the board info of ${1}. Its first line names the columns, in any order, separated by commas or semicolons. The first column, row, says what each line describes:', project.name),
		'',
		t('row = net: one signal, power or ground net.'),
		cols('net', 'kind', 'protocol', 'speed', 'driver_part', 'driver_pin', 'driver_pin_name', 'receivers', 'diff_partner', 'reference', 'target', 'notes'),
		t('    kind: ${1}.', NET_KINDS.join(', ')),
		t('    speed in Hz: 400k, 8 MHz, 115200. Several driver parts separated by ;, or none for a net without a driver.'),
		t('    reference: the intended return reference, such as GND on In1. target: an impedance or length target.'),
		t('row = load: one load on a power rail.'),
		cols('net', 'voltage', 'source_part', 'source_pin', 'load_part', 'load_pin', 'typical_current', 'peak_current', 'notes'),
		t('    net: the rail. voltage in V: 3.3 or 3V3. Currents: 150mA, or amps such as 0.15.'),
		t('row = layer: one copper layer.'),
		cols('layer', 'pours', 'splits', 'notes'),
		t('    pours: the nets poured on it. splits: intentional splits and star grounds.'),
		'',
		t('Leave a cell blank when it does not apply or is not known; a column the file leaves out is blank in every row.'),
		isEmpty(stored)
			? t('${1} has no board info yet, so the file becomes its board info.', project.name)
			: t('${1} already has board info (${2} nets, ${3} loads, ${4} layers). After the file is read you choose: Replace drops it and keeps only the file; Add keeps it and adds the rows of the file: a row for a net, a load (same rail and load part) or a layer that is already stored updates it, and its blank cells keep the stored values.', project.name, String(stored.nets.length), String(stored.loads.length), String(stored.layers.length)),
		t('The sample is a complete example to start from.'),
	].join('\n');
}

const TEMPLATE_NAME = 'board-info-template.csv';

/** Return Path > Load Board Info...: shows the CSV format, then reads a CSV into the open project's board info. */
export async function loadBoardInfo(): Promise<void> {
	const title = t('Load board info');
	await guarded(title, async () => {
		const fs = (eda as unknown as { sys_FileSystem?: { openReadFileDialog?: (ext?: string | string[], multi?: false) => Promise<File | undefined>; saveFile?: (data: Blob, name?: string) => Promise<void> } }).sys_FileSystem;
		if (!fs?.openReadFileDialog) {
			eda.sys_Dialog.showInformationMessage(t('This EasyEDA version cannot open a file for the extension.'), title);
			return;
		}
		const project = await currentProject();
		const stored = readBoardInfo(project);
		const help = dialogAsk();
		try {
			for (;;) {
				const what = await help.select(title, boardInfoCsvHelp(project, stored), [
					{ value: 'pick', label: t('Choose the CSV file…') },
					...(fs.saveFile ? [{ value: 'template', label: t('Save the sample CSV as a template (${1})', TEMPLATE_NAME) }] : []),
				], 'pick');
				if (!what)
					return;
				if (what === 'pick')
					break;
				await fs.saveFile!(new Blob([BOARD_INFO_SAMPLE_CSV], { type: 'text/csv' }), TEMPLATE_NAME);
				log(`board info: sample saved as ${TEMPLATE_NAME}`);
				toast(t('Sample saved as ${1}: edit it and load it here.', TEMPLATE_NAME));
			}
		}
		finally {
			help.close();
		}
		const file = await fs.openReadFileDialog(['csv']);
		if (!file)
			return;
		const { info, warnings } = parseBoardInfoCsv(await file.text());
		log(`board info: ${file.name}: ${info.nets.length} nets, ${info.loads.length} loads, ${info.layers.length} layers${warnings.length ? `; ${warnings.join('; ')}` : ''}`);
		if (isEmpty(info)) {
			eda.sys_Dialog.showInformationMessage([t('${1} has no net, load or layer rows.', file.name), ...warnings].join('\n'), title);
			return;
		}
		let next = info;
		if (!isEmpty(stored)) {
			const ask = dialogAsk();
			const how = await ask.select(title, t('${1} already has board info (${2} nets, ${3} loads, ${4} layers). Replace it with ${5}, or add the file to it? Rows in the file win over the same net, load or layer.', project.name, String(stored.nets.length), String(stored.loads.length), String(stored.layers.length), file.name), [
				{ value: 'replace', label: t('Replace the stored board info') },
				{ value: 'add', label: t('Add the file to it') },
			], 'replace').finally(ask.close);
			if (!how)
				return;
			if (how === 'add')
				next = mergeBoardInfo(stored, info);
		}
		await writeBoardInfo(project, next);
		eda.sys_Dialog.showInformationMessage([
			t('Board info of ${1}: ${2} nets, ${3} loads, ${4} layers. HF check and DC check prefill their questions from it, and what you change there is saved back.', project.name, String(next.nets.length), String(next.loads.length), String(next.layers.length)),
			...(warnings.length ? ['', t('Not read:'), ...warnings.slice(0, 12), ...(warnings.length > 12 ? [t('…and ${1} more (see Show Saved Log).', String(warnings.length - 12))] : [])] : []),
		].join('\n'), title);
	});
}

/** Return Path > Save Board Info...: saves the open project's board info as a CSV, to edit and load again. */
export async function saveBoardInfo(): Promise<void> {
	const title = t('Save board info');
	await guarded(title, async () => {
		const project = await currentProject();
		const info = readBoardInfo(project);
		const fs = (eda as unknown as { sys_FileSystem?: { saveFile?: (data: Blob, name?: string) => Promise<void> } }).sys_FileSystem;
		if (!fs?.saveFile) {
			eda.sys_Dialog.showInformationMessage(t('This EasyEDA version cannot save a file for the extension.'), title);
			return;
		}
		await fs.saveFile(new Blob([formatBoardInfoCsv(info)], { type: 'text/csv' }), fileName(project));
		log(`board info of ${project.name}: saved as ${fileName(project)} (${info.nets.length} nets, ${info.loads.length} loads, ${info.layers.length} layers)`);
		toast(isEmpty(info) ? t('No board info for ${1} yet: the file has the column headers only.', project.name) : t('Board info of ${1} saved as ${2}.', project.name, fileName(project)));
	});
}
