// Reads the open PCB through the EasyEDA Pro API into the core board model.
// Almost every call used here is @beta, so all API access stays in this module and overlay.ts.
import {
	arcPoints,
	area,
	bbox,
	circle,
	decodeComplex,
	decodeRings,
	pointInPaths,
	pouredScale,
	intersect,
	rect,
	rotate,
	scalePaths,
	splitIslands,
	strokePath,
	union,
	MULTI_LAYER,
	type Board,
	type Component,
	type CopperLayer,
	type Dielectric,
	type Keepout,
	type Pad,
	type Paths,
	type Pour,
	type Pt,
	type Track,
	type Via,
} from '@returnpath/core';
import extensionConfig from '../extension.json' with { type: 'json' };
import { checkpoint, log, readStored, TimedOut, withTimeout, writeStored, yieldToEditor } from './runner';

const VERSION = extensionConfig.version;

export const MIL = 0.0254;
const LAYER_MULTI = 12;
const LAYER_OUTLINE = 11;
const LAYER_TOP = 1;
const LAYER_BOTTOM = 2;
/** EPCB_PrimitiveRegionRuleType: NO_POURS keeps all pour copper out, NO_INNER_ELECTRICAL_LAYERS only plane-layer copper. */
const NO_POURS = 7;
const NO_PLANES = 8;

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

/** Copper foil thickness in the stackup unit; values outside 5–210 µm are taken for a unit mix-up and dropped. */
function copperMm(t: number, warnings: string[]): number | undefined {
	if (!(t > 0))
		return undefined;
	if (t >= 0.005 && t <= 0.21)
		return t;
	warnings.push(`Copper thickness ${t} mm from getStackup() is implausible; using the default.`);
	return undefined;
}

/** Time limits for API calls; tests shorten them. */
export const apiTimeouts = { callMs: 60_000, stackupMs: 15_000, pinsMs: 20_000, pouredTotalMs: 20_000, pouredSlowMs: 3_000, decodeMs: 10_000 };

/** Set while computed pour fills are fetched; still set at the next start means the editor hung there. */
const POURED_MARKER = 'fetchingPouredSince';

/**
 * Logs an API call before making it, saves the log, then waits for it with a time limit. If the
 * editor hangs inside the call, the saved log ends with its name.
 */
async function call<T>(name: string, fn: () => Promise<T> | T, timeoutMs = apiTimeouts.callMs): Promise<T> {
	log(`read board: ${name}…`);
	await checkpoint();
	return withTimeout(fn(), timeoutMs, name);
}

/**
 * Schematic pin names by designator, then pad number, from an EasyEDA netlist: components keyed by
 * id, each with props.Designator and a pinInfoMap of { number, name }. Unknown shapes give none.
 */
export function parsePinNames(text: string): Map<string, Map<string, string>> {
	const out = new Map<string, Map<string, string>>();
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	}
	catch {
		return out;
	}
	const obj = (v: unknown) => (v && typeof v === 'object' ? v as Record<string, unknown> : undefined);
	const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : undefined);
	const comps = obj(obj(doc)?.components) ?? obj(doc) ?? {};
	for (const c of Object.values(comps).map(obj)) {
		const props = obj(c?.props) ?? {};
		const des = str(props.Designator ?? props.designator ?? c?.designator);
		const pins = obj(c?.pinInfoMap ?? c?.pins);
		if (!des || !pins)
			continue;
		const names = new Map<string, string>();
		for (const [key, p] of Object.entries(pins)) {
			const pin = obj(p);
			const name = str(pin?.name ?? pin?.pinName);
			if (name)
				names.set(str(pin?.number ?? pin?.pinNumber) ?? key, name);
		}
		if (names.size)
			out.set(des, names);
	}
	return out;
}

