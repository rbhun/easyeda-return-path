// Reads the open PCB through the EasyEDA Pro API into the core board model.
// Almost every call used here is @beta, so all API access stays in this module and overlay.ts.
import {
	arcPoints,
	area,
	circle,
	decodeComplex,
	intersect,
	rect,
	rotate,
	splitIslands,
	strokePath,
	union,
	MULTI_LAYER,
	type Board,
	type Component,
	type CopperLayer,
	type Dielectric,
	type Pad,
	type Paths,
	type Pour,
	type Pt,
	type Track,
	type Via,
} from '@returnpath/core';

export const MIL = 0.0254;
const LAYER_MULTI = 12;

/** API data coordinates are mil, Y up, which is what the file parser assumes too. */
const conv = (x: number, y: number): Pt => ({ x: x * MIL, y: y * MIL });

function unitToMm(unit: string | undefined): number {
	switch ((unit ?? 'mm').toLowerCase()) {
		case 'mil': return MIL;
		case 'inch':
		case 'in': return 25.4;
		case 'um':
		case 'μm': return 0.001;
		default: return 1;
	}
}

/** Net of a selected track, via, pad or fill, if any of the selection carries one. */
export async function selectedNet(): Promise<string | undefined> {
	const selected = await eda.pcb_SelectControl.getAllSelectedPrimitives();
	for (const p of selected) {
		const net = (p as { getState_Net?: () => string | undefined }).getState_Net?.();
		if (net)
			return net;
	}
	return undefined;
}

async function readStackup(warnings: string[]): Promise<Board['stackup']> {
	const copper: CopperLayer[] = [];
	const dielectrics: Dielectric[] = [];
	if (typeof eda.pcb_Layer.getStackup === 'function') {
		const s = await eda.pcb_Layer.getStackup();
		const k = unitToMm(s.unit);
		let z = 0;
		let pending: Dielectric | undefined;
		for (const l of [...s.layers].sort((a, b) => a.zIndex - b.zIndex)) {
			if (l.kind === 'copper') {
				if (copper.length)
					dielectrics.push(pending ?? { name: 'unknown', thicknessMm: 0.2 });
				copper.push({ id: l.layerId, name: l.layerName, index: copper.length, z });
				pending = undefined;
			}
			else if (l.kind === 'dielectric' && copper.length) {
				const t = l.thickness * k;
				z += t;
				pending = pending
					? { name: `${pending.name}+${l.layerName}`, thicknessMm: pending.thicknessMm + t, er: l.permittivity }
					: { name: l.layerName, thicknessMm: t, er: l.permittivity, lossTangent: l.lossTangent };
			}
		}
	}
	if (copper.length < 2) {
		warnings.push('Stackup API unavailable (needs EasyEDA Pro >= 4.1.93); assuming 0.2 mm dielectrics.');
		copper.length = 0;
		dielectrics.length = 0;
		const layers = (await eda.pcb_Layer.getAllLayers()).filter(l => l.type === 'SIGNAL' || l.type === 'PLANE');
		const order = (id: number) => (id === 1 ? -1 : id === 2 ? 1000 : id);
		layers.sort((a, b) => order(a.id) - order(b.id));
		layers.forEach((l, i) => {
			copper.push({ id: l.id, name: l.name, index: i, z: i * 0.2 });
			if (i)
				dielectrics.push({ name: `D${i}`, thicknessMm: 0.2 });
		});
	}
	return { copper, dielectrics };
}

