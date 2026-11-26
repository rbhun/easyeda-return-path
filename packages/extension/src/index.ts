/**
 * Extension entry. Every function exported here can be referenced by name from
 * `headerMenus[*].menuItems[*].registerFn` in extension.json.
 * API guide: https://prodocs.easyeda.com/en/api/guide/
 */
import { analyzeNetSteps, buildDcSetup, classifySignal, CLOCK_KIND, formatHz, GENERIC, guessDrivers, hfApplicability, hfCandidates, netInfo, signalKindForProtocol, solveDcSteps, summariseSignal, traceStreamlines, withNet, DRAWN_STREAMS, FOCUS_STREAMS, focusInput, guessRails, padsOf, railLabel, railNetsOf, type Board, type BoardInfo, type DcSetupInput, type NetInfo, type Pad, type SignalKind, type Tick } from '@returnpath/core';
import extensionConfig from '../extension.json' with { type: 'json' };
import { boardInfo } from './board-info';
import { carriesCurrent, drawDc } from './dc-overlay';
import { addPinNames, readBoard, selectedNet, selectedPart, type SelectedPart } from './eda-board';
import { clearOverlay, drawAnalysis, leftoverOverlay, overlayState, toggleOverlay } from './overlay';
import { autoOpenPanel, forwardOverlayCommand, initPanel, panelReady, openPanel, publishState, releaseOverlay, report, shareLastRun, sharedLastRun } from './panel';
import { beginRun, boardSizes, cancelRunning, checkpoint, chosenRunFolder, endRun, guarded, log, logFileProblem, logFilePath, logStartup, readStored, recordResult, runFolderStatus, runSteps, savedLog, saveLogAs, setRunFolder as storeRunFolder, timed, toast, unwrittenRun, writeStored, writeUnwrittenRun } from './runner';
import { roleColour } from './style';
import { dialogAsk, loggedAsk, runDcWizard, withBack, type Ask } from './wizard';
import { cancelWizardQuestion } from './wizard-window';
import { t } from './i18n';

const HF_BUDGET_MS = 60_000;
const DC_BUDGET_MS = 120_000;

// eslint-disable-next-line unused-imports/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {
	logStartup();
	initPanel(panelHost);
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(`${t('Return-path overlay v${1}', extensionConfig.version)}\n\n${t('Analyses, the overlay and its colours are in the panel: Return Path > Open Panel. If the editor froze, reopen it and use Return Path > Show Saved Log.')}`, t('About'));
}

function confirm(content: string, title: string, ok: string): Promise<boolean> {
	return new Promise((resolve) => {
		eda.sys_Dialog.showConfirmationMessage(content, title, ok, t('Cancel'), clicked => resolve(!!clicked));
	});
}

/** Progress of the high-frequency analysis: chains carry the bulk of the work. */
function hfPercent() {
	let chainStart = 5;
	let chainSpan = 85;
	let last = 0;
	const within: Record<string, [number, number]> = { 'band coverage': [0, 0.2], 'sampling': [0.2, 0.2], 'gaps': [0.4, 0.6] };
	return (tick: Tick) => {
		const f = tick.fraction ?? 0;
		if (tick.phase === 'reference copper') {
			last = 5 * f;
		}
		else if (tick.phase === 'chains') {
			chainSpan = 85 / (tick.steps || 1);
			chainStart = 5 + 85 * f;
			last = chainStart;
		}
		else if (tick.phase === 'vias') {
			last = 90 + 3 * f;
		}
		else if (tick.phase === 'return path') {
			last = Math.max(last, 93 + 7 * f);
		}
		else if (within[tick.phase]) {
			const [a, w] = within[tick.phase];
			last = Math.max(last, chainStart + chainSpan * (a + w * f));
		}
		return last;
	};
}

export async function showReturnPath(): Promise<void> {
	await runReturnPath(dialogAsk());
}

/** Runs a menu action as one run: its log lines and results also go to the run files. */
async function recorded(command: string, title: string, fn: () => Promise<void>): Promise<void> {
	beginRun(command);
	try {
		await guarded(title, fn);
	}
	finally {
		if (!await endRun())
			await offerRunFolder();
	}
}

let askedRunFolder: unknown;

/** Once per session, when the documents folder is unknown and no Run folder is chosen, asks for one and writes the run there. */
async function offerRunFolder(): Promise<void> {
	const run = unwrittenRun();
	if (!run?.askable || askedRunFolder === eda)
		return;
	askedRunFolder = eda;
	if (await confirm(t('The run files (.log and .results.json) could not be written: ${1}.\n\nChoose a folder for them?', run.reason), t('Run folder'), t('Choose folder...')))
		await setRunFolder();
}

