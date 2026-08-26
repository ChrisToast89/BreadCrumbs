import type { Settings } from './settings.js';

/**
 * BreadCrumbs — shared type surface.
 *
 * This module is the single source of truth for (a) the data model defined in
 * SPEC §4 and (b) the typed IPC contract between main and renderer. It is
 * imported by main, preload, renderer, and the `inspect` CLI alike, so it must
 * stay free of any runtime import from those layers.
 */

// ---------------------------------------------------------------------------
// Data model — SPEC §4
// ---------------------------------------------------------------------------

/** Immutable result of indexing. Written once, read everywhere. */
export interface VideoIndex {
  path: string;
  /** Storage dimensions, before rotation and SAR. */
  codedWidth: number;
  codedHeight: number;
  /** Dimensions as the frame should be displayed. See I5. */
  displayWidth: number;
  displayHeight: number;
  rotationDegrees: 0 | 90 | 180 | 270;
  sampleAspectRatio: number;
  /** Nominal only — for timecode display. Never for frame math. See I1. */
  fps: number;
  frameCount: number;
  durationSec: number;
  /**
   * Presentation time of every frame, in display order. See I1 — this table is
   * the ONLY frame<->time mapping in the application. Never derive a frame
   * number from `time * fps`, nor a time from `frame / fps`.
   */
  ptsList: Float64Array | number[];
  variableFrameRate: boolean;
  codec: string;
  /** BT.2020 / PQ / HLG detected — export must tonemap. */
  hdr: boolean;
}

/** Per-frame analysis, one entry per frame. Computed in a single pass. */
export interface FrameMetrics {
  /** Mean absolute luma delta vs previous frame, 0..1. Motion. */
  motion: Float32Array;
  /** L1 distance between consecutive luma histograms, 0..2. Content change. */
  histogram: Float32Array;
  /** Normalized Laplacian variance, 0..1. Focus and motion blur. */
  sharpness: Float32Array;
  /** Mean luma, 0..1. Fade and flash detection. */
  luma: Float32Array;
  /** ffmpeg scene score where reported, else 0. */
  scene: Float32Array;
}

export type ShotBoundary = 'hard' | 'soft';

export interface Shot {
  id: string;
  startFrame: number;
  /** Inclusive. */
  endFrame: number;
  /** 0..1, strength of the cut at `startFrame`. */
  confidence: number;
  /** `soft` = dissolve or fade. */
  boundary: ShotBoundary;
  /** Excluded from the board, still shown in the timeline. */
  rejected: boolean;
}

/** See I8 — a shot yields at most two picks, 'A' then 'B'. Never three. */
export type PickRole = 'A' | 'B';

export interface Pick {
  id: string;
  shotId: string;
  frame: number;
  /** 'A' is the shot's representative frame. 'B' is the out-frame. See I8. */
  role: PickRole;
  /** See I6 — a touched pick survives re-detection. */
  pinned: boolean;
}

/**
 * SPEC §4 lists `settings: Settings` on Project but never defines the shape.
 * It is defined in `settings.ts`, where every value is marked as either stated
 * by the spec or chosen here.
 */
export type { Settings };

export interface Project {
  version: 1;
  sourcePath: string;
  projectDir: string;
  proxyPath: string;
  index: VideoIndex;
  shots: Shot[];
  picks: Pick[];
  settings: Settings;
}

// ---------------------------------------------------------------------------
// IPC contract
// ---------------------------------------------------------------------------

/**
 * Every IPC channel, as a map of channel name -> { request, response }.
 * `ipcInvoke` in the preload is typed off this map, so adding a channel here
 * is the only step needed to make it callable and type-safe on both sides.
 */
export interface IpcContract {
  'app:info': {
    request: void;
    response: AppInfo;
  };
  /** Phase 1 — read a source file and build its VideoIndex. */
  'video:index': {
    request: { path: string };
    response: IpcResult<VideoIndex>;
  };
}

/**
 * Anything that can fail because of the user's file comes back as this rather
 * than as a thrown error. SPEC §9 requires a readable cause naming the file and
 * the problem — never a stack trace — and an envelope makes that the default
 * path instead of something each caller has to remember to format.
 */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; problem: string };

/** The three platforms SPEC §1 targets. */
export type Platform = 'win32' | 'darwin' | 'linux';

export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: Platform;
}

export type IpcChannel = keyof IpcContract;
export type IpcRequest<C extends IpcChannel> = IpcContract[C]['request'];
export type IpcResponse<C extends IpcChannel> = IpcContract[C]['response'];

/**
 * The surface exposed on `window.breadcrumbs` by the preload. The renderer has
 * no Node access (`contextIsolation: true`, `nodeIntegration: false`), so this
 * is its entire route to the filesystem and to ffmpeg.
 *
 * See I7 — all persistence goes through here to disk in the main process.
 * The renderer must never touch localStorage, sessionStorage, or IndexedDB.
 */
export interface BreadCrumbsApi {
  invoke<C extends IpcChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>>;
}
