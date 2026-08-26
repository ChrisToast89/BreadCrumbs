/**
 * Settings — the tuning values behind detection and export.
 *
 * SPEC §4 lists `settings: Settings` on Project but never defines the shape,
 * and SPEC §6 names several rules without giving their constants. Every value
 * below is marked with where it comes from:
 *
 *   [spec]     stated outright in SPEC §6 or §8. Do not change without changing
 *              the spec — the build plan asks for these rules implemented
 *              literally.
 *   [chosen]   the spec names the rule but not the number. These are the ones
 *              worth a second opinion.
 *
 * There is deliberately no global sensitivity control in the interface
 * (SPEC §7) — re-rolling detection destroys work the user has already done.
 * These are defaults for a run, not a slider.
 */

export interface DetectionSettings {
  /**
   * [chosen] Shortest run of frames treated as its own shot. Candidate cuts
   * closer together than this collapse to the strongest one (SPEC §6), and a
   * clip shorter than this is a single shot (SPEC §9).
   *
   * 12 frames is roughly half a second at 24fps. Low enough for a fast cutting
   * rhythm, high enough that a flash or a two-frame glitch cannot split a shot.
   */
  minShotFrames: number;

  /** [spec] SPEC §6: `ffmpeg select='gt(scene,0.08)'`. A fixed bar. */
  sceneThreshold: number;

  /** [spec] SPEC §6: rolling median and MAD over a +/-45 frame window. */
  histogramWindow: number;

  /**
   * [chosen] The `k` in "rolling median + k x MAD" (SPEC §6). 5 is a
   * conventional outlier bar. SPEC §6 asks to over-detect slightly, since a
   * false cut costs one keystroke and a missed cut costs a hunt.
   */
  histogramMadK: number;

  /**
   * [chosen] Absolute floor under the adaptive histogram bar.
   *
   * Not in the spec, and added deliberately: across a long quiet stretch the
   * median and MAD both fall to near zero, and without a floor the adaptive bar
   * would sit at almost nothing and call every faint flicker a cut. The motion
   * floor below is the spec's own guard against this; the two together are what
   * keep a static section from shattering.
   */
  histogramFloor: number;

  /**
   * [chosen] SPEC §6 requires that "motion also exceeds a floor" for a
   * histogram-driven candidate, without naming it. 0.01 is a 1% mean luma
   * change frame to frame — above sensor noise, below any real movement.
   */
  motionFloor: number;

  /** [spec] SPEC §6: a dissolve is a plateau across the preceding 8 frames. */
  dissolveWindow: number;

  /**
   * [chosen] What counts as "elevated" among those 8 frames, as a fraction of
   * the candidate cut's own height, and how many of them must be elevated for
   * the boundary to be called soft. SPEC §6 says "most", read here as 5 of 8.
   */
  dissolveElevatedFraction: number;
  dissolveElevatedCount: number;
}

export interface FrameChoiceSettings {
  /** [spec] SPEC §6 step 1: skip frames within 5% of pure black or pure white. */
  blackWhiteMargin: number;

  /** [spec] SPEC §6 step 2: motion below max(0.35 x shot median, 0.02). */
  settledMotionFactor: number;
  settledMotionFloor: number;

  /** [spec] SPEC §6 step 3: sharpness at least 0.6 x the first third's peak. */
  sharpnessFactor: number;

  /** [spec] SPEC §6 step 4: stop searching 40% into the shot. */
  scanLimitFraction: number;

  /** [spec] SPEC §6 step 5: for a soft boundary, start a third of the way in. */
  softStartFraction: number;
}

export interface ExportSettings {
  /** [spec] SPEC §8 default pattern. */
  pattern: string;
  format: 'png' | 'jpeg';
  /** [chosen] JPEG quality when format is jpeg. SPEC §8 requires a control. */
  jpegQuality: number;
}

export interface Settings {
  detection: DetectionSettings;
  frameChoice: FrameChoiceSettings;
  export: ExportSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  detection: {
    minShotFrames: 12,
    sceneThreshold: 0.08,
    histogramWindow: 45,
    histogramMadK: 5,
    histogramFloor: 0.08,
    motionFloor: 0.01,
    dissolveWindow: 8,
    dissolveElevatedFraction: 0.5,
    dissolveElevatedCount: 5,
  },
  frameChoice: {
    blackWhiteMargin: 0.05,
    settledMotionFactor: 0.35,
    settledMotionFloor: 0.02,
    sharpnessFactor: 0.6,
    scanLimitFraction: 0.4,
    softStartFraction: 1 / 3,
  },
  export: {
    pattern: '{name}_shot{shot:03}{ab}_{tc}',
    format: 'png',
    jpegQuality: 90,
  },
};
