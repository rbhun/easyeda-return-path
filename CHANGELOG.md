# Changelog

Every change raises the patch number (`0.1.x`) and adds an entry here, newest first. The major and minor numbers change only when the owner declares a milestone; that entry's heading then ends with `- Milestone: <name>`. One version covers the whole repository: `packages/extension/extension.json` and every workspace `package.json` carry it, and the `.eext` file name includes it. `npm run check:version` checks this, and CI checks on pull requests that only the patch number went up (unless a milestone is declared).

## [0.1.15] - 2026-11-26

From 0.1.14 on the rack display: every marker was still white, and the lines looked thin and all alike. Show for Selected Net on `$1N58` (the switching node between U4 and L1) ran the high-frequency check without offering the DC view, and DC Return Current showed an "export failed" error before its first dialog.

- **Colours, the real cause:** in 0.1.10's colour check, red given on the 0–255 scale and red given on the 0–1 scale both came out red. EasyEDA Pro 3.2 reads marker colours on a 0–1 scale and clips anything above 1, so every mixed colour (amber, the grey band, orange) came out white. The alpha explanation in 0.1.11 was wrong. All markers now use colours whose channels are only 0 or 255, which read the same on either scale. DC: supply yellow, return magenta on the top layer and cyan on the others, bottleneck red. High-frequency view: return magenta on the top layer, cyan on the bottom one, green and blue on inner layers; hops dashed yellow; gaps red; ±3h band edges thin white.
- **Thicker lines:** DC supply 2 (was 1), DC return and the high-frequency return path 5 (was 3).
- **Supply and switching nodes are not signals:** Show for Selected Net now also refuses a net that connects to an inductor or ferrite bead (`L*`, `FB*`), or whose tracks are 0.8 mm or wider (median), and offers the DC view as it does for power rails. The DC wizard then ticks and preselects that net even though its name is not a rail name.
- **Netlist only once:** if the netlist gives no pin names (or the call fails, which may be the "export failed" message), later runs of the same version skip it instead of showing the error every time. Every ground pad of a load then starts a return, as before 0.1.12.

## [0.1.14] - 2026-11-26

High-frequency view (Show for Selected Net), first step: draw the return path itself. Until now the overlay showed the ±3h band, the gaps, the detours and the via links, but not where the return current runs.

- **Return path drawn:** a thick line on the reference layer under the trace, coloured by that layer (magenta on the top layer, cyan on the bottom one, green, yellow and blue on inner layers in turn). It follows the detour round a slot. For a coplanar return (2-layer boards) it runs along both pour edges beside the trace, where there is pour.
- **Hops off the plane** are dashed orange lines with a circle at the end: across a split through the bridging cap, at a signal via to the return via or decap, and at each end of the net from the signal pad to the part's pin on the reference net (ground, or the supply for a trace over a supply plane).
- **Loop closure:** one finding per net end names that pin and its distance from the signal pad, or warns that the part has no pad on the reference net.
- The ±3h band edges are thin grey (were green); gaps and band without copper stay red. The result dialog says which colour is which layer.
- CLI renders draw the return path and its hops too.

## [0.1.13] - 2026-11-26

The overlay stays temporary markers (not custom layers, for now), but can be hidden and redrawn without going through the wizard again.

- **Return Path → Hide/Show Overlay:** hides the last overlay and shows it again exactly as drawn, without a new analysis. **Clear Overlay** still removes it for good.
- **Return Path → Rerun Last Analysis:** reads the board again and repeats the last analysis: Show for Selected Net with the same net, or DC Return Current with the same rail, ground, source, loads and load currents, with no wizard. For checking a fix such as a moved or added via. The last analysis is stored with the extension's settings, so it also works after a restart. A part that no longer exists ends the rerun with a message naming it.

## [0.1.12] - 2026-11-26

From a DC run on SDA on the rack display, made with 0.1.10. The white dashed and dotted lines and the thin angled outlines in those screenshots are 0.1.10's supply dashes, other-layer return dots and density contours, which 0.1.11 already removed. Each TCA9548 started several returns.

