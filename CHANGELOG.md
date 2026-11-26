# Changelog

Every change raises the patch number (`0.1.x`) and adds an entry here, newest first. The major and minor numbers change only when the owner declares a milestone; that entry's heading then ends with `- Milestone: <name>`. One version covers the whole repository: `packages/extension/extension.json` and every workspace `package.json` carry it, and the `.eext` file name includes it. `npm run check:version` checks this, and CI checks on pull requests that only the patch number went up (unless a milestone is declared).

## [0.1.66] - 2026-11-26

From Balazs: U8 pin 7 is called SD. It is an enable pin tied to ground and draws almost no current. The return sink can also be named EP, −Vo or VSS, and on a header it may be only a pin number.

- **SD is not where the return starts.** Pin 7 stays tied to GND in the result, and the line leaves the pin named GND. The same goes for EN. The sink is a pin named GND, EP, −Vo or VSS. A header whose ground pins have no such name, only their numbers, still returns through each of them.

## [0.1.65] - 2026-11-26

From Balazs: U8's return on the +6V rail drew a loop that changed from run to run, and it started on pad 7.

- **An NC pin tied to ground does not start the return.** U8 pin 7 is NC, and pin 11 is GND. The return used every pad on GND whenever any one of them had no name, so the drawn line left from pad 7 and followed that pin's copper: a small loop, a hairpin, or the long way round the board, depending on the run. A named ground pin is now the only start. Pad 7 is listed as tied to GND and carrying no supply current. With no named ground pin, every pad on the ground still counts.

## [0.1.64] - 2026-11-26

From Balazs: on the R-Com dongle the forward current of 48V + VBUS + VBUS_R + VBUS_RAW, sourced at L1, drew no yellow line on the 48V traces. C6 and U1 were reported as not reached.

- **An eFuse or ideal diode joins the nets it passes the rail through.** E1 has IN on VBUS and OUT on 48V, plus its control pins. Only a part whose every pin was on the rail was taken as the short, so E1 was not, and the 48V copper carried no current. Its input and output pins are now the link. A part that only senses across the nets (VIN+ and VIN-) is still not a short. On this run the forward line reaches C6 and U1 on the 48V tracks.

## [0.1.63] - 2026-11-26

From Balazs: show the voltage drop, and check whether a trace or a choke is too narrow.

- **Voltage drop was already calculated.** The result line still gives the largest drop on the rail and on the ground. With more than one load it now also lists the drop to each load, in the same units (mV, or mV/A when no currents were given).
- **A trace, a pour neck or a via that is too narrow is named.** The current in a track is its width times the sheet density along it. A pour neck is the copper across the bottleneck. A via is the plating of its drill. Each is compared with IPC-2221 for a 10°C rise (outer copper k = 0.048, inner k = 0.024). A 0.15 mm track carrying 1 A is named; a 2 mm pour carrying 1 A is not. A via only a little over the chart is left, because the plating thickness is assumed.

## [0.1.62] - 2026-11-26

HF check: the return enters a part only through its ground pad, and stays in copper the whole way.

- **Into the pad.** Where a trace ends on a part, the return is drawn through the copper into that part's pad on the reference net. A pad on another layer is reached along that layer's own copper (its ground trace, where the layer has no pour) to the nearest ground via, and the line on the reference layer runs into that via.
- **Around, not across.** When the copper beside the trace does not reach the pad or via, the rest of the line is the path through the copper, around the trace or the gap that is in the way. Where the copper does not connect, the line stops. Nothing is drawn across the air.
- A ground pad or via the line reaches is marked with a circle. Dashed hops remain only where the current goes through a part: a bridging cap, a decap, or the driver's other edge.

## [0.1.61] - 2026-11-26

From Balazs: on the R-Com dongle the +12V ground return from U4 swept down across the board in a big arc, though the bottom layer is one solid pour and the current should go straight back to the source.