/** Same shape rules as the file parser in packages/cli: pad shapes are relative to the pad centre. */
function padShape(at: Pt, rotation: number, shape: unknown): Paths {
	const s = Array.isArray(shape) && shape.length ? shape : ['ELLIPSE', 0, 0];
	const kind = String(s[0]);
	const toWorld = (pts: Pt[]) => pts.map((p) => {
		const q = rotate(p, rotation);
		return { x: q.x + at.x, y: q.y + at.y };
	});
	if (kind === 'POLYGON')
		return decodeComplex(s[1], conv, MIL).map(toWorld);
	const w = Number(s[1]) * MIL;
	const h = Number(s[2] ?? s[1]) * MIL;
	if (kind === 'RECT')
		return [toWorld(rect(0, 0, w, h))];
	if (kind === 'NGON')
		return [toWorld(circle({ x: 0, y: 0 }, w / 2, Math.max(3, Number(s[2]) || 6)))];
	const r0 = Math.min(w, h) / 2;
	const dx = w > h ? (w - h) / 2 : 0;
	const dy = h > w ? (h - w) / 2 : 0;
	if (!dx && !dy)
		return [toWorld(circle({ x: 0, y: 0 }, Math.max(r0, 0.05)))];
	return strokePath([{ x: -dx, y: -dy }, { x: dx, y: dy }], 2 * r0).map(toWorld);
}

function toPad(p: IPCB_PrimitivePad, componentId?: string): Pad {
	const at = conv(p.getState_X(), p.getState_Y());
	const hole = p.getState_Hole();
	const layer = p.getState_Layer() as number;
	return {
		id: p.getState_PrimitiveId(),
		net: p.getState_Net() ?? '',
		layer: layer === LAYER_MULTI ? MULTI_LAYER : layer,
		number: p.getState_PadNumber(),
		at,
		shape: padShape(at, p.getState_Rotation(), p.getState_Pad()),
		holeDiameter: hole ? (hole[1] as number) * MIL : 0,
		componentId,
	};
}

