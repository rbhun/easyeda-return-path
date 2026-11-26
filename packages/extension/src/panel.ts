// The Return Path panel: a floating window that does not block the editor (iframe/index.html). It
// shows the last result and sends commands back through the extension's private message bus.
//
// EasyEDA can run menu actions and the panel's commands in separate instances of this extension,
// which share neither memory nor a fresh view of the stored settings. The instances therefore keep a
// shared state (result, last run, overlay, busy, style) in step over the bus, and exactly one
// instance acts on each command: the panel's owner, which hands overlay commands to the instance
// that drew the overlay and Cancel to the one that is running.
//
// An instance may also be gone before the panel opens (EasyEDA may start one per menu action). So each
// result and overlay change is also pushed to a mailbox topic, where the bus keeps it until it is
// pulled. The panel's page pulls the mailbox and hands each snapshot to the panel's owner, which takes
// over the result, the last run and the overlay drawing.
import extensionConfig from '../extension.json' with { type: 'json' };
import { adoptOverlay, forgetOverlay, leftoverOverlay, overlayGroups, overlayState, restyleOverlay, type MarkerGroup } from './overlay';
import { log, toast } from './runner';
import { currentStyle, DEFAULT_STYLE, INNER_CYCLE, PALETTE, ROLE_LABELS, ROLE_USE, ROLES, saveStyle, setSharedStyle, type Role, type RoleStyle } from './style';
import { t } from './i18n';

export const PANEL_ID = 'returnPathPanel';
export const PANEL_HTML = '/iframe/index.html';
export const TOPIC_COMMAND = 'returnpath.panel.command';
export const TOPIC_STATE = 'returnpath.panel.state';
export const TOPIC_SYNC = 'returnpath.panel.sync';
export const TOPIC_MAILBOX = 'returnpath.panel.mailbox';

/** What the mailbox carries: the shared fields that outlive an instance, and the overlay drawing. */
export interface Snapshot { from: string; fields: Stamped; overlay?: { groups: MarkerGroup[]; visible: boolean } }

type RunCmd = 'hf' | 'dc' | 'trace' | 'rerun' | 'toggle' | 'clear' | 'cancel';
export type PanelCommand = { to?: string } & (
	| { cmd: 'hello' }
	| { cmd: RunCmd }
	| { cmd: 'restyle' }
	| { cmd: 'style'; style: Partial<Record<Role, Partial<RoleStyle>>> }
	| { cmd: 'resetStyle' }
	| { cmd: 'adopt'; snapshot: Snapshot }
);

export interface PanelHost {
	/** Runs a panel action by command name. */
	run: (cmd: RunCmd) => Promise<void>;
	/** "DC 9V / GND, source J1" or "HF check: CLK"; undefined when nothing ran yet. */
	lastRunLabel: () => string | undefined;
	/** Kind of the last run, so the panel lists only the line kinds it draws. */
	lastRunKind?: () => 'hf' | 'dc' | undefined;
}

interface Shared {
	result: { title: string; lines: string[]; at: string } | undefined;
	lastRun: unknown;
	overlay: 'none' | 'shown' | 'hidden';
	overlayOwner: string | undefined;
	busy: string | undefined;
	busyOwner: string | undefined;
	panelOwner: string | undefined;
	/** The open panel's page has said hello, so results sent there are seen. */
	pageConnected: boolean;
	/** The user closed the panel; analyses do not reopen it until Open Panel is used. */
	closedByUser: boolean;
	style: Record<Role, RoleStyle> | undefined;
	/** One pad or part selected on the canvas, so Rerun becomes a run for it alone. */
	selection: PanelSelection | undefined;
}
export interface PanelSelection {
	kind: 'pad' | 'component';
	/** "U3" or "U3 pad 4". */
	label: string;
}
type Field = keyof Shared;
export type Stamped = { [K in Field]?: { v: Shared[K]; at: number } };
/** Fields a snapshot hands on; who owns the panel or is running belongs to live instances only. */
const LASTING: Field[] = ['result', 'lastRun', 'overlay', 'overlayOwner', 'style'];
type SyncMessage = { from: string; fields?: Stamped; request?: boolean };

/** This instance. */
const me = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let host: PanelHost | undefined;
/** The bus the subscriptions are on; a new editor API object needs new subscriptions. */
let subscribed: unknown;
const shared: Shared = { result: undefined, lastRun: undefined, overlay: 'none', overlayOwner: undefined, busy: undefined, busyOwner: undefined, panelOwner: undefined, pageConnected: false, closedByUser: false, style: undefined, selection: undefined };
const stampOf: Partial<Record<Field, number>> = {};
let clock = 0;
/** Strictly increasing, so two changes in one millisecond keep their order. */
const now = () => (clock = Math.max(clock + 1, Date.now()));

