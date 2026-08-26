/**
 * Phase 4 — Detect and choose. SPEC §6.
 *
 * Pure computation over cached metrics: no I/O, no ffmpeg, nothing async. That
 * is what lets re-detection be instant (SPEC §5) and what makes every rule here
 * testable from the inspect CLI.
 *
 * Two independent signals are fused, because neither alone survives mixed
 * source material:
 *
 *   - ffmpeg's scene score against a fixed bar. Catches most hard cuts, misses
 *     cuts between similarly-lit shots.
 *   - Histogram distance against an adaptive bar, gated by a motion floor.
 *     Catches tonal cuts and matched action; fast pans read as change, which is
 *     why motion alone cannot be the trigger.
 *
 * The adaptive bar is a rolling median plus k x MAD, so a handheld or strobing
 * section raises its own floor rather than producing forty false cuts.
 *
 * SPEC §6 is explicit that detection should over-detect slightly: a false cut
 * costs one keystroke, a missed cut costs the user finding it themselves.
 */

import type { FrameMetrics, Pick, Shot, VideoIndex } from '../shared/types.js';
import type { Settings } from '../shared/settings.js';
import { nextPickId } from '../shared/picks.js';

/** Which step of the SPEC §6 frame rule chose a frame, for the inspect CLI. */
export type ChoiceReason =
  | 'settled'
  | 'settled-after-soft-start'
  | 'sharpest-in-first-third'
  | 'single-frame-shot';

export interface FrameChoice {
  shotId: string;
  frame: number;
  reason: ChoiceReason;
  /** Frames skipped for being near-black or near-white (SPEC §6 step 1). */
  skippedForLuma: number;
  /** Frames rejected by the sharpness guard (SPEC §6 step 3). */
  skippedForSharpness: number;
}

