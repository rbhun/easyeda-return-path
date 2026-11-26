# easyeda-return-path

An EasyEDA Pro extension that visualizes high-frequency return current paths for
selected nets and flags return-path problems. EasyEDA has no built-in equivalent.

## Planned model (v1)

- HF return current flows on the nearest reference plane under the trace, with lateral
  density ∝ 1/(1+(x/h)²), where h is the trace-to-plane dielectric height. About 80 % of
  the current lies within ±3h.
- At a split or slot, the return detours around the gap. This is approximated by the
  shortest path inside the reference copper.
- At a layer change, the return goes through the nearest stitching via if both reference
  planes are the same net. If they are different nets, it goes through the nearest
  decoupling cap that bridges them.
- Loop closure goes through the driver's local supply pair and decap.

## Pipeline

1. Build the reference copper per layer: pour fills, with antipads already cut (Clipper2).
2. Check ±3h coverage for each fast-net segment, and flag a missing reference or a split crossing.
3. For each split crossing, compute the geodesic detour and the added loop area.
4. For each signal via, find the nearest return via or bridging decap.
5. Draw a temporary overlay (indicator markers, not saved in the document): the ±3h band, gaps, detours, via links and loop areas.

Analyses run as time-sliced steps with a time budget, progress, cancel and complexity limits, so the editor never blocks; power, ground and plane nets go to the DC view instead. 2-layer boards are handled: the reference is the opposite outer layer's pour or a coplanar pour on the trace's own layer.

DC mode (first milestone, design decision D7): a wizard guesses the power rails, their grounds, the source (a regulator output, or else a connector or battery on VIN/VBUS/VBAT) and the loads. It then solves the rail and its ground as a resistor network on the rasterised copper of each layer, with vias joining the layers, and draws streamlines and colour-binned current-density contours.

## Repository layout

npm workspaces, TypeScript, Node ≥ 20.17.

| Package | What it is |
|---|---|
| [`packages/core`](packages/core) | Pure geometry core: board model, reference copper, coverage, detours, via returns (pipeline steps 1–4), and the DC rail guess and resistive solve. No I/O, no Node or DOM APIs. |
| [`packages/cli`](packages/cli) | Offline tool: EasyEDA Pro file parser, SVG/PNG overlay renderer, JSON report, synthetic test boards. See its [README](packages/cli/README.md). |
| [`packages/extension`](packages/extension) | EasyEDA Pro extension (official pro-api-sdk template): reads the board through the API, runs the core and draws a temporary overlay. See its [README](packages/extension/README.md). |

```bash
npm ci
npm run typecheck
npm test
npm run build:extension   # → packages/extension/build/dist/*.eext
npm run demo              # CLI demo boards → packages/cli/out/
```

Versioning: every change raises the minor version and adds an entry to [CHANGELOG.md](CHANGELOG.md); `npm run check:version` (also run in CI) checks it.

## Run files and the sync worker

The extension can write a `.log` and a `.results.json` for every analysis (see the extension README). `npm run sync` (`scripts/agent-sync.mjs`) runs on the machine with EasyEDA and connects these files to a cloud agent. It needs Node ≥ 20 and push access to `origin`.

1. In EasyEDA Pro (desktop), allow **External Interaction** for the extension. Then use **Return Path → Set Run Folder...** and pick `agent-runs/` in this clone. Git ignores that folder.
2. Run `npm run sync` in this clone, or `npm run sync -- --branch <pull request branch>` to test an agent's change.

Every 30 s (`--interval`), the worker does three things:

- **Pull:** it fast-forwards the branch. It never pulls over local changes in tracked files. When code arrived, it rebuilds (`npm ci` when a `package.json` changed) and prints the `.eext` to import.
- **Collect:** it copies new run files from `agent-runs/` (or `--inbox <dir>`, repeatable).
- **Push:** it pushes them to the orphan branch `agent-runs`.

`--once`, `--no-pull`, `--no-build` and `--no-push` limit a cycle. Agents read the runs with:

```bash
git fetch origin agent-runs
git show origin/agent-runs:LATEST                       # newest run, e.g. return-path_20261126-101500_ab12cd34
git show "origin/agent-runs:runs/$(git show origin/agent-runs:LATEST).results.json"
git show "origin/agent-runs:runs/$(git show origin/agent-runs:LATEST).log"
```

## Status

Early development. The geometry is validated on synthetic boards only. The first run inside
EasyEDA Pro froze on a power net; that is fixed (time slicing, limits, power-net check) but not yet
re-tested in the app. See the extension README for reading its logs in the desktop client.

Prior art: [kistitch](https://github.com/hatlabs/kistitch) (MIT, © 2025 Hat Labs Oy) informed the
via-return thresholds; no code is copied.

## License

[Apache License 2.0](LICENSE), © 2026 Balazs Rozgonyi; see also [NOTICE](NOTICE).

Third-party code keeps its own license. If code from kistitch (MIT, © 2025 Hat Labs Oy) is
ever ported, include its copyright and permission notice: add the full MIT text to
`packages/extension/THIRD_PARTY_NOTICES.txt` (it ships in the `.eext`) and credit it in
`NOTICE`. The same applies to any other MIT, BSD or BSL code that gets bundled.
