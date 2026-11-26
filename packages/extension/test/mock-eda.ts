// In-memory stand-in for the subset of the EasyEDA Pro API the extension uses, serving a core
// Board as API primitives (mil, Y up). Lets the extension run under Node without EasyEDA.
import { buildReferenceCopper, defaultOptions, intersect, scalePaths, splitIslands, type Board, type Path, type Paths, type Pt } from '@returnpath/core';

const MIL = 0.0254;
const m = (mm: number) => mm / MIL;
const ring = (r: Path, origin: Pt = { x: 0, y: 0 }): unknown[] => {
	const [f, ...rest] = r;
	return [m(f.x - origin.x), m(f.y - origin.y), 'L', ...rest.flatMap(p => [m(p.x - origin.x), m(p.y - origin.y)])];
};
const complex = (paths: Paths) => splitIslands(paths).map(island => island.map(r => ring(r)));

/** Pours on `planeLayers` are served like EasyEDA plane layers: poured copper without a pour ID, plus mode-2 fills carrying the net. */
export interface DialogCall {
	kind: 'select' | 'multi' | 'input' | 'confirm';
	prompt: string;
	title: string;
	options: { value: string; displayContent: string }[];
	dflt: string | string[] | undefined;
}

export interface MockHost {
	/** Extension config storage; pass the same map to a second mock to simulate a restart. */
	storage?: Map<string, unknown>;
	/** 'denied' throws like a client without the external-interaction permission; omitted = browser (no file system). */
	fileSystem?: 'allowed' | 'denied';
	/** Unit of pour-fill coordinates in mil (EasyEDA Pro 3.2 stores and returns 10); default 1. */
	pouredUnitMil?: number;
	/** Thermal spokes served as unfilled pour-fill strokes (mm, with their pour id). */
	spokes?: { pourId: string; a: Pt; b: Pt; width: number }[];
}

