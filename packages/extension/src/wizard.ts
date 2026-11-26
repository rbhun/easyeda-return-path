// Wizard step 1 (design decisions D3, D7): confirm the power rails, pair each with its ground,
// pick the rail to solve, confirm its single active source (the other candidates are left out) and
// its loads, and optionally give load currents. Built on the system dialogs, so it needs no iframe.
import { pickMany } from './picker';
import { checkpoint, log } from './runner';
import { componentsOnNet, guessRails, loadsFor, parseCurrents, type Board, type DcSetupInput, type RailGuess } from '@returnpath/core';

export interface Option {
	value: string;
	label: string;
}

/** Dialog primitives; resolve undefined when the user cancels. */
export interface Ask {
	select: (title: string, prompt: string, options: Option[], dflt?: string) => Promise<string | undefined>;
	multi: (title: string, prompt: string, options: Option[], dflt: string[]) => Promise<string[] | undefined>;
	input: (title: string, prompt: string, value: string) => Promise<string | undefined>;
}

/** Logs and saves every question and answer, so a hang between dialogs shows in the saved log. */
export function loggedAsk(ask: Ask): Ask {
	const around = async <T>(prompt: string, q: () => Promise<T>): Promise<T> => {
		log(`wizard: ${prompt}`);
		await checkpoint();
		const a = await q();
		log(`wizard: answer ${a === undefined ? '(cancelled)' : JSON.stringify(a).slice(0, 200)}`);
		await checkpoint();
		return a;
	};
	return {
		select: (title, prompt, options, dflt) => around(`${prompt} (${options.length} options)`, () => ask.select(title, prompt, options, dflt)),
		multi: (title, prompt, options, dflt) => around(`${prompt} (${options.length} options)`, () => ask.multi(title, prompt, options, dflt)),
		input: (title, prompt, value) => around(prompt, () => ask.input(title, prompt, value)),
	};
}

const t = (key: string, ...args: string[]) => eda.sys_I18n.text(key, undefined, undefined, ...args);

/** Value of the select-all entry the system multi-select dialog gets in place of a select-all box. */
const ALL = '__returnpath_all__';

/**
 * Ask implemented with eda.sys_Dialog, except multi-choice questions, which use the picker window
 * when it connects. The dialogs report a choice through a callback only.
 */
export function dialogAsk(): Ask {
	const toApi = (o: Option[]) => o.map(x => ({ value: x.value, displayContent: x.label }));
	return {
		select: (title, prompt, options, dflt) => new Promise((resolve) => {
			eda.sys_Dialog.showSelectDialog(toApi(options), prompt, undefined, title, dflt, false, v => resolve(v || undefined));
		}),
		multi: async (title, prompt, options, dflt) => {
			const picked = await pickMany(title, prompt, options, dflt);
			if (picked !== null)
				return picked;
			const all = [{ value: ALL, label: t('Select all') }, ...options];
			return new Promise((resolve) => {
				eda.sys_Dialog.showSelectDialog(toApi(all), prompt, undefined, title, dflt, true, v => resolve(v?.includes(ALL) ? options.map(o => o.value) : v));
			});
		},
		input: (title, prompt, value) => new Promise((resolve) => {
			eda.sys_Dialog.showInputDialog(prompt, undefined, title, 'text', value, undefined, v => resolve(v == null ? undefined : String(v)));
		}),
	};
}

export interface WizardResult {
	input: DcSetupInput;
	/** Every confirmed rail with its ground. */
	pairs: Record<string, string>;
}