- **Each line is that part's own current.** The line used to follow the sum of every ticked load at once. On a solid pour that sum bends: current spreading from the other parts (the 12V capacitors, each given a current when ticked) pulls the line off the straight path and it only meets the source after a loop down the pour. Nothing is in the way. The drop and the bottleneck are still for every ticked part together; only the lines changed. A part with no other loads draws the same line as before.
- Core test: two loads on one solid rectangle, the far load's line stays within 3 mm of the straight line to the source.
- A load's own line is solved far enough to go round a slot. Stopping that solve early left the line short of the source.

## [0.1.60] - 2026-11-26

Overlay: colour shows where the current flows, as in the DC view.

- **By copper layer**: an HF return is coloured by the copper layer it flows in (magenta in Top copper, cyan in Bottom, blue in inner layers), not by the layer of its signal trace. A Bottom trace's return in the Top plane is now magenta.
- **Forward current by layer too**: the signal trace (HF) and the supply streamlines (DC) are yellow on the top layer and green on the others. The panel's "DC supply" and "Signal trace" roles become "Forward current, top layer" and "Forward current, other layers", used by both checks. Colours saved for the old roles are not carried over.
- Inner-layer returns are all blue (no longer green and blue in turn), as green now marks forward current on the other layers.
- Tests: the saved-log tests give storage writes 1 s (50 ms only where storage never answers), so a busy CI runner no longer drops a write and fails them.
## [0.1.59] - 2026-11-26

From Balazs: make DC wizard step 2 a tick list, so several parts of the same rail can be picked.

- **Step 2 ("rail to solve") is a tick list.** Tick several nets of one rail, for example both sides of a fuse, shunt or jumper, to solve them as one rail. The parts between them are taken as shorts, as on the neighbours page. One net is ticked to start with: the selected rail, else the last run's rail together with the nets it was solved with. Nets already ticked here are not offered again on the neighbours page. Step 2 is still skipped when only one rail is confirmed or a rail is selected on the canvas.

## [0.1.58] - 2026-11-26

From Balazs (0.1.54, EasyEDA Pro 2.2.32.4 on a Mac): the panel's check buttons stayed greyed out. His log showed `log file disabled: writing <Run folder>/returnpath-log.txt failed: sys_FileSystem.saveFileToFileSystem did not answer within 2 s`.

The panel greys its buttons while an analysis runs and enables them when the run ends. Three things could keep a run from ending, or keep its busy state after it ended:

- **File writes that never answer.** On his Mac the file-system calls into the chosen Run folder do not return; macOS folder access for EasyEDA is the likely cause. Each one was given up after 2 s, but every log checkpoint and every run's files called the API again. **Now the first call that times out stops file writes for the session**: the log stays in the extension's settings (Show Saved Log), the run files are not written, and the analyses do not call the file system again. Choosing **Return Path → Run Folder...** again tries the files again. The log says once: `file writes stopped: … The analyses are not affected.`
- **A wizard question whose window went away** without EasyEDA telling the extension. The run waited for the answer forever, and **Cancel** in the panel only stopped an analysis that was already computing. **Now Cancel also ends a question waiting in the wizard window**, so the run ends and the buttons come back.
- **A busy state left by an instance that is gone.** Cancel was handed to that instance, which never answered. **Now, if the busy state is still there 5 s after Cancel, the panel clears it** and logs an error naming the run.

Panel failures are no longer silent:

- A panel command that fails outside an analysis is logged as an error and shown in a toast.
- If the panel fails to start, it logs `panel: init failed`.
- If the state cannot be sent, the page shows `Panel error: …` with its buttons enabled.
- If the page cannot show a state, it says so instead of leaving the last one up.

## [0.1.57] - 2026-11-26

From Balazs: a DC check stopped with "Cannot read properties of null (reading 'x')" thrown inside `convertDataOriginToCanvasOrigin` (pro-api 0.3.59). The solve had finished; only the drawing failed.

