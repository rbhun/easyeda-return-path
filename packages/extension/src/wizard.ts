// Wizard step 1 (design decisions D3, D7): confirm the power rails, pair each with its ground,
// pick the rail to solve, confirm its single active source (the other candidates are left out) and
// its loads, and optionally give load currents. The questions are asked in the wizard window, or in
// the system dialogs when that window cannot be used.
import { checkpoint, log } from './runner';
import { askInWindow, BACK, closeWizardWindow, type WizardKind } from './wizard-window';
import { componentsOnNet, guessRails, loadsFor, parseCurrents, parseHz, type Board, type DcSetupInput, type RailGuess } from '@returnpath/core';
import { t } from './i18n';

export interface Option {
	value: string;
	label: string;
}

/** A net to pick, with the speeds offered for it (value: Hz) and the one preselected. */
export interface NetOption extends Option {
	speeds: Option[];
	speed: string;
}

/** Dialog primitives; resolve undefined when the user cancels, and throw GoBack when the user presses Back. */
export interface Ask {
	select: (title: string, prompt: string, options: Option[], dflt?: string) => Promise<string | undefined>;
	multi: (title: string, prompt: string, options: Option[], dflt: string[]) => Promise<string[] | undefined>;
	input: (title: string, prompt: string, value: string) => Promise<string | undefined>;
	/** One current per load (`150mA`, `0.02`), prefilled with `values`; resolves `U2=150mA, U3=0.02`, empty when every field is cleared. */
	currents: (title: string, prompt: string, loads: Option[], values: string[]) => Promise<string | undefined>;
	/** A net and its speed in Hz, on one page in the wizard window. */
	netSpeed: (title: string, prompt: string, nets: NetOption[], dflt: string) => Promise<{ net: string; hz: number } | undefined>;
	/** True when the user accepts with the `ok` button. */
	confirm: (title: string, prompt: string, ok: string) => Promise<boolean>;
	/** Ends the questions: closes the wizard window, if one is open. */
	close: () => Promise<void>;
	/** Offers Back on the next question (the wizard window only). */
	back?: (enabled: boolean) => void;
}

/** Thrown by a question when the user pressed Back. */
export class GoBack extends Error {
	constructor() {
		super('back');
	}
}

/** Logs and saves every question and answer, so a hang between dialogs shows in the saved log. */
export function loggedAsk(ask: Ask): Ask {
	const around = async <T>(prompt: string, q: () => Promise<T>): Promise<T> => {
		log(`wizard: ${prompt}`);
		await checkpoint();
		let a: T;
		try {
			a = await q();
		}
		catch (e) {
			if (e instanceof GoBack)
				log('wizard: back');
			throw e;
		}
		log(`wizard: answer ${a === undefined ? '(cancelled)' : JSON.stringify(a).slice(0, 200)}`);
		await checkpoint();
		return a;
	};
	return {
		select: (title, prompt, options, dflt) => around(`${prompt} (${options.length} options)`, () => ask.select(title, prompt, options, dflt)),
		multi: (title, prompt, options, dflt) => around(`${prompt} (${options.length} options)`, () => ask.multi(title, prompt, options, dflt)),
		input: (title, prompt, value) => around(prompt, () => ask.input(title, prompt, value)),
		currents: (title, prompt, loads, values) => around(`${prompt} (${loads.length} loads)`, () => ask.currents(title, prompt, loads, values)),
		netSpeed: (title, prompt, nets, dflt) => around(`${prompt} (${nets.length} nets)`, () => ask.netSpeed(title, prompt, nets, dflt)),
		confirm: (title, prompt, ok) => around(prompt, () => ask.confirm(title, prompt, ok)),
		close: () => ask.close(),
		back: ask.back,
	};
}

/**
 * Runs a series of questions with Back: on Back the flow starts again, earlier answers are replayed
 * without asking, and the question before is asked again with the answer it had. The flow must
 * ask the same questions for the same answers.
 */
export async function withBack<T>(ask: Ask, flow: (ask: Ask) => Promise<T>): Promise<T> {
	const answers: unknown[] = [];
	const undone: unknown[] = [];
	for (;;) {
		let i = 0;
		const step = async <R>(show: (prev: unknown) => Promise<R>): Promise<R> => {
			const k = i++;
			if (k < answers.length)
				return answers[k] as R;
			ask.back?.(k > 0);
			try {
				const v = await show(undone[k]);
				answers.push(v);
				return v;
			}
			catch (e) {
				if (e instanceof GoBack)
					undone[k - 1] = answers.pop();
				throw e;
			}
			finally {
				ask.back?.(false);
			}
		};
		const replay: Ask = {
			select: (title, prompt, options, dflt) => step(prev => ask.select(title, prompt, options, typeof prev === 'string' && options.some(o => o.value === prev) ? prev : dflt)),
			multi: (title, prompt, options, dflt) => step(prev => ask.multi(title, prompt, options, Array.isArray(prev) ? prev : dflt)),
			input: (title, prompt, value) => step(prev => ask.input(title, prompt, typeof prev === 'string' ? prev : value)),
			currents: (title, prompt, loads, values) => step(() => ask.currents(title, prompt, loads, values)),
			netSpeed: (title, prompt, nets, dflt) => step((prev) => {
				const p = prev as { net: string; hz: number } | undefined;
				const known = p && nets.find(n => n.value === p.net);
				return ask.netSpeed(title, prompt, known ? nets.map(n => (n === known ? { ...n, speed: String(p.hz) } : n)) : nets, known ? p.net : dflt);
			}),
			confirm: (title, prompt, ok) => step(() => ask.confirm(title, prompt, ok)),
			close: () => ask.close(),
		};
		try {
			return await flow(replay);
		}
		catch (e) {
			if (!(e instanceof GoBack))
				throw e;
		}
	}
}

