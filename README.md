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
5. Draw the overlay on a custom layer: the ±3h band, gaps, detours, via links and loop areas.

Status: early development.
