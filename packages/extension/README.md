# @returnpath/extension

EasyEDA Pro extension built on the official [pro-api-sdk](https://github.com/easyeda/pro-api-sdk) template (1.6.31). It runs the shared geometry core (`@returnpath/core`) on the open PCB and draws the result as a temporary overlay.

## Use

1. From the repository root: `npm ci && npm run build:extension`.
2. In EasyEDA Pro (≥ 4.1.93 for the stackup and undo-group APIs), import `packages/extension/build/dist/easyeda-return-path_v<version>.eext` (the version is in `extension.json`; see the root `CHANGELOG.md`) as a local extension in the Extension Manager. CI also uploads it as the `extension-eext` artifact.
3. In a PCB, select a track, via or pad of the net, then choose **Return Path → Show for Selected Net**. **Clear Overlay** removes the drawing.

The analysis runs in ~30 ms slices and hands control back to the editor between them, so the UI stays responsive. A progress bar shows the current phase; closing it, or **Return Path → Cancel Running Analysis**, stops the run (so does **Clear Overlay**). The high-frequency check stops with a message after 60 s, the DC solve after 120 s. Nets with more than 4000 track segments, or boards whose reference copper has more than 500 000 polygon vertices, are refused up front. A slot detour with more than 1500 copper corners in its search window is reported as too complex instead of being traced.

**Show for Selected Net** is for signal nets. Ground nets, power rails (by name) and nets that own pours are not run through it: a dialog explains why and offers to open **DC Return Current...** with the rail preselected.

On 2-layer boards the reference is the opposite outer layer's pour, or a pour of another net on the trace's own layer (coplanar return) when it sits closer to the trace than half the board thickness, or when the opposite layer has no pour. Coplanar crossings are found by probing the copper beside the trace, and the detour runs in that pour.

**DC Return Current...** runs wizard step 1 (design decisions D3, D7) with system dialogs. You confirm the power rails, pair each with a ground (only asked when there is more than one), pick the rail to solve (the selected net is preselected), confirm its single active source (the guessed one is preselected, and the other candidates are left out), tick the loads, and optionally give load currents (`U2=150mA, U3=0.02`). It then solves the rail and its ground (`packages/core/src/dc`) and draws, as indicator markers: one streamline per load, the supply thin amber and the return thick, magenta on the top layer and cyan on the others with a circle where it changes layer; and the bottleneck as a red circle. Drops, bottleneck and warnings are listed in a dialog. **Clear Overlay** removes this drawing too.

**Hide/Show Overlay** hides the last drawing and shows it again. **Rerun Last Analysis** reads the board again and repeats the last analysis with the same net, or the same DC wizard answers and load currents, so a change such as a moved or added via can be checked without the wizard. The last analysis is stored, so this works after a restart too.

It reads tracks, arcs, vias, free and component pads, pours, computed pour fills, copper fills and the stackup through the API (`src/eda-board.ts`). Plane-layer copper has no pour, so it takes its net from the fill-mode-2 (`INNER_ELECTRICAL_LAYER`) `Fill` it overlaps most. The overlay is temporary: it is drawn with `dmt_EditorControl.generateIndicatorMarkers` and removed with `removeIndicatorMarkers`, so nothing is saved in the document or the undo history (`src/overlay.ts`). Green outlines show the ±3h band, red the band without copper and centreline gaps, orange the detour path, and blue the links from vias to return vias or decaps and from splits to bridging caps. The findings are listed in a dialog.

## Testing in EasyEDA Pro and reading the logs

Every run writes its phases to the EasyEDA log panel, prefixed `[ReturnPath]`: board size after reading it (copper layers, nets, track segments, vias, pads, pours/fills and their vertex count), the start time of each analysis phase, the time spent per phase when it ends, the work sizes (segments, chains, reference-copper vertices, centreline samples, detours and the largest detour graph, DC grid, nodes, CG iterations), and the marker count. Errors go to the log with their stack and end in a dialog; a run stopped by the time budget or a complexity limit says which phase it was in.

- **Log panel:** open the bottom panel (shortcut **S**, or **View** in the top menu) and pick the **Log** tab.
- **Saved log, after a freeze or crash:** the panel is lost with the window, so every line is also stored with the extension's settings (last 1000 lines, timestamped) and saved before each step that could block. Reopen EasyEDA Pro and use **Return Path → Show Saved Log...**; it shows the last lines and can save the whole log as a file. The last line names the step that hung.
- **Log file:** enable **Allow External Interaction** for the extension (**Advanced → Extension Manager → Installed → Return Path Visualizer**, desktop client only) and the log is also written to `ReturnPath/returnpath-log.txt` in the EasyEDA documents folder (`sys_FileSystem.getEdaPath()`); **Show Saved Log...** prints the full path. Without that permission the file API throws, and the extension then keeps the log in its settings only.
- **Developer tools in the desktop client:** press **F12 three times** in quick succession, or right-click the top menu text and choose **Developer tools**; press F12 again to close them. In the browser one F12 is enough. Console errors (red) are what EasyEDA support asks for.
- **Debug mode:** in that console, run `window.location.href = 'https://client/editor?cll=debug'` (desktop) or open `https://pro.easyeda.com/editor?cll=debug` (browser). Extensions can then print to the console.
- If an extension breaks the editor, `?safetyMode=true` in the editor URL starts it with extensions disabled.

Sources: [Invoking the Extension API](https://prodocs.easyeda.com/en/api/guide/invoke-apis.html) (debug mode, F12 ×3 on the client), [Desktop Client FAQ](https://prodocs.easyeda.com/en/faq/client/) (right-click menu → Developer tools), [Other FAQs](https://prodocs.easyeda.com/en/faq/others/), [Error Handling](https://prodocs.easyeda.com/en/api/guide/error-handling.html) (safety mode), and the `SYS_Log.add` docs in `@jlceda/pro-api-types`.

## Limits of this first version

- First tried in EasyEDA Pro on a power net, which froze the UI: the detour search ran synchronously over a large plane. Fixed by the time slicing, limits and power-net check above. A second test still froze, with no readable log; 0.1.1 adds the saved log, turns power nets away before the board read, and makes the board read yield and avoid quadratic polygon merges. Not yet re-tested in the app. `test/extension.test.ts` runs the menu action against an in-memory mock of the API (`test/mock-eda.ts`), fed from the CLI's synthetic demo board, and checks that it gets the same findings as the file pipeline. `test/diagnostics.test.ts` checks the log lines, the progress bar, the power-net hand-off, error dialogs and cancelling a 600-segment net. `test/saved-log.test.ts` checks the stored log and log file, that the log is on disk before the board read starts, and the permission-denied case.
- Markers have no fill, so regions are drawn as outlines. Marker coordinates are assumed to be canvas coordinates, offset from data coordinates by a translation, and the marker line width is passed as 2 (mil or pixels is not documented).
- It needs current pour fills. Pours without a computed fill fall back to their outline, and keepout regions are not read. Plane copper that overlaps no mode-2 fill is skipped with a warning.
- Every via is treated as through-hole. Without `getStackup()`, dielectrics default to 0.2 mm.
- DC: pin names are schematic-only, so on the PCB the source guess relies on part names (`getState_Name()`), designators and rail voltages from net names. Copper thickness is taken from `getStackup()` in its unit, and values outside 5–210 µm are dropped. Rail–ground pairings are not saved between runs yet. Markers cannot show which layer a contour belongs to, so only each net's dominant layer is drawn. Each marker call is capped at 4000 shapes. The dialogs report a choice only through a callback, and closing one without choosing ends the wizard silently. The solve runs on the main thread in slices (no worker: the sandbox's support for them is unknown), about 1.5 s per rail for the 50 × 34 mm test board under Node; untested in the EasyEDA sandbox.
- API Y orientation and units are assumed to match the file format (mil, Y up).

## Template differences

`build/` and `config/` are the SDK's files unchanged, apart from running under `tsx` instead of `ts-node` (the repository uses TypeScript 7, which has no JS API for ts-node). The SDK's ESLint setup and git hooks are not included. `npm run update:check` compares the framework files against the upstream SDK. The SDK is Apache-2.0; its license is in `build/LICENSE-pro-api-sdk.txt`, and bundled third-party licenses are in `THIRD_PARTY_NOTICES.txt`.
