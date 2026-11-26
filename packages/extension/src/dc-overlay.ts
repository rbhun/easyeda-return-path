// DC return-current overlay (D7) as temporary indicator markers: streamlines per net and the bottleneck.
import type { DcNetResult, DcResult, Streamline } from '@returnpath/core';
import { drawGroups, markerKit, type MarkerGroup } from './overlay';

/** Whether any load reached the source through this net's copper. */
export const carriesCurrent = (n: DcNetResult) => n.layers.some(l => l.flow > 0);

export interface DcDrawn {
	markers: number;
}

/**
 * Streamlines and the bottleneck: the supply; the return in one style on the top copper layer and
 * another on the others, with a circle where it changes layer through a via.
 * Density contours are left to the CLI: as markers they crowd the view.
 */
export async function drawDc(res: DcResult, streams: { supply: Streamline[]; ret: Streamline[] }): Promise<DcDrawn> {
	const { segs, dot } = await markerKit();
	const top = res.supply.layers[0].layer;
	const lines = (ls: Streamline[], keep: (layer: number) => boolean) => ls.flatMap(l => l.segments.filter(s => keep(s.layer)).flatMap(s => segs(s.pts, false)));
	const hops = streams.ret.flatMap(l => l.segments.slice(1).map(s => dot(s.pts[0], 0.35)));
	const nets = [res.supply, res.ret].filter((n): n is DcNetResult => !!n && carriesCurrent(n));
	const groups: MarkerGroup[] = [
		{ role: 'supply', markers: lines(streams.supply, () => true) },
		{ role: 'returnTop', markers: lines(streams.ret, l => l === top) },
		{ role: 'returnOther', markers: [...lines(streams.ret, l => l !== top), ...hops] },
		{ role: 'gap', markers: nets.flatMap(n => n.bottleneck ? [dot(n.bottleneck.at, 1)] : []) },
	];
	return { markers: await drawGroups(groups) };
}
