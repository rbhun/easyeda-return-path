# @returnpath/mcp-rcp (`easyeda-mcp-rcp`)

Read-only EasyEDA Pro extension that checks the return-current path of PCB signal traces one net at a time and exposes those checks to AI agents over EasyEDA's public message bus (`mcp.rcp.*`), reached via the [`easyeda-mcp-pro`](https://github.com/oaslananka/easyeda-mcp-pro) bridge (`easyeda_extension_call`).

```text
agent ──easyeda_extension_call──▶ easyeda-mcp-pro ──bridge──▶ MCP Pro Bridge extension
      ──eda.sys_MessageBus.rpcCallPublic(topic, msg)──▶ easyeda-mcp-rcp ──▶ JSON reply
```

The extension performs the geometry analysis and returns compact, plain JSON findings in **millimetres (`mm`)**. The agent decides which nets to check, aggregates/ranks violations, and optionally highlights selected findings on the PCB canvas using temporary indicator markers that never modify the design.

## Hard guarantees

- **Public bus namespace:** all services register under `mcp.rcp.*` via `eda.sys_MessageBus.rpcServicePublic` in `activate()` (`activationEvents: { "onStartupFinished": true }`).
- **Envelope:** every topic returns `{ "ok": true, "data": ... }` on success or `{ "ok": false, "error": "..." }` on failure (errors are returned as data, never thrown across the bus).
- **Plain JSON & ≤ 256 KiB:** replies are strictly plain JSON (no functions, class instances, or non-finite numbers) and are bounded below 240 KiB (safely under the bridge's 256 KiB transport limit).
- **Read-only & idempotent:** analysis calls never mutate the PCB. `showFindings` and `clearMarkers` only manage temporary indicator markers (`dmt_EditorControl.generateIndicatorMarkers` / `removeIndicatorMarkers`), which are never saved into the document or undo history. Retrying any call after a timeout is safe.
- **Units:** EasyEDA stores PCB coordinates in `mil`. All coordinates, lengths, thicknesses, and radii in requests and replies are in **`mm`**, and every reply states `"unit": "mm"`.

## Topics

| Topic | Request (`message`) | Reply (`data`) |
| --- | --- | --- |
| `mcp.rcp.info` | `null` or `{}` | `{ service, version, pcbUuid, copperLayers, stackup, unit, defaultRules, topics }` |
| `mcp.rcp.listNets` | `{ offset?, limit?, includePower? }` | `{ unit, total, totalAll, offset, limit, includePower, hasMore, nets, truncated? }` |
| `mcp.rcp.checkNet` | `{ net, rules?, refresh? }` | `{ net, unit, skipped?, reason?, segmentsChecked, viasChecked, referenceNetsUsed, rulesApplied, summary, findings, truncated?, warnings? }` |
| `mcp.rcp.showFindings` | `{ findings, color?, lineWidth?, zoom?, clearExisting? }` | `{ shown, unit }` |
| `mcp.rcp.clearMarkers` | `null` or `{}` | `{ cleared, unit }` |

---

### `mcp.rcp.info`

Returns extension metadata, active PCB UUID, copper layer count, physical stackup, unit (`"mm"`), default check rules, and registered topic names. Requires a focused PCB document (`documentType === 3`).

```json
{
  "ok": true,
  "data": {
    "service": "easyeda-mcp-rcp",
    "version": "0.1.81",
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
      "mcp.rcp.clearMarkers"
    ]
  }
}
```

When EasyEDA does not expose the physical stackup, standard 1.6 mm dielectrics are assumed (`1.5 mm` for 2-layer; `0.21 / 1.065 / 0.21 mm` for 4-layer) and entries include `"assumed": true`.

---

### `mcp.rcp.listNets`

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

---

### `mcp.rcp.checkNet`

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

---

### `mcp.rcp.showFindings`

Draws temporary indicator markers on the focused PCB canvas for human review. Does not modify the design or undo stack.

**Request:**

- `findings` (`array`, required, max 2000 items): each item accepts either `{ x, y, w?, h?, r?, severity? }` or a `Finding` object from `checkNet` (`{ at: { x, y }, severity? }`), all coordinates and sizes in **mm**. When `w`/`h` are provided, a rectangle is drawn; otherwise a circle (default radius `0.8 mm`).
- `color` (`string | { r, g, b, alpha? }`, optional): named color (`red`, `yellow`, `green`, `cyan`, `blue`, `magenta`, `white`), `#RRGGBB`, or RGBA object. When omitted, errors render red, warnings yellow, and info cyan (using pure 0/255 channels with alpha 255 for EasyEDA Pro 3.2 and 4.x compatibility).
- `lineWidth` (`number`, optional, default `3`): marker stroke width.
- `zoom` (`boolean`, optional, default `false`): pan/zoom the canvas to the markers.
- `clearExisting` (`boolean`, optional, default `true`): clears prior indicator markers first so retries are idempotent.

**Reply (`data`):** `{ "shown": <count>, "unit": "mm" }`

---

### `mcp.rcp.clearMarkers`

Removes all temporary indicator markers from the focused PCB. Idempotent.

**Reply (`data`):** `{ "cleared": true, "unit": "mm" }`

---

## Building the `.eext` package

From the repository root:

```bash
npm ci
npm run build:mcp-rcp
```

This bundles `packages/mcp-rcp/src/index.ts` into `packages/mcp-rcp/dist/index.js` (IIFE assigned to `edaEsbuildExportName`) and packages:

```text
packages/mcp-rcp/build/dist/easyeda-mcp-rcp_v<version>.eext
```

You can also run `python3 packages/mcp-rcp/package.py` after `npm run compile -w @returnpath/mcp-rcp`.

## Installing and testing in desktop EasyEDA Pro (macOS)

EasyEDA Pro caches extension code aggressively — re-importing an unchanged version does not replace the running code. Follow these steps on every update:

1. **Confirm the version bumped** in `packages/mcp-rcp/extension.json` (and build a fresh `.eext` with `npm run build:mcp-rcp`).
2. **Remove the old copy:** in EasyEDA Pro open **Advanced → Extensions Manager → Installed**, remove any older `Return-Current-Path Checker (MCP)` entry.
3. **Full quit EasyEDA Pro:** press **⌘Q** and verify the dock dot under EasyEDA Pro is gone.
4. **Reopen EasyEDA Pro and import:** open **Advanced → Extensions Manager → Import**, and select `packages/mcp-rcp/build/dist/easyeda-mcp-rcp_v<version>.eext`.
5. **Full quit and reopen EasyEDA Pro again (⌘Q)** so `activationEvents.onStartupFinished` runs cleanly on the newly imported bundle.
6. **Verify live registration:** open **MCP Return Path → Status...** from either the Home or PCB top menu. Confirm the dialog shows the expected version and all 5 topics (`mcp.rcp.info`, `mcp.rcp.listNets`, `mcp.rcp.checkNet`, `mcp.rcp.showFindings`, `mcp.rcp.clearMarkers`).

## Calling from Claude Desktop via `easyeda-mcp-pro`

1. In `~/Library/Application Support/Claude/claude_desktop_config.json`, add `mcp.rcp.*` to the `easyeda-mcp-pro` server's `env`:

```json
{
  "TOOL_PROFILE": "experimental",
  "BRIDGE_EXTENSION_RPC_TOPICS": "mcp.demo.*,mcp.rcp.*"
}
```

2. Fully quit (**⌘Q**) and reopen Claude Desktop.
3. Focus a PCB document in EasyEDA Pro (e.g., the R-Com dongle board) and call through `easyeda_extension_call`:

```json
{ "topic": "mcp.rcp.info", "message": {}, "timeoutMs": 10000, "confirmWrite": true }
```

```json
{ "topic": "mcp.rcp.listNets", "message": { "offset": 0, "limit": 50, "includePower": false }, "timeoutMs": 10000, "confirmWrite": true }
```

```json
{ "topic": "mcp.rcp.checkNet", "message": { "net": "USB_DP" }, "timeoutMs": 20000, "confirmWrite": true }
```

```json
{ "topic": "mcp.rcp.showFindings", "message": { "findings": [{ "x": 12.5, "y": 8.2 }], "color": "red" }, "timeoutMs": 10000, "confirmWrite": true }
```

```json
{ "topic": "mcp.rcp.clearMarkers", "message": {}, "timeoutMs": 10000, "confirmWrite": true }
```

## License

Apache-2.0. See the repository `LICENSE` and `NOTICE` files.