function bus() {
	return (eda as unknown as { sys_MessageBus?: typeof eda.sys_MessageBus }).sys_MessageBus;
}

function publish(topic: string, message: unknown): void {
	if (!subscribed || subscribed !== bus())
		return;
	try {
		bus()!.publish(topic, message);
	}
	catch (e) {
		log(`panel: could not publish on ${topic} (${e instanceof Error ? e.message : String(e)})`, 'warn');
	}
}

function apply(fields: Stamped): void {
	for (const [k, s] of Object.entries(fields) as [Field, { v: never; at: number }][]) {
		if (!s || (stampOf[k] ?? -1) >= s.at)
			continue;
		stampOf[k] = s.at;
		(shared as unknown as Record<Field, unknown>)[k] = s.v;
		clock = Math.max(clock, s.at);
		if (k === 'style')
			setSharedStyle(s.v);
		if (k === 'overlayOwner' && s.v !== me)
			forgetOverlay();
	}
}

/** Changes shared fields here and in every other instance. */
function share(patch: Partial<Shared>): void {
	const fields: Stamped = {};
	const at = now();
	for (const [k, v] of Object.entries(patch) as [Field, never][])
		(fields as Record<Field, unknown>)[k] = { v, at };
	apply(fields);
	publish(TOPIC_SYNC, { from: me, fields } satisfies SyncMessage);
}

/** Pushes what should outlive this instance to the mailbox. */
function pushSnapshot(): void {
	const fields: Stamped = {};
	for (const k of LASTING) {
		if (stampOf[k] !== undefined)
			(fields as Record<Field, unknown>)[k] = { v: shared[k], at: stampOf[k] };
	}
	const mine = shared.overlayOwner === me ? overlayGroups() : undefined;
	const message: Snapshot = { from: me, fields, ...(mine ? { overlay: mine } : {}) };
	const b = bus();
	if (!b || typeof b.push !== 'function')
		return;
	try {
		b.push(TOPIC_MAILBOX, message);
	}
	catch (e) {
		log(`panel: could not push to the mailbox (${e instanceof Error ? e.message : String(e)})`, 'warn');
	}
}

/** Takes over a snapshot pulled from the mailbox: newer fields win, and its overlay drawing becomes this instance's. */
function adopt(snap: Snapshot): void {
	if (!snap || typeof snap !== 'object' || !snap.fields)
		return;
	const fields: Stamped = {};
	for (const k of LASTING) {
		if (snap.fields[k])
			(fields as Record<Field, unknown>)[k] = snap.fields[k];
	}
	const newerOverlay = (snap.fields.overlayOwner?.at ?? -1) > (stampOf.overlayOwner ?? -1);
	apply(fields);
	if (newerOverlay && snap.from !== me) {
		if (snap.overlay?.groups?.length && shared.overlay !== 'none') {
			adoptOverlay(snap.overlay.groups, snap.overlay.visible);
			share({ overlay: snap.overlay.visible ? 'shown' : 'hidden', overlayOwner: me });
		}
		else if (shared.overlay === 'none') {
			share({ overlayOwner: undefined });
		}
		log(`panel: took over the result and overlay of another instance (${snap.overlay?.groups?.length ?? 0} marker groups)`);
	}
}

function snapshot(): Stamped {
	const out: Stamped = {};
	for (const k of Object.keys(stampOf) as Field[])
		(out as Record<Field, unknown>)[k] = { v: shared[k], at: stampOf[k] };
	return out;
}

/** How long a new instance waits for the others to send their shared state. */
export const panelTimeouts = { syncMs: 300 };
let synced: Promise<void> = Promise.resolve();
let markSynced = () => {};

/** Resolves once another instance has sent its shared state, or after panelTimeouts.syncMs when none answers. */
export function panelReady(): Promise<void> {
	return synced;
}

/** Listens for panel commands and shared state; safe to call more than once. */
export function initPanel(h: PanelHost): void {
	host = h;
	const b = bus();
	if (!b || subscribed === b)
		return;
	// A new editor API object means a new editor session: nothing shared earlier applies.
	Object.assign(shared, { result: undefined, lastRun: undefined, overlay: 'none', overlayOwner: undefined, busy: undefined, busyOwner: undefined, panelOwner: undefined, pageConnected: false, closedByUser: false, style: undefined, selection: undefined });
	for (const k of Object.keys(stampOf) as Field[])
		delete stampOf[k];
	setSharedStyle(undefined);
	synced = new Promise((resolve) => {
		const timer = setTimeout(resolve, panelTimeouts.syncMs);
		markSynced = () => {
			clearTimeout(timer);
			resolve();
		};
	});
	try {
		b.subscribe(TOPIC_COMMAND, (m: PanelCommand) => void onCommand(m));
		b.subscribe(TOPIC_SYNC, (m: SyncMessage) => onSync(m));
		subscribed = b;
	}
	catch (e) {
		log(`panel: message bus not available (${e instanceof Error ? e.message : String(e)})`, 'warn');
		return;
	}
	publish(TOPIC_SYNC, { from: me, request: true } satisfies SyncMessage);
	watchSelection();
	const left = leftoverOverlay();
	if (left)
		log(`overlay: markers drawn by v${left} may still be on the canvas; Clear or Hide removes them`);
}