/** Value of the select-all entry the system multi-select dialog gets in place of a select-all box. */
const ALL = '__returnpath_all__';

/**
 * Ask in the wizard window, falling back to eda.sys_Dialog (which reports a choice through a
 * callback only) when the window cannot be used.
 */
export function dialogAsk(): Ask {
	const toApi = (o: Option[]) => o.map(x => ({ value: x.value, displayContent: x.label }));
	let back = false;
	const inWindow = async (kind: WizardKind, title: string, prompt: string, options: Option[], value: string | string[], ok?: string) => {
		const v = await askInWindow(kind, title, prompt, options, value, ok, back);
		if (v === BACK)
			throw new GoBack();
		return v;
	};
	const ask: Ask = {
		select: async (title, prompt, options, dflt) => {
			const v = await inWindow('select', title, prompt, options, dflt ?? '');
			if (v !== null)
				return typeof v === 'string' && v ? v : undefined;
			return new Promise((resolve) => {
				eda.sys_Dialog.showSelectDialog(toApi(options), prompt, undefined, title, dflt, false, v => resolve(v || undefined));
			});
		},
		multi: async (title, prompt, options, dflt) => {
			const v = await inWindow('multi', title, prompt, options, dflt);
			if (v !== null)
				return Array.isArray(v) ? v.filter(x => options.some(o => o.value === x)) : undefined;
			const all = [{ value: ALL, label: t('Select all') }, ...options];
			return new Promise((resolve) => {
				eda.sys_Dialog.showSelectDialog(toApi(all), prompt, undefined, title, dflt, true, v => resolve(v?.includes(ALL) ? options.map(o => o.value) : v));
			});
		},
		input: async (title, prompt, value) => {
			const v = await inWindow('input', title, prompt, [], value);
			if (v !== null)
				return typeof v === 'string' ? v : undefined;
			return new Promise((resolve) => {
				eda.sys_Dialog.showInputDialog(prompt, undefined, title, 'text', value, undefined, v => resolve(v == null ? undefined : String(v)));
			});
		},
		currents: async (title, prompt, loads, values) => {
			const v = await inWindow('currents', title, prompt, loads, values);
			if (v !== null)
				return typeof v === 'string' ? v : undefined;
			const text = currentsText(loads.map(l => l.value), values);
			return new Promise((resolve) => {
				eda.sys_Dialog.showInputDialog(prompt, undefined, title, 'text', text, undefined, v => resolve(v == null ? undefined : String(v)));
			});
		},
		netSpeed: async (title, prompt, nets, dflt) => {
			const v = await inWindow('nets', title, prompt, nets, dflt);
			if (v !== null) {
				const [net, speed] = Array.isArray(v) ? v : [];
				const hz = speed === undefined ? undefined : Number(speed) || parseHz(speed);
				return net && hz ? { net, hz } : undefined;
			}
			// System dialogs: the net, then its speed.
			const net = await ask.select(title, prompt, nets, dflt);
			const picked = nets.find(n => n.value === net);
			if (!picked)
				return undefined;
			const OTHER = 'other';
			const sp = await ask.select(title, t('Speed of ${1}: the bit rate or clock frequency. It sets the edge time, which decides whether the trace acts as a transmission line.', picked.value), [...picked.speeds, { value: OTHER, label: t('Other speed…') }], picked.speed);
			if (sp !== OTHER)
				return sp ? { net: picked.value, hz: Number(sp) } : undefined;
			for (let text = ''; ;) {
				const typed = await ask.input(title, t('Speed of ${1}, for example 400k, 12 MHz or 115200.', picked.value), text);
				if (typed === undefined)
					return undefined;
				const hz = parseHz(typed);
				if (hz)
					return { net: picked.value, hz };
				text = typed;
			}
		},
		confirm: async (title, prompt, ok) => {
			const v = await inWindow('confirm', title, prompt, [], '', ok);
			if (v !== null)
				return v === true;
			return new Promise((resolve) => {
				eda.sys_Dialog.showConfirmationMessage(prompt, title, ok, t('Cancel'), clicked => resolve(!!clicked));
			});
		},
		close: closeWizardWindow,
		back: (enabled) => {
			back = enabled;
		},
	};
	return ask;
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
