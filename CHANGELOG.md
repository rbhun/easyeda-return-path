# Changelog

Every change raises the minor version (`0.x.0`) and adds an entry here, newest first. One version covers the whole repository: `packages/extension/extension.json` and every workspace `package.json` carry it, and the `.eext` file name includes it. `npm run check:version` checks this, and CI checks on pull requests that the version is higher than the target branch's.

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
