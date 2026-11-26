# @returnpath/cli

Offline analysis of EasyEDA Pro files with the shared geometry core (`packages/core`). It reads EasyEDA Pro PCB data, runs pipeline steps 1–4 for one net, and renders step 5 as an SVG overlay (plus PNG and a JSON report).

## Run

Needs Node ≥ 20.17. From the repository root run `npm ci` once, then in `packages/cli`:

```bash
npm test                 # parser (both encodings), POURED fills, expected findings
npm run demo             # regenerate examples/ and render demo + fixed boards into out/
npm run analyze -- examples/demo-4layer.epro --net CLK --out out --png
npm run analyze -- my-board.epro --list-nets   # signal nets first, data lines with their kind
npm run analyze -- my-board.epro --net SCL --speed 400k
```

DC return current (design decision D7):

```bash
npm run demo:dc          # regenerate examples/dc-4layer.epro and render the 3V3 and VBUS loops into out/
npm run analyze -- examples/dc-4layer.epro --list-rails
npm run analyze -- examples/dc-4layer.epro --dc 3V3 --png
npm run analyze -- examples/dc-4layer.epro --dc 3V3 --current U2=150mA,U3=5mA,J2=0.5 --png
```

`--dc <rail>` runs wizard step 1 without dialogs: the guessed ground, source and loads are used unless `--ground`, `--source <designator>` or `--loads U2,U3` override them. `--current` gives load currents in A (or `mA`). Without it, 1 A total is split equally and the results are per amp. `--dc VBUS_R,VBUS_RAW` solves several nets as one rail (the first names it); the parts with pads on two of them, such as a fuse between them, are taken as shorts. `--cell <mm>` sets the raster cell; by default it is picked from a node budget. If the rail's source is ambiguous, the command stops and lists the candidates. Each run writes `<prefix>-overview.svg` (both nets: streamlines plus contours on each net's dominant layer), a `<prefix>-<net>-<layer>.svg` with a binned density raster for every layer that carries at least 2 % of a net's flow, a PNG of each with `--png`, and `<prefix>-report.json`.

2-layer boards (no inner plane):

```bash
npm run demo:2layer      # examples/2layer-coplanar.epro and 2layer-bottom-only.epro: CLK, DATA and the 3V3 DC loop
```

`coplanar` has GND pours on both sides: CLK (Top) and DATA (Bottom) return in the pour beside them, CLK across a break in the Top pour and DATA across a slot in the Bottom pour, and DATA's vias need GND stitching between the two pours. `bottom-only` has no Top pour, so CLK returns in the Bottom pour 1.5 mm below and crosses its slot.

CLI options: `--net <name>`, `--out <dir>` (default `out`), `--name <file prefix>`, `--png`, `--clearance <mm>` (default 0.25, used only when a pour has no stored fill), `--phys-unit auto|mil|mm` (unit of `LAYER_PHYS` thickness), `--pcb <name>` (pick a PCB in a multi-board project), `--force` (run the high-frequency check on a power, ground or plane net, which is refused by default with a hint to use `--dc`), `-v`/`--verbose` (time per phase and work sizes).

Input can be:

- an `.epro` / `.zip` project: the `*.epcb` board, `*.efoo` footprints (needed for component pads and decaps), and optional `*.ecop` pour results;
- a bare `.epcb` / saved `sys_FileManager.getDocumentSource()` text (free pads only, no footprint pads).

Each run writes `<prefix>-overview.svg`, a `<prefix>-ref-<layer>.svg` for each reference layer, a PNG of each with `--png`, and `<prefix>-report.json`.

## Layout

```
../core/           geometry core (@returnpath/core): no I/O, no Node or DOM APIs, shared with the extension
  types.ts           board model (mm, Y up)
  geom.ts            Clipper2 wrappers (@countertype/clipper2-ts), polygon helpers
  refcopper.ts       step 1: reference copper per layer and net
  analyze.ts         steps 2 + 4 and the orchestration: analyzeNet / analyzeNetAsync, hfApplicability
  detour.ts          step 3: geodesic shortest path inside copper (visibility graph + A*, node limit)
  budget.ts          analyses as generators: sync or time-sliced runs, time budget, cancel, progress
  spatial.ts         edge grid: point-in-region, segment crossing and near-boundary queries
  easyeda-polygon.ts EasyEDA complex-polygon decoder (same encoding in files and the API)
  dc/rails.ts        wizard step 1 guesses: rails, grounds, source, loads; DcSetup
  dc/raster.ts       copper rasterisation per (net, layer)
  dc/solve.ts        DC resistive solve (sheet conductance + via barrels, Jacobi-PCG)
  dc/field.ts        streamlines, density bins and contour lines
src/easyeda/       EasyEDA Pro file format → board model (records.ts is pure)
src/render/svg.ts  step 5: overlay as an SVG string (pure)
src/render/dc-svg.ts DC return-current view as an SVG string (pure)
src/dc.ts          --dc: setup from the guess and flags, views, JSON report
src/synth/         synthetic test board generators (4-layer demo/fixed, DC 4-layer, 2-layer)
src/cli.ts         file I/O, PNG via resvg
test/              node:test suite
examples/          generated boards (demo = problems, fixed = repaired, dc-4layer = DC loop with a slotted GND plane, 2layer-* = no inner plane)
```