- **The overlay no longer depends on the editor converting the canvas origin at drawing time.** The conversion throws inside EasyEDA when it has no PCB canvas to work on, for example when another tab or window has the focus after the solve. The origin is now also read while the board is read, when the PCB is surely open. If the conversion fails later, the overlay tries the inverse conversion, then that earlier origin, and as a last resort no offset. It no longer stops the run. The log records which conversion failed and which document was active (one warning line), and the same applies to the HF overlay.

## [0.1.56] - 2026-11-26

From Balazs: on the R-Com dongle, the +12V return looped through the ground vias of U19 and C115 instead of going straight back from U5 and C23.

- **The rail is followed back to the converter that makes it.** The +12V rail starts at J3, a jumper with no ground pin. In front of J3 are the shunt R7 and U1's +Vo pin. The DC wizard now lists the nets along that chain ($1N260 and $1N261), even though they have no names. This happens when the chain ends at a converter output (pins named +Vo, VOUT, VO and the like) or at a power-like net. The nets are ticked by default, and U1 is offered as the source, so the return closes at U1's −Vo. The chain stops at a switching node (SW or LX), so a buck's output inductor never joins its input to its output.
- **A sense chip across a shunt is neither a load nor a short.** U19 has pins on both sides of R7, but it also has pins elsewhere. It is left out of the loads with the reason "sits across", and R7 alone is taken as the 1 mΩ link.
- **A source with no ground pin borrows the supply behind it.** If you keep J3 alone as the source, the return ends at U1's ground, reached through the series parts, and no longer at the nearest part, which was U19. A warning suggests ticking the chain and picking U1, so the copper in between is solved too.

## [0.1.55] - 2026-11-26

HF check: return lines run into the GND pins and vias the current leaves through, instead of hopping to them through the air.

- **Into the ground pin**: where a trace ends on (or passes through) a part's pad, its return is drawn through the copper into that part's GND pin, which is marked with a circle only. A pin on the other layer is reached through the nearest GND via and that layer's copper (on SD0: OLED1 pin 7 and U7 pin 11).
- **Into the GND via**: where the return changes layer at a GND via (stitching, or between a pour beside the trace and the plane below), the lines on both sides run into the via. The dashed line from the forward trace to the via is gone. A trace that ends on another trace of the net next to a signal via (a T) takes that via's GND via too.
- **Under the whole trace**: a return that starts and ends at a via beside the trace still runs under the trace from one end to the other (the meander case).
- A hop stays dashed only where a return line cannot reach its pin or via through the copper near the trace.
- Every-net run time in Node: rack display 72 → 96 s, dongle 85 → 99 s. The strict audit on both test boards is still clean: no return outside its reference copper, on another net's copper or crossing it.

## [0.1.54] - 2026-11-26

From Balazs: check several DC nets together. On the R-Com dongle, VBUS_R and VBUS_RAW are the same power rail, on either side of the fuse F1.

- **A rail can span several nets.** When the rail you check continues through a two-pad series part (fuse, ferrite bead, inductor, diode or resistor) to another power-like net, the DC wizard lists those nets. Nets further along are listed too, for example VBUS_R → F1 → VBUS_RAW → D1 → VBUS. They are ticked by default, and the next run on the same rail remembers your choice. Ticked nets are solved as one rail named "VBUS_R + VBUS_RAW", and the page does not appear for rails without such neighbours.
- **The parts between the nets are taken as shorts (1 mΩ)**, so the drop shown is the copper's alone. The result says so ("F1 joins VBUS_R + VBUS_RAW, taken as a short: its own drop is not included"). They are not loads. The source and loads are offered from every net of the rail.
- **The streamline runs through the part**, drawn straight from one of its pads to the other, so a load beyond the fuse gets a line back to the source.
- CLI: `--dc VBUS_R,VBUS_RAW` checks the nets together; the report lists `railNets` and `bridges`.

## [0.1.53] - 2026-11-26

HF check: each return is one unbroken line, where the current actually flows.