interface MouseProp {
	primitiveType?: string;
	designator?: string;
	parentComponentDesignator?: string;
	padNumber?: string;
}

/** What the panel calls a single selected pad or part; undefined for anything else. */
export function selectionOf(props: MouseProp[] | undefined): PanelSelection | undefined {
	if (!Array.isArray(props) || props.length !== 1)
		return undefined;
	const p = props[0];
	if ((p.primitiveType === 'ComponentPad' || p.primitiveType === 'Pad') && p.parentComponentDesignator)
		return { kind: 'pad', label: p.padNumber ? `${p.parentComponentDesignator} pad ${p.padNumber}` : p.parentComponentDesignator };
	if (p.primitiveType === 'Component' && p.designator)
		return { kind: 'component', label: p.designator };
	return undefined;
}

/** Follows the canvas selection, so the panel can offer a run for a selected pad or part. */
function watchSelection(): void {
	const events = (eda as unknown as { pcb_Event?: { addMouseEventListener?: (id: string, type: string, cb: (type: string, props: MouseProp[]) => void, once?: boolean) => unknown } }).pcb_Event;
	if (typeof events?.addMouseEventListener !== 'function')
		return;
	try {
		events.addMouseEventListener('returnpath-selection', 'all', (type, props) => {
			if (type !== 'selected' && type !== 'clearSelected')
				return;
			const next = type === 'selected' ? selectionOf(props) : undefined;
			if (next?.label === shared.selection?.label && next?.kind === shared.selection?.kind)
				return;
			share({ selection: next });
			publishState();
		}, false);
	}
	catch (e) {
		log(`panel: cannot follow the selection (${e instanceof Error ? e.message : String(e)})`, 'warn');
	}
}

function onSync(m: SyncMessage): void {
	if (!m || typeof m !== 'object' || m.from === me)
		return;
	if (m.fields) {
		apply(m.fields);
		markSynced();
	}
	if (m.request && Object.keys(stampOf).length)
		publish(TOPIC_SYNC, { from: me, fields: snapshot() } satisfies SyncMessage);
}

/** The instance that acts on a command from the page. */
function handler(m: PanelCommand): string | undefined {
	if (m.to)
		return m.to;
	if (!shared.panelOwner)
		return m.cmd === 'hello' ? me : undefined;
	if (shared.panelOwner !== me)
		return undefined;
	// Clear stays here: removing the markers works from any instance, and the owner may be gone.
	if ((m.cmd === 'toggle' || m.cmd === 'restyle') && shared.overlayOwner)
		return shared.overlayOwner;
	if (m.cmd === 'cancel' && shared.busyOwner)
		return shared.busyOwner;
	return me;
}

async function onCommand(m: PanelCommand): Promise<void> {
	if (!m || typeof m !== 'object')
		return;
	if (m.cmd === 'hello' && !shared.pageConnected)
		log('panel: page connected');
	if (m.cmd === 'hello')
		apply({ pageConnected: { v: true, at: now() } });
	const target = handler(m);
	if (target !== me) {
		// The owner hands the command on, so the instance holding the overlay or the run gets it.
		if (target && !m.to && shared.panelOwner === me)
			publish(TOPIC_COMMAND, { ...m, to: target });
		return;
	}
	if (m.cmd === 'hello') {
		share({ panelOwner: me, pageConnected: true });
		publishState();
		return;
	}
	if (m.cmd === 'style' || m.cmd === 'resetStyle') {
		share({ style: await saveStyle(m.cmd === 'resetStyle' ? 'reset' : m.style) });
		if (shared.overlayOwner && shared.overlayOwner !== me)
			publish(TOPIC_COMMAND, { cmd: 'restyle', to: shared.overlayOwner });
		else
			await restyleOverlay();
		publishState();
		return;
	}
	if (m.cmd === 'adopt') {
		adopt(m.snapshot);
		publishState();
		return;
	}
	if (m.cmd === 'restyle') {
		await restyleOverlay();
		publishState();
		return;
	}
	if (shared.busy && m.cmd !== 'cancel') {
		toast(t('Busy: ${1}', shared.busy));
		return;
	}
	const labels: Record<string, string> = { hf: 'HF check', dc: 'DC check', trace: 'Selected trace', rerun: 'Rerun', toggle: '', clear: '', cancel: '' };
	const busy = labels[m.cmd] || undefined;
	if (busy)
		share({ busy, busyOwner: me });
	publishState();
	try {
		await host?.run(m.cmd);
	}
	finally {
		if (busy)
			share({ busy: undefined, busyOwner: undefined });
		publishState();
	}
}