## Format notes

EasyEDA Pro documents are JSON lines. Two encodings exist, and both are parsed:

- array lines (older files, KiCad importer docs): `["LINE","e1",0,"CLK",1,x1,y1,x2,y2,width,0]`
- object lines (current editor, `getDocumentSource()`): `{"type":"LINE","id":"e1","ticket":1}||{"netName":"CLK","layerId":1,...}|`

Array lines are mapped onto the object field names (`records.ts`). Coordinates are in **mil** with **Y up**. The stackup order is TOP, then the `SIGNAL`/`PLANE`/`SUBSTRATE` layers in file order, then BOTTOM. `LAYER_PHYS` gives the thickness and εr of each dielectric. Complex polygons are a list of rings: the first is the outer outline and the rest are holes. Ring commands: `L`, `ARC`/`CARC`, `C`, `R`, `CIRCLE`.

Record types used: `LAYER`, `LAYER_PHYS`, `NET`, `LINE`, `ARC`, `VIA`, `PAD`, `POUR`, `POURED`, `FILL`, `REGION` (pour keepouts), `POLY` (board outline on layer 11), `COMPONENT`, `ATTR` (Designator, Footprint), `PAD_NET`.

Sources: [easyeda-pro-file-format-v2](https://github.com/easyeda/easyeda-pro-file-format-v2), [EasyEDA Pro format docs](https://prodocs.easyeda.com/en/format/pcb/common/), and the [KiCad EasyEDA importer docs](https://dev-docs.kicad.org/en/import-formats/easyeda/), which describe the importer's behaviour only (no KiCad code is used).

## What the pipeline does

1. **Reference copper.** Uses the stored `POURED` fill per pour when present (antipads are already cut). Otherwise it recomputes each fill: the pour outline ∩ the board, minus keepouts, minus higher-priority fills, minus other-net tracks, vias and pads grown by the clearance. Same-net tracks, pads and vias are merged in, and the result is kept per (layer, net).
2. **Coverage.** Each net's tracks are chained per layer. The reference is the nearest adjacent copper layer that has reference copper, and h is the dielectric between them. A pour of another net on the trace's own layer is the reference instead (coplanar return) when the median gap between the trace edge and that pour is at most h/2, or when no adjacent layer has copper; it is found by probing both sides of the trace up to 1 mm out. Coplanar chains use the strip beside the trace clearance (3 gaps wide) as the band, classify the centreline by the copper beside it, and treat the trace's own pads as terminals. The ±3h band (butt ends) is intersected with the copper to give a coverage ratio per segment. The centreline is sampled and classified by the net underneath, and boundaries are refined by bisection. Gaps are classified as `slot` (same net on both sides), `split` (different nets), `off-reference` (gap at a trace end) or `via-antipad` (the net's own via clearance, ignored).
3. **Detour.** For each slot, the shortest path inside that net's copper runs from just before the gap to just after it. It is found with a visibility graph over reflex vertices plus A*, inside a search window that doubles until the path stops touching the window edge. Holes smaller than 1 mm² (antipads) are filled. The report gives the detour length, the extra length, and the added loop area: the even-odd area between the trace and the detour. For a split between nets, the report gives the nearest two-pad part bridging both nets.
4. **Vias.** For each signal via, the layer change is taken from the net's tracks that end at the via, and the reference net is looked up on each side. The return then goes through the plane if both sides share one, through the nearest via or THT pad of the same net, or through the nearest decap bridging the two nets. Distances are graded (via ≤ 1.5 / 4 mm, decap ≤ 3 / 8 mm), and the vertical loop area is estimated as distance × plane separation.
5. **Overlay.** Green: the ±3h band over copper. Red hatching: the band without copper. Thick red: a centreline gap. Orange dashes with orange fill: the detour and its loop area. Coloured links: via → return via or decap. Numbered markers point to the findings list.

