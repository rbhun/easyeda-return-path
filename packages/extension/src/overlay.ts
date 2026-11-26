// Draws an analysis as temporary indicator markers: nothing is stored in the document or the
// undo history (design decision D6). Markers have no fill, so regions are drawn as outlines.
import { dist, lerp, type Analysis, type Board, type Path, type Paths, type Pt } from '@returnpath/core';
import extensionConfig from '../extension.json' with { type: 'json' };
import { MIL } from './eda-board';
import { log, readStored, writeStored } from './runner';
import { roleColour, type Role } from './style';

export type { Rgba } from './style';

/** Copper-layer position of a reference layer: its overlay role, and for inner layers their index. */
function returnRole(board: Pick<Board, 'stackup'>, layer: number): { role: Role; inner?: number } {
	const stack = board.stackup.copper;
	const i = stack.findIndex(l => l.id === layer);
	if (i <= 0)
		return { role: 'returnTop' };
	if (i === stack.length - 1)
		return { role: 'returnOther' };
	return { role: 'returnInner', inner: i - 1 };
}

export type Marker = IDMT_IndicatorMarkerShape;
/** Markers drawn in the colour and width of a role, looked up at drawing time so style changes apply on redraw. */
export interface MarkerGroup { role: Role; inner?: number; markers: Marker[] }

/** Coverage below which a stretch of trace is drawn red; milder shortfalls are only listed as findings. */
const RED_BELOW = 0.5;

/** Cap per marker call; marker performance in the thousands is a D1 test item. */
const MAX_PER_CALL = 4000;

/** The overlay last drawn, kept so it can be hidden and shown again without a new analysis. */
let shown: { groups: MarkerGroup[]; visible: boolean } | undefined;

/**
 * Stored while markers are on the canvas, as the version that drew them. Markers outlive the
 * instance that drew them (an update or a reload of the extension), and the API cannot list them.
 */
const ON_CANVAS = 'overlayOnCanvas';
const markOnCanvas = (on: boolean) => writeStored(ON_CANVAS, on ? extensionConfig.version : false);

/** The version that drew markers still on the canvas, when this instance holds no overlay of its own. */
export function leftoverOverlay(): string | undefined {
	if (shown)
		return undefined;
	const v = readStored(ON_CANVAS);
	return typeof v === 'string' && v ? v : undefined;
}

async function paint(groups: MarkerGroup[]): Promise<number> {
	await eda.dmt_EditorControl.removeIndicatorMarkers();
	let n = 0;
	for (const grp of groups) {
		for (let k = 0; k < grp.markers.length; k += MAX_PER_CALL) {
			const markers = grp.markers.slice(k, k + MAX_PER_CALL);
			const { colour, width, visible } = roleColour(grp.role, grp.inner);
			if (!visible)
				break;
			if (await eda.dmt_EditorControl.generateIndicatorMarkers(markers, colour, width, false))
				n += markers.length;
		}
	}
	await markOnCanvas(n > 0);
	return n;
}

/** Replaces the overlay with these groups. Returns the number of markers drawn. */
export async function drawGroups(groups: MarkerGroup[]): Promise<number> {
	shown = { groups, visible: true };
	return paint(groups);
}

/** The kept overlay, for handing to another instance of the extension. */
export function overlayGroups(): { groups: MarkerGroup[]; visible: boolean } | undefined {
	return shown && { groups: shown.groups, visible: shown.visible };
}

/** Takes over an overlay another instance drew; the markers on the canvas are already as given. */
export function adoptOverlay(groups: MarkerGroup[], visible: boolean): void {
	shown = { groups, visible };
}

/** Drops the kept overlay without touching the markers: another instance of the extension drew over it. */
export function forgetOverlay(): void {
	shown = undefined;
}

/** Removes every marker on the canvas, including ones an earlier instance or version drew. */
export async function clearOverlay(): Promise<void> {
	shown = undefined;
	await eda.dmt_EditorControl.removeIndicatorMarkers();
	await markOnCanvas(false);
}