/** The panel's Selected trace: the check that fits the selection, HF for a signal net and DC, without asking first, for a power rail. */
export async function showForSelectedTrace(): Promise<void> {
	await runReturnPath(dialogAsk(), true);
}

/**
 * HF check: pick the net (recognised data lines first) and its speed. With fromSelection (the panel's
 * Selected trace), the selected net is checked at the usual speed of its kind, and a power rail goes
 * to the DC check without asking.
 */
export async function runReturnPath(ask: Ask, fromSelection = false): Promise<void> {
	const title = t('Return path');
	const command = fromSelection ? 'Selected trace' : 'HF check';
	await recorded(command, title, async () => {
		await showPanelForRun();
		const part = fromSelection ? await readSelectedPart() : undefined;
		if (part) {
			await focusOn(part, ask, command);
			return;
		}
		const selected = await selectedNet();
		log(`${command} (v${extensionConfig.version}), selected net ${selected ?? 'none'}`);
		if (fromSelection) {
			if (!selected) {
				recordResult('outcome', 'nothing selected');
				eda.sys_Dialog.showInformationMessage(t('Select a track, via or pad of the net to analyse.'), title);
				return;
			}
			await hfFor(selected, ask, { dcWithoutAsking: true });
			return;
		}
		// A selected ground or supply net is turned away (with the DC view offered) before the board is read.
		if (selected && !hfApplicability({ pours: [] }, selected).ok) {
			await hfFor(selected, ask);
			return;
		}
		const board = await timed('read board', readBoard, boardSizes);
		await addPinNames(board);
		if (selected && !hfApplicability(board, selected).ok) {
			await hfFor(selected, ask, { board });
			return;
		}
		const bi = await boardInfo();
		const picked = await withBack(loggedAsk(ask), async (a) => {
			const chosen = await chooseNet(board, selected, a, bi.info);
			return chosen && { ...chosen, driver: await chooseDrivers(board, chosen.net, a, bi.info) };
		});
		if (!picked) {
			recordResult('outcome', 'no net chosen');
			return;
		}
		const patch: Partial<NetInfo> = {
			...(picked.hz !== picked.prefilledHz ? { speedHz: picked.hz } : {}),
			...(picked.driver.answered ? { driver: picked.driver.answered } : {}),
		};
		if (Object.keys(patch).length)
			await bi.save(withNet(bi.info, picked.net, patch), `${picked.net}: ${Object.keys(patch).join(', ')}`);
		await hfFor(picked.net, ask, { board, hz: picked.hz, drivers: picked.driver.drivers, info: bi.info });
	}).finally(ask.close);
}

/** The kind of line a net is: as the board info gives it (protocol, or a clock), else as recognised from its name and pins. */
function kindOf(net: string, recognised: SignalKind | undefined, n: NetInfo | undefined): SignalKind | undefined {
	return (n?.protocol ? signalKindForProtocol(n.protocol) : undefined) ?? (n?.kind === 'clock' && !recognised ? CLOCK_KIND : recognised);
}

/** What the board info says about a net, for the label in the net list. */
function infoLabel(n: NetInfo | undefined, kind: SignalKind | undefined): string | undefined {
	if (!n)
		return undefined;
	return n.protocol ?? (n.kind && kind?.type !== 'clock' ? n.kind : undefined) ?? kind?.label;
}

/**
 * Lists the signal nets, recognised data lines first, each with its speeds and the usual one for its
 * kind preselected. Board info wins: its kind, protocol and speed are used, and nets it calls power
 * or ground are left out.
 */
