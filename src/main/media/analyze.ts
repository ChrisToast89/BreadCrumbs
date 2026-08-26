/**
 * Phase 3 — Analyze. Produces FrameMetrics for every frame plus a thumbnail for
 * every frame, from the proxy. SPEC §5, phase 3.
 *
 * Two decode passes over the proxy, and no more:
 *
 *   1. Metrics. The proxy is decoded once to raw 64x36 greyscale. Motion,
 *      histogram distance, sharpness and mean luma are computed from that
 *      buffer, and ffmpeg's own scene score is captured during the same pass by
 *      putting the `select` filter ahead of the downscale — so the scene score
 *      is measured at proxy resolution, not on the tiny greyscale.
 *   2. Thumbnails. A 160px-wide JPEG per frame, kept in memory as buffers.
 *
 * After this, the interface must never call ffmpeg again until export
 * (SPEC §5). Every scrub, drag and thumbnail read is an array index.
 *
 * Everything here reads the proxy, which is frame-aligned with the source by
 * I2, so metric index N and thumbnail N both describe source frame N.
 */

import { spawn } from 'node:child_process';
import type { FrameMetrics, VideoIndex } from '../../shared/types.js';
import { FFMPEG_PATH, assertBinaries } from './binaries.js';
import { MediaError } from './indexVideo.js';

/** Size of the greyscale buffer used for metrics. SPEC §5. */
const METRIC_WIDTH = 64;
const METRIC_HEIGHT = 36;
const METRIC_FRAME_BYTES = METRIC_WIDTH * METRIC_HEIGHT;

/** Width of the in-memory thumbnails. SPEC §5. */
const THUMBNAIL_WIDTH = 160;

/** Bins in the luma histogram used for the content-change signal. */
const HISTOGRAM_BINS = 64;

export interface AnalyzeResult {
  metrics: FrameMetrics;
  /** One JPEG per frame, in frame order. Held in memory (SPEC §5). */
  thumbnails: Buffer[];
  thumbnailWidth: number;
  thumbnailHeight: number;
  /** Total bytes of the thumbnail cache. */
  thumbnailBytes: number;
  metricsMs: number;
  thumbnailsMs: number;
}

export interface AnalyzeOptions {
  index: VideoIndex;
  proxyPath: string;
  projectDir: string;
  /** 0..1 across this phase only. */
  onProgress?: (fraction: number) => void;
}

// ---------------------------------------------------------------------------
// Pass 1 — metrics
// ---------------------------------------------------------------------------

/**
 * Per-frame accumulators, filled as raw greyscale frames stream in so that no
 * more than one frame is held at a time.
 */
class MetricAccumulator {
  readonly motion: Float32Array;
  readonly histogram: Float32Array;
  readonly sharpness: Float32Array;
  readonly luma: Float32Array;
  readonly scene: Float32Array;

  /** Raw Laplacian variance, normalised to 0..1 once the clip is known. */
  private readonly rawSharpness: Float32Array;
  private previousFrame: Uint8Array | null = null;
  private previousHistogram: Float32Array | null = null;
  private index = 0;

  constructor(private readonly frameCount: number) {
    this.motion = new Float32Array(frameCount);
    this.histogram = new Float32Array(frameCount);
    this.sharpness = new Float32Array(frameCount);
    this.luma = new Float32Array(frameCount);
    this.scene = new Float32Array(frameCount);
    this.rawSharpness = new Float32Array(frameCount);
  }

  get framesSeen(): number {
    return this.index;
  }

  push(frame: Uint8Array): void {
    const i = this.index;
    if (i >= this.frameCount) {
      // More frames than the index promised: record nothing and let the caller
      // fail the count check, rather than writing past the arrays.
      this.index += 1;
      return;
    }

    // --- mean luma, 0..1. Fade and flash detection (SPEC §4).
    let sum = 0;
    for (let p = 0; p < frame.length; p += 1) sum += frame[p] as number;
    this.luma[i] = sum / frame.length / 255;

    // --- motion: mean absolute luma delta against the previous frame, 0..1.
    if (this.previousFrame === null) {
      this.motion[i] = 0;
    } else {
      let delta = 0;
      for (let p = 0; p < frame.length; p += 1) {
        delta += Math.abs((frame[p] as number) - (this.previousFrame[p] as number));
      }
      this.motion[i] = delta / frame.length / 255;
    }

    // --- histogram: L1 distance between consecutive luma histograms, 0..2.
    const histogram = new Float32Array(HISTOGRAM_BINS);
    const binScale = HISTOGRAM_BINS / 256;
    for (let p = 0; p < frame.length; p += 1) {
      const bin = Math.min(HISTOGRAM_BINS - 1, ((frame[p] as number) * binScale) | 0);
      histogram[bin] = (histogram[bin] as number) + 1;
    }
    for (let b = 0; b < HISTOGRAM_BINS; b += 1) {
      histogram[b] = (histogram[b] as number) / frame.length;
    }
    if (this.previousHistogram === null) {
      this.histogram[i] = 0;
    } else {
      let distance = 0;
      for (let b = 0; b < HISTOGRAM_BINS; b += 1) {
        distance += Math.abs((histogram[b] as number) - (this.previousHistogram[b] as number));
      }
      this.histogram[i] = distance;
    }
    this.previousHistogram = histogram;

    // --- sharpness: variance of the Laplacian response. Focus and motion blur.
    this.rawSharpness[i] = laplacianVariance(frame, METRIC_WIDTH, METRIC_HEIGHT);

    // Keep a copy: the incoming buffer is reused by the reader.
    this.previousFrame = frame.slice();
    this.index += 1;
  }