- **Least loop inductance**: the drawn return is the path of least loop inductance through the reference copper, found on a 0.05 mm grid round the trace (each step costs (μ0/2π)·ln(1 + (s² + h²)/r²) nH per mm at distance s beside the trace and h below it). Over a plane it runs under the trace and round holes; beside a coplanar trace it takes the nearest pour edge that carries on.
- **One line, no dead ends**: a coplanar return is drawn on one side only, not on both. A strip of pour that ends (such as the outside of the bend at OLED1 on SD0) gets no line, and the line no longer stops or breaks where the copper beside the trace thins out. It breaks only where the current leaves the copper: at a split, where the trace has no reference copper, and at the pins and vias at the ends.
- **Follows the trace**: the line keeps to the course of the stretch it mirrors and does not cut across to another (such as the next leg of a meander). Under a meander far finer than its height above the plane it follows the meander's course, within 0.25 mm.
- **Round a gap or through vias, by inductance**: where a gap leaves the return both ways, round it in the copper or through GND vias and the other layer, the one with less loop inductance is taken (each via ≈ 1.3 nH through a 1.6 mm board), not the shorter one. The finding gives both in nH.
- The return path is built in time slices like the rest of the analysis (new phase "return path").
- Every-net run time in Node: rack display 53 → 72 s, dongle 73 → 85 s. Audit on both test boards, every signal net: no drawn return outside its reference copper, on another net's copper or crossing it.

## [0.1.52] - 2026-11-26

HF check: no drawn return line leaves its reference copper.

