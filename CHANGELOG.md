# Changelog

Every change raises the patch number (`0.1.x`) and adds an entry here, newest first. The major and minor numbers change only when the owner declares a milestone; that entry's heading then ends with `- Milestone: <name>`. One version covers the whole repository: `packages/extension/extension.json` and every workspace `package.json` carry it, and the `.eext` file name includes it. `npm run check:version` checks this, and CI checks on pull requests that only the patch number went up (unless a milestone is declared).

## [0.1.35] - 2026-11-26

Numbered above 0.1.34, main's version.

From Balazs, after an HF check of SC0 on a real board: he wanted to pick the net from a list with data lines first and set their speed; the red gap lines looked broken, the white band edges just traced the tracks, and the DC supply role was listed after an HF run.

- **Net picker with data types and speed.** HF check now lists the routed signal nets in the wizard window: recognised data lines first (I²C, SPI, UART, USB, I²S, SWD, SDIO, CAN, Ethernet, clocks, PWM, from the net name and the pin names), each with its kind and length, then the other signal nets. A selected track, via or pad preselects its net. The next page asks for the speed (for I²C: 100 kHz, 400 kHz, 1 MHz, 3.4 MHz, or another value), with the usual one preselected.
- **Signal line in the result.** The result names the kind and speed, the edge time, the knee frequency and the critical length, and says whether the trace is long enough to act as a transmission line. **Selected trace** asks no net or speed question and uses the usual speed of that kind of line, and says so.
- **Red only where the return is in trouble.** The red gap role used to outline every piece of uncovered band, so it wrapped the tracks in broken red lines. It now draws only along the stretches of trace whose band has too little reference copper, and the gap lines themselves. The band is also clipped to the board outline, so the edge of the board no longer counts as missing copper.
- **Band edges start hidden**, and the panel lists only the roles the last check draws (no DC supply after an HF check).
- **The legend** says that the return is drawn on the reference copper right under the trace, so it follows the trace, and that dashed hops go into vias, decaps, bridging caps and IC pins.
- **Negative rails** such as -5VF and -6V count as power nets.
- **CLI:** `--list-nets` lists the recognised data lines first with their kind and usual speed, and `--speed 400k` sets the speed for the signal line.

## [0.1.34] - 2026-11-26

Numbered above 0.1.33, main's version.

From Balazs, after 0.1.33: the HF driver question listed "OLED1 pad 10" with no pin name.

- **Pin names from the project file.** Pin names came only from the board's netlist. On boards where the netlist fails ("Export failed") or gives none, the driver question showed bare pad numbers. The extension now reads them from the project file instead (`sys_FileManager.getProjectFile`, `.epro2`): each part's device, its symbol, and the symbol's pin names. This is the same route the CLI uses. The driver question then reads "OLED1 pad 10 (SCL)", and the DC load and source checks get the names too.
  - On a real 2-layer test board, 27 parts are named this way, in about 0.1 s.
  - If the project file can't be read (EasyEDA asks for the "Download project" permission) or names no pins, later runs skip it, as they already do for the netlist.
- The CLI reads `.epro2` pin names through the same module (`@returnpath/cli/project`), so both paths share one parser.
- Tests:
  - pads named from a project file when the netlist fails;
  - no second try after the project file failed;
  - names by designator from an `.epro2`.

## [0.1.33] - 2026-11-26

Numbered above 0.1.32, main's version.

From Balazs, after 0.1.32: put a Selected trace button back where Cancel is, prefill the currents of all loads, and drop the result window now that results are in the panel.

- **Selected trace** button in the panel, where Cancel was. It runs the check that fits the selected track, via or pad: the HF check for a signal net, and for a power rail the DC check straight away (no "Open DC view?" question, rail taken from the selection). While an analysis runs, the same button reads **Cancel** and stops it.
- **Load currents, prefilled.** The currents question is now a page of its own in the wizard window, with one field per ticked load:
  - each field is prefilled with 100 mA, or with the current the last run on the same rail gave that load;
  - an **All loads** field sets every one at once;
  - a value that cannot be read is outlined in red and OK stays disabled until it is fixed;
  - clearing every field still splits 1 A equally and shows the result per amp.

  With the defaults, a DC run now reports absolute drops (mV) instead of per-amp values (mV/A). The system-dialog fallback gets the same prefilled text (`U2=100mA, U3=100mA`).