async function chooseNet(board: Board, selected: string | undefined, ask: Ask, info: BoardInfo): Promise<{ net: string; hz: number; prefilledHz: number } | undefined> {
	const title = t('HF check');
	const known = (net: string) => netInfo(info, net);
	const cands = hfCandidates(board)
		.filter(c => known(c.net)?.kind !== 'power' && known(c.net)?.kind !== 'ground')
		.map(c => ({ ...c, kind: kindOf(c.net, c.kind, known(c.net)), info: known(c.net) }))
		.map((c, i) => ({ c, i, first: !!(c.kind || c.info?.kind || c.info?.protocol) }))
		.sort((a, b) => Number(b.first) - Number(a.first) || a.i - b.i)
		.map(x => x.c);
	log(`HF check: ${cands.length} signal nets, ${cands.filter(c => c.kind).length} recognised as data lines`);
	if (!cands.length) {
		eda.sys_Dialog.showInformationMessage(t('No routed signal nets on this board: only ground, supply, plane and bias nets have tracks.'), title);
		return undefined;
	}
	const prefill = new Map<string, number>();
	const options = cands.map((c) => {
		const kind = c.kind ?? GENERIC;
		const hz = c.info?.speedHz ?? kind.speeds[kind.dflt].hz;
		prefill.set(c.net, hz);
		return {
			value: c.net,
			label: `${c.net} · ${infoLabel(c.info, c.kind) ?? (c.kind ? c.kind.label : t('other signal'))} · ${c.lengthMm.toFixed(0)} mm${c.info ? ` · ${t('board info')}` : ''}`,
			speeds: kind.speeds.map(s => ({ value: String(s.hz), label: t('${1} (edges ≈ ${2} ns)', s.label, String(s.riseNs)) })),
			speed: String(hz),
		};
	});
	const dflt = cands.some(c => c.net === selected) ? selected! : cands[0].net;
	const picked = await ask.netSpeed(title, t('Net to check and its speed (bit rate or clock frequency), prefilled from the board info or with the usual speed of its kind. The speed sets the edge time, which decides whether the trace acts as a transmission line. Recognised data lines come first; the selected net is ticked. A speed you change is saved to the board info.'), options, dflt);
	return picked && { ...picked, prefilledHz: prefill.get(picked.net)! };
}

async function hfFor(net: string, ask: Ask, opts: { drivers?: string[]; hz?: number; board?: Board; dcWithoutAsking?: boolean; info?: BoardInfo } = {}): Promise<void> {
	const title = t('Return path');
	const storedDrivers = opts.drivers;
	log(`HF check: ${net}${opts.hz ? ` at ${formatHz(opts.hz)}` : ''}`);
	// The name check needs no board, so power and ground nets are turned away before the read.
	const byName = hfApplicability({ pours: [] }, net);
	const board = byName.ok ? opts.board ?? await timed('read board', readBoard, boardSizes) : undefined;
	const scope = board ? hfApplicability(board, net) : byName;
	recordResult('net', net);
	if (board)
		recordResult('board', boardSizes(board));
	if (!scope.ok) {
		recordResult('outcome', `not a signal net (${scope.kind})`);
		log(`${net}: not a signal net (${scope.kind}); high-frequency check skipped`, 'warn');
		if (scope.kind === 'bias') {
			eda.sys_Dialog.showInformationMessage(scope.message!, title);
			return;
		}
		if (opts.dcWithoutAsking || await loggedAsk(ask).confirm(title, scope.message!, t('Open DC view')))
			await runDcReturn(ask, scope.kind === 'power' ? net : undefined, scope.kind === 'power');
		return;
	}
	if (!board)
		return;
	const bi = opts.info ? undefined : await boardInfo();
	const info = opts.info ?? bi!.info;
	const known = netInfo(info, net);
	let drivers = storedDrivers;
	if (!drivers) {
		const chosen = await chooseDrivers(board, net, loggedAsk(ask), info);
		drivers = chosen.drivers;
		if (chosen.answered && bi)
			await bi.save(withNet(info, net, { driver: chosen.answered }), `${net}: driver`);
	}
	await ask.close();
	await remember({ kind: 'hf', net, drivers, hz: opts.hz });
	const ownTracks = board.tracks.filter(tr => tr.net === net).length;
	log(`${net}: ${ownTracks} track segments, ${board.vias.filter(v => v.net === net).length} vias, driver ${drivers.join(', ') || 'none'}`);
	const analysis = await runSteps(analyzeNetSteps(board, net, { drivers }), { title, timeBudgetMs: HF_BUDGET_MS, percent: hfPercent() });
	log(`${net}: ${Object.entries(analysis.stats).map(([k, v]) => `${k}=${+Number(v).toFixed(3)}`).join(' ')}`);
	const drawn = await timed('draw markers', () => drawAnalysis(analysis, board), d => `${d.markers} markers`);
	const ownLength = board.tracks.filter(tr => tr.net === net).reduce((sum, tr) => sum + Math.hypot(tr.b.x - tr.a.x, tr.b.y - tr.a.y), 0);
	const kind = kindOf(net, classifySignal(net, board.pads.filter(p => p.net === net).map(p => p.pinName)), known) ?? GENERIC;
	const hz = opts.hz ?? known?.speedHz ?? kind.speeds[kind.dflt].hz;
	const signal = summariseSignal(net, kind, hz, ownLength);
	recordResult('signal', { type: kind.type, hz, chosen: !!opts.hz, fromBoardInfo: !opts.hz && !!known?.speedHz, kneeHz: signal.kneeHz, criticalMm: signal.criticalMm, lengthMm: ownLength, transmissionLine: signal.transmissionLine });
	const noted = known && [
		known.kind && t('kind ${1}', known.kind),
		known.diffPartner && t('diff partner ${1}', known.diffPartner),
		known.reference && t('intended reference ${1}', known.reference),
		known.target && t('target ${1}', known.target),
		known.receivers?.length && t('receivers ${1}', known.receivers.join(', ')),
		known.notes,
	].filter(Boolean).join('; ');
	recordResult('hf', { drivers, stats: analysis.stats, findings: analysis.findings, markers: drawn.markers, returnLayers: drawn.returnLayers, boardWarnings: board.warnings });
	const lines = [
		t('${1}: ${2} finding(s), ${3} overlay marker(s).', net, String(analysis.findings.length), String(drawn.markers)),
		opts.hz || known?.speedHz ? signal.message : `${signal.message} ${t('(The usual speed of this kind of line; HF check asks for the speed.)')}`,
		noted ? t('Board info: ${1}.', noted) : '',
		drawn.returnLayers.length
			? t('Return current of the trace on ${1}, drawn where it flows: on the trace when it runs in the copper of the other layer, beside it in a pour on the trace\'s own layer. Signal trace in ${4}, with a circle on each via it passes through. Dashed ${2}: hop between layers or into a part (via, decap, bridging cap, IC pin). ${3} over the trace: it crosses a gap, or has less than half the reference copper it needs (smaller shortfalls are listed in the result only).', drawn.returnLayers.join(', '), roleColour('hop').name, roleColour('gap').name, roleColour('signal').name)
			: t('No return path drawn: the trace has no reference copper.'),
		drivers.length ? t('Driver: ${1}. Its other edge is drawn dashed ${2} from its ground pin through the decap to its supply pin.', drivers.join(', '), roleColour('hop').name) : t('Driver: not chosen, so only the pin at each end closes the loop.'),
		...analysis.findings.map(f => `[${f.severity}] ${f.message}`),
		...board.warnings.map(w => `warning: ${w}`),
	].filter(Boolean);
	recordResult('report', lines);
	await report(title, lines);
}