  /**
   * Finish up. Sharpness is scaled against the sharpest frame in this clip,
   * which is what SPEC §6 compares against anyway — every use of it is a ratio
   * within a shot, never an absolute threshold.
   */
  finish(): FrameMetrics {
    let peak = 0;
    for (let i = 0; i < this.rawSharpness.length; i += 1) {
      const value = this.rawSharpness[i] as number;
      if (value > peak) peak = value;
    }
    if (peak > 0) {
      for (let i = 0; i < this.rawSharpness.length; i += 1) {
        this.sharpness[i] = (this.rawSharpness[i] as number) / peak;
      }
    }

    return {
      motion: this.motion,
      histogram: this.histogram,
      sharpness: this.sharpness,
      luma: this.luma,
      scene: this.scene,
    };
  }
}

/** Variance of the 3x3 Laplacian response over a greyscale buffer. */
function laplacianVariance(frame: Uint8Array, width: number, height: number): number {
  let sum = 0;
  let sumSquares = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const offset = y * width + x;
      const response =
        4 * (frame[offset] as number) -
        (frame[offset - 1] as number) -
        (frame[offset + 1] as number) -
        (frame[offset - width] as number) -
        (frame[offset + width] as number);
      sum += response;
      sumSquares += response * response;
      count += 1;
    }
  }

  if (count === 0) return 0;
  const mean = sum / count;
  return sumSquares / count - mean * mean;
}

/**
 * Pull ffmpeg's scene scores out of the text it printed during the metrics
 * pass. Frames with no reported score stay at 0 (SPEC §4).
 */
function readSceneScores(text: string, target: Float32Array): number {
  // The output is a run of blocks, each a "frame:N ..." line followed by
  // "lavfi.scene_score=0.123".
  const pattern = /lavfi\.scene_score=([0-9.eE+-]+)/g;
  let index = 0;
  let match = pattern.exec(text);
  while (match !== null && index < target.length) {
    const value = Number(match[1]);
    target[index] = Number.isFinite(value) ? value : 0;
    index += 1;
    match = pattern.exec(text);
  }
  return index;
}

interface MetricsPassResult {
  accumulator: MetricAccumulator;
  /** Everything ffmpeg printed, including the per-frame scene scores. */
  log: string;
}