- **Only ground pins start a return:** a load used to return its current through every pad on the ground, so a TCA9548 with A0, A1 and A2 tied to GND started four returns. Pin names are now read from the board's netlist (`pcb_Net.getNetlist`), and a part whose ground pads are all named returns only through its ground pins (GND, VSS, AGND, PGND, EP, PAD and similar). The summary lists the pins left out ("U1: A0, A1, A2 are tied to GND but carry no supply current; the return starts at GND."). Without names, or when no name matches, every ground pad still counts. The same applies at the source.
- **Signal nets in the DC view:** solving a net that is not a power rail (SDA) now warns that the view treats the source as a supply whose current the loads draw at their pins, and points to Show for Selected Net for a signal's return path.

## [0.1.11] - 2026-11-26

From 0.1.10 on the rack display: both test circles of Check Marker Colours came out red, the return still had a bundle of short lines between the OLED pin and the first via, and with many loads the thin lines criss-crossed.

- **Colours:** markers with an alpha below 1 come out white in EasyEDA Pro 3.2, and only the check circles were opaque. Every marker is now opaque, so colours show in the DC and the high-frequency overlay. Check Marker Colours is removed.
- **DC overlay colours:** supply thin amber; return thick, magenta on the top copper layer and cyan on the others, with a circle where it changes layer. No dashes or dots any more.
- **Fewer, cleaner streamlines** (extension and CLI renders): one streamline per load instead of three. They used to run side by side from the pad to the same via, which made the bundle of short lines. A streamline now ends where it comes within 0.6 mm of an earlier one on the same layer, so shared paths are drawn once and the lines form a tree. The cell staircase through narrow copper is smoothed. On the R-Com dongle's 3V3 rail this cuts the drawn segments from 849 to 132 (supply) and from 472 to 152 (GND return).
- **No density contours in the extension:** with many loads they were most of the criss-crossing thin lines. The bottleneck circle stays; the CLI renders keep the contours.

## [0.1.10] - 2026-11-26

From 0.1.8 runs on the rack display board (9V from J1 to the OLEDs). The return now reaches GND there, but the overlay was hard to read: streamlines seemed to jump around and cross traces, and outlines sat around the bends.

- **Return path by line style:** the return is thick, solid on the top copper layer and dotted on the other layers, with a circle wherever it changes layer through a via. On that board the GND return hops between the Top and Bottom pours at GND vias, because the long SC/SD traces cut the Bottom pour into strips. Drawn in one style, a Top-layer stretch looked as if it crossed Bottom traces. The supply is thin and dashed (1 mm dashes).
- **Density contours only with colour:** the thin outlines were the current-density contours (5, 15, 35 and 70 % of the peak), which mean nothing when every marker is white. They are drawn only after **Return Path → Check Marker Colours...** confirms that this client shows colours. That check draws two red circles at the board origin, one on the 0–255 RGB scale and one on the 0–1 scale, and asks which one is red. The answer is stored, and markers then use that scale (the high-frequency overlay too).
- **Source without a ground pin:** when the source has no ground pad (J1 there is a jumper between 9V and another net), the return ends at the ground pads of the nearest part on the source's other net, as before. The summary now names that part ("the return ends at the GND pads of C7, the nearest part on $1N235").
- Groups of more than 4000 markers are drawn in several calls instead of cut off at 4000.

## [0.1.9] - 2026-11-26

From a test on a second 2-layer board (rack display, 12V and 9V), where GND came out with no copper path from any load and every streamline was the supply.

- **Supply and return told apart without colour:** EasyEDA Pro 3.2 draws every indicator marker white whatever colour is passed, so the supply was indistinguishable from the return. Supply streamlines are now dashed (0.8 mm dashes, 0.6 mm gaps) and return streamlines solid. The summary says which is which.
- **A net with no connected load is reported in words:** "GND: no load has a copper path to CN1; nothing is drawn for it." replaces "drop 0.00 mV/A, bottleneck 0.000 A/mm per A on -", and no contours are drawn for it. On that board every white line was the 9V or 12V supply; no return was drawn.
- **Empty computed fills:** a pour whose computed fill decodes to nothing now falls back to its outline, with a warning. Before, it silently contributed no copper.
- **Diagnostics:** each pour is logged with its net, layer, priority, outline area and computed-fill area. When loads are not reached, the log names the source and load pads on that net (layer and position) and the pours on it.
- The cause of the missing GND copper on that board is not found yet: the R-Com dongle, with its file's pour fills served region by region as stored, still solves (+12V 48.8 mV/A, GND 1.4 mV/A). The board file and the saved log of a 0.1.9 run are needed.