/**
 * The parts that drive the net: guessed from the pin names (netlist), asked when the names do not
 * settle it. An empty list skips the driver loop (also when the question is closed).
 */
async function chooseDrivers(board: Board, net: string, ask: Ask, info: BoardInfo): Promise<{ drivers: string[]; answered?: NetInfo['driver'] }> {
	const given = netInfo(info, net)?.driver;
	if (given) {
		const onNet = new Set(board.pads.filter(p => p.net === net && p.componentId).map(p => board.components.find(c => c.id === p.componentId)?.designator));
		const parts = given.parts.filter(d => onNet.has(d));
		if (parts.length === given.parts.length) {
			log(`${net}: driver ${parts.join(', ') || 'none'} from the board info`);
			return { drivers: parts };
		}
		log(`${net}: board-info driver ${given.parts.join(', ')} has no pad on the net; guessing instead`, 'warn');
	}
	if (!board.pads.some(p => p.pinName))
		await addPinNames(board);
	const guess = guessDrivers(board, net);
	log(`${net}: driver candidates ${guess.candidates.map(c => `${c.designator} (${c.role}: ${c.why})`).join('; ') || 'none'}; guess ${guess.drivers.join(', ') || 'none'}${guess.confident ? '' : ' (not sure)'}`);
	if (guess.confident || !guess.candidates.length)
		return { drivers: guess.drivers };
	const ALL = '*';
	const NONE = '-';
	const options = [
		...guess.candidates.map(c => ({ value: c.designator, label: `${c.designator} pad ${c.pad.number}${c.pad.pinName ? ` (${c.pad.pinName})` : ''}` })),
		...(guess.candidates.length > 1 ? [{ value: ALL, label: t('All of them (driven from either end)') }] : []),
		{ value: NONE, label: t('None: skip the driver loop') },
	];
	const dflt = guess.candidates.find(c => c.role !== 'receiver')?.designator ?? options[0].value;
	const v = await ask.select(t('Return path'), t('Which part drives ${1}? Its supply pins and decap close the loop for the edge that does not return straight into its ground pin. Your answer is saved to the board info.', net), options, dflt);
	if (v === undefined)
		return { drivers: [] };
	const drivers = v === NONE ? [] : v === ALL ? guess.candidates.map(c => c.designator) : [v];
	const pad = drivers.length === 1 ? guess.candidates.find(c => c.designator === drivers[0])?.pad : undefined;
	return { drivers, answered: { parts: drivers, ...(pad ? { pin: pad.number } : {}), ...(pad?.pinName ? { pinName: pad.pinName } : {}) } };
}

