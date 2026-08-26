/**
 * The frame-choice rules from SPEC §6, shared between the main process and the
 * interface.
 *
 * These live in `shared` rather than beside detection because splitting a shot
 * in the interface has to choose a frame for the new half, and it has to do so
 * instantly — an IPC round trip per split would be felt. The metrics are handed
 * to the renderer once after analysis, so both sides run the identical rule
 * over the identical numbers.
 */

import type { FrameMetrics, Shot } from './types.js';
import type { Settings } from './settings.js';

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

/** Median of a numeric array. Does not mutate the input. */
export function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

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
