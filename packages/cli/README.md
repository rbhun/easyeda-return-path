# @returnpath/cli

Offline analysis of EasyEDA Pro files with the shared geometry core (`packages/core`). It reads EasyEDA Pro PCB data, runs pipeline steps 1–4 for one net, and renders step 5 as an SVG overlay (plus PNG and a JSON report).

## Run

Needs Node ≥ 20.17. From the repository root run `npm ci` once, then in `packages/cli`:

```bash
npm test                 # parser (both encodings), POURED fills, expected findings
npm run demo             # regenerate examples/ and render demo + fixed boards into out/
npm run analyze -- examples/demo-4layer.epro --net CLK --out out --png
npm run analyze -- my-board.epro --list-nets
```

CLI options: `--net <name>`, `--out <dir>` (default `out`), `--name <file prefix>`, `--png`, `--clearance <mm>` (default 0.25, used only when a pour has no stored fill), `--phys-unit auto|mil|mm` (unit of `LAYER_PHYS` thickness), `--pcb <name>` (pick a PCB in a multi-board project).

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
  analyze.ts         steps 2 + 4 and the orchestration: analyzeNet(board, net)
  detour.ts          step 3: geodesic shortest path inside copper (visibility graph + A*)
  easyeda-polygon.ts EasyEDA complex-polygon decoder (same encoding in files and the API)
src/easyeda/       EasyEDA Pro file format → board model (records.ts is pure)
src/render/svg.ts  step 5: overlay as an SVG string (pure)
src/synth/         synthetic test board generator
src/cli.ts         file I/O, PNG via resvg
test/              node:test suite
examples/          generated boards (demo = problems, fixed = repaired)
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
2. **Coverage.** Each net's tracks are chained per layer. The reference is the nearest adjacent copper layer that has reference copper, and h is the dielectric between them. The ±3h band (butt ends) is intersected with the copper to give a coverage ratio per segment. The centreline is sampled and classified by the net underneath, and boundaries are refined by bisection. Gaps are classified as `slot` (same net on both sides), `split` (different nets), `off-reference` (gap at a trace end) or `via-antipad` (the net's own via clearance, ignored).
3. **Detour.** For each slot, the shortest path inside that net's copper runs from just before the gap to just after it. It is found with a visibility graph over reflex vertices plus A*, inside a search window that doubles until the path stops touching the window edge. Holes smaller than 1 mm² (antipads) are filled. The report gives the detour length, the extra length, and the added loop area: the even-odd area between the trace and the detour. For a split between nets, the report gives the nearest two-pad part bridging both nets.
4. **Vias.** For each signal via, the layer change is taken from the net's tracks that end at the via, and the reference net is looked up on each side. The return then goes through the plane if both sides share one, through the nearest via or THT pad of the same net, or through the nearest decap bridging the two nets. Distances are graded (via ≤ 1.5 / 4 mm, decap ≤ 3 / 8 mm), and the vertical loop area is estimated as distance × plane separation.
5. **Overlay.** Green: the ±3h band over copper. Red hatching: the band without copper. Thick red: a centreline gap. Orange dashes with orange fill: the detour and its loop area. Coloured links: via → return via or decap. Numbered markers point to the findings list.

## Approximations and gaps

- Synthetic boards only so far. Real exports may differ: field order variants, compressed `.epro2`, and inner `PLANE` fills with no pour ID (see the prior-art review in the project docs).
- `LAYER_PHYS` thickness unit is guessed (`auto`: mm if any dielectric is under 1, else mil). Override it with `--phys-unit`. Without a stackup, h defaults to 0.2 mm.
- Without `POURED`, pours use one uniform clearance: no rule table, no thermal spokes, no island removal, no edge pullback.
- Every via is treated as through-hole (the blind/buried span is only a rule name). Footprint pads on bottom-layer components are mirrored in X, which is unverified against a real file.
- The reference is chosen per chain, not per segment, and only adjacent layers are considered. There is no fallback to the next plane when the adjacent one has a hole.
- A detour is the geometric shortest path, not a current distribution. Loop area is planar (trace vs detour). Via loops are distance × Δz. No inductance numbers.
- A decap is any component with exactly 2 pads on the two nets. Driver/receiver loop closure and frequency/edge rate (brief, "loop closure") are not implemented.
- The visibility graph is O(V²·E) per crossing. That is fine for windowed plane slots, but large dense fills will want `flatbush` or the navmesh route.