/** Wizard step 1, DC solve of the chosen rail and its ground, and the DC overlay (D7). */
export async function showDcReturn(): Promise<void> {
	await runDcReturn(dialogAsk());
}

/** `railGiven`: the rail came from the selection and was judged a supply net, so the wizard does not ask for it. */
export async function runDcReturn(ask: Ask, preferredRail?: string, railGiven = false): Promise<void> {
	const title = t('DC return current');
	await recorded('DC Return Current', title, async () => {
		log(`DC Return Current (v${extensionConfig.version})`);
		await showPanelForRun();
		const rail = preferredRail ?? await timed('read selection', selectedNet, n => n ?? 'nothing selected');
		const board = await timed('read board', readBoard, boardSizes);
		await addPinNames(board);
		recordResult('board', boardSizes(board));
		const last = lastRun();
		const bi = await boardInfo();
		const wiz = await withBack(loggedAsk(ask), a => runDcWizard(board, a, rail, railGiven, last?.kind === 'dc' ? last.input : undefined, bi.info));
		await ask.close();
		if (!wiz) {
			recordResult('outcome', 'wizard closed');
			return;
		}
		if (wiz.learned)
			await bi.save(wiz.learned, `${wiz.input.rail}: source ${wiz.input.source}, loads and currents`);
		await remember({ kind: 'dc', input: wiz.input });
		await dcFor(board, wiz.input);
	}).finally(ask.close);
}

async function readSelectedPart(): Promise<SelectedPart | undefined> {
	try {
		return await selectedPart();
	}
	catch (e) {
		log(`read selection: ${e instanceof Error ? e.message : String(e)}`, 'warn');
		return undefined;
	}
}

/**
 * A run for one selected pad or part: the HF check of a signal pad's net, otherwise the DC paths of
 * that part's own current alone, on the rail of the last DC run when the part is on it.
 */
async function focusOn(sel: SelectedPart, ask: Ask, command: string): Promise<void> {
	const title = t('DC return current');
	const board = await timed('read board', readBoard, boardSizes);
	await addPinNames(board);
	recordResult('board', boardSizes(board));
	const pad = sel.kind === 'pad' ? board.pads.find(p => p.id === sel.id) : undefined;
	const comp = sel.kind === 'pad' ? board.components.find(c => c.padIds.includes(sel.id)) : board.components.find(c => c.id === sel.id);
	log(`${command} (v${extensionConfig.version}), selected ${pad ? `pad ${comp?.designator ?? '?'}.${pad.number} on ${pad.net || 'no net'}` : comp?.designator ?? sel.id}`);
	if (!comp) {
		recordResult('outcome', 'selection not on a part');
		eda.sys_Dialog.showInformationMessage(t('The selected pad belongs to no part. Select a pad of a part, or the part itself.'), title);
		return;
	}
	recordResult('focus', comp.designator);
	const kind = pad?.net ? hfApplicability(board, pad.net) : undefined;
	if (pad?.net && kind?.ok) {
		await hfFor(pad.net, ask, { board });
		return;
	}
	const nets = new Set(padsOf(board, comp).map(p => p.net).filter(Boolean));
	// A pad on a supply net picks that rail; a ground pad or the whole part picks the rail it draws from.
	const wanted = kind?.kind === 'power' ? pad!.net : undefined;
	const last = lastRun();
	let input = last?.kind === 'dc' && (wanted ? railNetsOf(last.input).includes(wanted) : railNetsOf(last.input).some(n => nets.has(n))) ? last.input : undefined;
	if (!input) {
		const rails = guessRails(board).rails;
		const rail = wanted ?? rails.find(r => r.loads.some(l => l.componentId === comp.id))?.net ?? rails.find(r => nets.has(r.net))?.net;
		if (!rail) {
			recordResult('outcome', 'part not on a rail');
			eda.sys_Dialog.showInformationMessage(t('${1} has no pad on a power rail, so it draws no DC current to show.', comp.designator), title);
			return;
		}
		const bi = await boardInfo();
		const wiz = await withBack(loggedAsk(ask), a => runDcWizard(board, a, rail, true, undefined, bi.info));
		await ask.close();
		if (!wiz) {
			recordResult('outcome', 'wizard closed');
			return;
		}
		if (wiz.learned)
			await bi.save(wiz.learned, `${wiz.input.rail}: source ${wiz.input.source}, loads and currents`);
		await remember({ kind: 'dc', input: wiz.input });
		input = wiz.input;
	}
	if (input.source === comp.designator) {
		recordResult('outcome', 'source selected');
		eda.sys_Dialog.showInformationMessage(t('${1} is the source of ${2}. Select a pad of a part it supplies.', comp.designator, railLabel(input)), title);
		return;
	}
	await dcFor(board, focusInput(input, comp.designator), comp.designator);
}