## Approximations and gaps

- Synthetic boards only so far. Real exports may differ: field order variants, compressed `.epro2`, and inner `PLANE` fills with no pour ID (see the prior-art review in the project docs).
- `LAYER_PHYS` thickness unit is guessed (`auto`: whichever unit makes the board 0.2–10 mm thick; if both do, mm when any dielectric is under 1). Override it with `--phys-unit`. Without a stackup, h defaults to 0.2 mm.
- Without `POURED`, pours use one uniform clearance: no rule table, no thermal spokes, no island removal, no edge pullback.
- Every via is treated as through-hole (the blind/buried span is only a rule name). Footprint pads on bottom-layer components are mirrored in X, which is unverified against a real file.
- The reference is chosen per chain, not per segment, and only adjacent layers (or the trace's own layer, for coplanar return) are considered. A chain that is coplanar along part of its length and over the opposite pour elsewhere gets one of the two. There is no fallback to the next plane when the adjacent one has a hole.
- A detour is the geometric shortest path, not a current distribution. Loop area is planar (trace vs detour). Via loops are distance × Δz. No inductance numbers.
- A decap is any component with exactly 2 pads on the two nets. Driver/receiver loop closure and frequency/edge rate (brief, "loop closure") are not implemented.
- The visibility graph is O(V²) visibility tests per crossing, each answered from an edge grid. Windows with more than 1500 reflex corners are reported as too complex rather than traced; dense fills would need a navmesh to do better.
- Long nets are sampled at a coarser step (at most 40 000 centreline samples per net), so gaps shorter than the step can be missed on nets of several metres.

## DC return current (D7)

1. **Guess (wizard step 1).** Power rails come from net names (`3V3`, `+5V`, `VCC*`, `VDD*`, `VBUS`, `VBAT`, `VIN`…) and from non-ground nets that own pours. Grounds come from names (`GND`, `AGND`, `GND_ISO`, `VSS`…), and each rail is paired by name (AVDD → AGND, *ISO → GND_ISO), else `GND`. The source is a regulator output: a pad whose pin name is `VOUT`/`OUT`/`SW`, a part whose name looks like a regulator (AMS1117, LDO, TPS…) sitting between this rail and a higher or input-like rail, or a switcher's output inductor. If there is none and the rail is `VIN`/`VBUS`/`VBAT`-like, the source is the single connector (`J*`, `P*`, `CN*`, `USB*`) or battery (`BT*`). Several candidates, a conflict between the two rules, or no rule at all means *ask*: one active source is chosen, and the other candidates are left out of the solve. Loads are every other part on the rail, including connectors, apart from two-pin `C*` decaps across the rail and a ground, and parts with no pad on a ground net (pull-ups, LEDs to a GPIO, series parts), whose current returns through another part. The wizard still lets you tick those. A project with several PCBs is analysed on the one with the most tracks unless `--pcb` names another.
2. **Solve.** Each net (the rail, then its ground) is rasterised per copper layer on one grid: pour/plane fills, tracks (sub-sampled coverage, so a track narrower than a cell keeps its resistance per length), pads and vias. Neighbouring cells are joined by the sheet conductance σ·t (σ = 5.8·10⁷ S/m, t from the stackup, else 35 µm outer and 17.5 µm inner), using the harmonic mean of the cell weights. Via and plated-hole barrels join the layers with σ·π(r² − (r − 25 µm)²)/Δz. The source pads are held at 0 V, and each load's pads draw (rail) or return (ground) its current. Jacobi-preconditioned conjugate gradients, to a relative residual of 10⁻⁷.
3. **Draw.** Current density per cell (A/mm of copper width) comes from the edge currents. Streamlines are traced from each load's strongest pad cells back to the source along the field, falling back to steepest descent of the potential at track corners, and they switch layers where a via hands the current on. Contour lines are drawn at 5, 15, 35 and 70 % of the layer's peak (marching squares). The peak excludes cells within two cells of terminal pads and vias, and partly covered edge cells. The report gives the voltage drop to each load. A track, a pour neck or a via narrower than IPC-2221 allows for its current at a 10°C rise is named in the warnings.

DC approximations: through-hole vias only; the contact at a pad is uniform injection rather than an equipotential pad; diagonal tracks are staircased, which reads up to ~25 % high in density at the default cell; peaks at sharp corners grow as the cell shrinks; copper `LAYER_PHYS` thickness units are guessed (oz, mm or µm by magnitude); and no thermal reliefs, since stored fills are used as they are.
