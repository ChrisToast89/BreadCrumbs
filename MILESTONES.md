# BreadCrumbs — Build Plan

Seven phases. Each ends at a gate with a check that can be run from the terminal.
Do not begin a phase until the previous gate passes.

Read `SPEC.md` before starting and re-read the relevant section at the start of
each phase.

---

## Ground rule: build the headless path first

A coding agent cannot click a carrot. So every phase before the UI must be
verifiable from the command line, and those tools stay in the repo permanently
as debugging aids.

Build `npm run inspect -- <file>` as a debug CLI, extended each phase:

| After phase | `inspect` reports |
|---|---|
| 1 | Index JSON: dimensions, rotation, SAR, fps, frame count, VFR and HDR flags, first and last 5 PTS values |
| 2 | Proxy path, size, encode duration, verified proxy frame count == source frame count |
| 3 | Metric summary: min/max/mean per signal, plus a PNG plot of motion and histogram distance over time |
| 4 | Detected shots as a table, and the chosen frame per shot with the reason it was chosen |
| 6 | Dry-run export: the filenames that would be written |

Keep a `fixtures/` folder with at least: a hard-cut live-action clip, an
animation clip, a screen capture, a rotated phone video, and a VFR file. Under
30 seconds each. `inspect` runs against all of them.

---

## Phase 0 — Skeleton

**Build.** electron-vite + React + TypeScript project. Main, preload, renderer.
Typed IPC contract in `src/shared/types.ts`. Window opens with a placeholder.
Strict TypeScript, `contextIsolation: true`, `nodeIntegration: false`.

**Gate.** `npm run dev` opens a window. `npm run typecheck` passes clean.

---

## Phase 1 — Index

**Build.** `ffprobe`-based indexing producing the full `VideoIndex`: PTS table
from packet timestamps, display geometry resolved from rotation metadata and
sample aspect ratio, VFR detection, HDR detection from color primaries and
transfer characteristics.

Read SPEC §4 and invariants I1 and I5.

**Gate.**
- `inspect` prints a correct index for every fixture.
- The rotated fixture reports `rotationDegrees: 90` and *swapped* display dimensions.
- The VFR fixture reports `variableFrameRate: true`.
- `ptsList.length` matches `ffprobe -count_frames` for every fixture.

---

## Phase 2 — Proxy

**Build.** All-intra 480p H.264 proxy. Cached per source in the project folder,
reused if present. Determinate progress from ffmpeg's frame counter.

Read invariant I2. `-fps_mode passthrough` is mandatory.

**Gate.**
- Proxy frame count equals source frame count for every fixture, **including the VFR one**. This is the single most important check in the build; if it fails, stop and fix it before continuing.
- Proxy for a 2-minute 1080p fixture builds in under 30 seconds.
- Rotated fixture's proxy is upright.

---

## Phase 3 — Analyze

**Build.** One decode pass over the proxy producing `FrameMetrics` for every
frame, and a second producing a 160px JPEG thumbnail for every frame held in
memory. Weighted progress across phases 1–3.

Read SPEC §5.

**Gate.**
- `inspect` emits a metric plot; visually, spikes align with the visible cuts in the fixture.
- Memory after analysis of a 2-minute clip stays under 150MB.
- Total elapsed time for phases 1–3 on a 2-minute 1080p clip is under 30 seconds.
- Metrics arrays all have length `frameCount`.

---

## Phase 4 — Detect and choose

**Build.** Signal fusion, adaptive thresholding, run collapse, dissolve marking,
shot construction. The "first settled frame" rule, exactly as specified.

Read SPEC §6. Implement the rule literally — do not substitute a simpler
heuristic because it seems close enough.

**Gate.**
- Hand-count the cuts in each fixture. Detection is within ±20%, with false positives preferred over misses.
- The animation fixture does not produce hundreds of spurious cuts.
- `inspect` prints, for each shot, the chosen frame and which rule step selected it.
- Re-running detection over cached metrics takes under 100ms.
- A clip with no cuts yields exactly one shot.

---

## Phase 5 — Interface shell

**Build.** Three-pane layout, intake screen with the four-step explanation and
progress, board filmstrip, preview pane, overview row. Read-only — no editing yet.

Read SPEC §7 for structure and behavior, and §12 for the visual source. Import
the design through the `claude_design` MCP server before writing components, and
extract its tokens into one stylesheet rather than transcribing its markup.

**Gate.**
- Load a fixture end to end from the intake screen; board populates; clicking a board cell updates the preview.
- Rotated fixture displays upright in preview, board, and overview alike.
- Preview seek after selecting a different pick completes in under 100ms.
- Window resizes cleanly from 1100px to full screen.
- Keyboard focus is visible on every interactive element, using the design's focus treatment.
- Palette, type, and spacing come from a single token module — no hardcoded hex values in components.
- The A/B pairing in the board matches the design's device, and a paired cell cannot be misread as two shots.

---

## Phase 6 — Editing

**Build.** Shot row with per-frame thumbnails, draggable carrot, zoom and pan.
Merge, split, reject, add and remove out-frame. Undo stack. Pin-on-edit (I6).

Read SPEC §7 again, and I8.

**Gate.**
- Dragging the carrot updates preview and board with no visible lag — this is reading an array, so any lag means the frame cache is not being used.
- Merge then undo restores the exact prior state including pick positions.
- Split produces two shots whose frame ranges are contiguous and non-overlapping.
- A pick cannot be dragged outside its own shot.
- Adding an out-frame yields a paired board cell with an `A/B` badge, and the pair reads as one unit rather than two shots.
- The default out-frame lands back from the end of the shot, not on the final frame.
- Dragging A toward B, or B toward A, clamps — they never cross or swap (I8).
- Adding a third frame to a shot is impossible through any path, including undo replay. Verify at the store level, not just the UI.
- Merging two shots that each have an out-frame yields a shot with exactly two frames, and the discarded ones are restored on undo.
- Rejecting a shot removes it from the board but leaves it visible, desaturated, in the overview.

---

## Phase 7 — Export

**Build.** Pattern editor with live filename preview, PNG and JPEG output, single-pass
batch extraction, manifest CSV, overwrite prompt, folder reveal.

Read SPEC §8 and invariants I3 and I4.

**Gate.**
- Exported pixels are identical to `ffmpeg -i source -vf "select='eq(n\,N)'" -frames:v 1` run manually for a spot-check of 5 frames across 3 fixtures. **This is the correctness test the whole tool exists to pass.**
- Exports are full source resolution, not proxy resolution.
- Rotated fixture exports upright, correct aspect.
- 40 frames export in a single ffmpeg invocation — verify by logging the command.
- `manifest.csv` row count equals file count; timecodes match the UI.
- A colliding pattern is rejected with a message naming the fix.
- A board mixing single and paired shots exports as `shot007`, `shot008A`, `shot008B` — `{ab}` empty on singles, populated on pairs.
- `manifest.csv` carries the `role` column, and A always precedes B within a shot.

---

## Phase 8 — Packaging (optional)

Swap to an LGPL ffmpeg build (SPEC §10). Build installers for all three
platforms. Verify the unpacked sidecar binaries resolve correctly from inside the
packaged app — this breaks by default under asar and is the most common
packaging failure.

---

## Reporting

At each gate, report: what was built, which checks passed with their actual
measured numbers, anything that failed, and any place the spec was ambiguous.
Do not proceed past a failed gate. Do not batch multiple phases into one report.
