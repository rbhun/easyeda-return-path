# Changelog

Every change raises the minor version (`0.x.0`) and adds an entry here, newest first. One version covers the whole repository: `packages/extension/extension.json` and every workspace `package.json` carry it, and the `.eext` file name includes it. `npm run check:version` checks this, and CI checks on pull requests that the version is higher than the target branch's.

## [0.5.0] - 2026-11-25

In the third test the log stopped at `read board…` on a signal net (BNC1+), with nothing after it. The log does not say whether that was 0.3.0, whose board read froze right there, or 0.4.0, where only waiting API calls come next (saving the log, then `pcb_Layer.getStackup`). A call that never answers stalls a run silently.

- Every API call of the board read is logged, and the log saved, before it is made (`read board: pcb_PrimitivePoured.getAll…`), so the last line names the call the editor hung in.
- Every API call has a time limit: 60 s per board-read call, 20 s per component's pins (that component's pads are then left out, with a warning), 15 s for the stackup (then the layer list is used, as on older EasyEDA versions). Running out ends the run with a dialog naming the call.
- Saving the log is limited to 2 s per write; a write that does not answer switches that destination off with a warning instead of holding up the run. The stored log is now one string instead of a list.
- Each run starts with the version in its first log line (`Show for Selected Net: BNC1+ (v0.5.0)`).
- Progress is logged every 2 s while component pins are read.

## [0.4.0] - 2026-11-25

The editor still froze and went white in a second test, which also took the log panel with it.

- The log now survives a freeze or crash. Every line is also kept in the extension's stored settings (last 1000 lines, timestamped); after reopening EasyEDA Pro, **Return Path → Show Saved Log...** shows the end of it and can save it as a file. With **Allow External Interaction** enabled for the extension (Advanced → Extension Manager → Installed), the log is also written to `ReturnPath/returnpath-log.txt` in the EasyEDA documents folder. The log is saved before every step that could block, so the last line names the step that hung.
- Power and ground nets are turned away by name before the board is read, so Show for Selected Net on such a net no longer reads the whole board first.
- Reading the board no longer blocks the editor for long: it yields between primitive groups and logs counts and times for each. Pour and plane copper is merged once per pour or plane instead of piece by piece (which grew quadratically on large planes), plane islands are matched to plane partitions by bounding box and a point test before falling back to polygon intersection, and holes are assigned to islands with a bounding-box prefilter.

## [0.3.0] - 2026-11-25

Fixes the UI freeze from the first test in EasyEDA Pro (selecting a power net, then Return Path → Show for Selected Net).

- Analyses no longer block the editor: they run in ~30 ms slices with a progress bar. Closing the bar, the new **Cancel Running Analysis** menu item, or **Clear Overlay** stops a run. Runs stop with a message after 60 s (high-frequency) or 120 s (DC).
- The high-frequency check is much faster on large nets (a 600-segment net over a slotted plane: 108 s → 3.75 s). Nets over 4000 segments, or reference copper over 500 000 vertices, are refused up front; a detour too complex to trace becomes a warning.
- Ground nets, power rails and plane nets are no longer run through **Show for Selected Net**: a dialog explains why and offers the DC view with the rail preselected. The CLI refuses them unless `--force` is given.
- 2-layer boards: the reference is the opposite layer's pour, or a pour on the trace's own layer (coplanar return) when it is closer than half the board thickness or the opposite layer has none.
- Diagnostics: every phase is logged to the EasyEDA log panel (bottom panel, shortcut S, Log tab) with timings and sizes, prefixed `[ReturnPath]`. Errors are logged with their stack and shown in a dialog. The extension README explains how to open developer tools in the desktop client.
- CLI: `--verbose` prints time per phase; dielectric thickness units are guessed from the total board thickness (a single 1.5 mm core was read as mil); new synthetic 2-layer boards (`npm run demo:2layer`).

## [0.2.0] - 2026-11-25

- **DC Return Current...**: a wizard guesses the power rails, their grounds, the source and the loads, then solves the rail and its ground on the rasterised copper and draws streamlines and colour-binned current-density contours. Also in the CLI (`--list-rails`, `--dc`).
- The build Balazs first tested in EasyEDA Pro was this version, still labelled 0.1.0.

## [0.1.0] - 2026-11-25

- First version: high-frequency return-path overlay for the selected net (reference copper, ±3h coverage, slot and split crossings with geodesic detours, return vias and decaps at layer changes), the EasyEDA Pro extension and the offline CLI.