/** Draws the current overlay again with the current style; false when there is none or it is hidden. */
export async function restyleOverlay(): Promise<boolean> {
	if (!shown?.visible)
		return false;
	await paint(shown.groups);
	return true;
}

/** Whether an overlay is kept, and whether it is shown. */
export function overlayState(): 'none' | 'shown' | 'hidden' {
	return shown ? (shown.visible ? 'shown' : 'hidden') : 'none';
}

/** Hides the overlay, or shows the hidden one again. Returns whether it is now visible; undefined when there is none. */
export async function toggleOverlay(): Promise<boolean | undefined> {
	if (!shown)
		return undefined;
	if (shown.visible) {
		await eda.dmt_EditorControl.removeIndicatorMarkers();
		await markOnCanvas(false);
	}
	else
		await paint(shown.groups);
	shown.visible = !shown.visible;
	return shown.visible;
}

let lastOrigin: { api: unknown; at: Pt } | undefined;

/**
 * Where the data origin sits in canvas coordinates (mil). The editor's conversion throws inside
 * itself when it has no PCB canvas to work on (seen in EasyEDA Pro with pro-api 0.3.59), so the
 * inverse conversion is tried next, then the origin read earlier in this session (readBoard reads it
 * while the PCB is surely open), then no offset at all.
 */
