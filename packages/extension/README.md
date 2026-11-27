# @returnpath/extension

EasyEDA Pro extension built on the official [pro-api-sdk](https://github.com/easyeda/pro-api-sdk) template (1.6.31). It runs the shared geometry core (`@returnpath/core`) on the open PCB and draws the result as a temporary overlay.

## Use

1. From the repository root: `npm ci && npm run build:extension`.
2. In EasyEDA Pro (≥ 4.1.93 for the stackup and undo-group APIs), import `packages/extension/build/dist/easyeda-return-path_v<version>.eext` (the version is in `extension.json`; see the root `CHANGELOG.md`) as a local extension in the Extension Manager. CI uploads each pull request's build as the artifact `easyeda-return-path_v<version><letter>` (`a` for the first build of a version, then `b`, `c`, ...), and every version on main is published as the GitHub Release `v<version>` with the `.eext` attached.
3. In a PCB, open **Return Path → Open Panel...**. Press **HF check** in the panel, pick the net and its speed. A selected track, via or pad preselects its net. **Clear** removes the drawing.

The extension also serves the `mcp.rcp.*` commands on the bridge so AI agents can inspect nets, configure analysis options, and start/poll HF and DC analyses without editing the PCB (see [Agent bridge](#agent-bridge-mcprcp)). The menu has **Open Panel...**, **Load Board Info...**, **Save Board Info...**, **Run Folder...**, **Show Saved Log...** and **About...**; the analyses, the overlay and its colours are in the panel.

The analysis runs in ~30 ms slices and hands control back to the editor between them, so the UI stays responsive. A progress bar shows the current phase; closing it, or **Cancel** in the panel (the **Selected trace** button while a run is going), stops the run (so does **Clear**). The high-frequency check stops with a message after 60 s, the DC solve after 120 s. Nets with more than 4000 track segments, or boards whose reference copper has more than 500 000 polygon vertices, are refused up front. A slot detour with more than 1500 copper corners in its search window is reported as too complex instead of being traced.

**HF check** (the high-frequency view) is for signal nets. It lists the routed signal nets in the wizard window: recognised data lines first (I²C, SPI, UART, USB, I²S, SWD, CAN, Ethernet, clocks…, from the net name or the pin names), each with its kind, its length and a speed selector after it, then the rest. The speed is prefilled with the usual speed of that kind of line; the selector offers that kind's usual speeds with their typical edge times, or **Other speed…** to type one (`400k`, `12 MHz`, `115200`). Without the wizard window the net and its speed are asked in two system dialogs. The result says what the speed means for that trace: how high its spectrum reaches, and whether the trace is long enough to act as a transmission line. Ground nets, power rails (by name) and nets that own pours are not run through it: the wizard window explains why and offers to open the DC view for that rail without asking for it again.

**Selected trace** runs the check that fits the selected track, via or pad: the HF check for a signal net (no net or speed question: it takes the usual speed of that kind of line), and the DC check for a power rail, straight away and with the rail taken from the selection. While an analysis runs, this button reads **Cancel** and stops it; it also ends a wizard question that is still waiting, and clears the busy state of a run that does not answer within 5 s, so the buttons never stay greyed out. If a file write (log file or run files) does not answer within 2 s, file writes stop for the session and the analyses carry on; choosing the Run folder again retries them.

The return is one line, the path of least loop area through the ground copper, from the driving part's ground pad to the signal pin at the other end. Ground copper (the poured fill, ground tracks and ground pads) is rasterised at 3 mil; cells with no ground copper are impassable, and the line changes layer only at a ground via or through-hole pad that touches ground on both layers. A step costs eps + d/h, with d the distance to the signal and h the dielectric height read from the stackup (else 1.6 mm), so following the trace, including its corners, is nearly free and any shortcut pays the area it encloses. Where the line leaves the trace, the extra area decides: under h² it is drawn back on the trace and a small red minor-cut mark shows where that crosses other copper; from h² up to 9h² the detour is kept; at 9h² and over it is kept and flagged with a larger red mark and the area in the result. The line is straight segments of that raster path. White lines ±h either side of the trace bound half the return current in the plane under it (the spread is (2/π)·atan(d/h), so half sits inside ±h and about 80% inside the wider ±3h outline, which stays hidden until it is shown in the panel). Current is coloured by the copper layer it flows in, as in the DC view: the return magenta in Top copper, cyan in Bottom copper and blue in inner layers; the forward current (the signal trace) yellow on Top and green on other layers. Pour fill narrower than 0.1 mm is not counted as copper. The line enters a part only through a ground pad (GND, EP, −Vo, or a pin with VSS in its name; an enable pin such as SD tied to that net does not take it). Where the trace passes through a connector or module pin in the middle, the loop closure is reported through that part's ground pin. The signal trace itself is drawn thin in the colour of its layer, with a circle on each via it passes through from one layer to another; hops through a part (a bridging cap, a decap, the driver's other edge) are dashed white. A ground pad the line reaches is marked with a circle only: where the copper does not connect, the line stops, and nothing is drawn across the air, a trace or a gap. Red also marks stretches with less than half the reference copper they need; smaller shortfalls are listed in the result.

**DC check…** runs wizard step 1 (design decisions D3, D7) in the wizard window. That window holds every question of an analysis (pick one, pick several, type a value, give load currents, confirm) on one page layout: a step badge, the question, a list that scrolls on its own (with a select-all box when several can be picked) and Back/OK/Cancel below it. **Back** returns to the previous question with its earlier answer kept. It opens with the first question and closes before the analysis runs. If its page cannot reach the extension within 4 s, the questions go to the system dialogs instead (the multi-select one then starts with a "Select all" entry). You confirm the power rails, pair each with a ground (only asked when there is more than one), tick the rail to solve (tick several nets of one rail, such as both sides of a fuse, shunt, jumper or eFuse, to solve them together, with the parts between them taken as shorts; an eFuse or ideal diode is the short through its input and output pins), confirm its single active source (the guessed one is preselected, and the other candidates are left out), tick the loads, and give their currents: a **Total current** for the rail, shared between the loads by a slider per load (moving one keeps the total and the ratios of the others), and a field per load to type a current exactly (`150mA`, or `0.15` for amps; the total follows). They are prefilled with 100 mA per load, or with the last run's currents on the same rail; **Equal** shares the total equally. Clearing the total splits 1 A equally and shows the result per amp. With a guessed rail selected (or a rail handed over from HF check), the first two questions are skipped. Parts with no pad on a ground net (pull-ups, LEDs to a GPIO) are not ticked as loads. It then solves the rail and its ground (`packages/core/src/dc`) and draws, as indicator markers: one streamline per load (that load's own current, so the others do not bend it), coloured by the copper layer the current flows in: the supply thin, yellow on the top layer and green on the others, and the return thick, magenta on the top layer and cyan on the others with a circle where it changes layer; and the bottleneck as a red circle. Drops, bottleneck and warnings are listed in the panel. The drop is the voltage from the source to each load (the first number is the largest). A track, a pour neck or a via that is narrower than IPC-2221 allows for its current at a 10°C rise is named in a warning. **Clear** removes this drawing too.

**Return Path → Open Panel...** opens a window that stays open and does not block the editor (it can be minimised). It has buttons for HF check, DC check, Selected trace (Cancel while a run is going), Rerun last, Hide/Show and Clear (always available: it removes every Return Path marker on the board, also ones an earlier version left; markers left behind by an update or reload of 0.1.41 or later show as "Overlay: left by v0.1.x", and Hide removes them too); it shows the result of each analysis, and there is no separate result dialog (with the panel closed, a notice says the result is there); and it shows or hides each overlay role (forward current on the top layer and on other layers, return current on the top layer, on other layers and on inner layers, hops, gaps and bottleneck, band edges; only the ones the last check draws are listed, and band edges start hidden) and sets its colour and line width. Colour changes redraw the current overlay without a new analysis and are kept with the extension's settings. Only red, yellow, green, cyan, blue, magenta and white are offered: EasyEDA Pro 3.2 clips marker colours to a 0–1 scale, so mixed colours come out white. Every analysis opens the panel unless you closed it; Open Panel brings it back. The panel also shows results of analyses run in another instance of the extension, including ones run before it was opened: EasyEDA may run actions in separate instances, so each instance shares its result, last run and overlay over the extension's message bus, and also leaves them in a mailbox topic that the panel reads when it opens. If the panel stays on "Connecting", its page cannot reach the extension in this EasyEDA version; send the saved log.

**Hide**/**Show** hides the last drawing and shows it again. **Rerun last** reads the board again and repeats the last analysis with the same net, or the same DC wizard answers and load currents, so a change such as a moved or added via can be checked without the wizard. The last analysis is stored, so this works after a restart too.

### Board info

The extension keeps, per project, what the board cannot tell it: what each net is (kind, protocol and speed, driver, receivers, diff-pair partner, intended reference, impedance or length target, notes), each power rail's voltage, source and load currents, and each layer's pours and intentional splits. It is stored with the extension's settings under the project's id (`boardInfo:<project uuid>`), not in the document.

**Return Path → Load Board Info...** first shows the CSV format (the `row` column, each row type's columns, the kinds, units and blank cells) and what Replace and Add do, with **Save the sample CSV as a template** to save the sample below as `board-info-template.csv`; **Choose the CSV file…** then imports a file into it. If the project already has board info, it asks whether to **replace** it or **add** the file's rows to it (a row for a net, rail load or layer that is already known updates it; its blank cells keep the stored values). The summary lists the rows read and any cells it could not read, with their line numbers. **Return Path → Save Board Info...** saves the project's board info as `<project>-board-info.csv` in the same format, to edit and load again.

The HF and DC checks prefill from it, and write back what you change:

- **HF check** lists nets with board info first, labelled with their protocol (or kind) and `board info`, and leaves out nets the board info marks as power or ground. The speed selector starts at the board info's speed. A driver from the board info is used without asking (if all its parts have a pad on the net). The result has a `Board info:` line with the kind, diff partner, intended reference, target, receivers and notes.
- **DC check** offers the board info's rails and grounds, preselects the rail's source and loads, and prefills each load's current with its typical current (before the last run's currents and the 100 mA default).
- A speed you change, a driver you pick (also **None**), or a DC source, load set or currents that differ from the prefilled ones are saved into the board info when the analysis runs, so each net and rail is set up once. Board info, imported or saved this way, wins over what the extension recognises from names and pins; a later edit in the wizard overrides the imported value.

The CSV has one row per net, rail load or layer; the first column `row` says which. The header names the columns, in any order (commas or, as Excel writes them in some locales, semicolons; a column the file leaves out is blank). Blank cells mean not applicable or not known. [`examples/board-info-sample.csv`](examples/board-info-sample.csv) is a complete example.

| `row` | Columns used |
| --- | --- |
| `net` | `net`; `kind`: clock, data, bus, diff pair, power, ground, analog or control; `protocol` (I2C, SPI, UART, USB, MCO…); `speed` (`400k`, `8 MHz`, `115200`); `driver_part`, `driver_pin`, `driver_pin_name` (several parts separated by `;`, `none` for no driver); `receivers`; `diff_partner`; `reference` (intended return reference, such as `GND on In1`); `target` (impedance or length target); `notes` |
| `load` | `net` (the rail); `voltage` (`3.3`, `3V3`); `source_part`, `source_pin`; `load_part`, `load_pin`; `typical_current`, `peak_current` (`150mA`, or amps such as `0.15`); `notes` |
| `layer` | `layer`; `pours` (the nets poured on it); `splits` (intentional splits and star grounds); `notes` |

The stored peak currents, pins, receivers, targets and layer rows are kept and shown, but the analyses do not use them yet.

It reads tracks, arcs, vias, free and component pads, pours, computed pour fills, copper fills and the stackup through the API (`src/eda-board.ts`). Plane-layer copper has no pour, so it takes its net from the fill-mode-2 (`INNER_ELECTRICAL_LAYER`) `Fill` it overlaps most. The overlay is temporary: it is drawn with `dmt_EditorControl.generateIndicatorMarkers` and removed with `removeIndicatorMarkers`, so nothing is saved in the document or the undo history (`src/overlay.ts`). Green outlines show the ±3h band, red the band without copper and centreline gaps, orange the detour path, and blue the links from vias to return vias or decaps and from splits to bridging caps. The findings are listed in a dialog.

## Agent bridge (`mcp.rcp.*`)

The Return Path extension itself exposes `mcp.rcp.*` commands on EasyEDA's public message bus, so an AI agent can inspect nets, read and update analysis configuration, run fast geometry checks, and start/poll/cancel full HF and DC analyses through the [`easyeda-mcp-pro`](https://github.com/oaslananka/easyeda-mcp-pro) bridge (`easyeda_extension_call`). There is no second extension: upgrade Return Path and the topics are there.

```text
agent --easyeda_extension_call--> easyeda-mcp-pro --bridge--> MCP Pro Bridge extension
      --eda.sys_MessageBus.rpcCallPublic(topic, msg)--> Return Path (this extension) --> JSON reply
```

None of the bridge commands ever modify PCB copper, nets, or design primitives — configuration is stored in the extension's own settings (`sys_Storage`) and overlays are drawn only as temporary indicator markers. All geometry coordinates, lengths, thicknesses, and radii are in **millimetres (`mm`)**.

### Install, upgrade and verify (desktop EasyEDA Pro)

EasyEDA Pro caches extension code aggressively: re-importing an unchanged version does not replace the running code.

1. Build or download the new Return Path `.eext` (the version in `extension.json` is higher than the one installed).
2. In **Advanced -> Extension Manager -> Installed**, remove the old **Return Path** entry. If you installed the short-lived `MCP Return Path` / `Return-Current-Path Checker (MCP)` extension from 0.1.81, remove that too: it is retired, and its topics would clash with the ones Return Path now registers.
3. Fully quit EasyEDA Pro (**Cmd+Q**) and reopen it.
4. Import the `.eext` (**Extension Manager -> Import**), then fully quit and reopen once more so the startup activation runs on the new bundle.
5. Open any PCB and choose **Return Path -> About...**. It shows the version and all 10 `mcp.rcp.*` topics.

### Calling from Claude Desktop via `easyeda-mcp-pro`

1. In `~/Library/Application Support/Claude/claude_desktop_config.json`, add `mcp.rcp.*` to the `easyeda-mcp-pro` server's `env`:

```json
{
  "TOOL_PROFILE": "experimental",
  "BRIDGE_EXTENSION_RPC_TOPICS": "mcp.demo.*,mcp.rcp.*"
}
```

2. Fully quit (**Cmd+Q**) and reopen Claude Desktop.
3. Focus a PCB document in EasyEDA Pro and call through `easyeda_extension_call`:

Configure analysis defaults (board info, rules, target nets, HF/DC options):

```json
{
  "topic": "mcp.rcp.setConfig",
  "message": {
    "boardInfo": {
      "nets": [{ "net": "USB_DP", "kind": "diff pair", "protocol": "USB", "speed": "12 MHz", "driver": "U1", "edge": "fast" }],
      "loads": [{ "net": "3V3", "voltage": "3V3", "source": "U1", "load": "U2", "typicalCurrent": "150mA" }]
    },
    "rules": { "returnViaRadiusMm": 2.5 },
    "hf": { "nets": ["USB_DP", "USB_DM"], "draw": true },
    "dc": { "rail": "3V3", "ground": "GND", "draw": true }
  },
  "timeoutMs": 10000,
  "confirmWrite": true
}
```

Start an HF or DC analysis (returns the result immediately if it finishes within `waitMs`, or a `running` job handle to poll with `mcp.rcp.getAnalysis`):

```json
{
  "topic": "mcp.rcp.startAnalysis",
  "message": { "kind": "hf", "net": "USB_DP", "requestId": "hf-usb-dp-1", "waitMs": 15000 },
  "timeoutMs": 25000,
  "confirmWrite": true
}
```

```json
{
  "topic": "mcp.rcp.startAnalysis",
  "message": { "kind": "dc", "rail": "3V3", "requestId": "dc-3v3-1", "waitMs": 5000 },
  "timeoutMs": 15000,
  "confirmWrite": true
}
```

Poll if `status` is `"running"` (optional long-poll `waitMs`):

```json
{
  "topic": "mcp.rcp.getAnalysis",
  "message": { "jobId": "rcp-1-abc123", "waitMs": 15000 },
  "timeoutMs": 25000,
  "confirmWrite": true
}
```

Fast geometry checks and markers still work directly too:

```json
{ "topic": "mcp.rcp.info", "message": {}, "timeoutMs": 10000, "confirmWrite": true }
```

```json
{ "topic": "mcp.rcp.listNets", "message": { "offset": 0, "limit": 50, "includePower": false }, "timeoutMs": 10000, "confirmWrite": true }
```

```json
{ "topic": "mcp.rcp.checkNet", "message": { "net": "USB_DP" }, "timeoutMs": 20000, "confirmWrite": true }
```

### Hard guarantees

- **Public bus namespace:** all 10 services register under `mcp.rcp.*` via `eda.sys_MessageBus.rpcServicePublic` when the Return Path extension starts (`activationEvents: { "onStartupFinished": true }`), reusing the same analysis engine and `returnpath.run` executor as the UI.
- **Envelope:** every topic returns `{ "ok": true, "data": ... }` on success or `{ "ok": false, "error": "..." }` on failure (errors are returned as data, never thrown across the bus).
- **Plain JSON & ≤ 256 KiB:** replies are strictly plain JSON (no functions, class instances, or non-finite numbers) and are bounded below 240 KiB (safely under the bridge's 256 KiB transport limit).
- **No PCB mutations & idempotent handlers:** none of the topics edit PCB copper, nets, or undo history. `setConfig` writes only to the extension's own storage (`sys_Storage`); overlays use temporary indicator markers only. Pass `requestId` on `startAnalysis` so retrying after a bridge timeout returns the existing job handle/result instead of starting a duplicate run. `setConfig`, `getConfig`, `getAnalysis`, `cancelAnalysis`, `showFindings`, and `clearMarkers` are all idempotent.
- **Units:** EasyEDA stores PCB coordinates in `mil`. All coordinates, lengths, thicknesses, and radii in requests and replies are in **`mm`**, and every reply states `"unit": "mm"`.

### Topics

| Topic | Request (`message`) | Reply (`data`) |
| --- | --- | --- |
| `mcp.rcp.info` | `null` or `{}` | `{ service, version, pcbUuid, copperLayers, stackup, unit, defaultRules, topics }` |
| `mcp.rcp.listNets` | `{ offset?, limit?, includePower? }` | `{ unit, total, totalAll, offset, limit, includePower, hasMore, nets, truncated? }` |
| `mcp.rcp.checkNet` | `{ net, rules?, refresh? }` | `{ net, unit, skipped?, reason?, segmentsChecked, viasChecked, referenceNetsUsed, rulesApplied, summary, findings, truncated?, warnings? }` |
| `mcp.rcp.showFindings` | `{ findings, color?, lineWidth?, zoom?, clearExisting? }` | `{ shown, unit }` |
| `mcp.rcp.clearMarkers` | `null` or `{}` | `{ cleared, unit }` |
| `mcp.rcp.getConfig` | `null` or `{}` | `{ unit, project, boardInfo, rules, hf, dc, overlayStyle, lastRun, activeJob, truncated? }` |
| `mcp.rcp.setConfig` | `{ mode?, reset?, boardInfo?, rules?, hf?, dc?, overlayStyle? }` | `{ unit, updated, config }` |
| `mcp.rcp.startAnalysis` | `{ kind: "hf" \| "dc", requestId?, waitMs?, includeLines?, net?, nets?, speed?, speedHz?, drivers?, rail?, railNets?, ground?, source?, loads?, currents?, focus?, draw?, timeoutMs? }` | `{ jobId, requestId?, kind, status, unit, startedAt, finishedAt?, durationMs, progress, pollTopic?, result?, error?, truncated? }` |
| `mcp.rcp.getAnalysis` | `{ jobId?, requestId?, waitMs?, includeLines?, list? }` | Same job envelope as `startAnalysis`, or `{ unit, activeJobId, jobs }` when `list: true` |
| `mcp.rcp.cancelAnalysis` | `null` or `{ jobId?, requestId? }` | `{ unit, cancelled, jobId, status }` |

#### `mcp.rcp.info`

Returns extension metadata, active PCB UUID, copper layer count, physical stackup, unit (`"mm"`), default check rules, and registered topic names. Requires a focused PCB document (`documentType === 3`).

```json
{
  "ok": true,
  "data": {
    "service": "easyeda-return-path",
    "version": "0.1.83",
    "pcbUuid": "pcb-uuid",
    "copperLayers": 4,
    "stackup": [
      { "layerId": 1, "name": "Top Layer", "type": "copper", "thicknessMm": 0.035 },
      { "layerId": 0, "name": "Prepreg 1", "type": "dielectric", "thicknessMm": 0.21 },
      { "layerId": 15, "name": "Inner1", "type": "copper", "thicknessMm": 0.017 },
      { "layerId": 0, "name": "Core", "type": "dielectric", "thicknessMm": 1.065 },
      { "layerId": 16, "name": "Inner2", "type": "copper", "thicknessMm": 0.017 },
      { "layerId": 0, "name": "Prepreg 2", "type": "dielectric", "thicknessMm": 0.21 },
      { "layerId": 2, "name": "Bottom Layer", "type": "copper", "thicknessMm": 0.035 }
    ],
    "unit": "mm",
    "defaultRules": {
      "referenceNets": null,
      "returnViaRadiusMm": 2.5,
      "planeEdgeClearanceFactor": 3,
      "minSegmentLengthMm": 0.25,
      "skipNets": []
    },
    "topics": [
      "mcp.rcp.info",
      "mcp.rcp.listNets",
      "mcp.rcp.checkNet",
      "mcp.rcp.showFindings",
      "mcp.rcp.clearMarkers",
      "mcp.rcp.getConfig",
      "mcp.rcp.setConfig",
      "mcp.rcp.startAnalysis",
      "mcp.rcp.getAnalysis",
      "mcp.rcp.cancelAnalysis"
    ]
  }
}
```

When EasyEDA does not expose the physical stackup, standard 1.6 mm dielectrics are assumed (`1.5 mm` for 2-layer; `0.21 / 1.065 / 0.21 mm` for 4-layer) and entries include `"assumed": true`.

#### `mcp.rcp.listNets`

Lists PCB nets in pages so replies stay small on large boards.

**Request:**

- `offset` (`number`, default `0`): zero-based index into the filtered net list.
- `limit` (`number`, default `50`, max `200`): page size.
- `includePower` (`boolean`, default `false`): when `false`, power rails and ground nets are filtered out so agents can iterate signal nets directly; when `true`, all nets are returned with `isPower` and `isGround` flags.

**Reply (`data`):**

```json
{
  "unit": "mm",
  "total": 98,
  "totalAll": 134,
  "offset": 0,
  "limit": 50,
  "includePower": false,
  "hasMore": true,
  "nets": [
    {
      "name": "USB_DP",
      "trackCount": 14,
      "viaCount": 2,
      "layers": [1, 2],
      "totalLengthMm": 28.45,
      "isPower": false,
      "isGround": false,
      "hasPour": false
    }
  ]
}
```

#### `mcp.rcp.checkNet`

Runs return-current-path checks for a single net (matched case-insensitively, matching EasyEDA's net semantics). Adjacent findings along a trace are merged to keep replies compact.

**Request:**

- `net` (`string`, required): net name on the focused PCB.
- `rules` (`object`, optional): overrides any subset of `defaultRules` (see below).
- `refresh` (`boolean`, optional, default `false`): bypass the short 5-second decoded-copper cache to re-read board pours immediately after an edit.

**`Finding` schema:**

```ts
type Finding = {
  severity: 'error' | 'warning' | 'info';
  kind:
    | 'no_reference_plane'      // trace segment with no solid reference plane on the adjacent layer beneath it
    | 'plane_split_crossing'    // trace crosses a gap/split between plane islands or pours
    | 'plane_void'              // trace runs over a void/cutout (antipad, keepout) inside a reference plane
    | 'near_plane_edge'         // trace runs within N × dielectric height of the reference plane edge
    | 'layer_change_no_return'  // signal via changes reference plane with no return/stitching via within radius
    | 'reference_net_change';   // reference plane changes net (e.g. GND → 3V3 or GND → 48V_PGND) along the route
  net: string;
  layerId: number;              // signal layer of the offending trace/via
  referenceLayerId?: number;    // adjacent reference layer checked against
  at: { x: number; y: number }; // location in mm
  lengthMm?: number;            // affected trace length in mm, when applicable
  detail: string;               // human-readable one-sentence explanation
  primitiveIds?: string[];      // offending track/arc/via primitive IDs
};
```

**Default rules:**

| Rule | Default | Description |
| --- | --- | --- |
| `referenceNets` | `null` | Reference-plane net names (case-insensitive). `null` or `[]` auto-selects all ground nets (`GND`, `AGND`, `DGND`, `PGND`, `48V_PGND`, `ISO_GND`, `VSS`, …) that have pours/planes on the board. Pass e.g. `["GND"]` to restrict to specific nets. |
| `returnViaRadiusMm` | `2.5` | Maximum distance (mm) from a layer-changing signal via to a valid return/stitching via (or through-hole pad) connecting both reference layers. |
| `planeEdgeClearanceFactor` | `3` | Multiplier `N` applied to the adjacent dielectric height `h` for `near_plane_edge` (`N × h`). Set `0` to disable edge-clearance warnings. |
| `minSegmentLengthMm` | `0.25` | Minimum affected trace length (mm) for `no_reference_plane`, `plane_void`, and `near_plane_edge` findings. (`plane_split_crossing`, `reference_net_change`, and `layer_change_no_return` are always reported regardless of gap width.) |
| `skipNets` | `[]` | Net names (case-insensitive) to skip; returns `{ skipped: true, findings: [] }`. |

#### `mcp.rcp.showFindings`

Draws temporary indicator markers on the focused PCB canvas for human review. Does not modify the design or undo stack.

**Request:**

- `findings` (`array`, required, max 2000 items): each item accepts either `{ x, y, w?, h?, r?, severity? }` or a `Finding` object from `checkNet` (`{ at: { x, y }, severity? }`), all coordinates and sizes in **mm**. When `w`/`h` are provided, a rectangle is drawn; otherwise a circle (default radius `0.8 mm`).
- `color` (`string | { r, g, b, alpha? }`, optional): named color (`red`, `yellow`, `green`, `cyan`, `blue`, `magenta`, `white`), `#RRGGBB`, or RGBA object. When omitted, errors render red, warnings yellow, and info cyan (using pure 0/255 channels with alpha 255 for EasyEDA Pro 3.2 and 4.x compatibility).
- `lineWidth` (`number`, optional, default `3`): marker stroke width.
- `zoom` (`boolean`, optional, default `false`): pan/zoom the canvas to the markers.
- `clearExisting` (`boolean`, optional, default `true`): clears prior indicator markers first so retries are idempotent.

**Reply (`data`):** `{ "shown": <count>, "unit": "mm" }`

#### `mcp.rcp.clearMarkers`

Removes all temporary indicator markers from the focused PCB. Idempotent.

**Reply (`data`):** `{ "cleared": true, "unit": "mm" }`

#### `mcp.rcp.getConfig`

Reads the active project's stored Return Path analysis configuration as plain JSON:

- `project`: `{ id, name }` for the active EasyEDA project.
- `boardInfo`: `{ nets, loads, layers }` — the exact per-project board info shared with the UI's HF and DC wizards (net kinds, protocols, speeds, drivers, edge/drive classes, rail voltages, sources, load currents, layer pours/splits).
- `rules`: effective `CheckRules` used by `mcp.rcp.checkNet` (stored overrides merged onto `DEFAULT_CHECK_RULES`).
- `hf`: `{ nets, speedHz?, drivers?, draw, timeoutMs }` — default target signal nets and HF options used when `startAnalysis({ kind: "hf" })` omits them.
- `dc`: `{ rail?, railNets?, ground?, source?, loads?, currents?, focus?, draw, timeoutMs }` — default DC options used when `startAnalysis({ kind: "dc" })` omits them.
- `overlayStyle`: current role colours, widths, and visibility (`forwardTop`, `returnTop`, `hop`, `gap`, …).
- `lastRun`: the last HF or DC run recorded by the extension (or `null`).
- `activeJob`: currently running MCP analysis job summary (or `null`).

#### `mcp.rcp.setConfig`

Updates the active project's analysis configuration in extension storage (`sys_Storage`) without modifying the PCB design. Idempotent.

**Request:**

- `mode` (`"merge" | "replace"`, default `"merge"`): `"merge"` merges provided fields into existing config (`mergeBoardInfo` for `boardInfo`); `"replace"` replaces each provided section wholesale.
- `reset` (`boolean`, optional): when `true`, resets `rules`, `hf`, and `dc` to defaults before applying any fields in the same request.
- `boardInfo` (`{ nets?, loads?, layers? } | null`, optional): updates per-project `BoardInfo` (shared with the UI). Accepts human-friendly shorthands (`speed: "16 MHz"`, `driver: "U1"` or `["U1", "U2"]` or `"none"`, `voltage: "3V3"`, `source: "U1"`, `load: "U2"`, `typicalCurrent: "150mA"`). Changing `edge` (`"fast" | "normal" | "slow"`) or `drive` (`"push-pull" | "open-drain"`) on an already-checked net immediately rescores its stored HF check without re-solving. Pass `null` to clear `boardInfo`.
- `rules` (`Partial<CheckRules> | null`, optional): sets persistent default rules for `mcp.rcp.checkNet`. Pass `null` to reset to `DEFAULT_CHECK_RULES`.
- `hf` (`{ nets?, speed?, speedHz?, drivers?, draw?, timeoutMs? } | null`, optional): sets default target signal nets and HF options (`draw` defaults to `true`, `timeoutMs` clamped to `1000..300000`). Pass `null` to reset.
- `dc` (`{ rail?, railNets?, ground?, source?, loads?, currents?, focus?, draw?, timeoutMs? } | null`, optional): sets default DC options (`currents` accepts amp numbers or strings like `"150mA"`, e.g. `{ "U2": "150mA" }` or `"U2=150mA"`). Pass `null` to reset.
- `overlayStyle` (`Partial<Record<Role, { colour?, width?, visible? }>> | "reset"`, optional): updates overlay role styling (valid colours: `red`, `yellow`, `green`, `cyan`, `blue`, `magenta`, `white`; widths `1..10`).

**Reply (`data`):** `{ "unit": "mm", "updated": [...], "config": <same shape as getConfig> }`

#### `mcp.rcp.startAnalysis`

Starts a full HF or DC return-path analysis through the extension's existing solver and `returnpath.run` pipeline (same scoring, overlay drawing, `lastRun`, and panel reporting as the UI, with zero blocking dialogs).

**Request:**

- `kind` (`"hf" | "dc"`, required): which analysis to run.
- `requestId` (`string`, optional): idempotency key. Retrying with the same `requestId` (while running or after completion) returns the existing job handle/result instead of starting a second analysis.
- `waitMs` (`number`, default `5000`, range `0..55000`): how long to wait for completion before returning a pollable `"running"` handle. Fast single-net HF runs usually finish within `waitMs` and return `status: "completed"` in one call; slower DC solves or multi-net batches return `status: "running"` with `jobId` and `pollTopic: "mcp.rcp.getAnalysis"`. Pass `0` for immediate fire-and-poll.
- `includeLines` (`boolean`, default `true`): include human-readable report `lines` in the reply (set `false` for smaller replies).
- **HF fields** (`kind: "hf"`):
  - `net` (`string`) OR `nets` (`string[]`, max **10** nets per batch): which signal net(s) to analyse. When both are omitted, uses `config.hf.nets`. Split larger net sets into batches of up to 10.
  - `speed` (`string | number`) / `speedHz` (`number`), `drivers` (`string | string[]`) / `source` (`string`): optional overrides (otherwise uses `boardInfo` and automatic signal/driver recognition).
- **DC fields** (`kind: "dc"`):
  - `rail` (`string`, falls back to `config.dc.rail`), `railNets` (`string[]`), `ground` (`string`), `source` (`string`), `loads` (`string[]`), `currents` (`Record<string, number | string> | string`), `focus` (`string`). Omitted fields fall back to `config.dc`, `boardInfo`, and board inference.
- `draw` (`boolean`, optional): whether to draw the temporary overlay on the PCB canvas (defaults to `config.hf.draw` / `config.dc.draw`, which default to `true`).
- `timeoutMs` (`number`, optional, `1000..300000`): per-net HF or DC solver time budget.

**Reply (`data`):** `{ jobId, requestId?, kind, status: "running" | "completed" | "failed" | "cancelled", unit: "mm", startedAt, finishedAt?, durationMs, progress: { completed, total, currentNet? }, pollTopic?, result?, error?, truncated? }`

#### `mcp.rcp.getAnalysis`

Polls an analysis job started by `mcp.rcp.startAnalysis`, or lists recent jobs. Read-only and idempotent.

**Request:**

- `jobId` (`string`, optional) or `requestId` (`string`, optional): which job to fetch. When both are omitted, returns the currently running job or the most recent job.
- `waitMs` (`number`, default `0`, range `0..55000`): optional long-poll duration when the job is still `"running"`.
- `includeLines` (`boolean`, default `true`): whether to include report `lines`.
- `list` (`boolean`, optional): when `true`, returns `{ unit: "mm", activeJobId, jobs }` with compact summaries of up to 20 recent jobs.

#### `mcp.rcp.cancelAnalysis`

Cancels a running analysis job (or the currently active analysis). Idempotent: calling on an idle or already-finished job returns `{ ok: true, data: { cancelled: false, ... } }`.

**Request:** `null` or `{ jobId?, requestId? }`

**Reply (`data`):** `{ "unit": "mm", "cancelled": true | false, "jobId": "..." | null, "status": "cancelling" | "completed" | "failed" | "cancelled" | "idle" | "not_found" }`

## Testing in EasyEDA Pro and reading the logs

Every run writes its phases to the EasyEDA log panel, prefixed `[ReturnPath]`: board size after reading it (copper layers, nets, track segments, vias, pads, pours/fills and their vertex count), the start time of each analysis phase, the time spent per phase when it ends, the work sizes (segments, chains, reference-copper vertices, centreline samples, detours and the largest detour graph, DC grid, nodes, CG iterations), and the marker count. Errors go to the log with their stack and end in a dialog; a run stopped by the time budget or a complexity limit says which phase it was in.

- **Log panel:** open the bottom panel (shortcut **S**, or **View** in the top menu) and pick the **Log** tab.
- **Saved log, after a freeze or crash:** the panel is lost with the window, so every line is also stored with the extension's settings (last 1000 lines, timestamped) and saved before each step that could block. Reopen EasyEDA Pro and use **Return Path → Show Saved Log...**; it shows the last lines and can save the whole log as a file. The last line names the step that hung.
- **Log file:** enable **Allow External Interaction** for the extension (**Advanced → Extension Manager → Installed → Return Path Visualizer**, desktop client only) and the log is also written to `ReturnPath/returnpath-log.txt` in the EasyEDA documents folder (`sys_FileSystem.getEdaPath()`); **Show Saved Log...** prints the full path. Without that permission the file API throws, and the extension then keeps the log in its settings only.
- **Run files, for an agent to read:** with the same permission, each analysis also writes `return-path_<YYYYMMDD-HHMMSS>_<id>.log` and `.results.json` to the run folder. The `.log` holds that run's lines. The `.results.json` (`returnpath-run/v1`, written in `src/runner.ts` and `src/index.ts`) holds the status, net, findings, stats, DC figures and report. The default folder is `ReturnPath/runs` in the EasyEDA documents folder. **Return Path → Run Folder...** changes it; point it at `agent-runs/` in your clone and run `npm run sync` (see the root README).
- **Developer tools in the desktop client:** press **F12 three times** in quick succession, or right-click the top menu text and choose **Developer tools**; press F12 again to close them. In the browser one F12 is enough. Console errors (red) are what EasyEDA support asks for.
- **Debug mode:** in that console, run `window.location.href = 'https://client/editor?cll=debug'` (desktop) or open `https://pro.easyeda.com/editor?cll=debug` (browser). Extensions can then print to the console.
- If an extension breaks the editor, `?safetyMode=true` in the editor URL starts it with extensions disabled.

Sources: [Invoking the Extension API](https://prodocs.easyeda.com/en/api/guide/invoke-apis.html) (debug mode, F12 ×3 on the client), [Desktop Client FAQ](https://prodocs.easyeda.com/en/faq/client/) (right-click menu → Developer tools), [Other FAQs](https://prodocs.easyeda.com/en/faq/others/), [Error Handling](https://prodocs.easyeda.com/en/api/guide/error-handling.html) (safety mode), and the `SYS_Log.add` docs in `@jlceda/pro-api-types`.

## Limits of this first version

- First tried in EasyEDA Pro on a power net, which froze the UI: the detour search ran synchronously over a large plane. Fixed by the time slicing, limits and power-net check above. A second test still froze, with no readable log; 0.1.1 adds the saved log, turns power nets away before the board read, and makes the board read yield and avoid quadratic polygon merges. Not yet re-tested in the app. `test/extension.test.ts` runs the menu action against an in-memory mock of the API (`test/mock-eda.ts`), fed from the CLI's synthetic demo board, and checks that it gets the same findings as the file pipeline. `test/diagnostics.test.ts` checks the log lines, the progress bar, the power-net hand-off, error dialogs and cancelling a 600-segment net. `test/saved-log.test.ts` checks the stored log and log file, that the log is on disk before the board read starts, and the permission-denied case.
- Markers have no fill, so regions are drawn as outlines. Marker coordinates are assumed to be canvas coordinates, offset from data coordinates by a translation, and the marker line width is passed as 2 (mil or pixels is not documented).
- It needs current pour fills. Pours without a computed fill fall back to their outline, and keepout regions are not read. Plane copper that overlaps no mode-2 fill is skipped with a warning.
- Every via is treated as through-hole. Without `getStackup()`, dielectrics default to 0.2 mm.
- Pin names are schematic-only. They are read from the board's netlist, or, when that gives none (it fails on some boards with "Export failed"), from the project file (`.epro2`: each part's device, its symbol, the symbol's pin names). The project file needs the "Download project" permission; without it, or without pin names, the driver question lists bare pad numbers and the DC source guess relies on part names (`getState_Name()`), designators and rail voltages from net names. Copper thickness is taken from `getStackup()` in its unit, and values outside 5–210 µm are dropped. Rail–ground pairings are not saved between runs yet. Markers cannot show which layer a contour belongs to, so only each net's dominant layer is drawn. Each marker call is capped at 4000 shapes. The dialogs report a choice only through a callback, and closing one without choosing ends the wizard silently. The solve runs on the main thread in slices (no worker: the sandbox's support for them is unknown), about 1.5 s per rail for the 50 × 34 mm test board under Node; untested in the EasyEDA sandbox.
- API Y orientation and units are assumed to match the file format (mil, Y up).

## Template differences

`build/` and `config/` are the SDK's files unchanged, apart from running under `tsx` instead of `ts-node` (the repository uses TypeScript 7, which has no JS API for ts-node). The SDK's ESLint setup and git hooks are not included. `npm run update:check` compares the framework files against the upstream SDK. The SDK is Apache-2.0; its license is in `build/LICENSE-pro-api-sdk.txt`, and bundled third-party licenses are in `THIRD_PARTY_NOTICES.txt`.