- **No result window.** A finished analysis shows its result only in the panel. The panel opens for it unless the user closed it; then a notice says the result is there.
- Tests: Selected trace on a rail and on a signal net, the prefilled currents from the last run, and clearing every field. The mock reads results from the panel instead of from the result dialog.

## [0.1.32] - 2026-11-26

Numbered above 0.1.31 on main. First opened as 0.1.29; renumbered after #12 (0.1.30) and #10 (0.1.31) merged.

From the owner, after 0.1.26: everything should work from the panel, not the menu, with an HF check button there; the wizard pages should look the same; the overlay lines should not be see-through.

- **The menu has only Open Panel..., Show Saved Log... and About....** The analyses, Rerun last, Cancel, Hide/Show, Clear and the log were already panel buttons. Set Run Folder... (0.1.27) is now the panel's **Run folder…** button. Messages that pointed at menu items now point at the panel, and About says where things are.
- **HF check button:** the panel's high-frequency button, "Selected net" until now, is labelled **HF check**, and "DC current…" became **DC check…**. HF check runs Show for Selected Net on the selected track, via or pad. When the pin names do not settle the driver, it asks for it in the wizard window. The panel's busy line and last-run label say "HF check: CLK, driver U1". The log lines and the run files keep the command name "Show for Selected Net", which the sync worker reads.
- **One wizard window for every question.** The 0.1.26 load picker became the wizard window (`iframe/wizard.html`, `src/wizard-window.ts`). It asks every question of an analysis: the DC wizard's rails, ground, source, loads and currents; Show for Selected Net's driver; and the "open the DC view instead?" question for a power net. They share one page layout: a "Step n of 5" badge, the question, then radio buttons, check boxes with select-all, a text field or nothing (a confirmation), and OK/Cancel below. The window opens with the first question, stays open between steps, and closes before the analysis runs, on Cancel or when it is closed. The system-dialog fallback (page not connected within 4 s) is unchanged, and now covers every question kind.
- **Opaque markers:** marker colours are sent with alpha 255 instead of 1. EasyEDA Pro 3.2 reads the colour channels on a 0–1 scale and clips above 1. If it reads alpha on a 0–255 scale, alpha 1 is nearly transparent. Alpha 255 is fully opaque on either scale.

## [0.1.31] - 2026-11-26

Numbered above 0.1.30, main's version.

High-frequency view, milestone 2 of `docs/hf-plan.md`: what Show for Selected Net says on two real boards, the R-Com dongle and the rack display (both 2-layer). Before this change, the non-supply nets of the two boards gave 325 slot-crossing errors, 115 isolated-copper errors and 1022 band-coverage warnings, mostly noise. Now they give 34 slot-crossing errors (35 warnings), 9 isolated-copper errors (62 warnings) and 382 band-coverage warnings, and 58 bias nets are turned away.

