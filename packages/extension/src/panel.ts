// The Return Path panel: a floating window that does not block the editor (iframe/index.html). It
// shows the last result and sends commands back through the extension's private message bus.
import extensionConfig from '../extension.json' with { type: 'json' };
import { overlayState, restyleOverlay } from './overlay';
import { log, toast } from './runner';
import { currentStyle, DEFAULT_STYLE, INNER_CYCLE, PALETTE, ROLE_LABELS, ROLES, saveStyle, type Role, type RoleStyle } from './style';

export const PANEL_ID = 'returnPathPanel';
export const PANEL_HTML = '/iframe/index.html';
export const TOPIC_COMMAND = 'returnpath.panel.command';
export const TOPIC_STATE = 'returnpath.panel.state';

export type PanelCommand =
	| { cmd: 'hello' }
	| { cmd: 'hf' | 'dc' | 'rerun' | 'toggle' | 'clear' | 'cancel' | 'log' }
	| { cmd: 'style'; style: Partial<Record<Role, Partial<RoleStyle>>> }
	| { cmd: 'resetStyle' };

export interface PanelHost {
	/** Runs a menu action by command name. */
	run: (cmd: 'hf' | 'dc' | 'rerun' | 'toggle' | 'clear' | 'cancel' | 'log') => Promise<void>;
	/** "DC 9V / GND, source J1" or "Show for Selected Net: CLK"; undefined when nothing ran yet. */
	lastRunLabel: () => string | undefined;
}

const t = (key: string, ...args: string[]) => eda.sys_I18n.text(key, undefined, undefined, ...args);

let host: PanelHost | undefined;
/** The bus the command subscription is on; a new editor API object needs a new subscription. */
let subscribed: unknown;
/** The page of the open panel has said hello on this bus, so results sent there are seen. */
let pageOn: unknown;
let busy: string | undefined;
let result: { title: string; lines: string[]; at: string } | undefined;

function bus() {
	return (eda as unknown as { sys_MessageBus?: typeof eda.sys_MessageBus }).sys_MessageBus;
}

/** Listens for panel commands; safe to call more than once. */
export function initPanel(h: PanelHost): void {
	host = h;
	const b = bus();
	if (!b || subscribed === b)
		return;
	try {
		b.subscribe(TOPIC_COMMAND, (m: PanelCommand) => void onCommand(m));
		subscribed = b;
	}
	catch (e) {
		log(`panel: message bus not available (${e instanceof Error ? e.message : String(e)})`, 'warn');
	}
}

async function onCommand(m: PanelCommand): Promise<void> {
	if (!m || typeof m !== 'object')
		return;
	if (m.cmd === 'hello') {
		if (pageOn !== bus())
			log('panel: page connected');
		pageOn = bus();
		publishState();
		return;
	}
	if (m.cmd === 'style' || m.cmd === 'resetStyle') {
		await saveStyle(m.cmd === 'resetStyle' ? 'reset' : m.style);
		await restyleOverlay();
		publishState();
		return;
	}
	if (busy && m.cmd !== 'cancel') {
		toast(t('Busy: ${1}', busy));
		return;
	}
	const labels: Record<string, string> = { hf: 'Show for Selected Net', dc: 'DC Return Current', rerun: 'Rerun', toggle: '', clear: '', cancel: '', log: '' };
	busy = labels[m.cmd] || undefined;
	publishState();
	try {
		await host?.run(m.cmd);
	}
	finally {
		busy = undefined;
		publishState();
	}
}

export function publishState(): void {
	if (!subscribed || subscribed !== bus())
		return;
	const style = currentStyle();
	try {
		bus()!.publish(TOPIC_STATE, {
			version: extensionConfig.version,
			busy,
			overlay: overlayState(),
			lastRun: host?.lastRunLabel(),
			result,
			roles: ROLES.map(r => ({ role: r, label: t(ROLE_LABELS[r]), colour: style[r].colour, width: style[r].width, isDefault: style[r].colour === DEFAULT_STYLE[r].colour && style[r].width === DEFAULT_STYLE[r].width })),
			palette: Object.keys(PALETTE),
			innerCycle: INNER_CYCLE,
		});
	}
	catch (e) {
		log(`panel: could not send state (${e instanceof Error ? e.message : String(e)})`, 'warn');
	}
}

/** Set when the user closes the panel, so analyses stop reopening it until Open Panel is used again. */
let closedByUser = false;

/** Opens the panel, or brings it back if it is open but hidden or minimised. False when EasyEDA refused. */
export async function openPanel(): Promise<boolean> {
	closedByUser = false;
	if (await panelIsOpen()) {
		await eda.sys_IFrame.showIFrame(PANEL_ID);
		publishState();
		return true;
	}
	let opened: unknown;
	pageOn = undefined;
	try {
		opened = await eda.sys_IFrame.openIFrame(PANEL_HTML, 400, 620, PANEL_ID, {
			title: t('Return Path'),
			minimizeButton: true,
			maximizeButton: false,
			grayscaleMask: false,
			buttonCallbackFn: (button) => {
				if (button === 'close')
					closedByUser = true;
			},
		});
	}
	catch (e) {
		log(`panel: openIFrame failed (${e instanceof Error ? e.message : String(e)})`, 'warn');
		return false;
	}
	log(`panel: openIFrame returned ${JSON.stringify(opened)}`, opened === false ? 'warn' : 'info');
	return opened !== false;
}

/** Opens the panel at the start of an analysis, unless the user closed it; failures are only logged. */
export async function autoOpenPanel(): Promise<void> {
	if (closedByUser || await panelIsOpen())
		return;
	await openPanel();
}

export async function panelIsOpen(): Promise<boolean> {
	try {
		return !!(await eda.sys_IFrame.isIFrameAlreadyExist(PANEL_ID));
	}
	catch {
		return false;
	}
}

/** Shows a result in the panel when it is open, else in a dialog. */
export async function report(title: string, lines: string[]): Promise<void> {
	result = { title, lines, at: new Date().toLocaleTimeString() };
	// A panel whose page never connected (no API access in the frame) would swallow the result.
	if (subscribed && subscribed === bus() && pageOn === bus() && await panelIsOpen()) {
		publishState();
		toast(t('${1}: done; the result is in the Return Path panel.', title));
		return;
	}
	eda.sys_Dialog.showInformationMessage(lines.join('\n'), title);
}