## [0.1.8] - 2026-11-26

The R-Com dongle project file (`.epro2`) reproduced the freeze offline. Its causes were in the extension, not in EasyEDA.

- **Freeze:** `union()` called Clipper's two-argument overload, which rounds to 0.01 mm. EasyEDA Pro 3.2 stores and returns pour fills in units of 10 mil, so decoded as mil they were 10 times too small. One fill region of the Top GND pour, at that size and rounding, sent Clipper into an endless loop that used up all memory (the white window). `union()` now keeps 0.1 µm like the other operations.
- **Pour-fill scale:** each pour's fill is compared with its outline, and fills in 10 mil units are scaled up (logged). Before, the fills sat in a 12 × 7 mm corner of the board, which on its own explains "U4/U5 has no copper path to J3 on GND".
- **Thermal spokes:** unfilled fill entries (thermal spokes) are now stroked with their line width instead of dropped. The CLI read `fill: false` as filled.
- **DC wizard:** the rail is picked first (step 2) and its ground asked once (step 3), only when there is more than one ground. Before, a ground dialog came for every rail: 12 on this board.
- **Grounds:** nets with a prefix before GND (`48V_PGND`, `ISO_GND`) are grounds, not rails, and a rail pairs with the ground named after it (48V → 48V_PGND).
- **CLI:** reads `.epro2` projects (one `.epru` with all documents) and the object form of editor 3.2: compound ids, `use` layer flags, component `x`/`y`, prohibit types as words, nested pour fills, and object pad shapes and holes.
- What earlier versions stored about pour fills that froze is now ignored, because every one of those freezes was this bug. Otherwise both GND pours of the R-Com dongle would stay on the skip list and be computed from their outlines. Markers and the skip list now record the version that wrote them. Saved logs from older builds are no longer read for hung fetches.
- On this board, offline through the mocked API: DC +12V / GND (J3 to U4, U5, F2) takes 2.3 s; Show for Selected Net takes 1.4 s for `$1N261` and 0.4 s for `BNC1+`.

## [0.1.7] - 2026-11-26

With 0.1.5 on the R-Com dongle, EasyEDA returned every pour fill within 3 ms, but DC Return Current still froze: first while the regions of fill `0ca4da6a31655d4b` were read, then, with that fill skipped, after the fetch. Only one step of that later stretch was saved to the log, and it covered decoding and merging every fill.

- Decoding and merging each pour fill are now logged and saved before they start, with region, ring and point counts and times when they finish. The fill being decoded or merged is stored the same way as during the fetch, so a run that freezes there makes the next one skip just that fill and compute its pour from its outline.
- Decoding yields to the editor between fill regions, gives up on a fill after 10 s (its pour is then computed from its outline), and drops points that are not finite numbers.

## [0.1.6] - 2026-11-26

- A freeze while fetching a pour fill under 0.1.4 leaves that version's marker set. 0.1.5 read that marker as "skip every fill" for one run before learning which fill hung. The fill is now taken from the saved log at once, so the first run after updating skips only that fill (on the R-Com dongle, `0ca4da6a31655d4b`, which froze both DC Return Current and Show for Selected Net).

## [0.1.5] - 2026-11-26

On the R-Com dongle, fetching one computed pour fill (`0ca4da6a31655d4b`) froze EasyEDA on every run without a selection. 0.1.4 then computed all pours from their outlines for one run only, so the run after that froze again. A run that recovered this way also ended without a log line after the board read.