/** Runs the wizard; undefined when the user cancels or there is nothing to solve. */
export async function runDcWizard(board: Board, ask: Ask, preferredRail?: string, railGiven = false): Promise<WizardResult | undefined> {
	const title = t('DC return current');
	log('wizard: guessing rails…');
	await checkpoint();
	const guess = guessRails(board);
	log(`wizard: ${guess.rails.length} rails (${guess.rails.map(r => `${r.net}: source ${r.source?.designator ?? '?'}`).join(', ')}), grounds ${guess.grounds.join(', ') || '-'}`);
	const byNet = new Map(guess.rails.map(r => [r.net, r]));
	const allNets = [...new Set([...board.nets, ...board.pads.map(p => p.net)].filter(Boolean))].sort();

	// 1. Power rails.
	const railOptions = [
		...guess.rails.map(r => ({ value: r.net, label: `${r.net}${r.voltage !== undefined ? ` (${r.voltage} V)` : ''}: ${r.source ? t('source ${1}', r.source.designator) : t('source to confirm')}` })),
		...allNets.filter(n => !byNet.has(n) && !guess.grounds.includes(n)).map(n => ({ value: n, label: n })),
	];
	// A selected rail needs no confirming or picking: steps 1 and 2 are skipped.
	const given = preferredRail && !guess.grounds.includes(preferredRail) && allNets.includes(preferredRail) && (railGiven || byNet.has(preferredRail)) ? preferredRail : undefined;
	const asked = preferredRail && !byNet.has(preferredRail) && allNets.includes(preferredRail) ? [preferredRail] : [];
	const rails = given ? [given] : await ask.multi(title, t('Step 1/5: confirm the power rails (guessed from net names and pours).'), railOptions, [...guess.rails.map(r => r.net), ...asked]);
	if (!rails?.length)
		return undefined;
	if (given)
		log(`wizard: rail ${given} taken from the selection; steps 1 and 2 skipped`);

	// 2. Rail to solve.
	const grounds = guess.grounds.length ? guess.grounds : allNets.filter(n => !rails.includes(n));
	const pairs: Record<string, string> = {};
	for (const r of rails) {
		const dflt = byNet.get(r)?.ground ?? grounds[0];
		if (dflt)
			pairs[r] = dflt;
	}
	let rail = rails[0];
	if (rails.length > 1) {
		const picked = await ask.select(title, t('Step 2/5: rail to solve.'), rails.map(r => ({ value: r, label: pairs[r] ? `${r} / ${pairs[r]}` : r })), preferredRail && rails.includes(preferredRail) ? preferredRail : rails[0]);
		if (!picked)
			return undefined;
		rail = picked;
	}

	// 3. Its ground, asked only when there is a choice.
	if (grounds.length > 1 || !pairs[rail]) {
		const ground = await ask.select(title, t('Step 3/5: ground that carries the return current of ${1}.', rail), grounds.map(n => ({ value: n, label: n })), pairs[rail]);
		if (!ground)
			return undefined;
		pairs[rail] = ground;
	}
	const g: RailGuess = byNet.get(rail) ?? { net: rail, reason: 'name', candidates: [], rule: 'ask', loads: [], excluded: [], askReason: t('${1} was not guessed as a rail: pick its source.', rail) };

	// 4. Source: one active source; other candidates are left out of the solve (D7).
	const onRail = componentsOnNet(board, rail);
	const candIds = new Set(g.candidates.map(c => c.componentId));
	const sourceOptions = [
		...g.candidates.map(c => ({ value: c.componentId, label: `${c.designator}: ${c.reason}${c.componentId === g.source?.componentId ? ` (${t('guess')})` : ''}` })),
		...onRail.filter(c => !candIds.has(c.id)).map(c => ({ value: c.id, label: c.designator + (c.name ? ` (${c.name})` : '') })),
	];
	if (!sourceOptions.length)
		return undefined;
	const sourcePrompt = g.source
		? t('Step 4/5: active source of ${1}. Guessed ${2} (${3}).', rail, g.source.designator, g.source.reason)
		: t('Step 4/5: active source of ${1}. ${2}', rail, g.askReason ?? '');
	const sourceId = await ask.select(title, `${sourcePrompt} ${t('Other candidate sources are left out of the solve.')}`, sourceOptions, g.source?.componentId);
	if (!sourceId)
		return undefined;

	// 5. Loads (connectors can be loads or sources) and their currents.
	const guessLoads = loadsFor(board, rail, sourceId, [...candIds]).loads.map(l => l.componentId);
	const loadOptions = onRail.filter(c => c.id !== sourceId).map(c => ({
		value: c.id,
		label: c.designator + (c.name ? ` (${c.name})` : ''),
	}));
	const loads = await ask.multi(title, t('Step 5/5: loads on ${1}. Decaps carry no DC and other candidate sources are left out unless you tick them.', rail), loadOptions, guessLoads);
	if (!loads?.length)
		return undefined;
	const designator = (id: string) => board.components.find(c => c.id === id)?.designator ?? id;
	const currentText = await ask.input(title, t('Load currents, e.g. ${1}. Leave empty to split 1 A equally and show normalised density.', loads.slice(0, 2).map((id, i) => `${designator(id)}=${i ? '20mA' : '0.15'}`).join(', ')), '');
	if (currentText === undefined)
		return undefined;

	return {
		input: { rail, ground: pairs[rail], source: designator(sourceId), loads: loads.map(designator), currents: parseCurrents(currentText) },
		pairs,
	};
}
