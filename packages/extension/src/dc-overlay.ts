// DC return-current overlay (D7) as temporary indicator markers: streamlines per net, density
// contours on each net's dominant layer with one marker call per colour bin, and the bottleneck.
import { densityContours, dominantLayer, type DcNetResult, type DcResult, type Pt, type Streamline } from '@returnpath/core';
import { clearOverlay, markerKit, type Marker, type Rgba } from './overlay';

export const DC_COLORS = {
	supply: { r: 251, g: 191, b: 36, alpha: 0.95 },
	return: { r: 217, g: 70, b: 239, alpha: 0.95 },
	bottleneck: { r: 229, g: 57, b: 53, alpha: 1 },
	bins: [
		{ r: 37, g: 99, b: 235, alpha: 0.8 },
		{ r: 16, g: 185, b: 129, alpha: 0.85 },
		{ r: 250, g: 204, b: 21, alpha: 0.9 },
		{ r: 239, g: 68, b: 68, alpha: 0.95 },
	],
} satisfies Record<string, Rgba | Rgba[]>;

/** Cap per marker call; marker performance in the thousands is a D1 test item. */
const MAX_PER_CALL = 4000;

/** Dash and gap of supply streamlines, mm. */
const DASH = 0.8;
const GAP = 0.6;

/** Pieces of a polyline: DASH long, GAP apart. */
export function dashes(pts: Pt[]): Pt[][] {
	const out: Pt[][] = [];
	let cur: Pt[] = [];
	let on = true;
	let left = DASH;
	for (let i = 1; i < pts.length; i++) {
		let a = pts[i - 1];
		const b = pts[i];
		let len = Math.hypot(b.x - a.x, b.y - a.y);
		if (on && !cur.length)
			cur.push(a);
		while (len > left) {
			const t = left / len;
			const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
			if (on) {
				cur.push(p);
				out.push(cur);
				cur = [];
			}
			else {
				cur = [p];
			}
			on = !on;
			len -= left;
			left = on ? DASH : GAP;
			a = p;
		}
		left -= len;
		if (on)
			cur.push(b);
	}
	if (on && cur.length > 1)
		out.push(cur);
	return out;
}

/** Whether any load reached the source through this net's copper. */
export const carriesCurrent = (n: DcNetResult) => n.layers.some(l => l.flow > 0);

export interface DcDrawn {
	markers: number;
	/** Layer whose contours were drawn, per net. */
	contourLayers: { net: string; layer: number }[];
}

export async function drawDc(res: DcResult, streams: { supply: Streamline[]; ret: Streamline[] }): Promise<DcDrawn> {
	const { segs, dot } = await markerKit();
	const groups: { color: Rgba; markers: Marker[]; width: number }[] = [];
	const streamMarkers = (lines: Streamline[], dashed: boolean) => lines.flatMap(l => l.segments.flatMap(s => (dashed ? dashes(s.pts) : [s.pts]).flatMap(p => segs(p, false))));
	// EasyEDA Pro 3.2 draws every indicator marker white whatever colour is passed, so the supply
	// is dashed to tell it from the return.
	groups.push({ color: DC_COLORS.supply, markers: streamMarkers(streams.supply, true), width: 3 });
	groups.push({ color: DC_COLORS.return, markers: streamMarkers(streams.ret, false), width: 3 });

	const nets = [res.supply, res.ret].filter((n): n is DcNetResult => !!n && carriesCurrent(n));
	const contourLayers: DcDrawn['contourLayers'] = [];
	const bins: Marker[][] = DC_COLORS.bins.map(() => []);
	for (const net of nets) {
		const layer = dominantLayer(net);
		const field = net.layers.find(l => l.layer === layer)!;
		contourLayers.push({ net: net.net, layer });
		densityContours(res.grid, field, field.peak?.j || net.fullScale).forEach((lines, k) => bins[k].push(...lines.flatMap(l => segs(l, false))));
	}
	bins.forEach((markers, k) => groups.push({ color: DC_COLORS.bins[k], markers, width: 1 }));
	groups.push({ color: DC_COLORS.bottleneck, markers: nets.flatMap(n => n.bottleneck ? [dot(n.bottleneck.at, 1)] : []), width: 3 });

	await clearOverlay();
	let n = 0;
	for (const grp of groups) {
		const markers = grp.markers.slice(0, MAX_PER_CALL);
		if (markers.length && await eda.dmt_EditorControl.generateIndicatorMarkers(markers, grp.color, grp.width, false))
			n += markers.length;
	}
	return { markers: n, contourLayers };
}