- A pour fill whose fetch froze the editor is now remembered (stored as `pouredIdsThatHang`) and never fetched again; only that pour is computed from its outline, and the others still come from EasyEDA. The fill being fetched is stored before each fetch. For logs from older builds, the last fetch line with no result after it names the fill. A log line now separates EasyEDA returning the fill from reading its regions, to show which one hangs.
- Keepout regions with only the "no inner plane" rule no longer cut Top and Bottom pours; they only clear inner plane layers. On a 2-layer board they used to cut holes into outline-computed pours, which can split a ground pour into islands. Each region's rules, layer and area are logged.
- DC Return Current: the selection is read before the board (selecting a trace is optional; it only preselects its net). The end of the board read, the rail guess, every wizard question and answer, and the chosen setup are now saved to the log as they happen, so a freeze between the board read and the solve shows where it happened.

## [0.1.4] - 2026-11-26

First complete runs on a real board (R-Com dongle, 2 layers): DC Return Current (+12V from J3 to U4 and U5) and Show for Selected Net (BNC1+) both finished. But the DC overlay crossed the board outline and keepouts, and the high-frequency check assumed 0.2 mm between the layers.

- Pour fills: in EasyEDA Pro (API 0.3.59) the pour-fill primitive has no `getState_Layer`, which 0.1.3 required, so every pour was computed from its outline. It is now used as is; the layer comes from its pour. Plane copper without a layer is skipped with a warning, and its plane outline is used.
- The board outline (polylines on the outline layer, else the bounding box of outline lines) and keepout regions (rules "no pours" and "no inner plane") are now read. Copper computed from pour outlines is clipped to them; until now it could spill past the board edge and through keepouts.
- Without the stackup API, a 1.6 mm board is assumed: one 1.5 mm core for 2 layers, JLCPCB's default 7628 stack for 4 layers (0.21 / 1.065 / 0.21 mm), and 0.2 mm outer prepregs with the rest split evenly for more. Until now it was 0.2 mm between every pair of layers, which made the ±3h band and via loop estimates far too small on a 2-layer board. The warning now says the stack is assumed, instead of naming an EasyEDA version.

## [0.1.3] - 2026-11-26

The 0.1.2 test got through the board read in about 0.1 s up to the pour fills. It ended with a dialog, "Error: p.getState_Layer is not a function": in this client, `pcb_PrimitivePoured.get(id)` does not return the documented primitive object.

- The result of `pcb_PrimitivePoured.get` is now accepted as the primitive, as an array holding it, or as plain state (`layer`, `pourFills`, …). A fill region's `path` may be a complex-polygon object or already its source.
- The first result's shape (type and keys) is logged, so an unexpected form can be supported from the log alone.
- Any failure while fetching pour fills now falls back to fills computed from pour outlines, with a warning; it no longer ends the run. A pour fill that cannot be decoded is skipped the same way.

## [0.1.2] - 2026-11-26

The saved log of the first 0.1.1 test (DC Return Current on the R-Com dongle board) ended at `read board: pcb_PrimitivePoured.getAll…`. EasyEDA froze inside that call, which returns the pour fills EasyEDA has computed. The 60 s limit never fired, so the editor itself was blocked, not just slow to answer. The same log showed 34 copper layers on that board.

- Computed pour fills are fetched one at a time (`getAllPrimitiveId`, then `get` per fill). Each fetch is logged before it is made, along with its size and time.
- If one fetch takes over 3 s, or all of them over 20 s, the remaining pours are computed from their outlines instead (clearances approximated), with a warning.
- A marker is stored while fetching. If the next run finds it still set, the editor hung there, so that run skips the fetch and computes every pour from its outline. A saved log from 0.1.1 that ends in `pcb_PrimitivePoured.getAll…` counts the same, so the next run after that freeze does not try again.
- Stackup: `pcb_Layer.getStackup` is not in this EasyEDA version, and the fallback `getAllLayers` lists all 32 possible inner layers. Only layers in use are kept now: `layerStatus` not "not used", and within `getTheNumberOfCopperLayers()`.

## [0.1.1] - 2026-11-26

Everything since 0.1.0. The test builds handed out as `_v0.3.0`, `_v0.4.0` and `_v0.5.0` were numbered wrongly (the minor number went up instead of the patch number); they are earlier states of this version.

### API call logging and time limits (test build 0.5.0)

