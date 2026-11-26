# Changelog

Every change raises the patch number (`0.1.x`) and adds an entry here, newest first. The major and minor numbers change only when the owner declares a milestone; that entry's heading then ends with `- Milestone: <name>`. One version covers the whole repository: `packages/extension/extension.json` and every workspace `package.json` carry it, and the `.eext` file name includes it. `npm run check:version` checks this, and CI checks on pull requests that only the patch number went up (unless a milestone is declared).

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