export interface DetectionResult {
  shots: Shot[];
  picks: Pick[];
  choices: FrameChoice[];
  /** Per-frame adaptive histogram bar, kept for the inspect plot. */
  adaptiveThreshold: Float32Array;
  candidatesBeforeCollapse: number;
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Thresholding
// ---------------------------------------------------------------------------

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * Move the k-th smallest value into position k, partitioning around it.
 * Reorders `buffer` in place and looks at far less of it than a sort would.
 *
 * The rolling median runs twice per frame — once for the median, once for the
 * MAD — so on a 9,000 frame clip (SPEC §1's worst case) this is 18,000
 * selections. Sorting a 91-wide window each time put re-detection near the
 * 100ms budget at 3,600 frames and over it at 9,000.
 */
function selectInPlace(buffer: Float64Array, length: number, k: number): number {
  let left = 0;
  let right = length - 1;

  while (left < right) {
    const pivot = buffer[(left + right) >> 1] as number;
    let i = left;
    let j = right;

    while (i <= j) {
      while ((buffer[i] as number) < pivot) i += 1;
      while ((buffer[j] as number) > pivot) j -= 1;
      if (i <= j) {
        const swap = buffer[i] as number;
        buffer[i] = buffer[j] as number;
        buffer[j] = swap;
        i += 1;
        j -= 1;
      }
    }

    if (k <= j) right = j;
    else if (k >= i) left = i;
    else return buffer[k] as number;
  }

  return buffer[k] as number;
}

/** Median of the first `length` entries of a scratch buffer. Reorders it. */
function medianInPlace(buffer: Float64Array, length: number): number {
  if (length === 0) return 0;
  const middle = length >> 1;
  const upper = selectInPlace(buffer, length, middle);
  if (length % 2 === 1) return upper;

  // The lower middle is now known to sit in the left partition.
  let lower = buffer[0] as number;
  for (let i = 1; i < middle; i += 1) {
    const value = buffer[i] as number;
    if (value > lower) lower = value;
  }
  return (lower + upper) / 2;
}

/**
 * Rolling median + k x MAD over a +/-window frame span (SPEC §6), with an
 * absolute floor so that a long quiet stretch — where median and MAD both fall
 * to nearly nothing — does not put the bar on the floor.
 */
function adaptiveHistogramThreshold(histogram: Float32Array, settings: Settings): Float32Array {
  const { histogramWindow, histogramMadK, histogramFloor } = settings.detection;
  const count = histogram.length;
  const thresholds = new Float32Array(count);

  // Two scratch buffers, reused for every frame. Allocating a fresh window and
  // a fresh deviation array per frame was most of the cost here.
  const span = histogramWindow * 2 + 1;
  const windowBuffer = new Float64Array(span);
  const deviationBuffer = new Float64Array(span);

  for (let i = 0; i < count; i += 1) {
    const from = Math.max(0, i - histogramWindow);
    const to = Math.min(count - 1, i + histogramWindow);
    const length = to - from + 1;

    for (let j = 0; j < length; j += 1) windowBuffer[j] = histogram[from + j] as number;
    const median = medianInPlace(windowBuffer, length);

    // Refill from the source: medianInPlace reordered the buffer above.
    for (let j = 0; j < length; j += 1) {
      deviationBuffer[j] = Math.abs((histogram[from + j] as number) - median);
    }
    const mad = medianInPlace(deviationBuffer, length);

    thresholds[i] = Math.max(histogramFloor, median + histogramMadK * mad);
  }

  return thresholds;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

interface Candidate {
  frame: number;
  /** How far past its bar the strongest signal reached. 1 means exactly at it. */
  score: number;
  boundary: 'hard' | 'soft';
  confidence: number;
}

/**
 * Map "how far past the bar" to a 0..1 confidence. At the bar is 0; three times
 * the bar or more is 1. Used for the low-confidence markers in the overview
 * (SPEC §7), so what matters is the ordering, not the exact curve.
 */
function scoreToConfidence(score: number): number {
  return Math.max(0, Math.min(1, (score - 1) / 2));
}

function findCandidates(
  metrics: FrameMetrics,
  thresholds: Float32Array,
  settings: Settings,
): Candidate[] {
  const { sceneThreshold, motionFloor, dissolveWindow, dissolveElevatedFraction, dissolveElevatedCount } =
    settings.detection;
  const candidates: Candidate[] = [];

  // Frame 0 is the start of the clip, not a cut.
  for (let i = 1; i < metrics.histogram.length; i += 1) {
    const scene = metrics.scene[i] as number;
    const histogram = metrics.histogram[i] as number;
    const motion = metrics.motion[i] as number;
    const bar = thresholds[i] as number;

    // SPEC §6: the scene score clears a fixed bar, OR the histogram distance
    // clears the adaptive bar while motion also exceeds a floor.
    const sceneHit = scene > sceneThreshold;
    const histogramHit = histogram > bar && motion > motionFloor;
    if (!sceneHit && !histogramHit) continue;

    const sceneRatio = sceneThreshold > 0 ? scene / sceneThreshold : 0;
    const histogramRatio = bar > 0 ? histogram / bar : 0;
    const score = Math.max(sceneHit ? sceneRatio : 0, histogramHit ? histogramRatio : 0);

    // SPEC §6, dissolves: a hard cut is a spike against quiet neighbours; a
    // dissolve is a plateau. If most of the preceding frames are also elevated,
    // the boundary is soft.
    //
    // "Elevated" is measured against this candidate's own height, not against
    // the adaptive bar. A hard cut towers over its neighbours whatever the bar
    // happens to be sitting at locally; a dissolve spreads the same change
    // across many frames, so its neighbours reach a good fraction of the peak.
    // Comparing to the bar instead marked ordinary hard cuts as dissolves
    // whenever the preceding shot merely had some movement in it.
    let elevated = 0;
    for (let j = Math.max(0, i - dissolveWindow); j < i; j += 1) {
      if ((metrics.histogram[j] as number) >= dissolveElevatedFraction * histogram) {
        elevated += 1;
      }
    }
    const boundary: 'hard' | 'soft' = elevated >= dissolveElevatedCount ? 'soft' : 'hard';

    candidates.push({ frame: i, score, boundary, confidence: scoreToConfidence(score) });
  }

  return candidates;
}

/**
 * SPEC §6: candidates within minShotFrames of each other reduce to the one with
 * the highest score.
 */
function collapseRuns(candidates: Candidate[], minShotFrames: number): Candidate[] {
  if (candidates.length === 0) return [];

  const collapsed: Candidate[] = [];
  let best = candidates[0] as Candidate;
  // Chained against the previous candidate, not against the strongest one so
  // far: SPEC §6 says candidates "within minShotFrames of each other". A
  // dissolve fires on thirty consecutive frames, and measuring from the peak
  // instead broke that run in half, leaving the transition itself standing as
  // a separate shot the user would only have to merge away.
  let previousFrame = best.frame;

  for (let i = 1; i < candidates.length; i += 1) {
    const candidate = candidates[i] as Candidate;
    if (candidate.frame - previousFrame < minShotFrames) {
      // Same run. Keep the stronger, but a soft boundary anywhere in the run
      // means the transition as a whole is gradual.
      const boundary = best.boundary === 'soft' || candidate.boundary === 'soft' ? 'soft' : 'hard';
      best = candidate.score > best.score ? { ...candidate, boundary } : { ...best, boundary };
    } else {
      collapsed.push(best);
      best = candidate;
    }
    previousFrame = candidate.frame;
  }
  collapsed.push(best);

  return collapsed;
}

// ---------------------------------------------------------------------------
// Frame choice — SPEC §6, "first settled frame"
// ---------------------------------------------------------------------------

function isNearBlackOrWhite(luma: number, margin: number): boolean {
  return luma <= margin || luma >= 1 - margin;
}

/**
 * The default frame for a shot, implementing SPEC §6 step by step:
 *
 *   1. Skip frames within 5% of pure black or pure white (fade, flash).
 *   2. Find the first frame where motion drops below
 *      max(0.35 x median motion across the shot, 0.02).
 *   3. Require sharpness >= 0.6 x the peak across the shot's first third.
 *      A frame failing this does not stop the scan.
 *   4. Stop 40% into the shot. If nothing qualified, fall back to the sharpest
 *      frame in the first third.
 *   5. For a soft boundary, start the scan a third of the way in instead of at
 *      startFrame.
 *
 * This favours the composition the editor settled on over the prettiest frame
 * in the shot, and is deliberately predictable: the user adjusts from it, so it
 * has to land somewhere they can anticipate.
 */
export function chooseFrame(
  shot: Shot,
  metrics: FrameMetrics,
  settings: Settings,
): Omit<FrameChoice, 'shotId'> {
  const { blackWhiteMargin, settledMotionFactor, settledMotionFloor, sharpnessFactor, scanLimitFraction, softStartFraction } =
    settings.frameChoice;

  const length = shot.endFrame - shot.startFrame + 1;
  if (length <= 1) {
    return {
      frame: shot.startFrame,
      reason: 'single-frame-shot',
      skippedForLuma: 0,
      skippedForSharpness: 0,
    };
  }

  // Step 5 — a dissolve is still resolving at its start, so begin further in.
  const softStart = shot.boundary === 'soft' ? Math.floor(length * softStartFraction) : 0;
  const scanFrom = shot.startFrame + softStart;

  // Step 4 — the scan stops 40% into the shot, measured from its real start.
  const scanTo = Math.min(shot.endFrame, shot.startFrame + Math.max(1, Math.floor(length * scanLimitFraction)));

  // Step 2 — the motion bar is relative to this shot's own median motion.
  const shotMotion: number[] = [];
  for (let i = shot.startFrame; i <= shot.endFrame; i += 1) shotMotion.push(metrics.motion[i] as number);
  const motionBar = Math.max(settledMotionFactor * medianOf(shotMotion), settledMotionFloor);

  // Step 3 — the sharpness bar comes from the peak across the first third.
  const firstThirdEnd = Math.min(shot.endFrame, shot.startFrame + Math.max(1, Math.floor(length / 3)));
  let firstThirdPeakSharpness = 0;
  let sharpestFrame = shot.startFrame;
  for (let i = shot.startFrame; i <= firstThirdEnd; i += 1) {
    const sharpness = metrics.sharpness[i] as number;
    if (sharpness > firstThirdPeakSharpness) {
      firstThirdPeakSharpness = sharpness;
      sharpestFrame = i;
    }
  }
  const sharpnessBar = sharpnessFactor * firstThirdPeakSharpness;

  let skippedForLuma = 0;
  let skippedForSharpness = 0;

  for (let i = scanFrom; i <= scanTo; i += 1) {
    // Step 1 — fades and flashes are never representative.
    if (isNearBlackOrWhite(metrics.luma[i] as number, blackWhiteMargin)) {
      skippedForLuma += 1;
      continue;
    }
    // Step 2.
    if ((metrics.motion[i] as number) >= motionBar) continue;
    // Step 3 — keep scanning rather than accepting a blurred frame.
    if ((metrics.sharpness[i] as number) < sharpnessBar) {
      skippedForSharpness += 1;
      continue;
    }

    return {
      frame: i,
      reason: softStart > 0 ? 'settled-after-soft-start' : 'settled',
      skippedForLuma,
      skippedForSharpness,
    };
  }

  // Step 4 — nothing settled in time.
  return {
    frame: sharpestFrame,
    reason: 'sharpest-in-first-third',
    skippedForLuma,
    skippedForSharpness,
  };
}

/**
 * Where an out-frame lands by default. SPEC §6: run the settled scan backwards
 * from endFrame with the same guards, stopping 40% back into the shot.
 *
 * B is never created automatically in v1 (SPEC §6, §11) — the user adds it, and
 * this is where it goes when they do. It deliberately avoids the literal last
 * frame, which is so often motion-blurred, mid-gesture or already fading that
 * the user would have to fix it every single time.
 *
 * Clamped so B cannot land on or before A (I8).
 */
export function chooseOutFrame(
  shot: Shot,
  aFrame: number,
  metrics: FrameMetrics,
  settings: Settings,
): number {
  const { blackWhiteMargin, settledMotionFactor, settledMotionFloor, sharpnessFactor, scanLimitFraction } =
    settings.frameChoice;

  const length = shot.endFrame - shot.startFrame + 1;
  const floor = aFrame + 1;
  if (floor > shot.endFrame) return shot.endFrame;

  // SPEC §6 is explicit: "Do not default to the literal last frame." On real
  // footage the guards below usually push past it anyway, since the frames
  // before a cut tend to be blurred or already fading — but on clean material
  // the final frame passes every guard, so it is excluded outright. It remains
  // reachable by dragging; this is only where B starts.
  const scanFrom = Math.max(floor, shot.endFrame - 1);
  const scanTo = Math.max(floor, shot.endFrame - Math.max(1, Math.floor(length * scanLimitFraction)));

  const shotMotion: number[] = [];
  for (let i = shot.startFrame; i <= shot.endFrame; i += 1) shotMotion.push(metrics.motion[i] as number);
  const motionBar = Math.max(settledMotionFactor * medianOf(shotMotion), settledMotionFloor);

  // The mirror of the first-third sharpness bar: the peak across the last third.
  const lastThirdStart = Math.max(shot.startFrame, shot.endFrame - Math.max(1, Math.floor(length / 3)));
  let lastThirdPeakSharpness = 0;
  let sharpestFrame = scanFrom;
  for (let i = lastThirdStart; i <= scanFrom; i += 1) {
    const sharpness = metrics.sharpness[i] as number;
    if (sharpness > lastThirdPeakSharpness) {
      lastThirdPeakSharpness = sharpness;
      sharpestFrame = i;
    }
  }
  const sharpnessBar = sharpnessFactor * lastThirdPeakSharpness;

  for (let i = scanFrom; i >= scanTo; i -= 1) {
    if (isNearBlackOrWhite(metrics.luma[i] as number, blackWhiteMargin)) continue;
    if ((metrics.motion[i] as number) >= motionBar) continue;
    if ((metrics.sharpness[i] as number) < sharpnessBar) continue;
    return Math.max(floor, i);
  }

  return Math.max(floor, Math.min(shot.endFrame, sharpestFrame));
}

// ---------------------------------------------------------------------------

let shotCounter = 0;

function nextShotId(): string {
  shotCounter += 1;
  return `shot-${shotCounter}`;
}

/**
 * Build shots and their default picks from cached metrics.
 *
 * Existing picks marked `pinned` are carried through untouched (I6) — any frame
 * the user has touched survives re-detection. Pinned picks whose shot no longer
 * exists are re-homed onto whichever new shot contains their frame.
 */
export function detectShots(
  index: VideoIndex,
  metrics: FrameMetrics,
  settings: Settings,
  previousPicks: readonly Pick[] = [],
): DetectionResult {
  const started = Date.now();
  const { minShotFrames } = settings.detection;

  const thresholds = adaptiveHistogramThreshold(metrics.histogram, settings);

  // SPEC §9 — a clip shorter than minShotFrames is one shot, not an error.
  const tooShort = index.frameCount < minShotFrames;
  const rawCandidates = tooShort ? [] : findCandidates(metrics, thresholds, settings);
  const cuts = tooShort ? [] : collapseRuns(rawCandidates, minShotFrames);

  // Boundaries: the clip start, then each surviving cut.
  const shots: Shot[] = [];
  const starts = [0, ...cuts.map((cut) => cut.frame)];

  for (let i = 0; i < starts.length; i += 1) {
    const startFrame = starts[i] as number;
    const endFrame = i + 1 < starts.length ? (starts[i + 1] as number) - 1 : index.frameCount - 1;
    if (endFrame < startFrame) continue;

    // The first shot begins at the clip start, which is a certainty rather than
    // a detected cut — full confidence, and never marked soft.
    const cut = i === 0 ? null : (cuts[i - 1] as Candidate);

    shots.push({
      id: nextShotId(),
      startFrame,
      endFrame,
      confidence: cut ? cut.confidence : 1,
      boundary: cut ? cut.boundary : 'hard',
      rejected: false,
    });
  }

  // Choose a default A for every shot, then let pinned picks override.
  const choices: FrameChoice[] = [];
  const picks: Pick[] = [];

  for (const shot of shots) {
    const choice = chooseFrame(shot, metrics, settings);
    choices.push({ shotId: shot.id, ...choice });
    picks.push({
      id: nextPickId(),
      shotId: shot.id,
      frame: choice.frame,
      role: 'A',
      pinned: false,
    });
  }

  // I6 — user edits survive re-analysis. A pinned pick keeps its frame; it is
  // attached to whichever shot now contains that frame.
  for (const pinned of previousPicks) {
    if (!pinned.pinned) continue;

    const host = shots.find((shot) => pinned.frame >= shot.startFrame && pinned.frame <= shot.endFrame);
    if (!host) continue;

    if (pinned.role === 'A') {
      const existing = picks.findIndex((pick) => pick.shotId === host.id && pick.role === 'A');
      if (existing >= 0) picks[existing] = { ...pinned, shotId: host.id };
    } else {
      // I8 — at most one B per shot, and it must sit after A.
      const a = picks.find((pick) => pick.shotId === host.id && pick.role === 'A');
      const hasB = picks.some((pick) => pick.shotId === host.id && pick.role === 'B');
      if (a && !hasB && pinned.frame > a.frame) {
        picks.push({ ...pinned, shotId: host.id });
      }
    }
  }

  return {
    shots,
    picks,
    choices,
    adaptiveThreshold: thresholds,
    candidatesBeforeCollapse: rawCandidates.length,
    elapsedMs: Date.now() - started,
  };
}