function runMetricsPass(options: AnalyzeOptions): Promise<MetricsPassResult> {
  const { index, proxyPath } = options;
  const accumulator = new MetricAccumulator(index.frameCount);

  // The scene score is computed by `select` before the downscale, so it sees
  // proxy resolution. Passing `gte(scene,-1)` lets every frame through while
  // still causing the score to be evaluated and printed (SPEC §6).
  //
  // `metadata=print` with no destination writes to ffmpeg's error channel,
  // which is what we want: the raw frames already own stdout. Naming a file
  // instead would mean surviving ffmpeg's filter-graph escaping on top of
  // Windows drive letters, and an explicit `pipe:2` is rejected outright.
  const filter =
    `select='gte(scene\\,-1)',metadata=print,` +
    `scale=${METRIC_WIDTH}:${METRIC_HEIGHT}:flags=bilinear,format=gray`;

  const args = [
    '-hide_banner',
    '-nostdin',
    '-i',
    proxyPath,
    '-an',
    '-sn',
    '-dn',
    // I2 again — one frame in, one frame out, so metric N stays frame N.
    '-fps_mode',
    'passthrough',
    '-nostats',
    '-vf',
    filter,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    'pipe:1',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, args, { windowsHide: true });
    let stderr = '';

    // Frames arrive as a byte stream with no boundaries, so they are
    // reassembled here into fixed-size frames.
    let carry: Buffer = Buffer.alloc(0);
    const frame = new Uint8Array(METRIC_FRAME_BYTES);

    child.stdout.on('data', (chunk: Buffer) => {
      let buffer = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      let offset = 0;

      while (buffer.length - offset >= METRIC_FRAME_BYTES) {
        frame.set(buffer.subarray(offset, offset + METRIC_FRAME_BYTES));
        accumulator.push(frame);
        offset += METRIC_FRAME_BYTES;

        if (index.frameCount > 0) {
          options.onProgress?.(Math.min(1, accumulator.framesSeen / index.frameCount));
        }
      }

      carry = offset > 0 ? Buffer.from(buffer.subarray(offset)) : buffer;
      buffer = Buffer.alloc(0);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ accumulator, log: stderr });
        return;
      }
      const detail = stderr.trim().split('\n').slice(-3).join(' ');
      reject(new MediaError(proxyPath, `the clip could not be analysed — ${detail || `ffmpeg exit ${code}`}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Pass 2 — thumbnails
// ---------------------------------------------------------------------------

const JPEG_START = 0xffd8;
const JPEG_END = 0xffd9;

/**
 * Decode the proxy again, emitting one JPEG per frame down a pipe, and split
 * the stream back into individual images.
 */
function runThumbnailPass(options: AnalyzeOptions): Promise<Buffer[]> {
  const { index, proxyPath } = options;

  const args = [
    '-hide_banner',
    '-nostdin',
    '-i',
    proxyPath,
    '-an',
    '-sn',
    '-dn',
    '-fps_mode',
    'passthrough',
    '-vf',
    `scale=${THUMBNAIL_WIDTH}:-2:flags=bilinear`,
    '-q:v',
    '6',
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    'pipe:1',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, args, { windowsHide: true });
    const thumbnails: Buffer[] = [];
    let stderr = '';
    let buffer: Buffer = Buffer.alloc(0);

    child.stdout.on('data', (chunk: Buffer) => {
      buffer = buffer.length > 0 ? Buffer.concat([buffer, chunk]) : chunk;

      // Images are delimited by the JPEG start and end markers. Scan for a
      // complete pair and cut it out.
      let start = 0;
      for (;;) {
        if (buffer.length - start < 4) break;
        if (buffer.readUInt16BE(start) !== JPEG_START) break;

        let end = -1;
        for (let p = start + 2; p < buffer.length - 1; p += 1) {
          if (buffer.readUInt16BE(p) === JPEG_END) {
            end = p + 2;
            break;
          }
        }
        if (end === -1) break;

        thumbnails.push(Buffer.from(buffer.subarray(start, end)));
        start = end;

        if (index.frameCount > 0) {
          options.onProgress?.(Math.min(1, thumbnails.length / index.frameCount));
        }
      }

      if (start > 0) buffer = Buffer.from(buffer.subarray(start));
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(thumbnails);
        return;
      }
      const detail = stderr.trim().split('\n').slice(-3).join(' ');
      reject(
        new MediaError(proxyPath, `thumbnails could not be built — ${detail || `ffmpeg exit ${code}`}`),
      );
    });
  });
}

// ---------------------------------------------------------------------------

export async function analyze(options: AnalyzeOptions): Promise<AnalyzeResult> {
  assertBinaries();

  const { index } = options;

  // The two passes each cover half of this phase's progress.
  const metricsStarted = Date.now();
  const { accumulator, log } = await runMetricsPass({
    ...options,
    onProgress: (fraction) => options.onProgress?.(fraction * 0.5),
  });
  const metricsMs = Date.now() - metricsStarted;

  if (accumulator.framesSeen !== index.frameCount) {
    throw new MediaError(
      index.path,
      `analysis saw ${accumulator.framesSeen} frames but the clip has ${index.frameCount}. ` +
        'Frame numbers would not line up, so analysis has been stopped.',
    );
  }

  const metrics = accumulator.finish();
  readSceneScores(log, metrics.scene);

  const thumbnailsStarted = Date.now();
  const thumbnails = await runThumbnailPass({
    ...options,
    onProgress: (fraction) => options.onProgress?.(0.5 + fraction * 0.5),
  });
  const thumbnailsMs = Date.now() - thumbnailsStarted;

  if (thumbnails.length !== index.frameCount) {
    throw new MediaError(
      index.path,
      `built ${thumbnails.length} thumbnails but the clip has ${index.frameCount} frames.`,
    );
  }

  const thumbnailHeight = Math.max(
    2,
    Math.round((THUMBNAIL_WIDTH * index.displayHeight) / index.displayWidth / 2) * 2,
  );
  const thumbnailBytes = thumbnails.reduce((total, buffer) => total + buffer.length, 0);

  options.onProgress?.(1);

  return {
    metrics,
    thumbnails,
    thumbnailWidth: THUMBNAIL_WIDTH,
    thumbnailHeight,
    thumbnailBytes,
    metricsMs,
    thumbnailsMs,
  };
}
