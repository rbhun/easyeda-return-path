// Draws an analysis as temporary indicator markers: nothing is stored in the document or the
// undo history (design decision D6). Markers have no fill, so regions are drawn as outlines.
import { dist, lerp, type Analysis, type Board, type Path, type Paths, type Pt } from '@returnpath/core';
import { MIL } from './eda-board';

export type Rgba = { r: number; g: number; b: number; alpha: number };

// Markers with alpha below 1 come out white in EasyEDA Pro 3.2; only opaque colours show.
export const COLORS = {
	band: { r: 148, g: 163, b: 184, alpha: 1 },
	gap: { r: 229, g: 57, b: 53, alpha: 1 },
	hop: { r: 251, g: 140, b: 0, alpha: 1 },
} satisfies Record<string, Rgba>;

/** Return path colour per reference layer: magenta on the top layer, cyan on the bottom one, inner layers in turn. */
export const RETURN_COLORS = {
	top: { r: 217, g: 70, b: 239, alpha: 1 },
	bottom: { r: 34, g: 211, b: 238, alpha: 1 },
	inner: [
		{ r: 132, g: 204, b: 22, alpha: 1 },
		{ r: 250, g: 204, b: 21, alpha: 1 },
		{ r: 59, g: 130, b: 246, alpha: 1 },
	],
} satisfies Record<string, Rgba | Rgba[]>;

export const RETURN_COLOR_NAMES = { top: 'magenta', bottom: 'cyan', inner: ['green', 'yellow', 'blue'] };

/** Index-ordered copper layers: 0 is the top. */
function returnColor(board: Pick<Board, 'stackup'>, layer: number): { color: Rgba; name: string } {
	const stack = board.stackup.copper;
	const i = stack.findIndex(l => l.id === layer);
	if (i <= 0)
		return { color: RETURN_COLORS.top, name: RETURN_COLOR_NAMES.top };
	if (i === stack.length - 1)
		return { color: RETURN_COLORS.bottom, name: RETURN_COLOR_NAMES.bottom };
	const k = (i - 1) % RETURN_COLORS.inner.length;
	return { color: RETURN_COLORS.inner[k], name: RETURN_COLOR_NAMES.inner[k] };
}

export type Marker = IDMT_IndicatorMarkerShape;
export interface MarkerGroup { color: Rgba; markers: Marker[]; width: number }

/** Cap per marker call; marker performance in the thousands is a D1 test item. */
const MAX_PER_CALL = 4000;

/** The overlay last drawn, kept so it can be hidden and shown again without a new analysis. */
let shown: { groups: MarkerGroup[]; visible: boolean } | undefined;

async function paint(groups: MarkerGroup[]): Promise<number> {
	await eda.dmt_EditorControl.removeIndicatorMarkers();
	let n = 0;
	for (const grp of groups) {
		for (let k = 0; k < grp.markers.length; k += MAX_PER_CALL) {
			const markers = grp.markers.slice(k, k + MAX_PER_CALL);
			if (await eda.dmt_EditorControl.generateIndicatorMarkers(markers, grp.color, grp.width, false))
				n += markers.length;
		}
	}
	return n;
}

/** Replaces the overlay with these groups. Returns the number of markers drawn. */
export async function drawGroups(groups: MarkerGroup[]): Promise<number> {
	shown = { groups, visible: true };
	return paint(groups);
}

export async function clearOverlay(): Promise<void> {
	shown = undefined;
	await eda.dmt_EditorControl.removeIndicatorMarkers();
}

/** Hides the overlay, or shows the hidden one again. Returns whether it is now visible; undefined when there is none. */
export async function toggleOverlay(): Promise<boolean | undefined> {
	if (!shown)
		return undefined;
	if (shown.visible)
		await eda.dmt_EditorControl.removeIndicatorMarkers();
	else
		await paint(shown.groups);
	shown.visible = !shown.visible;
	return shown.visible;
}

/** Marker builders in canvas coordinates for core geometry in mm. */
export async function markerKit() {
	// Assumes marker coordinates are canvas coordinates, offset from data coordinates by a translation (D1: to test).
	const origin = await eda.pcb_Document.convertDataOriginToCanvasOrigin(0, 0);
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
	/** "Inner1: green" for each reference layer the return path runs on. */
	returnLayers: string[];
}

/**
 * Replaces the overlay with the given analysis: the return path, thick, in a colour per reference
 * layer; dashed orange hops (via, decap, bridging cap, IC pin); red where the trace crosses a gap or
 * the ±3h band lacks copper; the band edges thin grey.
 */
export async function drawAnalysis(an: Analysis, board: Pick<Board, 'stackup'>): Promise<HfDrawn> {
	const { segs, outline, dot, dashed } = await markerKit();
	const layerName = (id: number) => board.stackup.copper.find(l => l.id === id)?.name ?? `L${id}`;

	const groups = new Map<string, MarkerGroup>();
	const group = (key: string, color: Rgba, width: number) => {
		let g = groups.get(key);
		if (!g)
			groups.set(key, g = { color, width, markers: [] });
		return g.markers;
	};
	const band = group('band', COLORS.band, 1);
	const gap = group('gap', COLORS.gap, 3);
	const hop = group('hop', COLORS.hop, 2);

	for (const c of an.chains) {
		band.push(...outline(c.band));
		gap.push(...outline(c.bandUncovered));
		for (const g of c.gaps) {
			if (g.kind !== 'via-antipad')
				gap.push(...segs([g.a, g.b], false));
		}
	}
	const returnLayers: string[] = [];
	for (const t of an.returnPath.traces) {
		const { color, name } = returnColor(board, t.layer);
		const key = `return ${t.layer}`;
		if (!groups.has(key))
			returnLayers.push(`${layerName(t.layer)}: ${name}`);
		group(key, color, 3).push(...segs(t.pts, false));
	}
	for (const j of an.returnPath.jumps)
		hop.push(...dashed(j.from, j.to), dot(j.to, 0.4));

	return { markers: await drawGroups([...groups.values()]), returnLayers };
}