export async function canvasOrigin(): Promise<Pt> {
	const ok = (p: unknown): p is Pt => !!p && Number.isFinite((p as Pt).x) && Number.isFinite((p as Pt).y);
	const failed: string[] = [];
	const tries: [string, () => Promise<unknown>][] = [
		['convertDataOriginToCanvasOrigin', () => eda.pcb_Document.convertDataOriginToCanvasOrigin(0, 0)],
		['convertCanvasOriginToDataOrigin', async () => {
			const d = await eda.pcb_Document.convertCanvasOriginToDataOrigin(0, 0);
			return ok(d) ? { x: -d.x, y: -d.y } : d;
		}],
	];
	for (const [name, f] of tries) {
		try {
			const p = await f();
			if (ok(p))
				return (lastOrigin = { api: eda, at: { x: p.x, y: p.y } }).at;
			failed.push(`${name} returned ${JSON.stringify(p)}`);
		}
		catch (e) {
			failed.push(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	let doc: unknown;
	try {
		doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	}
	catch {}
	const earlier = lastOrigin?.api === eda ? lastOrigin.at : undefined;
	log(`overlay: canvas origin unavailable (${failed.join('; ')}); current document ${JSON.stringify(doc ?? null)}; ${earlier ? `using the one read earlier (${earlier.x}, ${earlier.y})` : 'drawing without an origin offset'}`, 'warn');
	return earlier ?? { x: 0, y: 0 };
}

/** Marker builders in canvas coordinates for core geometry in mm. */
export async function markerKit() {
	// Assumes marker coordinates are canvas coordinates, offset from data coordinates by a translation (D1: to test).
	const origin = await canvasOrigin();
	const toMil = (p: Pt) => ({ x: p.x / MIL + origin.x, y: p.y / MIL + origin.y });
	const segs = (path: Path, closed: boolean): Marker[] => {
		const pts = path.map(toMil);
		if (closed && pts.length > 2)
			pts.push(pts[0]);
		return pts.slice(1).map((b, i) => ({ type: 'line' as EDMT_IndicatorMarkerType, startX: pts[i].x, startY: pts[i].y, endX: b.x, endY: b.y }));
	};
	const outline = (paths: Paths) => paths.flatMap(r => segs(r, true));
	const dot = (p: Pt, rMm: number): Marker => ({ type: 'circle' as EDMT_IndicatorMarkerType, ...toMil(p), r: rMm / MIL });
	/** A straight hop drawn as dashes (mm), so it reads as a jump rather than copper. */
	const dashed = (a: Pt, b: Pt, dash = 0.6, gap = 0.4): Marker[] => {
		const d = dist(a, b);
		const out: Marker[] = [];
		for (let s = 0; s < d; s += dash + gap)
			out.push(...segs([lerp(a, b, s / d), lerp(a, b, Math.min(d, s + dash) / d)], false));
		return out;
	};
	return { segs, outline, dot, dashed };
}

export interface HfDrawn {
	markers: number;
	/** "Inner1: green" for each signal layer whose return is drawn. */
	returnLayers: string[];
	forwardLayers: string[];
}

/**
 * Replaces the overlay with the given analysis: the return path in a colour per signal layer, the
 * signal trace and the vias it passes through;
 * dashed hops (via, decap, bridging cap, IC pin); red over the trace where it crosses a gap or is
 * short of reference copper; the band edges (hidden by default). Colours and widths come from the style (style.ts).
 */
export async function drawAnalysis(an: Analysis, board: Pick<Board, 'stackup'>): Promise<HfDrawn> {
	const { segs, outline, dot, dashed } = await markerKit();
	const layerName = (id: number) => board.stackup.copper.find(l => l.id === id)?.name ?? `L${id}`;

	const groups = new Map<string, MarkerGroup>();
	const group = (key: string, role: Role, inner?: number) => {
		let g = groups.get(key);
		if (!g)
			groups.set(key, g = { role, inner, markers: [] });
		return g.markers;
	};
	const band = group('band', 'band');
	const gap = group('gap', 'gap');
	const hop = group('hop', 'hop');

	for (const c of an.chains) {
		band.push(...outline(c.band));
		// Red runs along the trace where it is short of reference copper, rather than outlining every
		// uncovered piece of the band, which on a busy board breaks up into fragments.
		for (const th of c.thin) {
			if (th.ratio < RED_BELOW)
				gap.push(...segs([th.a, th.b], false));
		}
		for (const g of c.gaps) {
			if (g.kind !== 'via-antipad')
				gap.push(...segs([g.a, g.b], false));
		}
	}
	// Each return is drawn where it flows, in the colour of the copper layer it flows in: on the trace
	// when it runs in the copper of another layer, beside it in a pour on the same layer.
	const returnLayers: string[] = [];
	const returns = new Map<number, MarkerGroup>();
	for (const t of an.returnPath.traces) {
		let g = returns.get(t.layer);
		if (!g) {
			const { role, inner } = returnRole(board, t.layer);
			returnLayers.push(`${layerName(t.layer)} ${roleColour(role, inner).name}`);
			returns.set(t.layer, g = { role, inner, markers: [] });
		}
		g.markers.push(...segs(t.pts, false));
	}
	for (const j of an.returnPath.jumps)
		hop.push(...dashed(j.from, j.to), dot(j.to, 0.4));
	// The signal itself in the colour of its layer, and the vias it passes through from one layer to another.
	const top = board.stackup.copper[0]?.id;
	const forwardTop: Marker[] = [];
	const forwardOther: Marker[] = [];
	const forwardLayers: string[] = [];
	for (const c of an.chains) {
		const role: Role = c.chain.layer === top ? 'forwardTop' : 'forwardOther';
		const name = `${layerName(c.chain.layer)} ${roleColour(role).name}`;
		if (!forwardLayers.includes(name))
			forwardLayers.push(name);
		(role === 'forwardTop' ? forwardTop : forwardOther).push(...segs(c.chain.pts, false));
	}
	for (const v of an.vias) {
		if (v.transitions.length)
			forwardTop.push(dot(v.via.at, v.via.diameter / 2 + 0.15));
	}
	const ordered = [groups.get('band')!, ...returns.values(), groups.get('gap')!, { role: 'forwardOther' as Role, markers: forwardOther }, { role: 'forwardTop' as Role, markers: forwardTop }, groups.get('hop')!];

	return { markers: await drawGroups(ordered), returnLayers, forwardLayers };
}