In the third test the log stopped at `read board…` on a signal net (BNC1+), with nothing after it. The log does not say whether that was 0.3.0, whose board read froze right there, or 0.4.0, where only waiting API calls come next (saving the log, then `pcb_Layer.getStackup`). A call that never answers stalls a run silently.

- Every API call of the board read is logged, and the log saved, before it is made (`read board: pcb_PrimitivePoured.getAll…`), so the last line names the call the editor hung in.
- Every API call has a time limit: 60 s per board-read call, 20 s per component's pins (that component's pads are then left out, with a warning), 15 s for the stackup (then the layer list is used, as on older EasyEDA versions). Running out ends the run with a dialog naming the call.
- Saving the log is limited to 2 s per write; a write that does not answer switches that destination off with a warning instead of holding up the run. The stored log is now one string instead of a list.
- Each run starts with the version in its first log line (`Show for Selected Net: BNC1+ (v0.1.1)`).
- Progress is logged every 2 s while component pins are read.

### Saved log and non-blocking board read (test build 0.4.0)

The editor still froze and went white in a second test, which also took the log panel with it.

- The log now survives a freeze or crash. Every line is also kept in the extension's stored settings (last 1000 lines, timestamped); after reopening EasyEDA Pro, **Return Path → Show Saved Log...** shows the end of it and can save it as a file. With **Allow External Interaction** enabled for the extension (Advanced → Extension Manager → Installed), the log is also written to `ReturnPath/returnpath-log.txt` in the EasyEDA documents folder. The log is saved before every step that could block, so the last line names the step that hung.
- Power and ground nets are turned away by name before the board is read, so Show for Selected Net on such a net no longer reads the whole board first.
- Reading the board no longer blocks the editor for long: it yields between primitive groups and logs counts and times for each. Pour and plane copper is merged once per pour or plane instead of piece by piece (which grew quadratically on large planes), plane islands are matched to plane partitions by bounding box and a point test before falling back to polygon intersection, and holes are assigned to islands with a bounding-box prefilter.

### Freeze fix, 2-layer boards and diagnostics (test build 0.3.0)

Fixes the UI freeze from the first test in EasyEDA Pro (selecting a power net, then Return Path → Show for Selected Net).

- Analyses no longer block the editor: they run in ~30 ms slices with a progress bar. Closing the bar, the new **Cancel Running Analysis** menu item, or **Clear Overlay** stops a run. Runs stop with a message after 60 s (high-frequency) or 120 s (DC).
- The high-frequency check is much faster on large nets (a 600-segment net over a slotted plane: 108 s → 3.75 s). Nets over 4000 segments, or reference copper over 500 000 vertices, are refused up front; a detour too complex to trace becomes a warning.
- Ground nets, power rails and plane nets are no longer run through **Show for Selected Net**: a dialog explains why and offers the DC view with the rail preselected. The CLI refuses them unless `--force` is given.
- 2-layer boards: the reference is the opposite layer's pour, or a pour on the trace's own layer (coplanar return) when it is closer than half the board thickness or the opposite layer has none.
- Diagnostics: every phase is logged to the EasyEDA log panel (bottom panel, shortcut S, Log tab) with timings and sizes, prefixed `[ReturnPath]`. Errors are logged with their stack and shown in a dialog. The extension README explains how to open developer tools in the desktop client.
- CLI: `--verbose` prints time per phase; dielectric thickness units are guessed from the total board thickness (a single 1.5 mm core was read as mil); new synthetic 2-layer boards (`npm run demo:2layer`).

### DC return current

- **DC Return Current...**: a wizard guesses the power rails, their grounds, the source and the loads, then solves the rail and its ground on the rasterised copper and draws streamlines and colour-binned current-density contours. Also in the CLI (`--list-rails`, `--dc`).
- The build Balazs first tested in EasyEDA Pro had this, still labelled 0.1.0.

## [0.1.0] - 2026-11-25

- First version: high-frequency return-path overlay for the selected net (reference copper, ±3h coverage, slot and split crossings with geodesic detours, return vias and decaps at layer changes), the EasyEDA Pro extension and the offline CLI.
