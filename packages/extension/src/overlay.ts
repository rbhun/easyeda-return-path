// Draws an analysis as temporary indicator markers: nothing is stored in the document or the
// undo history (design decision D6). Markers have no fill, so regions are drawn as outlines.
import { type Analysis, type Path, type Paths, type Pt } from '@returnpath/core';
import { MIL } from './eda-board';

export type Rgba = { r: number; g: number; b: number; alpha: number };

// Markers with alpha below 1 come out white in EasyEDA Pro 3.2; only opaque colours show.
export const COLORS = {
	band: { r: 46, g: 158, b: 79, alpha: 1 },
	gap: { r: 229, g: 57, b: 53, alpha: 1 },
	detour: { r: 251, g: 140, b: 0, alpha: 1 },
	link: { r: 30, g: 136, b: 229, alpha: 1 },
} satisfies Record<string, Rgba>;

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
	return { segs, outline, dot };
}

/** Replaces the overlay with the given analysis. Returns the number of markers drawn. */
export async function drawAnalysis(an: Analysis): Promise<number> {
	const { segs, outline, dot } = await markerKit();

	const groups: Record<keyof typeof COLORS, Marker[]> = { band: [], gap: [], detour: [], link: [] };
	for (const c of an.chains) {
		groups.band.push(...outline(c.band));
		groups.gap.push(...outline(c.bandUncovered));
		for (const g of c.gaps) {
			if (g.kind === 'via-antipad')
				continue;
			groups.gap.push(...segs([g.a, g.b], false));
			if (g.detour)
				groups.detour.push(...segs(g.detour.path, false));
			if (g.bridge)
				groups.link.push(...segs([g.a, g.bridge.at], false), dot(g.bridge.at, 0.5));
		}
	}
	for (const v of an.vias) {
		for (const t of v.transitions) {
			if (t.target)
				groups.link.push(...segs([v.via.at, t.target.at], false), dot(t.target.at, 0.5));
		}
	}

	return drawGroups((Object.entries(groups) as [keyof typeof COLORS, Marker[]][]).map(([key, markers]) => ({ color: COLORS[key], markers, width: 2 })));
}