/** Answers every dialog with its default unless `answer` says otherwise. */
export function createMockEda(board: Board, selectedNet: string, planeLayers: number[] = [], answer: (d: DialogCall) => unknown = d => d.dflt, host: MockHost = {}) {
	const dialogs: { kind: string; prompt: string; options: string[]; dflt: unknown }[] = [];
	// EasyEDA serves computed fills (clearances, keepouts and priorities applied); stand in for them
	// with the core's own computation so pours without a stored fill still match the file pipeline.
	const refCopper = buildReferenceCopper(board, { clearance: defaultOptions.clearance });
	const fillOf = (p: Board['pours'][number]): Paths => p.poured ?? intersect(refCopper.get(p.layer)?.byNet.get(p.net) ?? [], p.outline);
	const isPlane = (p: Board['pours'][number]) => planeLayers.includes(p.layer);

	const markers: { shape: Record<string, unknown>; color: unknown }[] = [];
	const messages: string[] = [];
	const logs: { message: string; type: string }[] = [];
	const progress: { progress?: number; title?: string }[] = [];
	const toasts: string[] = [];
	const storage = host.storage ?? new Map<string, unknown>();
	const files = new Map<string, string>();
	const downloads: { name?: string; text: string }[] = [];
	const counts = { boardReads: 0 };
	const fsCall = <T>(fn: () => T) => async () => {
		if (host.fileSystem === 'denied')
			throw new Error('external interaction is not allowed');
		return fn();
	};
	const progressListeners = new Map<string, (p: { action: string }) => void>();
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

	const pouredObjs = () => board.pours.map(p => getters({
		PrimitiveId: `${p.id}-fill`,
		PourPrimitiveId: isPlane(p) ? undefined : p.id,
		Layer: p.layer,
		PourFills: [
			...complex(scalePaths(fillOf(p), 1 / (host.pouredUnitMil ?? 1))).map((source, i) => ({ id: `${i}`, fill: true, lineWidth: 0, path: { getSource: () => source } })),
			...(host.spokes ?? []).filter(k => k.pourId === p.id).map((k, i) => {
				const u = MIL * (host.pouredUnitMil ?? 1);
				return { id: `spoke${i}`, fill: false, lineWidth: k.width / u, path: { getSource: () => [[k.a.x / u, k.a.y / u, 'L', k.b.x / u, k.b.y / u]] } };
			}),
		],
	}));
	const eda = {
		sys_I18n: { text: (key: string, _ns?: string, _lang?: string, ...args: string[]) => args.reduce((s, a, i) => s.replace(`\${${i + 1}}`, a), key) },
		sys_Log: { add: (message: string, type = 'info') => void logs.push({ message, type }) },
		sys_LoadingAndProgressBar: {
			showProgressBar: (p?: number, title?: string) => void progress.push({ progress: p, title }),
			destroyProgressBar: () => void progress.push({}),
		},
		sys_Event: {
			addProgressBarEventListener: (id: string, fn: (p: { action: string }) => void) => void progressListeners.set(id, fn),
			removeEventListener: (id: string) => progressListeners.delete(id),
		},
		sys_Storage: {
			getExtensionUserConfig: (k: string) => storage.get(k),
			setExtensionUserConfig: async (k: string, v: unknown) => {
				storage.set(k, structuredClone(v));
				return true;
			},
		},
		sys_FileSystem: {
			saveFile: async (data: Blob, name?: string) => void downloads.push({ name, text: await data.text() }),
			...(host.fileSystem
				? {
						getEdaPath: fsCall(() => 'C:\\Users\\me\\Documents\\EasyEDA-Pro'),
						createDirectoryInFileSystem: fsCall(() => true),
						saveFileToFileSystem: async (uri: string, data: Blob) => {
							if (host.fileSystem === 'denied')
								throw new Error('external interaction is not allowed');
							files.set(uri, await data.text());
							return true;
						},
					}
				: {}),
		},
		sys_Message: { showToastMessage: (m: string) => void toasts.push(m) },
		sys_Dialog: {
			showInformationMessage: (content: string) => void messages.push(content),
			showConfirmationMessage: (content: string, title: string, _ok: string, _cancel: string, cb: (ok: boolean) => void) => {
				dialogs.push({ kind: 'confirm', prompt: content, options: [], dflt: undefined });
				cb(!!answer({ kind: 'confirm', prompt: content, title, options: [], dflt: undefined }));
			},
			showSelectDialog: (options: { value: string; displayContent: string }[], before: string, _after: unknown, title: string, dflt: string | string[] | undefined, multiple: boolean, cb: (v: unknown) => void) => {
				dialogs.push({ kind: multiple ? 'multi' : 'select', prompt: before, options: options.map(o => o.value), dflt });
				cb(answer({ kind: multiple ? 'multi' : 'select', prompt: before, title, options, dflt }));
			},
			showInputDialog: (before: string, _after: unknown, title: string, _type: string, value: string, _props: unknown, cb: (v: unknown) => void) => {
				dialogs.push({ kind: 'input', prompt: before, options: [], dflt: value });
				cb(answer({ kind: 'input', prompt: before, title, options: [], dflt: value }));
			},
		},
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
			getAllLayers: async () => board.stackup.copper.map(l => ({ id: l.id, name: l.name, type: planeLayers.includes(l.id) ? 'PLANE' : 'SIGNAL', layerStatus: 1 })),
			getTheNumberOfCopperLayers: async () => board.stackup.copper.length,
		},
		pcb_PrimitiveLine: {
			getAll: async () => (counts.boardReads++, board.tracks.map(t => getters({ PrimitiveId: t.id, Net: t.net, Layer: t.layer, StartX: m(t.a.x), StartY: m(t.a.y), EndX: m(t.b.x), EndY: m(t.b.y), LineWidth: m(t.width) }))),
		},
		pcb_PrimitiveArc: { getAll: async () => [] },
		pcb_PrimitiveVia: {
			getAll: async () => board.vias.map(v => getters({ PrimitiveId: v.id, Net: v.net, X: m(v.at.x), Y: m(v.at.y), HoleDiameter: m(v.drill), Diameter: m(v.diameter), ViaType: v.stitching ? 1 : 0 })),
		},
		pcb_PrimitivePad: { getAll: async () => board.pads.filter(p => !p.componentId).map(padObj) },
		pcb_PrimitiveComponent: {
			getAll: async () => board.components.map(c => getters({ PrimitiveId: c.id, Designator: c.designator, Name: c.name, X: m(c.at.x), Y: m(c.at.y), Rotation: c.rotation, Layer: c.layer })),
			getAllPinsByPrimitiveId: async (id: string) => board.pads.filter(p => p.componentId === id).map(padObj),
		},
		pcb_PrimitivePoured: {
			getAllPrimitiveId: async () => board.pours.map(p => `${p.id}-fill`),
			get: async (id: string) => pouredObjs().find(o => o.getState_PrimitiveId() === id),
			getAll: async () => pouredObjs(),
		},
		pcb_PrimitivePolyline: {
			getAll: async (_net?: string, layer?: number) => board.outline
				.filter(() => layer === undefined || layer === 11)
				.map((r, i) => getters({ PrimitiveId: `outline-${i}`, Net: '', Layer: 11, Polygon: { getSource: () => ring(r) } })),
		},
		pcb_PrimitiveRegion: {
			getAll: async () => board.keepouts.map(k => getters({
				PrimitiveId: k.id,
				Layer: k.layer === -1 ? 12 : k.layer,
				RuleType: [7],
				ComplexPolygon: { getSource: () => complex(k.outline)[0] ?? [] },
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
	/** Simulates the user closing the progress bar. */
	const closeProgressBar = () => progressListeners.forEach(fn => fn({ action: 'close' }));
	return { eda, markers, messages, dialogs, logs, progress, toasts, closeProgressBar, storage, files, downloads, counts };
}