/** Fills Pad.pinName from the board's netlist, so DC loads return only through their ground pins. */
export async function addPinNames(board: Board): Promise<number> {
	let text: string | undefined;
	try {
		text = await call('pcb_Net.getNetlist', () => eda.pcb_Net.getNetlist('EasyEDA' as ESYS_NetlistType), apiTimeouts.stackupMs);
	}
	catch (e) {
		log(`pin names: netlist not available (${e instanceof Error ? e.message : String(e)}); every ground pad of a load starts a return`, 'warn');
		return 0;
	}
	const names = parsePinNames(text ?? '');
	if (!names.size) {
		log(`pin names: none found in the netlist (${(text ?? '').length} characters, starts ${JSON.stringify((text ?? '').slice(0, 160))}); every ground pad of a load starts a return`, 'warn');
		return 0;
	}
	const designators = new Map(board.components.map(c => [c.id, c.designator]));
	let n = 0;
	for (const p of board.pads) {
		const name = p.componentId ? names.get(designators.get(p.componentId) ?? '')?.get(p.number) : undefined;
		if (name) {
			p.pinName = name;
			n++;
		}
	}
	log(`pin names: ${n} of ${board.pads.filter(p => p.componentId).length} component pads named from the netlist (${names.size} parts)`);
	return n;
}