/** `focus`: the one part whose current alone is solved and drawn (the last run stays as it was). */
async function dcFor(board: Board, input: DcSetupInput, focus?: string): Promise<void> {
	const title = t('DC return current');
	log(`DC setup: ${JSON.stringify(input)}`);
	await checkpoint();
	const setup = buildDcSetup(board, input);
	const rail = railLabel(setup);
	log(`DC ${rail}/${setup.ground}: source ${setup.source.designator}, loads ${setup.loads.map(l => `${l.designator}=${l.current} A`).join(', ')}`);
	const percent = (tick: Tick) => {
		const f = tick.fraction ?? 0;
		const at: Record<string, [number, number]> = {
			'reference copper': [0, 5],
			[`raster ${rail}`]: [5, 10],
			[`network ${rail}`]: [15, 0],
			[`solve ${rail}`]: [15, 35],
			[`raster ${setup.ground}`]: [50, 10],
			[`network ${setup.ground}`]: [60, 0],
			[`solve ${setup.ground}`]: [60, 35],
		};
		const r = at[tick.phase];
		return r ? r[0] + r[1] * f : undefined;
	};
	const res = await runSteps(solveDcSteps(board, setup), { title, timeBudgetMs: DC_BUDGET_MS, percent });
	log(`DC grid ${res.grid.nx}×${res.grid.ny} cells of ${res.grid.cell} mm; ${[res.supply, res.ret].filter(n => !!n).map(n => `${n!.net}: ${n!.nodes} nodes, ${n!.iterations} CG iterations, residual ${n!.residual.toExponential(1)}`).join('; ')}`);
	for (const n of [res.supply, res.ret]) {
		if (!n?.unconnected.length)
			continue;
		const pads = (ps: Pad[]) => ps.map(p => `${p.id} L${p.layer} (${p.at.x.toFixed(2)}, ${p.at.y.toFixed(2)})`).join(' ') || 'none';
		const which = n.role === 'supply' ? 'railPads' : 'groundPads';
		log(`${n.net}: ${n.unconnected.join(', ')} not reached from ${setup.source.designator}; source pads ${pads(setup.source[which])}; load pads ${setup.loads.map(l => `${l.designator}: ${pads(l[which])}`).join('; ')}; pours on ${n.net}: ${board.pours.filter(p => p.net === n.net).map(p => `${p.id} L${p.layer}`).join(', ') || 'none'}`, 'warn');
	}
	const streams = await timed('streamlines', async () => ({ supply: traceStreamlines(res.grid, res.supply, focus ? FOCUS_STREAMS : DRAWN_STREAMS), ret: res.ret ? traceStreamlines(res.grid, res.ret, focus ? FOCUS_STREAMS : DRAWN_STREAMS) : [] }), s => `${s.supply.length + s.ret.length} lines`);
	const drawn = await timed('draw markers', () => drawDc(res, streams), d => `${d.markers} markers`);
	const layerName = (id: number) => board.stackup.copper.find(l => l.id === id)?.name ?? `L${id}`;
	recordResult('dc', {
		input,
		...(focus ? { focus } : {}),
		rail: setup.rail,
		...(setup.railNets && setup.railNets.length > 1 ? { railNets: setup.railNets, bridges: (setup.bridges ?? []).map(b => b.designator) } : {}),
		ground: setup.ground,
		source: setup.source.designator,
		loads: setup.loads.map(l => ({ designator: l.designator, current: l.current })),
		normalised: setup.normalised,
		grid: { nx: res.grid.nx, ny: res.grid.ny, cellMm: res.grid.cell },
		nets: [res.supply, res.ret].filter(n => !!n).map(n => ({
			net: n!.net,
			role: n!.role,
			dropV: n!.drop,
			bottleneck: n!.bottleneck ? { ...n!.bottleneck, layerName: layerName(n!.bottleneck.layer) } : undefined,
			unconnected: n!.unconnected,
			nodes: n!.nodes,
			iterations: n!.iterations,
			residual: n!.residual,
		})),
		streamlines: { supply: streams.supply.length, ret: streams.ret.length },
		markers: drawn.markers,
		warnings: [...board.warnings, ...res.warnings],
	});
	const vUnit = setup.normalised ? 'mV/A' : 'mV';
	const jUnit = setup.normalised ? 'A/mm per A' : 'A/mm';
	const lines = [
		focus
			? t('Focus on ${1}: only its own current on ${2} / ${3} from ${4} is solved and drawn. Rerun last draws every load again.', focus, rail, setup.ground, setup.source.designator)
			: t('${1} / ${2}: source ${3}, loads ${4}.', rail, setup.ground, setup.source.designator, setup.loads.map(l => l.designator).join(', ')),
		setup.normalised ? (focus ? t('No current given for ${1}: values are per amp of its current.', focus) : t('No load currents given: 1 A total split equally; values are per amp.')) : '',
		...[res.supply, res.ret].filter(n => !!n).map(n => carriesCurrent(n!)
			? t('${1}: drop ${2} ${3}, bottleneck ${4} ${5} on ${6}.', n!.net, (n!.drop * 1000).toFixed(2), vUnit, (n!.bottleneck?.j ?? 0).toFixed(3), jUnit, n!.bottleneck ? layerName(n!.bottleneck.layer) : '-')
			: t('${1}: no load has a copper path to ${2}; nothing is drawn for it.', n!.net, setup.source.designator)),
		t('Streamlines: ${1} supply ${2}; ${3} return ${4} on ${5} and ${6} on other layers, with a circle where it changes layer.', rail, roleColour('supply').name, setup.ground, roleColour('returnTop').name, layerName(board.stackup.copper[0].id), roleColour('returnOther').name),
		t('${1} overlay marker(s).', String(drawn.markers)),
		...[...board.warnings, ...res.warnings].map(w => `warning: ${w}`),
	].filter(Boolean);
	recordResult('report', lines);
	await report(title, lines);
}

