// DC return-current overlay (D7) as temporary indicator markers: streamlines per net and the bottleneck.
import type { DcNetResult, DcResult, Streamline } from '@returnpath/core';
import { drawGroups, markerKit, type MarkerGroup, type Rgba } from './overlay';

export const DC_COLORS = {
	supply: { r: 251, g: 191, b: 36, alpha: 1 },
	return: { r: 217, g: 70, b: 239, alpha: 1 },
	/** Return on copper layers other than the top one. */
	returnOther: { r: 34, g: 211, b: 238, alpha: 1 },
	bottleneck: { r: 229, g: 57, b: 53, alpha: 1 },
} satisfies Record<string, Rgba | Rgba[]>;

/** Whether any load reached the source through this net's copper. */
export const carriesCurrent = (n: DcNetResult) => n.layers.some(l => l.flow > 0);

export interface DcDrawn {
	markers: number;
}

/**
 * Streamlines and the bottleneck. The supply is thin; the return is thick, magenta on the top
 * copper layer and cyan on the others, with a circle where it changes layer through a via.
 * Density contours are left to the CLI: as markers they crowd the view.
 */
export async function drawDc(res: DcResult, streams: { supply: Streamline[]; ret: Streamline[] }): Promise<DcDrawn> {
	const { segs, dot } = await markerKit();
	const top = res.supply.layers[0].layer;
	const lines = (ls: Streamline[], keep: (layer: number) => boolean) => ls.flatMap(l => l.segments.filter(s => keep(s.layer)).flatMap(s => segs(s.pts, false)));
	const hops = streams.ret.flatMap(l => l.segments.slice(1).map(s => dot(s.pts[0], 0.35)));
	const nets = [res.supply, res.ret].filter((n): n is DcNetResult => !!n && carriesCurrent(n));
	const groups: MarkerGroup[] = [
		{ color: DC_COLORS.supply, markers: lines(streams.supply, () => true), width: 1 },
		{ color: DC_COLORS.return, markers: lines(streams.ret, l => l === top), width: 3 },
		{ color: DC_COLORS.returnOther, markers: [...lines(streams.ret, l => l !== top), ...hops], width: 3 },
		{ color: DC_COLORS.bottleneck, markers: nets.flatMap(n => n.bottleneck ? [dot(n.bottleneck.at, 1)] : []), width: 3 },
	];
	return { markers: await drawGroups(groups) };
}