async function readStackup(warnings: string[]): Promise<Board['stackup']> {
	const copper: CopperLayer[] = [];
	const dielectrics: Dielectric[] = [];
	let s: Awaited<ReturnType<typeof eda.pcb_Layer.getStackup>> | undefined;
	if (typeof eda.pcb_Layer.getStackup === 'function') {
		try {
			s = await call('pcb_Layer.getStackup', () => eda.pcb_Layer.getStackup(), apiTimeouts.stackupMs);
		}
		catch (e) {
			log(`read board: pcb_Layer.getStackup failed (${e instanceof Error ? e.message : String(e)}); using the layer list`, 'warn');
		}
	}
	if (s?.layers) {
		const k = unitToMm(s.unit);
		let z = 0;
		let pending: Dielectric | undefined;
		for (const l of [...s.layers].sort((a, b) => a.zIndex - b.zIndex)) {
			if (l.kind === 'copper') {
				if (copper.length)
					dielectrics.push(pending ?? { name: 'unknown', thicknessMm: 0.2 });
				copper.push({ id: l.layerId, name: l.layerName, index: copper.length, z, thicknessMm: copperMm(l.thickness * k, warnings) });
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
		copper.length = 0;
		dielectrics.length = 0;
		// getAllLayers lists every possible inner layer; keep the ones the board uses.
		const all = (await call('pcb_Layer.getAllLayers', () => eda.pcb_Layer.getAllLayers())).filter(l => l.type === 'SIGNAL' || l.type === 'PLANE');
		let count: number | undefined;
		if (typeof eda.pcb_Layer.getTheNumberOfCopperLayers === 'function') {
			try {
				count = await call('pcb_Layer.getTheNumberOfCopperLayers', () => eda.pcb_Layer.getTheNumberOfCopperLayers(), apiTimeouts.stackupMs);
			}
			catch {}
		}
		const INNER_1 = 15;
		const layers = all.filter(l => (l.layerStatus as number | undefined) !== 0 && (!count || l.id === 1 || l.id === 2 || (l.id >= INNER_1 && l.id < INNER_1 + count - 2)));
		log(`read board: ${layers.length} copper layers in use (board says ${count ?? '?'}; ${all.length} listed)`);
		const order = (id: number) => (id === 1 ? -1 : id === 2 ? 1000 : id);
		layers.sort((a, b) => order(a.id) - order(b.id));
		const gaps = assumedDielectricsMm(layers.length);
		let z = 0;
		layers.forEach((l, i) => {
			if (i) {
				z += gaps[i - 1];
				dielectrics.push({ name: `assumed D${i}`, thicknessMm: gaps[i - 1] });
			}
			copper.push({ id: l.id, name: l.name, index: i, z });
		});
		warnings.push(`This EasyEDA version does not give the layer stack to extensions; assuming a 1.6 mm board with dielectrics of ${gaps.map(g => `${g} mm`).join(', ')}.`);
	}
	return { copper, dielectrics };
}

/**
 * Dielectric thicknesses (top to bottom) of a common 1.6 mm board when the stack is unknown:
 * 2 layers = one 1.5 mm core; 4 layers = JLCPCB's default 7628 stack; more = 0.2 mm outer prepregs
 * with the rest split evenly.
 */
export function assumedDielectricsMm(copperLayers: number): number[] {
	if (copperLayers < 2)
		return [];
	if (copperLayers === 2)
		return [1.5];
	if (copperLayers === 4)
		return [0.21, 1.065, 0.21];
	const inner = +((1.5 - 0.4) / (copperLayers - 3)).toFixed(3);
	return [0.2, ...Array.from({ length: copperLayers - 3 }, () => inner), 0.2];
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

type PlaneFill = { net: string; layer: number; shape: Paths };

/** The plane partition an island of plane copper belongs to: by bounding box, then a point test, and only then by overlap area. */
function matchPlane(island: Paths, layer: number, planes: PlaneFill[], boxes: ReturnType<typeof bbox>[]): PlaneFill | undefined {
	const b = bbox(island);
	const near = planes.filter((p, i) => p.layer === layer && boxes[i].minX <= b.maxX && boxes[i].maxX >= b.minX && boxes[i].minY <= b.maxY && boxes[i].maxY >= b.minY);
	if (near.length <= 1)
		return near[0];
	const probe = island[0]?.[0];
	if (probe) {
		const inside = near.filter(p => pointInPaths(probe, p.shape));
		if (inside.length === 1)
			return inside[0];
	}
	let best: PlaneFill | undefined;
	let bestArea = 0;
	for (const p of near) {
		const overlap = area(intersect(island, p.shape));
		if (overlap > bestArea) {
			bestArea = overlap;
			best = p;
		}
	}
	return best;
}

/** The board outline: polylines on the outline layer, else the bounding box of outline line segments. */
async function readOutline(segments: Pt[][], warnings: string[]): Promise<Paths> {
	const rings: Paths = [];
	const api = eda.pcb_PrimitivePolyline;
	if (typeof api?.getAll === 'function') {
		try {
			for (const pl of await call('pcb_PrimitivePolyline.getAll (board outline)', () => api.getAll(undefined, LAYER_OUTLINE as never))) {
				if ((pl.getState_Layer() as number) !== LAYER_OUTLINE)
					continue;
				rings.push(...decodeRings(pl.getState_Polygon().getSource(), conv, MIL).filter(r => r.length >= 3));
			}
		}
		catch (e) {
			log(`read board: board outline not readable (${e instanceof Error ? e.message : String(e)})`, 'warn');
		}
	}
	if (rings.length)
		return union(rings);
	if (segments.length) {
		const b = bbox(segments);
		warnings.push('Board outline built from line segments; using their bounding box.');
		return [rect((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.maxX - b.minX, b.maxY - b.minY)];
	}
	warnings.push('No board outline found; copper computed from pour outlines is not clipped to the board.');
	return [];
}

/** Regions that forbid pours or plane copper. */
async function readKeepouts(copperIds: Set<number>): Promise<Keepout[]> {
	const api = eda.pcb_PrimitiveRegion;
	if (typeof api?.getAll !== 'function')
		return [];
	const out: Keepout[] = [];
	try {
		for (const r of await call('pcb_PrimitiveRegion.getAll (keepouts)', () => api.getAll())) {
			const rules = (r.getState_RuleType() ?? []) as number[];
			const layer = r.getState_Layer() as number;
			const id = r.getState_PrimitiveId();
			let layers: number[] = [];
			if (rules.includes(NO_POURS))
				layers = layer === LAYER_MULTI ? [MULTI_LAYER] : [layer];
			else if (rules.includes(NO_PLANES))
				layers = (layer === LAYER_MULTI ? [...copperIds] : [layer]).filter(l => l !== LAYER_TOP && l !== LAYER_BOTTOM);
			layers = layers.filter(l => l === MULTI_LAYER || copperIds.has(l));
			const outline = layers.length ? decodeComplex(r.getState_ComplexPolygon().getSource(), conv, MIL) : [];
			log(`read board: region ${id}: rules [${rules.join(', ')}], layer ${layer}${layers.length ? `, ${Math.round(Math.abs(area(outline)))} mm², keeps pours out of ${layers[0] === MULTI_LAYER ? 'all layers' : `layer ${layers.join(', ')}`}` : ', ignored'}`);
			for (const l of layers) out.push({ id: layers.length > 1 ? `${id}@${l}` : id, layer: l, outline });
		}
	}
	catch (e) {
		log(`read board: keepout regions not readable (${e instanceof Error ? e.message : String(e)})`, 'warn');
	}
	return out;
}

type Poured = Awaited<ReturnType<typeof eda.pcb_PrimitivePoured.getAll>>[number];
type PourFill = ReturnType<Poured['getState_PourFills']>[number];

/** Describes an unexpected API value for the log: its type and keys, not its (possibly huge) content. */
function shapeOf(x: unknown): string {
	if (Array.isArray(x))
		return `array(${x.length})${x.length ? ` of ${shapeOf(x[0])}` : ''}`;
	if (x && typeof x === 'object') {
		const keys = new Set<string>(Object.keys(x));
		for (let o = Object.getPrototypeOf(x); o && o !== Object.prototype; o = Object.getPrototypeOf(o))
			for (const k of Object.getOwnPropertyNames(o)) keys.add(k);
		return `object {${[...keys].slice(0, 25).join(', ')}}`;
	}
	return typeof x;
}

/**
 * `pcb_PrimitivePoured.get(id)` is documented to return the primitive object, but in some clients it
 * returns something else (an array, or plain state). Accept those and report anything unknown.
 */
function asPoured(x: unknown): Poured | undefined {
	const o = (Array.isArray(x) ? x[0] : x) as Record<string, unknown> | undefined;
	if (!o || typeof o !== 'object')
		return undefined;
	if (typeof o.getState_Layer === 'function' && typeof o.getState_PourFills === 'function')
		return o as unknown as Poured;
	// Seen in EasyEDA Pro (API 0.3.59): the primitive without getState_Layer.
	const field = (name: string) => {
		const getter = o[`getState_${name}`];
		if (typeof getter === 'function')
			return (getter as () => unknown).call(o);
		return o[name] ?? o[name[0].toLowerCase() + name.slice(1)];
	};
	if (!Array.isArray(field('PourFills')))
		throw new Error(`pcb_PrimitivePoured.get returned ${shapeOf(x)}`);
	return {
		getState_PrimitiveId: () => field('PrimitiveId'),
		getState_Layer: () => field('Layer'),
		getState_PourPrimitiveId: () => field('PourPrimitiveId'),
		getState_PourFills: () => field('PourFills'),
	} as unknown as Poured;
}

/** The complex-polygon source of one fill region, whether `path` is an IPCB_ComplexPolygon or already its source. */
function fillSource(f: PourFill): unknown {
	const path = f.path as unknown as { getSource?: () => unknown; source?: unknown } | unknown[];
	if (Array.isArray(path))
		return path;
	return typeof path?.getSource === 'function' ? path.getSource() : path?.source;
}

/** Pour-fill IDs whose fetch froze the editor; they are never fetched again by this version. */
const SKIP_POURED = 'pouredIdsThatHang';

/**
 * Markers and skip lists carry the version that wrote them. A newer build may have fixed what froze
 * (0.1.8 did: every hang until then was the extension's own), so older entries are dropped.
 */
const stamp = (s: string) => `${VERSION} ${s}`;

/** The pour fills a previous run of this version was working on when the editor hung. `'*'`: inside getAll. */
function hungFetch(marker: unknown): { ids: string[]; while: string } | undefined {
	const m = typeof marker === 'string' ? /^(\S+) (getAll|get|decode|union):?(.*)$/.exec(marker) : null;
	if (!m || m[1] !== VERSION)
		return undefined;
	if (m[2] === 'getAll')
		return { ids: ['*'], while: 'fetching' };
	return { ids: m[3].split(','), while: { get: 'fetching', decode: 'decoding', union: 'merging' }[m[2]]! };
}

function storedSkipList(): Set<string> {
	const stored = readStored(SKIP_POURED) as { version?: string; ids?: unknown[] } | unknown[] | undefined;
	if (!stored || Array.isArray(stored) || stored.version !== VERSION)
		return new Set();
	return new Set((stored.ids ?? []).filter((x): x is string => typeof x === 'string'));
}

/**
 * Fetches the computed pour fills one at a time. EasyEDA computes them in the editor itself, and
 * some fetches freeze the editor, which no time limit can interrupt. The fill being fetched is
 * stored first; if the editor hangs, the next run adds it to a skip list and computes that pour from
 * its outline (clearances approximated). Decoding and merging a fill store their fill the same way.
 * Slow fetches switch the rest to outlines too.
 */
async function readPoured(warnings: string[]): Promise<{ poured: Poured[]; skippedIds: Set<string>; allSkipped: boolean }> {
	const marker = readStored(POURED_MARKER);
	const skip = storedSkipList();
	const hung = hungFetch(marker);
	if (marker && !hung)
		log(`read board: ignoring what an older version stored about pour fills that froze (${String(marker)}); this version fixed the known causes`);
	await writeStored(POURED_MARKER, '');
	if (hung?.ids[0] === '*') {
		const msg = 'The previous run froze while fetching computed pour fills; pours are computed from their outlines this time.';
		log(`read board: ${msg}`, 'warn');
		warnings.push(msg);
		return { poured: [], skippedIds: new Set(), allSkipped: true };
	}
	const fresh = hung?.ids.filter(id => !skip.has(id)) ?? [];
	if (fresh.length) {
		fresh.forEach(id => skip.add(id));
		await writeStored(SKIP_POURED, { version: VERSION, ids: [...skip].slice(-50) });
		log(`read board: the previous run froze while ${hung!.while} computed pour fill ${fresh.join(', ')}; it is skipped from now on`, 'warn');
	}
	const api = eda.pcb_PrimitivePoured;
	const ids = typeof api.getAllPrimitiveId === 'function' ? await call('pcb_PrimitivePoured.getAllPrimitiveId', () => api.getAllPrimitiveId()) : undefined;
	const skippedIds = new Set<string>();
	try {
		if (!ids) {
			await writeStored(POURED_MARKER, stamp('getAll'));
			return { poured: await call('pcb_PrimitivePoured.getAll', () => api.getAll()), skippedIds, allSkipped: false };
		}
		const out: Poured[] = [];
		const t0 = clock();
		for (const [i, id] of ids.entries()) {
			if (skip.has(id)) {
				skippedIds.add(id);
				log(`read board: pour fill ${i + 1}/${ids.length} (${id}) skipped: it froze the editor before`, 'warn');
				continue;
			}
			if (clock() - t0 > apiTimeouts.pouredTotalMs) {
				const msg = `Fetching computed pour fills took over ${Math.round(apiTimeouts.pouredTotalMs / 1000)} s; ${ids.length - i} of ${ids.length} are computed from their outlines.`;
				log(`read board: ${msg}`, 'warn');
				warnings.push(msg);
				ids.slice(i).forEach(x => skippedIds.add(x));
				return { poured: out, skippedIds, allSkipped: false };
			}
			await writeStored(POURED_MARKER, stamp(`get:${id}`));
			const t1 = clock();
			const raw: unknown = await call(`pcb_PrimitivePoured.get ${i + 1}/${ids.length} (${id})`, () => api.get(id));
			const ms = clock() - t1;
			if (i === 0 || !out.length)
				log(`read board: pcb_PrimitivePoured.get returns ${shapeOf(raw)}`);
			log(`read board: ${id} returned after ${Math.round(ms)} ms; reading its fill regions…`);
			await checkpoint();
			const p = asPoured(raw);
			if (p) {
				out.push(p);
				const fills = p.getState_PourFills();
				let values = 0;
				for (const f of fills) values += (fillSource(f) as unknown[] | undefined)?.length ?? 0;
				log(`read board: poured ${id}: pour ${p.getState_PourPrimitiveId() ?? '-'}, layer ${p.getState_Layer() ?? '?'}, ${fills.length} fill regions, ${values} path values, ${Math.round(clock() - t1)} ms`);
			}
			if (clock() - t1 > apiTimeouts.pouredSlowMs) {
				const msg = `Fetching computed pour fill ${id} took ${Math.round((clock() - t1) / 1000)} s; the remaining ${ids.length - i - 1} are computed from their outlines.`;
				log(`read board: ${msg}`, 'warn');
				warnings.push(msg);
				ids.slice(i + 1).forEach(x => skippedIds.add(x));
				return { poured: out, skippedIds, allSkipped: false };
			}
			await yieldToEditor();
		}
		return { poured: out, skippedIds, allSkipped: false };
	}
	catch (e) {
		// Pour fills only refine accuracy; any failure here falls back to outlines instead of ending the run.
		const err = e instanceof Error ? e : new Error(String(e));
		log(`read board: ${err.message}; pours are computed from their outlines${e instanceof TimedOut || !err.stack ? '' : `\n${err.stack}`}`, 'warn');
		warnings.push(`Computed pour fills could not be read (${err.message}); pours are computed from their outlines.`);
		return { poured: [], skippedIds, allSkipped: true };
	}
	finally {
		await writeStored(POURED_MARKER, '');
	}
}

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Builds the core board model from the open PCB. Fills must be current; stale pours fall back to outlines. */
export async function readBoard(): Promise<Board> {
	const warnings: string[] = [];
	let t0 = clock();
	// Logs what was read, saves the log and lets the editor repaint before the next group.
	const step = async (what: string) => {
		log(`read board: ${what} (${Math.round(clock() - t0)} ms)`);
		await checkpoint();
		await yieldToEditor();
		t0 = clock();
	};
	const stackup = await readStackup(warnings);
	await step(`stackup, ${stackup.copper.length} copper layers`);
	const copperIds = new Set(stackup.copper.map(l => l.id));

	const tracks: Track[] = [];
	const outlineSegments: Pt[][] = [];
	for (const l of await call('pcb_PrimitiveLine.getAll', () => eda.pcb_PrimitiveLine.getAll())) {
		const layer = l.getState_Layer() as number;
		if (layer === LAYER_OUTLINE)
			outlineSegments.push([conv(l.getState_StartX(), l.getState_StartY()), conv(l.getState_EndX(), l.getState_EndY())]);
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
	for (const arc of await call('pcb_PrimitiveArc.getAll', () => eda.pcb_PrimitiveArc.getAll())) {
		const layer = arc.getState_Layer() as number;
		if (!copperIds.has(layer))
			continue;
		const pts = arcPoints(conv(arc.getState_StartX(), arc.getState_StartY()), conv(arc.getState_EndX(), arc.getState_EndY()), arc.getState_ArcAngle());
		for (let i = 1; i < pts.length; i++) {
			tracks.push({ id: `${arc.getState_PrimitiveId()}#${i}`, net: arc.getState_Net(), layer, a: pts[i - 1], b: pts[i], width: arc.getState_LineWidth() * MIL });
		}
	}

	await step(`${tracks.length} track segments from lines and arcs`);

	const vias: Via[] = (await call('pcb_PrimitiveVia.getAll', () => eda.pcb_PrimitiveVia.getAll())).map(v => ({
		id: v.getState_PrimitiveId(),
		net: v.getState_Net(),
		at: conv(v.getState_X(), v.getState_Y()),
		drill: v.getState_HoleDiameter() * MIL,
		diameter: v.getState_Diameter() * MIL,
		stitching: (v.getState_ViaType() as number) === 1,
	}));

	const pads: Pad[] = (await call('pcb_PrimitivePad.getAll', () => eda.pcb_PrimitivePad.getAll())).map(p => toPad(p));
	await step(`${vias.length} vias, ${pads.length} free pads`);
	const components: Component[] = [];
	const allComponents = await call('pcb_PrimitiveComponent.getAll', () => eda.pcb_PrimitiveComponent.getAll());
	log(`read board: pcb_PrimitiveComponent.getAllPinsByPrimitiveId for ${allComponents.length} components…`);
	let lastReport = clock();
	for (const [i, c] of allComponents.entries()) {
		const id = c.getState_PrimitiveId();
		if (clock() - lastReport > 2000) {
			log(`read board: pins of component ${i + 1} of ${allComponents.length} (${c.getState_Designator() ?? id})`);
			await checkpoint();
			lastReport = clock();
		}
		let pins: Awaited<ReturnType<typeof eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId>> = [];
		try {
			pins = (await withTimeout(eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(id), apiTimeouts.pinsMs, `pins of ${c.getState_Designator() ?? id}`)) ?? [];
		}
		catch (e) {
			if (!(e instanceof TimedOut))
				throw e;
			warnings.push(`${e.message}; its pads are left out.`);
			log(`read board: ${e.message}`, 'warn');
		}
		const own = pins.map(p => toPad(p, id));
		pads.push(...own);
		components.push({
			id,
			designator: c.getState_Designator() ?? id,
			name: c.getState_Name(),
			at: conv(c.getState_X(), c.getState_Y()),
			rotation: c.getState_Rotation(),
			layer: c.getState_Layer() as number,
			padIds: own.map(p => p.id),
		});
	}

	await step(`${components.length} components, ${pads.length} pads with pins`);

	// Plane-layer partitions are fills with mode INNER_ELECTRICAL_LAYER (2); they carry the net that
	// plane copper (poured, but with no pour) lacks. Other copper fills are solid copper as drawn.
	const planeFills: { net: string; layer: number; shape: Paths }[] = [];
	const pours: Pour[] = [];
	for (const f of await call('pcb_PrimitiveFill.getAll', () => eda.pcb_PrimitiveFill.getAll())) {
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

	await step(`${planeFills.length} plane partitions, ${pours.length} solid fills`);

	// Collect every piece first and union once per pour or plane: unioning piece by piece regrows the
	// whole polygon each time, which on a big plane is quadratic and freezes the editor.
	const ringsByPour = new Map<string, Paths>();
	const islandsByPlane = new Map<string, { plane: typeof planeFills[number]; islands: Paths }>();
	const planeBoxes = planeFills.map(p => bbox(p.shape));
	const { poured: pouredAll, skippedIds, allSkipped } = await readPoured(warnings);
	let pieces = 0;
	let islandCount = 0;
	let sliceStart = clock();
	const breathe = async () => {
		if (clock() - sliceStart > 30) {
			await yieldToEditor();
			sliceStart = clock();
		}
	};
	const pouredOfPour = new Map<string, string[]>();
	for (const poured of pouredAll) {
		const pouredId = String(poured.getState_PrimitiveId());
		await writeStored(POURED_MARKER, stamp(`decode:${pouredId}`));
		log(`read board: decoding pour fill ${pouredId}…`);
		await checkpoint();
		const rings: Paths = [];
		const t1 = clock();
		let points = 0;
		try {
			const fills = poured.getState_PourFills();
			for (const f of fills) {
				const src = fillSource(f) as Parameters<typeof decodeComplex>[0];
				// Unfilled regions are thermal spokes and similar strokes, drawn with their line width.
				const width = Number((f as { lineWidth?: number; strokeWidth?: number }).lineWidth ?? (f as { strokeWidth?: number }).strokeWidth) * MIL;
				const decoded = f.fill ? decodeComplex(src, conv, MIL) : width > 0 ? union(...decodeRings(src, conv, MIL).filter(r => r.length >= 2).map(r => strokePath(r.length > 2 ? [...r, r[0]] : r, width))) : [];
				for (const r of decoded) {
					if (r.every(q => Number.isFinite(q.x) && Number.isFinite(q.y))) {
						rings.push(r);
						points += r.length;
					}
				}
				if (clock() - t1 > apiTimeouts.decodeMs)
					throw new Error(`decoding took over ${Math.round(apiTimeouts.decodeMs / 1000)} s`);
				await breathe();
			}
			log(`read board: decoded ${pouredId}: ${fills.length} fill regions, ${rings.length} rings, ${points} points, ${Math.round(clock() - t1)} ms`);
		}
		catch (e) {
			const msg = `Computed pour fill ${pouredId} could not be decoded (${e instanceof Error ? e.message : String(e)}); its pour is computed from its outline.`;
			log(`read board: ${msg}`, 'warn');
			warnings.push(msg);
			continue;
		}
		pieces += rings.length;
		const pourId = poured.getState_PourPrimitiveId();
		if (pourId) {
			const list = ringsByPour.get(pourId) ?? [];
			for (const r of rings) list.push(r);
			ringsByPour.set(pourId, list);
			pouredOfPour.set(pourId, [...(pouredOfPour.get(pourId) ?? []), pouredId]);
			continue;
		}
		const layer = poured.getState_Layer() as number | undefined;
		if (layer === undefined) {
			warnings.push(`Plane copper ${poured.getState_PrimitiveId()} has no layer in this EasyEDA version; its plane outline is used instead.`);
			continue;
		}
		for (const island of splitIslands(rings)) {
			islandCount++;
			const plane = matchPlane(island, layer, planeFills, planeBoxes);
			await breathe();
			if (!plane) {
				warnings.push(`Plane copper on layer ${layer} at (${island[0][0].x.toFixed(1)}, ${island[0][0].y.toFixed(1)}) matches no plane fill; skipped.`);
				continue;
			}
			const key = `${layer}:${plane.net}`;
			const entry = islandsByPlane.get(key) ?? { plane, islands: [] };
			for (const r of island) entry.islands.push(r);
			islandsByPlane.set(key, entry);
		}
	}
	await step(`${pouredAll.length} computed copper areas, ${pieces} rings, ${islandCount} plane islands`);

	const fillsByPour = new Map<string, Paths>();
	for (const [id, rings] of ringsByPour) {
		await writeStored(POURED_MARKER, stamp(`union:${(pouredOfPour.get(id) ?? [id]).join(',')}`));
		log(`read board: merging ${rings.length} rings of pour ${id}…`);
		await checkpoint();
		const t1 = clock();
		fillsByPour.set(id, union(rings));
		log(`read board: merged pour ${id} into ${fillsByPour.get(id)!.length} rings, ${Math.round(clock() - t1)} ms`);
		await breathe();
	}
	await writeStored(POURED_MARKER, '');
	for (const [key, { plane, islands }] of islandsByPlane) {
		pours.push({ id: `plane-${key}`, net: plane.net, layer: plane.layer, name: 'plane', priority: 0, outline: plane.shape, poured: union(islands) });
		await breathe();
	}
	for (const plane of planeFills) {
		if (!islandsByPlane.has(`${plane.layer}:${plane.net}`)) {
			warnings.push(`Plane fill ${plane.net} on layer ${plane.layer} has no computed copper; using its outline.`);
			pours.push({ id: `plane-${plane.layer}:${plane.net}`, net: plane.net, layer: plane.layer, name: 'plane', priority: 0, outline: plane.shape });
		}
	}
	await step(`merged ${ringsByPour.size} pours and ${islandsByPlane.size} planes`);

	for (const p of await call('pcb_PrimitivePour.getAll', () => eda.pcb_PrimitivePour.getAll())) {
		const id = p.getState_PrimitiveId();
		const outline = decodeComplex(p.getState_ComplexPolygon().getSource(), conv, MIL);
		let poured = fillsByPour.get(id);
		if (poured) {
			const k = pouredScale(outline, poured);
			if (k !== 1)
				log(`read board: pour ${id}: fill coordinates are in units of ${k} mil; scaled to match the pour outline`);
			poured = scalePaths(poured, k);
		}
		const outlineArea = Math.abs(area(outline));
		const fillArea = poured ? Math.abs(area(poured)) : 0;
		log(`read board: pour ${id} "${p.getState_PourName()}" (${p.getState_Net()}), layer ${p.getState_Layer()}, priority ${p.getState_PourPriority()}: outline ${Math.round(outlineArea)} mm², ${poured ? `computed fill ${Math.round(fillArea)} mm² in ${poured.length} rings` : 'no computed fill'}`);
		if (poured && !(fillArea > 0) && outlineArea > 0) {
			const msg = `Pour "${p.getState_PourName()}" (${p.getState_Net()}) has an empty computed fill; it is computed from its outline.`;
			log(`read board: ${msg}`, 'warn');
			warnings.push(msg);
			poured = undefined;
		}
		if (!poured && skippedIds.size)
			warnings.push(`Pour "${p.getState_PourName()}" (${p.getState_Net()}) is computed from its outline: EasyEDA froze when asked for its fill.`);
		else if (!poured && !allSkipped)
			warnings.push(`Pour "${p.getState_PourName()}" (${p.getState_Net()}) has no computed fill; rebuild copper for accurate results.`);
		pours.push({
			id,
			net: p.getState_Net(),
			layer: p.getState_Layer() as number,
			name: p.getState_PourName(),
			priority: p.getState_PourPriority(),
			outline,
			poured,
		});
	}
	await step(`${pours.length} pours, fills and planes in total`);

	const nets = [...new Set([...tracks.map(t => t.net), ...vias.map(v => v.net), ...pads.map(p => p.net)].filter(Boolean))].sort();
	const outline = await readOutline(outlineSegments, warnings);
	const keepouts = await readKeepouts(copperIds);
	await step(`board outline ${outline.length ? `${outline.length} ring(s)` : 'missing'}, ${keepouts.length} pour keepouts`);
	return { outline, stackup, nets, tracks, vias, pads, components, pours, keepouts, warnings };
}