- **Coplanar or plane, per stretch.** A trace on a 2-layer board often runs beside its own layer's pour for part of its length and over the far-side pour for the rest. The reference is now decided every 0.25 mm along the trace: coplanar where copper of another net lies within half the core thickness beside it, plane elsewhere. A stretch changes reference only where a via of the pour's net lets the return change layers (within 2 mm, or 2× the core thickness); the drop through that via is drawn as a hop. Without such a via, the whole run keeps the reference of its longer part. This also removes the 125.62 mm "gap" on the rack display's SCL: it was a coplanar run whose bottom stretch had no pour beside it at all, and that stretch now references the pour on the other side.
- **Slot detours graded by length.** A return that detours less than 1 mm round a gap is not reported; up to 5 mm is a warning; longer stays an error. The dongle's BCLK keeps its errors (+58.0 mm and +33.9 mm, with a +3.1 mm warning). These detours are real: a bundle of bottom-layer tracks cuts the bottom GND under the top trace near U12, and there is no top pour there.
- **Band coverage weighted towards the trace.** The share of the band covered by copper is now weighted the way return current spreads (most of it within one dielectric height of the trace) instead of counting every point of ±3h the same. A coplanar trace is judged on its better side. Consecutive low segments become one finding with their extent and length, for example "Top Layer (12.3, 4.0)→(30.1, 4.0), 5 segments, 17.8 mm".
- **Islands joined to the other layer.** A break in the reference pour is a warning instead of an error when the same net's copper on the other layer bridges it: under a coplanar trace ("the return has to go down to GND on Bottom Layer through the vias that join them"), or beside the trace on its own layer for a trace over a plane.
- **Nets with no tracks** (unrouted, or joined only by pours or touching copper, such as the dongle's USB_D+) give a finding saying so instead of an uncaught "net has no tracks" error.
- **Bias nets are turned away.** A net that joins one active part only to resistors or capacitors tied to a rail (a current-reference, VCOM, reset or feedback pin) is not a signal travelling between parts. Show for Selected Net says so, as it does for supply nets ("IREF1 joins only U3 to R12, tied to GND: a bias or reference pin…").
- **Vias by position.** Via findings name the via by its position ("nearest GND via at (12.4, -3.1)") instead of its internal id. A through-hole pad is named by part and pin.
- **CLI overview of long boards.** A board much longer than it is wide (the rack display is about 350 × 12 mm) is drawn in rows stacked top to bottom, each labelled with its x range, instead of as an unreadable strip. The findings panel now sets the picture's height when it is taller than the board. The return centreline is drawn with `stroke-opacity`; with plain `opacity`, the PNG renderer crashed on copper drawn outside the picture.

## [0.1.30] - 2026-11-26

Pull request workflow: every pull request gets a numbered build, merges itself when CI passes, and main publishes a release. Numbered above 0.1.29, the highest version on the open pull requests (#10 has 0.1.28, #11 has 0.1.29).

- **Build per pull request:** the `check` job uploads the `.eext` as the artifact `easyeda-return-path_v<version><letter>`. The letter counts the builds of that version in the repository's artifacts: `a` for the first, then `b`, `c` and so on. `extension.json` keeps the plain `x.y.z` version that EasyEDA expects.
- **Merge when green:** a new `automerge` job runs after `check` passes. It calls `gh pr merge --auto --merge` with `GITHUB_TOKEN` and, where auto-merge is not available (a private repository on GitHub Free has no branch protection), merges directly with a merge commit. Drafts, pull requests from forks and pull requests that change `.github/workflows` (which `GITHUB_TOKEN` may not merge) are left for a person. A merge by `GITHUB_TOKEN` starts no push workflows, so the job then starts the Release workflow itself.
- **Release on main:** the new Release workflow (`.github/workflows/release.yml`) runs on every push to main and on request. It builds the `.eext` and publishes the GitHub Release `v<version>` with the file attached and this changelog's entry as notes. A version that already has a release is skipped.
- **Version rule:** CI now compares every pull request's version against `origin/main`, whatever branch it targets: the patch number must be above main's.
- **`npm run fetch:build -- <pr-number|main>`** (`scripts/fetch-build.mjs`): saves a pull request's newest successful CI build, or main's newest release, to `~/Downloads` under its own file name (`--out <dir>` for another folder). Builds from before this version, uploaded as `extension-eext`, are found too.

## [0.1.27] - 2026-11-26

Run files for the agent, so a cloud agent can read what a run on your machine did without screenshots or pasted logs.

- **Run files:** every Show for Selected Net, DC Return Current and Rerun Last Analysis writes two files named `return-path_<YYYYMMDD-HHMMSS>_<id>`:
  - **`.log`:** the log lines of that run alone.
  - **`.results.json`:** what the run found. It has the schema `returnpath-run/v1` and holds the version, command, status (`ok`, `cancelled`, `stopped` or `error`, with message and stack), net, board sizes, and the final report lines.
    - High-frequency runs add the driver, the analysis stats and every finding with its position, plus the marker count and the return layers.
    - DC runs add the rail, ground, source, loads, the grid, and per net the drop, bottleneck, unreached loads and solver figures.
  - A DC hand-off from Show for Selected Net stays one run.
  - Like the log file, the run files need **Allow External Interaction**. Without it, the run logs "run files not written" and nothing else changes.
- **Return Path → Set Run Folder...:** picks the folder for the run files. The default is `ReturnPath/runs` in the EasyEDA documents folder. Point it at `agent-runs/` in your clone of this repository so the sync worker picks the files up.
- **Sync worker, `npm run sync`** (`scripts/agent-sync.mjs`): runs on the machine with EasyEDA. Every 30 s it does three things:
  - **Pull:** it fast-forwards the branch it follows (`--branch <name>` to test a pull request). It skips the pull while tracked files have local changes. When code arrives, it runs `npm ci` if a `package.json` changed and `npm run build:extension`, then prints the `.eext` to import.
  - **Collect:** it copies new run files from `agent-runs/`.
  - **Push:** it pushes them to the orphan branch `agent-runs`, through a separate worktree in `.agent-runs-branch/`. `LATEST` on that branch names the newest run.

## [0.1.26] - 2026-11-26

Numbered above 0.1.25, which the HF fix takes (#8 takes 0.1.24).

From the owner's look at the DC wizard's load step: the list needs a select-all box, the parts show `={Value}` and `={Manufacturer Part}` instead of their values, and the open dropdown covers the OK button.

- **Picker window for multi-choice questions** (the loads, and the power rails when they are asked). It has a select-all box (ticked, cleared, or partly ticked to match the list) with an "n of m selected" count, a list that scrolls on its own, and OK and Cancel below it that the list cannot cover. Enter accepts and Esc cancels. Closing the window cancels the wizard, as the system dialog did. It talks to the extension over the message bus like the panel; if its page has not connected after 4 s, the question goes to the system dialog, and later questions in that editor session go there directly. The system dialog then gets a "Select all" entry at the top of its list.
- **Part names show their attribute values.** EasyEDA gives part names such as `={Value}` or `={Manufacturer Part}` that point at the part's attributes; they are now filled in from the part's attributes (and its manufacturer and supplier part numbers), so the load list reads "C1 (100nF)" and "U3 (AMS1117-3.3)". A name whose attributes are all empty is left out, so the line shows just the designator. The filled-in names also reach the rail and source guesses, which look at part names.

## [0.1.23] - 2026-11-26

High-frequency view, milestone 3 of `docs/hf-plan.md`: the loop at the driver. Until now each end of the net closed the return into the nearest pin of the same part on the reference net (usually GND). That is only half of it: when a CMOS output drives high, the current comes from its supply pin, so on a ground reference the rising edge returns through a decap into the driver's supply pin.

- **Driver question:** Show for Selected Net reads the pin names from the netlist (as DC Return Current does) and guesses the driver from them (`TX`, `MOSI`, `DOUT`, `MCO`, `OSC_OUT`… drive; `RX`, `MISO`, `DIN`… receive). When the names do not settle it, or the net is a bus driven from either end (`SDA`, `SCL`, `SWDIO`, USB data), it asks which part drives the net, with "All of them" and "None" as choices. Closing the question skips the driver loop. Rerun Last Analysis keeps the answer.
- **Driver loop:** for the driver, one finding names both edges, for example "U1 (driver): the falling edge returns into U1 pad 2 (GND); the rising edge through decap C1 into U1 pad 3 (3V3), 8.55 mm pin to cap to pin". The decap is the two-pad part between the reference net and one of the driver's supply nets that gives the shortest ground pin → cap → supply pin loop. Up to 4 mm is ok, up to 10 mm a warning, longer an error; no decap at all is an error. On a supply-net reference the roles swap. The two legs are drawn as hops, in the hop colour of the panel (yellow by default).
- **Panel:** the HF result in the Return Path panel has the driver line and the driver finding; its last-run label names the driver ("Show for Selected Net: CLK, driver U1"), and Rerun from the panel keeps it. The driver legs are hops, so the panel's hop colour and width restyle them with the others.
- **Series parts:** a net end at a resistor, ferrite or crystal with no pin on the reference net is now reported as ok ("the signal continues through R5 onto another net…") instead of a warning that the loop cannot close.
- **CLI:** `--driver U1[,U2]`. Without it the CLI prints the candidates and its guess, and uses the guess only when it is sure. `.epro2` projects now give pins their names (from the symbol of each part's device), and a project without a layer stack is read as a 1.6 mm board (1.5 mm core on two layers; 0.21 / 1.065 / 0.21 mm on four), as the extension already did, instead of 0.2 mm between all layers.
- **Fixes:** a coplanar detour no longer reports a negative extra length, and segments shorter than 0.1 mm get no band-coverage warning.

## [0.1.22] - 2026-11-26

Numbered above 0.1.21, the highest version on the open pull requests (the HF line took 0.1.19 to 0.1.21).

From the owner's run of 0.1.18: the panel opened from the menu knew nothing of the analysis just run from the menu, though analyses run from the panel worked; some lines were hard to see; lines need a show/hide control.

- **The panel shows menu runs.** EasyEDA appears to run menu actions in separate instances of the extension, which share neither memory nor a fresh view of the stored settings. The instances now keep the result, the last run, the overlay, busy state and style in step over the extension's message bus, and exactly one acts on each panel command: the panel's owner, which hands Hide/Show, Clear and redraws to the instance that drew the overlay. Each result and overlay change is also pushed to a mailbox topic, which the bus keeps until it is pulled; the panel's page pulls it and hands the newest to its owner, which takes over the result, Rerun and the drawing even when the instance that ran the analysis is gone. Hide/Show and Clear from the menu reach whichever instance holds the overlay.
- **Show/hide per line kind.** Each role in the panel (DC supply, return on top, other and inner layers, hops, gaps and bottleneck, band edges) has a checkbox; hidden roles are not drawn, and the choice is kept with the colours and widths.


## [0.1.18] - 2026-11-26

From the owner's run of 0.1.17 on the rack display: a 9V track selected, Show for Selected Net, then the DC view.

- **The selected rail is not asked for again.** With a guessed rail selected, or a rail handed over from Show for Selected Net, the wizard skips "confirm the power rails" and "rail to solve" and starts at the ground (when there is a choice) or the source.
- **"Export failed" once, not once per version.** That message most likely comes from `pcb_Net.getNetlist`. The flag that skips the netlist after it gave no pin names was tied to the extension version, so every upgrade showed the message again. It is now kept until the netlist reader itself changes.
- **Board outline.** The rack display's outline is a single rectangle polyline of type `BOARD_OUTLINE`, which the polyline API apparently does not return. The outline is now also looked for on all layers and then in the PCB's document source (`sys_FileManager.getDocumentSource`). The log says how many polylines each step found.
- **Panel.** Every analysis opens the Return Path panel unless you closed it. Results go to the panel only once its page has connected (said hello); otherwise they stay in the dialog, so a panel that cannot reach the extension never swallows a result. Open Panel reports when EasyEDA refuses to open the window, and the log records what `openIFrame` returned.


## [0.1.17] - 2026-11-26

From the first run on the rack display backup (`rack display_2026-11-23-17-52.epro2`).

- **Parts with no ground pad are no longer default loads.** On the rack display's 3V3 rail, 44 of the 55 default loads were I2C pull-ups, an LED and parts with no GND pin. With no load currents entered, the 1 A total was split equally across all of them, so the TCA9548s and OLEDs that really return current to ground got about a fifth of it. These parts are now listed under "left out: no ground pad", and the wizard still lets you tick them.
- **CLI: projects with several PCBs.** The CLI analysed the first PCB in the project; on the rack display that is an unrouted copy with 0 tracks, which gave "no copper path" for every OLED and "net has no tracks" for `$1N58`. It now picks the PCB with the most tracks and lists the others in the warning. `--pcb` still overrides. The extension is unaffected (it analyses the open PCB).


## [0.1.16] - 2026-11-26

A window that stays open, as asked: results, actions and overlay styling without going through the menu each time.

- **Return Path → Open Panel...:** a floating window (`iframe/index.html`) that does not grey out or block the editor and can be minimised. Buttons: Selected net, DC current..., Rerun last, Cancel, Hide/Show, Clear, Log.... It shows what is running, whether the overlay is shown, the last analysis, and the last result. While the panel is open, results go there instead of the modal dialog, with a short toast.
- **Colours and widths per role:** DC supply, return on the top layer, on other layers, on inner layers, hops, gaps and bottleneck, and band edges; a colour from red, yellow, green, cyan, blue, magenta and white, and a width from 1 to 10. Changes redraw the current overlay without a new analysis, are kept with the extension's settings, and the result legends name the chosen colours. Reset to defaults restores 0.1.15's scheme.
- The panel talks to the extension over its private message bus (`sys_MessageBus`); the menu items work as before.

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