type LastRun = { kind: 'hf'; net: string; drivers?: string[]; hz?: number } | { kind: 'dc'; input: DcSetupInput };
const LAST_RUN = 'lastRun';

/** Stored, so Rerun Last Analysis works after a restart too. */
async function remember(run: LastRun): Promise<void> {
	shareLastRun(run);
	await writeStored(LAST_RUN, JSON.stringify(run));
}

function lastRun(): LastRun | undefined {
	try {
		// Another instance's stored copy may not have reached this one yet; the shared one is current.
		const v = sharedLastRun() ?? readStored(LAST_RUN);
		const run = (typeof v === 'string' ? JSON.parse(v) : v) as LastRun | undefined;
		return run && (run.kind === 'hf' ? typeof run.net === 'string' : run.kind === 'dc' && !!run.input?.rail) ? run : undefined;
	}
	catch {
		return undefined;
	}
}

/** Repeats the last analysis on the board as it is now, with the same net or wizard answers. */
export async function rerunAnalysis(): Promise<void> {
	initPanel(panelHost);
	await panelReady();
	const run = lastRun();
	if (!run) {
		eda.sys_Dialog.showInformationMessage(t('No analysis to rerun yet: run HF check or DC check in the panel first.'), t('Rerun last analysis'));
		return;
	}
	if (run.kind === 'hf') {
		const ask = dialogAsk();
		await recorded('Rerun Last Analysis', t('Return path'), async () => {
			await showPanelForRun();
			await hfFor(run.net, ask, { drivers: run.drivers, hz: run.hz });
		}).finally(ask.close);
		return;
	}
	await recorded('Rerun Last Analysis', t('DC return current'), async () => {
		log(`Rerun DC Return Current (v${extensionConfig.version})`);
		await showPanelForRun();
		const board = await timed('read board', readBoard, boardSizes);
		await addPinNames(board);
		await dcFor(board, run.input);
	});
}

/** The panel's Rerun: for the one selected pad or part when there is one, otherwise the last analysis. */
export async function rerunForSelection(): Promise<void> {
	initPanel(panelHost);
	await panelReady();
	const part = await readSelectedPart();
	if (!part) {
		await rerunAnalysis();
		return;
	}
	const ask = dialogAsk();
	await recorded(part.kind === 'pad' ? 'Rerun for single pad' : 'Rerun for single part', t('DC return current'), async () => {
		await showPanelForRun();
		await focusOn(part, ask, part.kind === 'pad' ? 'Rerun for single pad' : 'Rerun for single part');
	}).finally(ask.close);
}

/** Hides the overlay, or shows it again. */
export async function toggleReturnPath(): Promise<void> {
	initPanel(panelHost);
	await panelReady();
	if (forwardOverlayCommand('toggle'))
		return;
	await guarded(t('Return path'), async () => {
		if (overlayState() === 'none' && leftoverOverlay()) {
			await clearOverlay();
			toast(t('Removed the overlay left on the board by an earlier session. Rerun last draws it again.'));
			return;
		}
		const visible = await toggleOverlay();
		toast(visible === undefined ? t('No overlay to show: run an analysis first.') : visible ? t('Overlay shown.') : t('Overlay hidden. Use Show in the panel to show it again.'));
	});
	publishState();
}