/** Builds the core board model from the open PCB. Fills must be current; stale pours fall back to outlines. */
export async function readBoard(): Promise<Board> {
	const warnings: string[] = [];
	const stackup = await readStackup(warnings);
	const copperIds = new Set(stackup.copper.map(l => l.id));

	const tracks: Track[] = [];
	for (const l of await eda.pcb_PrimitiveLine.getAll()) {
		const layer = l.getState_Layer() as number;
		if (!copperIds.has(layer))
			continue;
		tracks.push({
			id: l.getState_PrimitiveId(),
			net: l.getState_Net(),
			layer,
			a: conv(l.getState_StartX(), l.getState_StartY()),
			b: conv(l.getState_EndX(), l.getState_EndY()),
			width: l.getState_LineWidth() * MIL,
		});
	}
	for (const arc of await eda.pcb_PrimitiveArc.getAll()) {
		const layer = arc.getState_Layer() as number;
		if (!copperIds.has(layer))
			continue;
		const pts = arcPoints(conv(arc.getState_StartX(), arc.getState_StartY()), conv(arc.getState_EndX(), arc.getState_EndY()), arc.getState_ArcAngle());
		for (let i = 1; i < pts.length; i++) {
			tracks.push({ id: `${arc.getState_PrimitiveId()}#${i}`, net: arc.getState_Net(), layer, a: pts[i - 1], b: pts[i], width: arc.getState_LineWidth() * MIL });
		}
	}

	const vias: Via[] = (await eda.pcb_PrimitiveVia.getAll()).map(v => ({
		id: v.getState_PrimitiveId(),
		net: v.getState_Net(),
		at: conv(v.getState_X(), v.getState_Y()),
		drill: v.getState_HoleDiameter() * MIL,
		diameter: v.getState_Diameter() * MIL,
		stitching: (v.getState_ViaType() as number) === 1,
	}));

	const pads: Pad[] = (await eda.pcb_PrimitivePad.getAll()).map(p => toPad(p));
	const components: Component[] = [];
	for (const c of await eda.pcb_PrimitiveComponent.getAll()) {
		const id = c.getState_PrimitiveId();
		const pins = (await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(id)) ?? [];
		const own = pins.map(p => toPad(p, id));
		pads.push(...own);
		components.push({
			id,
			designator: c.getState_Designator() ?? id,
			at: conv(c.getState_X(), c.getState_Y()),
			rotation: c.getState_Rotation(),
			layer: c.getState_Layer() as number,
			padIds: own.map(p => p.id),
		});
	}

	// Plane-layer partitions are fills with mode INNER_ELECTRICAL_LAYER (2); they carry the net that
	// plane copper (poured, but with no pour) lacks. Other copper fills are solid copper as drawn.
	const planeFills: { net: string; layer: number; shape: Paths }[] = [];
	const pours: Pour[] = [];
	for (const f of await eda.pcb_PrimitiveFill.getAll()) {
		const layer = f.getState_Layer() as number;
		const net = f.getState_Net();
		if (!copperIds.has(layer) || !net)
			continue;
		const shape = decodeComplex(f.getState_ComplexPolygon().getSource(), conv, MIL);
		if ((f.getState_FillMode() as number | undefined) === 2)
			planeFills.push({ net, layer, shape });
		else
			pours.push({ id: f.getState_PrimitiveId(), net, layer, name: 'fill', priority: 0, outline: shape, poured: shape });
	}

	const fillsByPour = new Map<string, Paths>();
	const planeCopper = new Map<string, Pour>();
	for (const poured of await eda.pcb_PrimitivePoured.getAll()) {
		const rings = poured.getState_PourFills().filter(f => f.fill).flatMap(f => decodeComplex(f.path.getSource(), conv, MIL));
		const pourId = poured.getState_PourPrimitiveId();
		if (pourId) {
			fillsByPour.set(pourId, union(fillsByPour.get(pourId) ?? [], rings));
			continue;
		}
		const layer = poured.getState_Layer() as number;
		for (const island of splitIslands(rings)) {
			let plane: typeof planeFills[number] | undefined;
			let best = 0;
			for (const p of planeFills.filter(p => p.layer === layer)) {
				const overlap = area(intersect(island, p.shape));
				if (overlap > best) {
					best = overlap;
					plane = p;
				}
			}
			if (!plane) {
				warnings.push(`Plane copper on layer ${layer} at (${island[0][0].x.toFixed(1)}, ${island[0][0].y.toFixed(1)}) matches no plane fill; skipped.`);
				continue;
			}
			const key = `${layer}:${plane.net}`;
			const pour = planeCopper.get(key) ?? { id: `plane-${key}`, net: plane.net, layer, name: 'plane', priority: 0, outline: plane.shape, poured: [] };
			pour.poured = union(pour.poured!, island);
			planeCopper.set(key, pour);
		}
	}
	for (const plane of planeFills) {
		if (!planeCopper.has(`${plane.layer}:${plane.net}`)) {
			warnings.push(`Plane fill ${plane.net} on layer ${plane.layer} has no computed copper; using its outline.`);
			pours.push({ id: `plane-${plane.layer}:${plane.net}`, net: plane.net, layer: plane.layer, name: 'plane', priority: 0, outline: plane.shape });
		}
	}
	pours.push(...planeCopper.values());

	for (const p of await eda.pcb_PrimitivePour.getAll()) {
		const id = p.getState_PrimitiveId();
		const poured = fillsByPour.get(id);
		if (!poured)
			warnings.push(`Pour "${p.getState_PourName()}" (${p.getState_Net()}) has no computed fill; rebuild copper for accurate results.`);
		pours.push({
			id,
			net: p.getState_Net(),
			layer: p.getState_Layer() as number,
			name: p.getState_PourName(),
			priority: p.getState_PourPriority(),
			outline: decodeComplex(p.getState_ComplexPolygon().getSource(), conv, MIL),
			poured,
		});
	}

	const nets = [...new Set([...tracks.map(t => t.net), ...vias.map(v => v.net), ...pads.map(p => p.net)].filter(Boolean))].sort();
	return { outline: [], stackup, nets, tracks, vias, pads, components, pours, keepouts: [], warnings };
}