/** Hands Hide/Show or Clear from a menu to the instance that drew the overlay; false when this one holds it or none does. */
export function forwardOverlayCommand(cmd: 'toggle' | 'clear'): boolean {
	if (overlayState() !== 'none' || !shared.overlayOwner || shared.overlayOwner === me || !subscribed)
		return false;
	publish(TOPIC_COMMAND, { cmd, to: shared.overlayOwner });
	return true;
}

/** After a Clear here: no instance holds an overlay any more, even when the one that drew it is gone. */
export function releaseOverlay(): void {
	if (!shared.overlayOwner || shared.overlayOwner === me)
		return;
	share({ overlay: 'none', overlayOwner: undefined });
	pushSnapshot();
}

/** Markers on the canvas that no live instance holds: drawn before an update or a reload of the extension. */
function leftover(): string | undefined {
	return overlayState() === 'none' && !shared.overlayOwner ? leftoverOverlay() : undefined;
}

/** The last analysis as seen by any instance; undefined when none has shared one. */
export function sharedLastRun(): unknown {
	return shared.lastRun;
}

export function shareLastRun(run: unknown): void {
	share({ lastRun: run });
}

/** The overlay as this instance holds it, or as the instance that drew it reported. */
function overlayNow(): Shared['overlay'] {
	const local = overlayState();
	if (local !== 'none' || shared.overlayOwner === me)
		return local;
	return shared.overlayOwner ? shared.overlay : leftover() ? 'shown' : 'none';
}

export function publishState(): void {
	if (!subscribed || subscribed !== bus())
		return;
	const local = overlayState();
	if (local !== 'none' && (shared.overlayOwner !== me || shared.overlay !== local)) {
		share({ overlay: local, overlayOwner: me });
		pushSnapshot();
	}
	else if (local === 'none' && shared.overlayOwner === me) {
		share({ overlay: 'none', overlayOwner: undefined });
		pushSnapshot();
	}
	const style = currentStyle();
	const kind = host?.lastRunKind?.();
	publish(TOPIC_STATE, {
		version: extensionConfig.version,
		busy: shared.busy,
		overlay: overlayNow(),
		leftover: leftover(),
		lastRun: host?.lastRunLabel(),
		selection: shared.selection,
		result: shared.result,
		roles: ROLES.filter(r => !kind || ROLE_USE[r].includes(kind)).map(r => ({ role: r, label: t(ROLE_LABELS[r]), colour: style[r].colour, width: style[r].width, visible: style[r].visible, isDefault: style[r].colour === DEFAULT_STYLE[r].colour && style[r].width === DEFAULT_STYLE[r].width && style[r].visible === DEFAULT_STYLE[r].visible })),
		palette: Object.keys(PALETTE),
		innerCycle: INNER_CYCLE,
		// The page compares these with the newest mailbox snapshot it holds and hands it on when this is older.
		stamps: { result: stampOf.result ?? -1, overlayOwner: stampOf.overlayOwner ?? -1, lastRun: stampOf.lastRun ?? -1 },
	});
}

/** Opens the panel, or brings it back if it is open but hidden or minimised. False when EasyEDA refused. */
export async function openPanel(): Promise<boolean> {
	if (shared.closedByUser)
		share({ closedByUser: false });
	if (await panelIsOpen()) {
		// The instance that opened it may be gone; this one answers the page from now on.
		share({ panelOwner: me });
		await eda.sys_IFrame.showIFrame(PANEL_ID);
		publishState();
		return true;
	}
	share({ pageConnected: false, panelOwner: me });
	let opened: unknown;
	try {
		opened = await eda.sys_IFrame.openIFrame(PANEL_HTML, 400, 660, PANEL_ID, {
			title: t('Return Path'),
			minimizeButton: true,
			maximizeButton: false,
			grayscaleMask: false,
			buttonCallbackFn: (button) => {
				if (button === 'close')
					share({ closedByUser: true, pageConnected: false });
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
	if (shared.closedByUser || await panelIsOpen())
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

/** Shows a result in the panel, opening it unless the user closed it; there is no result dialog. */
export async function report(title: string, lines: string[]): Promise<void> {
	share({ result: { title, lines, at: new Date().toLocaleTimeString() } });
	publishState();
	pushSnapshot();
	await autoOpenPanel();
	toast(await panelIsOpen()
		? t('${1}: done; the result is in the Return Path panel.', title)
		: t('${1}: done; open the Return Path panel to see the result.', title));
}
