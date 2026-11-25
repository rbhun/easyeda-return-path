// In-memory stand-in for the subset of the EasyEDA Pro API the extension uses, serving a core
// Board as API primitives (mil, Y up). Lets the extension run under Node without EasyEDA.
import { buildReferenceCopper, defaultOptions, intersect, splitIslands, type Board, type Path, type Paths, type Pt } from '@returnpath/core';

const MIL = 0.0254;
const m = (mm: number) => mm / MIL;
const ring = (r: Path, origin: Pt = { x: 0, y: 0 }): unknown[] => {
	const [f, ...rest] = r;
	return [m(f.x - origin.x), m(f.y - origin.y), 'L', ...rest.flatMap(p => [m(p.x - origin.x), m(p.y - origin.y)])];
};
const complex = (paths: Paths) => splitIslands(paths).map(island => island.map(r => ring(r)));

/** Pours on `planeLayers` are served like EasyEDA plane layers: poured copper without a pour ID, plus mode-2 fills carrying the net. */
export function createMockEda(board: Board, selectedNet: string, planeLayers: number[] = []) {
	// EasyEDA serves computed fills (clearances, keepouts and priorities applied); stand in for them
	// with the core's own computation so pours without a stored fill still match the file pipeline.
	const refCopper = buildReferenceCopper(board, { clearance: defaultOptions.clearance });
	const fillOf = (p: Board['pours'][number]): Paths => p.poured ?? intersect(refCopper.get(p.layer)?.byNet.get(p.net) ?? [], p.outline);
	const isPlane = (p: Board['pours'][number]) => planeLayers.includes(p.layer);

	const markers: { shape: Record<string, unknown>; color: unknown }[] = [];
	const messages: string[] = [];
	const getters = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [`getState_${k}`, () => v]));
	const padObj = (p: Board['pads'][number]) => getters({
		PrimitiveId: p.id,
		Net: p.net,
		Layer: p.layer === -1 ? 12 : p.layer,
		PadNumber: p.number,
		X: m(p.at.x),
		Y: m(p.at.y),
		Rotation: 0,
		Pad: ['POLYGON', p.shape.map(r => ring(r, p.at))],
		Hole: p.holeDiameter ? ['ROUND', m(p.holeDiameter)] : null,
	});

	const stackLayers: Record<string, unknown>[] = [];
	board.stackup.copper.forEach((l, i) => {
		stackLayers.push({ layerId: l.id, layerName: l.name, kind: 'copper', thickness: 0.035, zIndex: stackLayers.length });
		const d = board.stackup.dielectrics[i];
		if (d)
			stackLayers.push({ layerId: 100 + i, layerName: d.name, kind: 'dielectric', thickness: d.thicknessMm, permittivity: d.er ?? 4.5, lossTangent: 0.02, zIndex: stackLayers.length });
	});

	const eda = {
		sys_I18n: { text: (key: string, _ns?: string, _lang?: string, ...args: string[]) => args.reduce((s, a, i) => s.replace(`\${${i + 1}}`, a), key) },
		sys_Dialog: { showInformationMessage: (content: string) => void messages.push(content) },
		dmt_EditorControl: {
			generateIndicatorMarkers: async (shapes: Record<string, unknown>[], color: unknown) => {
				markers.push(...shapes.map(shape => ({ shape, color })));
				return true;
			},
			removeIndicatorMarkers: async () => {
				markers.length = 0;
				return true;
			},
		},
		pcb_Document: { convertDataOriginToCanvasOrigin: async (x: number, y: number) => ({ x, y }) },
		pcb_SelectControl: { getAllSelectedPrimitives: async () => [{ getState_Net: () => selectedNet }] },
		pcb_Layer: {
			getStackup: async () => ({ layers: stackLayers, totalThickness: 1.6, unit: 'mm' }),
			getAllLayers: async () => board.stackup.copper.map(l => ({ id: l.id, name: l.name, type: planeLayers.includes(l.id) ? 'PLANE' : 'SIGNAL' })),
		},
		pcb_PrimitiveLine: {
			getAll: async () => board.tracks.map(t => getters({ PrimitiveId: t.id, Net: t.net, Layer: t.layer, StartX: m(t.a.x), StartY: m(t.a.y), EndX: m(t.b.x), EndY: m(t.b.y), LineWidth: m(t.width) })),
		},
		pcb_PrimitiveArc: { getAll: async () => [] },
		pcb_PrimitiveVia: {
			getAll: async () => board.vias.map(v => getters({ PrimitiveId: v.id, Net: v.net, X: m(v.at.x), Y: m(v.at.y), HoleDiameter: m(v.drill), Diameter: m(v.diameter), ViaType: v.stitching ? 1 : 0 })),
		},
		pcb_PrimitivePad: { getAll: async () => board.pads.filter(p => !p.componentId).map(padObj) },
		pcb_PrimitiveComponent: {
			getAll: async () => board.components.map(c => getters({ PrimitiveId: c.id, Designator: c.designator, X: m(c.at.x), Y: m(c.at.y), Rotation: c.rotation, Layer: c.layer })),
			getAllPinsByPrimitiveId: async (id: string) => board.pads.filter(p => p.componentId === id).map(padObj),
		},
		pcb_PrimitivePoured: {
			getAll: async () => board.pours.map(p => getters({
				PrimitiveId: `${p.id}-fill`,
				PourPrimitiveId: isPlane(p) ? undefined : p.id,
				Layer: p.layer,
				PourFills: complex(fillOf(p)).map((source, i) => ({ id: `${i}`, fill: true, lineWidth: 0, path: { getSource: () => source } })),
			})),
		},
		pcb_PrimitivePour: {
			getAll: async () => board.pours.filter(p => !isPlane(p)).map(p => getters({
				PrimitiveId: p.id,
				Net: p.net,
				Layer: p.layer,
				PourName: p.name,
				PourPriority: p.priority,
				ComplexPolygon: { getSource: () => complex(p.outline)[0] ?? [] },
			})),
		},
		pcb_PrimitiveFill: {
			getAll: async () => board.pours.filter(isPlane).map(p => getters({
				PrimitiveId: `${p.id}-plane`,
				Net: p.net,
				Layer: p.layer,
				FillMode: 2,
				ComplexPolygon: { getSource: () => complex(p.outline)[0] ?? [] },
			})),
		},
	};
	return { eda, markers, messages };
}
