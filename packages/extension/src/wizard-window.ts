// The wizard window (iframe/wizard.html): every wizard question (pick one, pick several, type a value,
// confirm) on the same page layout, with a step badge, a list that scrolls on its own, and OK/Cancel
// below it. It stays open from the first question of an analysis until close(). When its page does
// not connect, the questions go to the system dialogs instead.
import { log } from './runner';
import type { Option } from './wizard';

export const WIZARD_ID = 'returnPathWizard';
export const WIZARD_HTML = '/iframe/wizard.html';
export const TOPIC_WIZARD_ASK = 'returnpath.wizard.ask';
export const TOPIC_WIZARD_REPLY = 'returnpath.wizard.reply';

export type WizardKind = 'select' | 'multi' | 'input' | 'confirm';

export type WizardReply =
	| { cmd: 'hello' }
	| { cmd: 'answer'; id: string; value: string | string[] | boolean }
	| { cmd: 'cancel'; id: string };

export interface WizardQuestion {
	/** Unique across extension instances, which all hear the page's replies. */
	id: string;
	kind: WizardKind;
	title: string;
	prompt: string;
	options: Option[];
	/** Chosen value(s) of select and multi, the text of input. */
	value: string | string[];
	/** Label of the OK button. */
	ok: string;
	labels: { all: string; cancel: string; count: string; step: string };
}

/** How long the page has to say hello before the system dialogs are used instead. */
export const wizardTimeouts = { helloMs: 4000 };

const t = (key: string, ...args: string[]) => eda.sys_I18n.text(key, undefined, undefined, ...args);

const me = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let nextId = 1;
/** The bus on which the page failed to connect, so later questions there go straight to the system dialogs. */
let failedOn: unknown;
/** The bus the reply subscription is on; a new editor API object needs a new subscription. */
let subscribed: unknown;
let onReply: ((m: WizardReply) => void) | undefined;
/** The open window: 'ready' once its page said hello, 'closed' when the user closed it first, 'failed' when it could not be used. */
let open: Promise<'ready' | 'closed' | 'failed'> | undefined;
/** Settles the question on screen when the window closes under it. */
let abandon: (() => void) | undefined;
let markClosed: (() => void) | undefined;

function bus() {
	return (eda as unknown as { sys_MessageBus?: typeof eda.sys_MessageBus }).sys_MessageBus;
}

function openWindow(b: NonNullable<ReturnType<typeof bus>>): Promise<'ready' | 'closed' | 'failed'> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (state: 'ready' | 'closed' | 'failed') => {
			if (settled)
				return;
			settled = true;
			clearTimeout(timer);
			if (state === 'failed') {
				failedOn = b;
				open = undefined;
				void eda.sys_IFrame.closeIFrame(WIZARD_ID).catch(() => {});
			}
			resolve(state);
		};
		markClosed = () => {
			open = undefined;
			settle('closed');
			abandon?.();
		};
		onReply = (m) => {
			if (m?.cmd === 'hello')
				settle('ready');
		};
		const timer = setTimeout(() => {
			log(`wizard window: no answer from its page within ${wizardTimeouts.helloMs} ms; using the system dialogs from now on`, 'warn');
			settle('failed');
		}, wizardTimeouts.helloMs);
		const show = async () => {
			if (await eda.sys_IFrame.isIFrameAlreadyExist?.(WIZARD_ID))
				await eda.sys_IFrame.closeIFrame(WIZARD_ID);
			return eda.sys_IFrame.openIFrame(WIZARD_HTML, 460, 440, WIZARD_ID, {
				title: t('Return Path'),
				minimizeButton: false,
				maximizeButton: false,
				grayscaleMask: true,
				buttonCallbackFn: (button) => {
					if (button === 'close')
						markClosed?.();
				},
			});
		};
		show().then((opened) => {
			if (opened === false) {
				log('wizard window: openIFrame refused; using the system dialogs', 'warn');
				settle('failed');
			}
		}, (e) => {
			log(`wizard window: openIFrame failed (${e instanceof Error ? e.message : String(e)}); using the system dialogs`, 'warn');
			settle('failed');
		});
	});
}

/**
 * Asks in the wizard window, opening it for the first question. Resolves the answer, undefined when
 * the user cancels or closes the window, or null when the window could not be used.
 */
export async function askInWindow(kind: WizardKind, title: string, prompt: string, options: Option[], value: string | string[], ok?: string): Promise<string | string[] | boolean | undefined | null> {
	const b = bus();
	if (!b || failedOn === b || !eda.sys_IFrame?.openIFrame)
		return null;
	if (subscribed !== b) {
		try {
			b.subscribe(TOPIC_WIZARD_REPLY, (m: WizardReply) => onReply?.(m));
			subscribed = b;
			open = undefined;
		}
		catch (e) {
			log(`wizard window: message bus not available (${e instanceof Error ? e.message : String(e)})`, 'warn');
			failedOn = b;
			return null;
		}
	}
	open ??= openWindow(b);
	const state = await open;
	if (state !== 'ready')
		return state === 'closed' ? undefined : null;
	const q: WizardQuestion = {
		id: `${me}-${nextId++}`,
		kind,
		title,
		prompt,
		options,
		value,
		ok: ok ?? t('OK'),
		labels: { all: t('Select all'), cancel: t('Cancel'), count: t('${1} of ${2} selected'), step: t('Step ${1} of ${2}') },
	};
	return new Promise((resolve) => {
		const finish = (v: string | string[] | boolean | undefined) => {
			onReply = undefined;
			abandon = undefined;
			resolve(v);
		};
		abandon = () => finish(undefined);
		onReply = (m) => {
			if (!m || typeof m !== 'object' || m.cmd === 'hello' || m.id !== q.id)
				return;
			finish(m.cmd === 'answer' ? m.value : undefined);
		};
		b.publish(TOPIC_WIZARD_ASK, q);
	});
}

/** Closes the wizard window, if it is open. */
export async function closeWizardWindow(): Promise<void> {
	if (!open)
		return;
	open = undefined;
	markClosed = undefined;
	try {
		await eda.sys_IFrame.closeIFrame(WIZARD_ID);
	}
	catch {}
}
