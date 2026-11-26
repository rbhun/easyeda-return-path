# @returnpath/extension

EasyEDA Pro extension built on the official [pro-api-sdk](https://github.com/easyeda/pro-api-sdk) template (1.6.31). It runs the shared geometry core (`@returnpath/core`) on the open PCB and draws the result as a temporary overlay.

## Use

1. From the repository root: `npm ci && npm run build:extension`.
2. In EasyEDA Pro (≥ 4.1.93 for the stackup and undo-group APIs), import `packages/extension/build/dist/easyeda-return-path_v0.1.0.eext` as a local extension in the Extension Manager. CI also uploads it as the `extension-eext` artifact.
3. In a PCB, select a track, via or pad of the net, then choose **Return Path → Show for Selected Net**. **Clear Overlay** removes the drawing.

It reads tracks, arcs, vias, free and component pads, pours, computed pour fills, copper fills and the stackup through the API (`src/eda-board.ts`). Plane-layer copper has no pour, so it takes its net from the fill-mode-2 (`INNER_ELECTRICAL_LAYER`) `Fill` it overlaps most. The overlay is temporary: it is drawn with `dmt_EditorControl.generateIndicatorMarkers` and removed with `removeIndicatorMarkers`, so nothing is saved in the document or the undo history (`src/overlay.ts`). Green outlines show the ±3h band, red the band without copper and centreline gaps, orange the detour path, and blue the links from vias to return vias or decaps and from splits to bridging caps. The findings are listed in a dialog.

## Limits of this first version

- Untested in a real EasyEDA Pro session so far. `test/extension.test.ts` runs the menu action against an in-memory mock of the API (`test/mock-eda.ts`), fed from the CLI's synthetic demo board, and checks that it gets the same findings as the file pipeline.
- Markers have no fill, so regions are drawn as outlines. Marker coordinates are assumed to be canvas coordinates, offset from data coordinates by a translation, and the marker line width is passed as 2 (mil or pixels is not documented).
- It needs current pour fills. Pours without a computed fill fall back to their outline, and keepout regions are not read. Plane copper that overlaps no mode-2 fill is skipped with a warning.
- Every via is treated as through-hole. Without `getStackup()`, dielectrics default to 0.2 mm.
- API Y orientation and units are assumed to match the file format (mil, Y up).

## Template differences

`build/` and `config/` are the SDK's files unchanged, apart from running under `tsx` instead of `ts-node` (the repository uses TypeScript 7, which has no JS API for ts-node). The SDK's ESLint setup and git hooks are not included. `npm run update:check` compares the framework files against the upstream SDK. The SDK is Apache-2.0; its license is in `build/LICENSE-pro-api-sdk.txt`, and bundled third-party licenses are in `THIRD_PARTY_NOTICES.txt`.