- **Returns keep inside the copper**: detours and via-route legs are drawn 0.1 mm inside the reference copper (0.05 or 0.02 mm where it is narrower), not along its edge, so the drawn line no longer straddles the edge of a hole. Ends that sit at a gap edge step straight in.
- **Hairline fill slivers are not copper**: pour fill narrower than 0.1 mm (EasyEDA's stored fill can hold 0.015 mm strips between a pour edge and a clearance) is dropped. A return no longer detours along such a strip; where one used to bridge a gap, the gap is now reported (a small detour, a via route, or unconnected islands).
- Audit on both test boards, every signal net: no return line on or across another net's copper, and none outside its reference copper beyond single samples on the edge.

## [0.1.51] - 2026-11-26

From Balazs: show the board info CSV format at the import.

- **Return Path → Load Board Info... shows the CSV format before the file is picked**, in the wizard window: the `row` column (net, load or layer), the columns of each row type, the allowed kinds, units (speed in Hz such as `400k` or `8 MHz`, voltage such as `3.3` or `3V3`, currents such as `150mA` or `0.15`), that blank cells mean not applicable, and what Replace and Add do when the project already has board info. In English and Chinese.
- **Save the sample CSV as a template** there saves the sample (`examples/board-info-sample.csv`, now shipped inside the extension) as `board-info-template.csv`, then shows the format again; **Choose the CSV file…** opens the file dialog.
- The wizard window's question text scrolls when it is longer than the window, and starts at the top for each question.

## [0.1.50] - 2026-11-26

From Balazs, on 0.1.48: DC lines still had corners, one of them nearly 90°, where a line left a via and joined another line. "It's unlikely current has a 90 degrees joint by itself." The join beside C11, a long shallow merge, is how it should look.

- **Smoothing that shows**: the drawn lines are smoothed with a Gaussian over 0.35 mm (at least one cell) along their length. The 0.1.48 smoothing worked on steps a fraction of a cell long, and thinning the points afterwards put the corners back. The ends (pads, vias, joins) stay where they are, and the smoothing never moves a point off its layer's copper, so a line still turns tightly around a copper corner.
- **Shallow joins**: a line joining another meets it at least 2.5 times as far ahead as the other line lies to the side (and at least 1 mm or three cells). In 0.1.48 the target could lie only 0.6 mm ahead of a line 0.8 mm to the side, so the curve onto it was almost vertical, as beside R21.
- Every line still reaches its load, and the layer changes are the same on the rack display (3V3, 9V, 12V) and the R-Com dongle (+12V). The drawn lines have about twice as many short pieces as before.

## [0.1.49] - 2026-11-26

HF check: return lines that follow the real copper (SD0 on the rack display board).

- **The return beyond a neighbouring trace counts again**: a pour on the trace's own layer is the coplanar reference when it is the nearest return copper, even with another trace in between (SD0 beside SC0). The return runs in it as one continuous line; before, the trace was taken as referenced to the far plane, and its return was a broken line along the trace with a detour around C84.
- **Short plane stretches between coplanar ones are merged**: a stretch shorter than one via reach no longer sends the return down through a via and back up.
- **The loop closes at a connector or module pin in the middle of the trace**: when the trace passes through a pin of a part that is not a passive (such as the OLED module), the return starts from that part's nearest ground pin, not from the end of the trace.
- **Via routes**: where a gap splits the reference into islands that GND vias join through the other layer, the return is drawn down one via, along that layer's copper and up the next, and the finding names the vias.
- **Detours are drawn around every hole**, small ones too, and small detours (under 1 mm extra) are drawn as well. A coplanar return is drawn only within the trace's footprint or at the pour edge, never further out.
- **Colours**: the signal trace is now yellow (matching the DC view), and hops are dashed white.

## [0.1.48] - 2026-11-26

From Balazs, on the DC lines: a nicer join where one line meets another, a little smoothing, and a focus mode for one pad.

- **Lines join along each other**: where a load's line reaches an earlier one, it now bends onto it and meets it about 1 mm further along, heading the same way. Before, it ended in a corner, a sharp V or a sideways jog. Lines are smoothed a little more (three rounds instead of two), and a line counts as meeting another within 0.6 mm (at least one cell; before, two).
- **Focus on one pad or part**: with one pad or part selected on the canvas, the panel's **Rerun last** reads **Rerun for single pad** (or **Rerun for single part**). It solves and draws only that part's current, on the rail of the last DC run when the part is on it, with the current given for it then (per amp when none was given), and a few lines from its pads so parallel paths show. The result starts with "Focus on U3: …". **Rerun last** still means every load once the selection is cleared.
- **Selected trace with a pad or part selected** does the same: a pad on a signal net gets the HF check of its net. A pad on a supply net picks that rail, while a ground pad or a whole part picks the rail the part draws from. The DC wizard is asked first when no DC run covers that rail.

## [0.1.47] - 2026-11-26

From Balazs: a per-project board info database, so each net and rail is set up once.

- **Board info, stored per project** with the extension's settings: for each net its kind, protocol and speed, driver part and pin, receivers, diff-pair partner, intended reference, impedance or length target and notes; for each power rail its voltage, source and each load's typical and peak current; for each layer its pours and intentional splits.
- **Return Path → Load Board Info...** imports it from a CSV file (first column `row`: `net`, `load` or `layer`; comma or semicolon separated; blank cells are not applicable), replacing the project's board info or adding to it. **Return Path → Save Board Info...** saves it in the same format. A sample is in `packages/extension/examples/board-info-sample.csv`, and the format is in the extension README.
- **HF check prefills from it**: nets with board info are listed first with their protocol, power and ground nets are left out, the speed starts at the stored speed, and a stored driver is used without asking. The result has a `Board info:` line (kind, diff partner, intended reference, target, receivers, notes).
- **DC check prefills from it**: the rail's source and loads are preselected and the currents start at the typical currents.
- **Changes in the wizard are written back**: a changed speed, the driver you pick (also None), and a DC source, load set or currents that differ from the prefilled ones. Board info wins over what is recognised from names and pins, and a later edit in the wizard overrides the imported value.
- The MCO protocol (a microcontroller's clock output) is recognised as a clock.

## [0.1.46] - 2026-11-26

From Balazs: HF check on SD0 in 0.1.44 stopped after 60 s (time budget) "during gaps", on a net of 23 segments.

Since 0.1.44, SD0's bottom stretch, which runs 0.35 mm beside SC0, returns in the Top GND (the Bottom pour lies behind SC0). That pour is in 193 pieces, so SD0 crosses about ten slots, and for most of them the copper on the two sides is not connected. For each, the detour search doubled its window until it covered the whole pour, clipping and preparing the pour again every time. That took 3.5 s in Node and 52 s inside EasyEDA.

- **The detour search first checks that both ends lie on the same piece of copper**; if not, there is no detour, and it says so at once. The pour's pieces are prepared once per analysis. Detours for SD0 take 0.13 s instead of 3.5 s, with the same results; all signal nets of both boards give the same findings, and the rack display's whole run takes 27 s instead of 46 s.
- **The time-budget message names the phase that used the time**, rather than the one about to start (it said "gaps" for time spent tracing detours).

## [0.1.45] - 2026-11-26

Numbered above 0.1.44, main's version.

From Balazs, on DC return lines: one jumped from the bottom to the top layer at a via and back down at the next, where the bottom ground pour runs on unbroken; another curved wide through a top pour between two vias instead of taking the straight path.

The solve was right; the drawn line was not. Each load gets one line traced back along the solved current field. At a via it switched layers whenever the barrel carried any current in the walking direction. On a 2-layer board, where every stitching via hands a little current between the pours, that was nearly every via it crossed. Leaving a via, it started in the direction of the field at the barrel's centre. There the barrel's own radial flow dominates, so that direction was noise.

- **Layer changes follow the bulk of the current.** The line changes layer at a via only where the barrel takes more current than flows on past the via on the same layer, measured through a 1 mm ring around it. On the rack display's 3V3 rail, the return lines change layer 26 times instead of 34; on 9V, 23 times instead of 32. Vias at the end of a track and the loads' own ground vias are still taken. OLED2's line, which went up to the top layer at a stitching via and back down 20 mm later, now stays on the bottom pour; there, the bottom copper around the via carried about 113 mA/mm and the top 14 mA/mm.
- **Leaving a via along the densest path.** The line leaves a via where the most current crosses that ring, so between a via feeding a plane and a via draining it, it takes the straight path. In a test plane the bow dropped from 0.48 mm to 0.11 mm.
- The 9V return line of OLED8, which used to stop short, now reaches the source. Supply lines on both boards are unchanged.

## [0.1.44] - 2026-11-26

From Balazs: the point is a visually accurate picture of where the return current flows, so the designer can see where it takes big turns or passes through choke points; lines that pass through other traces, or are otherwise unreal, are unacceptable.

An audit of every drawn return line on the two real boards against the reference copper found that, on the rack display, 1201 of 2895 mm of coplanar return lay outside copper and 439 mm on other nets' traces (the SCL/SDA bus runs side by side), and 184 of 650 mm of plane return lay over no copper. Now all of it lies in copper (detours around slots run along the copper edge).

- **A coplanar return is drawn at the pour edge, just inside the pour**, on each side where the pour comes before any other conductor, instead of at a fixed distance from the trace whenever pour was anywhere within 6 mm. Each drawn point and the line to the next one are checked to lie in reference copper; the line breaks where they do not.
- **A pour behind a neighbouring trace is no coplanar reference.** The analysis used to find pour beyond the neighbour and take it; now any track, pad or via of a net without a pour on that layer stops the search, so such stretches return in the plane under them.
- **The plane return keeps to the copper.** It is drawn under the trace where there is copper there; across a hole (an antipad, another trace's clearance) it moves aside to the nearest copper, within the trace half-width plus h, keeping to one side, and breaks where there is none. It no longer folds back at the inside of a bend.

## [0.1.43] - 2026-11-26

Numbered above 0.1.42, main's version.

From Balazs, after 0.1.40 on SC0: only cyan was left, also on the top trace; there was no forward trace and nothing on the vias. The colours of 0.1.39 were right, the places were wrong. Asked what he expects, he chose: the colour of a return follows the layer of its signal trace; it is drawn where the current physically flows; the meander's return runs in the Top GND under it; the signal trace is highlighted, and so are the vias it actually passes through.

- **Return colour follows the signal trace's layer.** A Top trace's return is magenta and a Bottom trace's cyan (inner traces green and blue), wherever it flows. It used to take the colour of the copper it flows in, so on a 2-layer board almost everything returning in the Bottom GND was cyan, the Top trace's too. It is still drawn where it flows: on the trace when it runs in the other layer's copper, beside it in a pour on the trace's own layer.
- **The meander returns in the plane under it again.** 0.1.40's rule that kept a meander on the pour beside it is gone. A stretch of pour beside the trace shorter than two via reaches no longer pulls the return back up either, so SC0's whole meander returns in the Top GND under it: in through the GND via beside the meander, and out at the signal via to the Top trace's return in the Bottom GND, each drawn as a dashed hop.
- **The signal trace is drawn**, thin and white over its return, with a circle on each via it passes through from one layer to another (not on vias it only touches). It has its own line in the panel, "Signal trace and its vias", for colour, width and visibility.
- **Recognised data lines longest first** in the HF check's net list (SCL 376 mm, SDA 375 mm, SD0 152 mm, SC0 151 mm… on that board); the other signal nets follow by name.

## [0.1.42] - 2026-11-26

From Balazs, with a screenshot of the panel: the buttons are uneven.

- The panel's buttons in a row now share its width equally, so both columns line up from row to row. Before, each button was sized by its label, so "Rerun last" was narrower than "HF check" above it.

## [0.1.41] - 2026-11-26

Numbered above 0.1.40, which #20 took.

From Balazs: after an update, an overlay already on the board is not picked up and cannot be cleared.

Markers stay on the canvas when the extension is updated or reloaded, but the new instance starts with no overlay, and the EasyEDA API cannot list markers. So the panel said "Overlay: none" and disabled Clear and Hide.

- **Clear is always available** (except while a run is going). It removes every Return Path marker on the board, including ones an earlier version drew.
- **Leftover overlays are recognised:** while markers are on the canvas, the version that drew them is kept in the extension's settings. After an update or reload, the panel shows "Overlay: left by v0.1.x", and **Hide** or **Clear** removes those markers. **Rerun last** draws the overlay again. Versions before 0.1.41 did not record this, so markers they left are removed with Clear only.
- **Clear no longer depends on the instance that drew the overlay.** The instance owning the panel removes the markers itself. Before, Clear was handed to the drawing instance, and nothing happened when that instance was gone.

## [0.1.40] - 2026-11-26

Numbered above 0.1.39, main's version. First pushed as 0.1.39; renumbered after #19 took 0.1.39 and merged.

From Balazs, with a screenshot of the HF check of SC0 on a 2-layer board: the meander (on Bottom) was drawn in magenta (return on Top) with red under it, the next bump of the meander had no return at all, and dashed yellow lines ran from the meander to a GND via.

- **A meander keeps its coplanar return.** The bottom pour keeps further from a meander than from the rest of the trace, so that stretch was given the Top pour as its reference. The return then dropped through a GND via to Top and came back up through the same via, which drew the yellow hops and the magenta. A stretch on the opposite layer's pour, between two stretches with a pour beside them and shorter than twice the via reach, now keeps the pour beside it. On that board's SC0, the trace is one stretch with no hops.
- **Vias use the reference the trace actually found.** A via was judged against the opposite layer's pour on each side. Where the trace on one side returns in a pour beside it on the same layer the other side returns in (as SC0 does at its via to Top), the return does not change layer there, and the via is no longer reported. Across the two real test boards, via hops fall from 272 to 156 and warnings from 660 to 572.
- **The coplanar return is drawn along every stretch with pour beside it.** It used to be drawn only when the middle of the stretch had pour beside it, and as an offset line that folded back inside tight bends. It is now drawn along the pour edge on each side that has pour within the band, stopping where another leg of the same trace is in the way.
- **Red only where at least half the reference copper is missing.** A stretch at 62–90% coverage was drawn red like a broken return. Red now marks coverage below 50%; smaller shortfalls stay in the result list. Short bends of a coplanar trace, shorter than its keepout, are no longer judged on their own.

## [0.1.39] - 2026-11-26

From Balazs: the run folder is a basic setting, so it belongs in the menu, not the panel; the panel's Log button duplicates the menu's Show Saved Log.

- **Return Path → Run Folder...** in the menu, between Open Panel and Show Saved Log. It does what the panel's **Run folder…** button did.
- The panel's **Log…** and **Run folder…** buttons are removed. The saved log stays at **Return Path → Show Saved Log...**.
- When the run files or the log file cannot be written, the log line now points at Return Path > Run Folder.

## [0.1.38] - 2026-11-26

From Balazs, with a screenshot of the HF check speed page showing `${1} (edges ≈ ${2} ns)`: put the speed selector on the "Net to check" page after each net's length, prefilled with the usual speed for that kind of line, and give the wizard a Back button.

- **Net and speed on one page:** the HF check lists each net as `net · kind · length` followed by a speed selector. It is prefilled with the usual speed of that kind (a clock 16 MHz, I²C 400 kHz, …) and offers the kind's other usual speeds with their edge times, plus **Other speed…** with a field for a typed speed (`400k`, `12 MHz`, `115200`); OK stays disabled until the typed speed reads as one. The separate speed page is gone. Without the wizard window, the net and its speed are still asked in two system dialogs.
- **Back** in the wizard window, beside OK and Cancel, from the second question on: it returns to the previous question with the earlier answer preselected (HF check: from the driver question back to the net page; DC check: from the loads back to the source, from the currents back to the loads).
- **Placeholders filled in:** texts with `${1}`, `${2}` that had no entry in the locale files were shown with the placeholders left in. Every translated text now goes through one helper that fills them in either way, every missing text was added to `en.json` and `zh-Hans.json`, and a test checks that each text the extension translates has an entry in both.
- Pin names are read once per board read, not again for each question.

## [0.1.37] - 2026-11-26

Numbered above 0.1.36, main's version.

From Balazs, on EasyEDA Pro desktop 2.2.32.4 for macOS with 0.1.33: the log said "run files not written: allow External Interaction" although External Interaction was allowed, and no `returnpath-log.txt` existed. The run folder and the log file both came from `sys_FileSystem.getEdaPath` (marked @beta in the API types). Any failure there, and a missing write API, ended in the same message about the permission, and the error itself was dropped.

- **The real reason is logged and shown.** The log names which call is missing (`sys_FileSystem.saveFileToFileSystem` or `sys_FileSystem.getEdaPath`), says when `getEdaPath` returned an empty path or did not answer, or quotes its error. The permission is named only when the write API itself is missing. A failed write of the log file is logged with its error too. Show Saved Log and Run folder… show the same reason.
- **Run folder as the fallback.** When `getEdaPath` fails, the run files and `returnpath-log.txt` go to the Run folder chosen in the panel. With no Run folder chosen, the first run of the session asks for one; the files of that run and the log are then written there. `getEdaPath` is asked once per session, so a call that hangs costs its 2 s limit once.

## [0.1.36] - 2026-11-26

Numbered above 0.1.35, main's version. First pushed as 0.1.35; renumbered after #15 took 0.1.35 and merged.

From Balazs, after 0.1.34: the prefilled currents are fine, but he wants to enter the rail's full current and set roughly how much each component gets with small sliders.

- **Total current and share sliders** on the currents page of the wizard window:
  - a **Total current** field at the top. Typing a new total scales every load and keeps their ratios.
  - each load has a slider for its share of the total, with the share in percent and the current beside it. Moving one slider keeps the total; the other loads keep their ratios and share what is left.
  - a load's current can still be typed exactly, and the total follows.
  - **Equal** shares the total equally.
  - the values are prefilled as in 0.1.33: 100 mA per load, or the last run's currents on the same rail. Clearing the total still gives the per-amp view.
- The reply to the extension is unchanged (`U2=240mA, U3=…`), so the system-dialog fallback and saved runs work as before.

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
