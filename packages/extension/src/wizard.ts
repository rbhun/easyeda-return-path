// Wizard step 1 (design decisions D3, D7): confirm the power rails, pair each with its ground,
// pick the rail to solve, confirm its single active source (the other candidates are left out) and
// its loads, and optionally give load currents. The questions are asked in the wizard window, or in
// the system dialogs when that window cannot be used.
import { checkpoint, log } from './runner';
import { askInWindow, closeWizardWindow } from './wizard-window';
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
	/** One current per load (`150mA`, `0.02`), prefilled with `values`; resolves `U2=150mA, U3=0.02`, empty when every field is cleared. */
	currents: (title: string, prompt: string, loads: Option[], values: string[]) => Promise<string | undefined>;
	/** True when the user accepts with the `ok` button. */
	confirm: (title: string, prompt: string, ok: string) => Promise<boolean>;
	/** Ends the questions: closes the wizard window, if one is open. */
	close: () => Promise<void>;
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
		currents: (title, prompt, loads, values) => around(`${prompt} (${loads.length} loads)`, () => ask.currents(title, prompt, loads, values)),
		confirm: (title, prompt, ok) => around(prompt, () => ask.confirm(title, prompt, ok)),
		close: () => ask.close(),
	};
}

const t = (key: string, ...args: string[]) => eda.sys_I18n.text(key, undefined, undefined, ...args);

/** Value of the select-all entry the system multi-select dialog gets in place of a select-all box. */
const ALL = '__returnpath_all__';

/**
 * Ask in the wizard window, falling back to eda.sys_Dialog (which reports a choice through a
 * callback only) when the window cannot be used.
 */
export function dialogAsk(): Ask {
	const toApi = (o: Option[]) => o.map(x => ({ value: x.value, displayContent: x.label }));
	return {
		select: async (title, prompt, options, dflt) => {
			const v = await askInWindow('select', title, prompt, options, dflt ?? '');
			if (v !== null)
				return typeof v === 'string' && v ? v : undefined;
			return new Promise((resolve) => {
				eda.sys_Dialog.showSelectDialog(toApi(options), prompt, undefined, title, dflt, false, v => resolve(v || undefined));
			});
		},
		multi: async (title, prompt, options, dflt) => {
			const v = await askInWindow('multi', title, prompt, options, dflt);
			if (v !== null)
				return Array.isArray(v) ? v.filter(x => options.some(o => o.value === x)) : undefined;
			const all = [{ value: ALL, label: t('Select all') }, ...options];
			return new Promise((resolve) => {
				eda.sys_Dialog.showSelectDialog(toApi(all), prompt, undefined, title, dflt, true, v => resolve(v?.includes(ALL) ? options.map(o => o.value) : v));
			});
		},
		input: async (title, prompt, value) => {
			const v = await askInWindow('input', title, prompt, [], value);
			if (v !== null)
				return typeof v === 'string' ? v : undefined;
			return new Promise((resolve) => {
				eda.sys_Dialog.showInputDialog(prompt, undefined, title, 'text', value, undefined, v => resolve(v == null ? undefined : String(v)));
			});
		},
		currents: async (title, prompt, loads, values) => {
			const v = await askInWindow('currents', title, prompt, loads, values);
			if (v !== null)
				return typeof v === 'string' ? v : undefined;
			const text = currentsText(loads.map(l => l.value), values);
			return new Promise((resolve) => {
				eda.sys_Dialog.showInputDialog(prompt, undefined, title, 'text', text, undefined, v => resolve(v == null ? undefined : String(v)));
			});
		},
		confirm: async (title, prompt, ok) => {
			const v = await askInWindow('confirm', title, prompt, [], '', ok);
			if (v !== null)
				return v === true;
			return new Promise((resolve) => {
				eda.sys_Dialog.showConfirmationMessage(prompt, title, ok, t('Cancel'), clicked => resolve(!!clicked));
			});
		},
		close: closeWizardWindow,
	};
}

/** `U2=150mA, U3=0.02` from designators and their current fields; empty fields are left out. */
export function currentsText(designators: string[], values: string[]): string {
	return designators.map((d, i) => [d, (values[i] ?? '').replace(/\s+/g, '')] as const).filter(([, v]) => v).map(([d, v]) => `${d}=${v}`).join(', ');
}

/** Current a load is prefilled with when no earlier run gave it one, A. */
export const DEFAULT_LOAD_CURRENT = 0.1;

function currentField(a: number): string {
	return a < 1 ? `${+(a * 1000).toFixed(3)}mA` : `${+a.toFixed(4)}`;
}

export interface WizardResult {
	input: DcSetupInput;
	/** Every confirmed rail with its ground. */
	pairs: Record<string, string>;
}

/** Runs the wizard; undefined when the user cancels or there is nothing to solve. */
/** `previous`: the last DC run's input; its load currents prefill the currents page when the same rail is solved. */
export async function runDcWizard(board: Board, ask: Ask, preferredRail?: string, railGiven = false, previous?: DcSetupInput): Promise<WizardResult | undefined> {
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
	const known = previous?.rail === rail ? previous.currents ?? {} : {};
	const loadRows = loads.map(id => ({ value: designator(id), label: loadOptions.find(o => o.value === id)?.label ?? designator(id) }));
	const values = loadRows.map(o => currentField(known[o.value] ?? DEFAULT_LOAD_CURRENT));
	const currentText = await ask.currents(title, t('Total current of the rail, shared between the loads with the sliders; a load\'s current can also be typed (150mA, or 0.15 for amps). Prefilled with ${1} per load, or with the last run\'s values on this rail. Clear the total to split 1 A equally and show normalised density.', currentField(DEFAULT_LOAD_CURRENT)), loadRows, values);
	if (currentText === undefined)
		return undefined;

	return {
		input: { rail, ground: pairs[rail], source: designator(sourceId), loads: loads.map(designator), currents: parseCurrents(currentText) },
		pairs,
	};
}
