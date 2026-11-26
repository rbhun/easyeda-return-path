// DC return-current overlay (D7) as temporary indicator markers: streamlines per net, density
// contours on each net's dominant layer with one marker call per colour bin, and the bottleneck.
import { densityContours, dominantLayer, type DcNetResult, type DcResult, type Pt, type Streamline } from '@returnpath/core';
import { clearOverlay, coloursWork, markerColour, markerKit, type Marker, type Rgba } from './overlay';

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

/** Dash patterns, mm: [dash, gap]. */
export const SUPPLY_DASH: [number, number] = [1, 0.7];
export const OTHER_LAYER_DOTS: [number, number] = [0.25, 0.35];

/** Pieces of a polyline: `dash` long, `gap` apart. */
export function dashes(pts: Pt[], [dash, gap]: [number, number] = SUPPLY_DASH): Pt[][] {
	const out: Pt[][] = [];
	let cur: Pt[] = [];
	let on = true;
	let left = dash;
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
			left = on ? dash : gap;
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
	/** Layer whose contours were drawn, per net; empty when markers show no colour. */
	contourLayers: { net: string; layer: number }[];
}

/**
 * Markers may all come out white (EasyEDA Pro 3.2), so line style carries the meaning: the return
 * is thick, solid on the top copper layer and dotted on the others, with a circle where it changes
 * layer; the supply is thin and dashed. Density contours need colour and are drawn only when
 * Check Marker Colours confirmed it.
 */
export async function drawDc(res: DcResult, streams: { supply: Streamline[]; ret: Streamline[] }): Promise<DcDrawn> {
	const { segs, dot } = await markerKit();
	const groups: { color: Rgba; markers: Marker[]; width: number }[] = [];
	const top = res.supply.layers[0].layer;
	const supply = streams.supply.flatMap(l => l.segments.flatMap(s => dashes(s.pts).flatMap(p => segs(p, false))));
	const ret = streams.ret.flatMap(l => l.segments.flatMap(s => (s.layer === top ? [s.pts] : dashes(s.pts, OTHER_LAYER_DOTS)).flatMap(p => segs(p, false))));
	const hops = streams.ret.flatMap(l => l.segments.slice(1).map(s => dot(s.pts[0], 0.35)));
	groups.push({ color: DC_COLORS.supply, markers: supply, width: 1 });
	groups.push({ color: DC_COLORS.return, markers: [...ret, ...hops], width: 3 });

	const nets = [res.supply, res.ret].filter((n): n is DcNetResult => !!n && carriesCurrent(n));
	const contourLayers: DcDrawn['contourLayers'] = [];
	if (coloursWork()) {
		const bins: Marker[][] = DC_COLORS.bins.map(() => []);
		for (const net of nets) {
			const layer = dominantLayer(net);
			const field = net.layers.find(l => l.layer === layer)!;
			contourLayers.push({ net: net.net, layer });
			densityContours(res.grid, field, field.peak?.j || net.fullScale).forEach((lines, k) => bins[k].push(...lines.flatMap(l => segs(l, false))));
		}
		bins.forEach((markers, k) => groups.push({ color: DC_COLORS.bins[k], markers, width: 1 }));
	}
	groups.push({ color: DC_COLORS.bottleneck, markers: nets.flatMap(n => n.bottleneck ? [dot(n.bottleneck.at, 1)] : []), width: 3 });

	await clearOverlay();
	let n = 0;
	for (const grp of groups) {
		for (let k = 0; k < grp.markers.length; k += MAX_PER_CALL) {
			const markers = grp.markers.slice(k, k + MAX_PER_CALL);
			if (await eda.dmt_EditorControl.generateIndicatorMarkers(markers, markerColour(grp.color), grp.width, false))
				n += markers.length;
		}
	}
	return { markers: n, contourLayers };
}
