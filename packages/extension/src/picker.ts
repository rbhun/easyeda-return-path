// Multi-choice picker in our own window (iframe/pick.html): a select-all box and a scrolling list
// above fixed OK/Cancel buttons, which the system select dialog cannot give. When the window's page
// does not connect, the caller falls back to the system dialog.
import { log } from './runner';
import type { Option } from './wizard';

export const PICKER_ID = 'returnPathPicker';
export const PICKER_HTML = '/iframe/pick.html';
export const TOPIC_PICK_ASK = 'returnpath.picker.ask';
export const TOPIC_PICK_REPLY = 'returnpath.picker.reply';

export type PickerReply =
	| { cmd: 'hello' }
	| { cmd: 'answer'; id: string; values: string[] }
	| { cmd: 'cancel'; id: string };

export interface PickerQuestion {
	/** Unique across extension instances, which all hear the page's replies. */
	id: string;
	title: string;
	prompt: string;
	options: Option[];
	selected: string[];
	labels: { all: string; ok: string; cancel: string; count: string };
}

/** How long the page has to say hello before the system dialog is used instead. */
export const pickerTimeouts = { helloMs: 4000 };

const t = (key: string, ...args: string[]) => eda.sys_I18n.text(key, undefined, undefined, ...args);

/** The bus on which the page failed to connect, so later questions there go straight to the system dialog. */
let failedOn: unknown;
const me = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let nextId = 1;
let handler: ((m: PickerReply) => void) | undefined;
/** The bus the reply subscription is on; a new editor API object needs a new subscription. */
let subscribed: unknown;

function bus() {
	return (eda as unknown as { sys_MessageBus?: typeof eda.sys_MessageBus }).sys_MessageBus;
}

/**
 * Asks in the picker window. Resolves the chosen values, undefined when the user cancels, or null
 * when the window could not be used.
 */
export async function pickMany(title: string, prompt: string, options: Option[], selected: string[]): Promise<string[] | undefined | null> {
	const b = bus();
	if (!b || failedOn === b || !eda.sys_IFrame?.openIFrame)
		return null;
	if (subscribed !== b) {
		try {
			b.subscribe(TOPIC_PICK_REPLY, (m: PickerReply) => handler?.(m));
			subscribed = b;
		}
		catch (e) {
			log(`picker: message bus not available (${e instanceof Error ? e.message : String(e)})`, 'warn');
			failedOn = b;
			return null;
		}
	}
	const question: PickerQuestion = {
		id: `${me}-${nextId++}`,
		title,
		prompt,
		options,
		selected,
		labels: { all: t('Select all'), ok: t('OK'), cancel: t('Cancel'), count: t('${1} of ${2} selected') },
	};
	return new Promise((resolve) => {
		let connected = false;
		let done = false;
		const finish = (v: string[] | undefined | null) => {
			if (done)
				return;
			done = true;
			handler = undefined;
			clearTimeout(timer);
			void eda.sys_IFrame.closeIFrame(PICKER_ID).catch(() => {});
			resolve(v);
		};
		handler = (m) => {
			if (!m || typeof m !== 'object')
				return;
			if (m.cmd === 'hello') {
				connected = true;
				b.publish(TOPIC_PICK_ASK, question);
			}
			else if (m.id === question.id) {
				finish(m.cmd === 'answer' ? m.values.filter(v => options.some(o => o.value === v)) : undefined);
			}
		};
		const timer = setTimeout(() => {
			if (connected)
				return;
			log(`picker: the window did not connect within ${pickerTimeouts.helloMs} ms; using the system dialog from now on`, 'warn');
			failedOn = b;
			finish(null);
		}, pickerTimeouts.helloMs);
		const rows = Math.min(options.length, 14);
		eda.sys_IFrame.openIFrame(PICKER_HTML, 420, 150 + 26 * rows + Math.min(60, Math.ceil(prompt.length / 55) * 16), PICKER_ID, {
			title,
			minimizeButton: false,
			maximizeButton: false,
			grayscaleMask: true,
			buttonCallbackFn: (button) => {
				if (button === 'close')
					finish(connected ? undefined : null);
			},
		}).then((opened) => {
			if (opened === false) {
				log('picker: openIFrame refused; using the system dialog', 'warn');
				failedOn = b;
				finish(null);
			}
		}, (e) => {
			log(`picker: openIFrame failed (${e instanceof Error ? e.message : String(e)}); using the system dialog`, 'warn');
			failedOn = b;
			finish(null);
		});
	});
}
