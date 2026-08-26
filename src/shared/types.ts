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
  /**
   * A clip named by the BREADCRUMBS_OPEN environment variable, to be loaded on
   * startup. Development only: it exists so the interface can be driven and
   * screenshotted without a human clicking through a native file dialog, in
   * the same spirit as the inspect CLI. Null in normal use.
   */
  'app:startupPath': {
    request: void;
    response: string | null;
  };
  /** Open the system file picker. Null when the user cancels. */
  'project:choose': {
    request: void;
    response: string | null;
  };
  /**
   * Run the whole analysis (SPEC §5) and hand back everything the interface
   * needs. Progress arrives separately on the 'pipeline:progress' event.
   */
  'project:analyze': {
    request: { path: string };
    response: IpcResult<AnalyzedProject>;
  };
  /** Pick a folder to export into. Null when the user cancels. */
  'export:chooseFolder': {
    request: { current: string | null };
    response: string | null;
  };
  /**
   * Write the frames. The renderer sends the plan it previewed, so the names
   * on screen and the names on disk come from one calculation.
   */
  'export:run': {
    request: ExportRequest;
    response: IpcResult<ExportOutcome>;
  };
  /** Show the exported folder in the system file manager (SPEC §8). */
  'export:reveal': {
    request: { path: string };
    response: void;
  };
}

export interface ExportRequest {
  sourcePath: string;
  outputDir: string;
  format: 'png' | 'jpeg';
  quality: number;
  overwrite: boolean;
  /** Exactly what to write, as previewed. */
  entries: ExportPlanEntry[];
}

/** The subset of an export entry that has to cross IPC. */
export interface ExportPlanEntry {
  index: number;
  shotNumber: number;
  shotId: string;
  frame: number;
  ab: '' | 'A' | 'B';
  role: '' | 'A' | 'B';
  timecode: string;
  seconds: number;
  shotStartFrame: number;
  shotEndFrame: number;
  shotDurationFrames: number;
  confidence: number;
  filename: string;
}

export interface ExportOutcome {
  written: string[];
  manifestPath: string;
  outputDir: string;
  elapsedMs: number;
  /** Non-empty when files already existed and overwrite was not granted. */
  collisions: string[];
}

/**
 * Everything the renderer needs after analysis. Sent once; after this the
 * interface never calls ffmpeg again until export (SPEC §5).
 */
export interface AnalyzedProject {
  sourcePath: string;
  sourceName: string;
  projectDir: string;
  /** Custom-protocol URL for the proxy, playable by a <video> element. */
  proxyUrl: string;
  proxyWidth: number;
  proxyHeight: number;
  index: VideoIndex;
  shots: Shot[];
  picks: Pick[];
  settings: Settings;
  /**
   * The per-frame measurements. Sent so the interface can apply the SPEC §6
   * frame rule itself when a split creates a shot that needs a frame chosen —
   * an IPC round trip per edit would be felt. Five arrays of frameCount
   * floats: about 72KB for a two-minute clip.
   */
  metrics: FrameMetrics;
  /**
   * All thumbnails concatenated, with a byte offset per frame. One transfer
   * instead of thousands: the renderer slices this into blob URLs once and
   * then every thumbnail read is an array index (SPEC §5).
   */
  thumbnails: {
    data: ArrayBuffer;
    /** offsets[n] .. offsets[n + 1] is frame n's JPEG. Length frameCount + 1. */
    offsets: number[];
    width: number;
    height: number;
  };
  elapsedMs: number;
}

/** Main-to-renderer events. Progress cannot be a response — it arrives during. */
export interface IpcEvents {
  'pipeline:progress': PipelineProgressEvent;
  'export:progress': { written: number; total: number };
}

export type PipelineStepName = 'index' | 'proxy' | 'analyze' | 'detect';
export type PipelineStepState = 'pending' | 'running' | 'done';

export interface PipelineProgressEvent {
  overall: number;
  step: PipelineStepName;
  stepFraction: number | null;
  states: Record<PipelineStepName, PipelineStepState>;
}

export type IpcEventName = keyof IpcEvents;

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
  /** Subscribe to a main-process event. Returns an unsubscribe function. */
  on<E extends IpcEventName>(event: E, listener: (payload: IpcEvents[E]) => void): () => void;
  /**
   * The real filesystem path of a dropped File. Electron stopped exposing
   * `File.path` to isolated renderers, so this goes through the preload.
   * Returns an empty string for anything without a path on disk.
   */
  pathForFile(file: File): string;
}
