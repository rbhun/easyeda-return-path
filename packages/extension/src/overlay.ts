// Draws an analysis as temporary indicator markers: nothing is stored in the document or the
// undo history (design decision D6). Markers have no fill, so regions are drawn as outlines.
import { type Analysis, type Path, type Paths, type Pt } from '@returnpath/core';
import { MIL } from './eda-board';

type Rgba = { r: number; g: number; b: number; alpha: number };

export const COLORS = {
	band: { r: 46, g: 158, b: 79, alpha: 0.5 },
	gap: { r: 229, g: 57, b: 53, alpha: 0.9 },
	detour: { r: 251, g: 140, b: 0, alpha: 0.9 },
	link: { r: 30, g: 136, b: 229, alpha: 0.9 },
} satisfies Record<string, Rgba>;

type Marker = IDMT_IndicatorMarkerShape;

export async function clearOverlay(): Promise<void> {
	await eda.dmt_EditorControl.removeIndicatorMarkers();
}

/** Replaces the overlay with the given analysis. Returns the number of markers drawn. */
export async function drawAnalysis(an: Analysis): Promise<number> {
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

	await clearOverlay();
	let n = 0;
	for (const [key, markers] of Object.entries(groups) as [keyof typeof COLORS, Marker[]][]) {
		if (markers.length && await eda.dmt_EditorControl.generateIndicatorMarkers(markers, COLORS[key], 2, false))
			n += markers.length;
	}
	return n;
}