/** Stops a running analysis (closing its progress bar does the same). */
export function cancelAnalysis(): void {
	if (cancelRunning())
		return;
	if (cancelWizardQuestion()) {
		log('cancel: ended the question waiting in the wizard window');
		return;
	}
	toast(t('No analysis is running.'));
}

export async function clearReturnPath(): Promise<void> {
	cancelRunning();
	initPanel(panelHost);
	await panelReady();
	forwardOverlayCommand('clear');
	await guarded(t('Return path'), clearOverlay);
	releaseOverlay();
	publishState();
}

/** Analyses open the panel, so their result lands there, unless the user closed it. */
async function showPanelForRun(): Promise<void> {
	initPanel(panelHost);
	await panelReady();
	await autoOpenPanel();
}

/** Opens the Return Path panel: last result, actions and overlay colours in a window that stays open. */
export async function showPanel(): Promise<void> {
	initPanel(panelHost);
	await guarded(t('Return Path'), async () => {
		if (!await openPanel())
			eda.sys_Dialog.showInformationMessage(t('This EasyEDA version did not open the panel window, and the analyses run from the panel. The saved log (Return Path > Show Saved Log) has the details.'), t('Return Path'));
	});
}

const panelHost = {
	run: async (cmd: 'hf' | 'dc' | 'trace' | 'rerun' | 'toggle' | 'clear' | 'cancel') => {
		const actions = { hf: showReturnPath, dc: showDcReturn, trace: showForSelectedTrace, rerun: rerunForSelection, toggle: toggleReturnPath, clear: clearReturnPath, cancel: async () => cancelAnalysis() };
		await actions[cmd]();
	},
	lastRunKind: () => lastRun()?.kind,
	lastRunLabel: () => {
		const run = lastRun();
		if (!run)
			return undefined;
		if (run.kind === 'hf') {
			const net = run.hz ? t('${1} at ${2}', run.net, formatHz(run.hz)) : run.net;
			return run.drivers?.length ? t('HF check: ${1}, driver ${2}', net, run.drivers.join(', ')) : t('HF check: ${1}', net);
		}
		return t('DC ${1} / ${2}, source ${3}, loads ${4}', railLabel(run.input), run.input.ground, run.input.source, (run.input.loads ?? []).join(', ') || '-');
	},
};

/** Shows the saved log, which survives an editor freeze or crash, and offers to save it as a file. */
export async function showSavedLog(): Promise<void> {
	await guarded(t('Saved log'), async () => {
		const path = await logFilePath();
		const all = savedLog();
		const problem = logFileProblem();
		const where = path
			? t('The full log is also written to: ${1}', path)
			: problem
				? t('The log file ${1} is not written: ${2}', 'returnpath-log.txt', problem)
				: t('To have the log written to a file as well, allow "External Interaction" for this extension in Advanced > Extension Manager.');
		const body = [where, '', ...all.slice(-40)].join('\n');
		if (await confirm(body, t('Saved log (last ${1} of ${2} lines)', String(Math.min(40, all.length)), String(all.length)), t('Save as file...')))
			await saveLogAs();
	});
}

/** Picks the folder for the run files (each analysis's `.log` and `.results.json`). */
export async function setRunFolder(): Promise<void> {
	const title = t('Run folder');
	await guarded(title, async () => {
		const current = chosenRunFolder();
		let folder: string | undefined;
		try {
			folder = await eda.sys_FileSystem.openReadFolderPathDialog();
		}
		catch {
			folder = await new Promise<string | undefined>((resolve) => {
				eda.sys_Dialog.showInputDialog(t('Folder for the run files (absolute path). Leave empty for the default.'), '', title, 'text', current ?? '', undefined, (v: unknown) => resolve(typeof v === 'string' ? v : undefined));
			});
			if (folder === undefined)
				return;
		}
		if (folder === undefined && current !== undefined)
			return;
		await storeRunFolder(folder?.trim() || undefined);
		const status = await runFolderStatus();
		log(`run folder: ${status.dir ?? `none (${status.reason})`}`);
		const written = status.dir !== null ? await writeUnwrittenRun() : null;
		const logPath = await logFilePath();
		eda.sys_Dialog.showInformationMessage(status.dir !== null
			? [
					t('Each analysis now writes its .log and .results.json to: ${1}', status.dir),
					...(written ? [t('The last run\'s files were written there too.')] : []),
					...(logPath ? [t('The full log is also written to: ${1}', logPath)] : []),
				].join('\n\n')
			: t('Run files are not written: ${1}', status.reason), title);
	});
}

export { loadBoardInfo, saveBoardInfo } from './board-info';
