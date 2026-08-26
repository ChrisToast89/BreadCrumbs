/**
 * Phase 7 — Export. SPEC §8.
 *
 * I3 — this reads the ORIGINAL file. Never the proxy. The proxy is 480p and
 * re-encoded; it exists for scrubbing and analysis only.
 *
 * I4 — one decode pass, with a single compound select expression naming every
 * wanted frame. Seeking per frame turns a 40-frame board from seconds into
 * minutes on long-GOP sources, which is most sources.
 *
 * I5 — display geometry is applied here as it is everywhere else. ffmpeg
 * rotates on decode by default, so rotation needs nothing; a non-square pixel
 * aspect does need a scale, and is the only reason to add one. Scaling a
 * square-pixel source would resample it for no reason and would stop the
 * output being pixel-identical to the frame ffmpeg would hand you directly.
 */

import { spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { VideoIndex } from '../../shared/types.js';
import type { ExportEntry } from '../../shared/exportPattern.js';
import { manifestCsv } from '../../shared/exportPattern.js';
import { FFMPEG_PATH, assertBinaries } from './binaries.js';
import { MediaError } from './indexVideo.js';

export interface ExportOptions {
  index: VideoIndex;
  entries: readonly ExportEntry[];
  outputDir: string;
  format: 'png' | 'jpeg';
  /** 1..100, JPEG only. */
  quality: number;
  /** Overwrite files that already exist. Callers must have asked first. */
  overwrite: boolean;
  onProgress?: (written: number, total: number) => void;
}

export interface ExportResult {
  written: string[];
  manifestPath: string;
  /** The exact ffmpeg argument list used, so the single pass can be verified. */
  command: string[];
  elapsedMs: number;
  /** Files that already existed, when `overwrite` is false. */
  collisions: string[];
}

/**
 * The compound select expression from SPEC §8 / I4:
 * `select='eq(n\,12)+eq(n\,40)+eq(n\,97)'`
 *
 * Every distinct frame appears once; a frame wanted twice (A of one shot and B
 * of another cannot overlap, but a pattern could still ask twice) is written
 * once and copied afterwards.
 */
export function selectExpression(frames: readonly number[]): string {
  return frames.map((frame) => `eq(n\\,${frame})`).join('+');
}

/**
 * Build the filter chain. Order matters: select first so the scale only ever
 * runs on frames being kept.
 */
export function filterChain(index: VideoIndex, frames: readonly number[]): string {
  const parts = [`select='${selectExpression(frames)}'`];

  // I5 — non-square pixels are corrected to the display shape. Rotation is
  // already handled by ffmpeg's decode-side auto-rotation, and the display
  // dimensions in the index account for both.
  if (Math.abs(index.sampleAspectRatio - 1) > 0.001) {
    parts.push(`scale=${index.displayWidth}:${index.displayHeight}`, 'setsar=1');
  }

  // SPEC §8 — tonemap when the source is HDR, or every export comes out washed
  // out and flat.
  if (index.hdr) {
    parts.push(
      'zscale=t=linear:npl=100',
      'tonemap=tonemap=hable:desat=0',
      'zscale=p=bt709:t=bt709:m=bt709:r=tv',
      'format=yuv420p',
    );
  }

  return parts.join(',');
}

/** Extract every wanted frame in one pass, into a temporary numbered set. */
function extract(
  source: string,
  index: VideoIndex,
  frames: readonly number[],
  stagingDir: string,
  format: 'png' | 'jpeg',
  quality: number,
): { command: string[]; done: Promise<void> } {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    // I3 — the original file.
    '-i',
    source,
    '-an',
    '-sn',
    '-dn',
    '-vf',
    filterChain(index, frames),
    // Write exactly the frames the filter passed, with no duplication or
    // dropping, so output N is the Nth wanted frame.
    '-fps_mode',
    'passthrough',
    ...(format === 'png'
      ? ['-c:v', 'png']
      : ['-c:v', 'mjpeg', '-q:v', String(jpegQualityScale(quality)), '-pix_fmt', 'yuvj420p']),
    join(stagingDir, `frame_%05d.${format === 'png' ? 'png' : 'jpg'}`),
  ];

  const done = new Promise<void>((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, args, { windowsHide: true });
    let stderr = '';

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim().split('\n').slice(-3).join(' ');
      reject(new MediaError(source, `the frames could not be exported — ${detail || `ffmpeg exit ${code}`}`));
    });
  });

  return { command: [FFMPEG_PATH, ...args], done };
}

/** ffmpeg's mjpeg quality runs 2 (best) to 31 (worst); the UI speaks 1..100. */
function jpegQualityScale(quality: number): number {
  const clamped = Math.max(1, Math.min(100, quality));
  return Math.round(31 - (clamped / 100) * 29);
}

export async function exportFrames(options: ExportOptions): Promise<ExportResult> {
  assertBinaries();

  const { index, entries, outputDir, format, quality, overwrite } = options;
  const started = Date.now();

  if (entries.length === 0) {
    throw new MediaError(index.path, 'there are no frames to export.');
  }

  // SPEC §9 — the source can have moved since analysis.
  if (!existsSync(index.path)) {
    throw new MediaError(index.path, 'the original file is no longer where it was. Locate it and try again.');
  }

  await mkdir(outputDir, { recursive: true });

  // Existing files are the caller's decision to make, not ours.
  const collisions = entries
    .map((entry) => entry.filename)
    .filter((filename) => existsSync(join(outputDir, filename)));
  if (collisions.length > 0 && !overwrite) {
    return {
      written: [],
      manifestPath: '',
      command: [],
      elapsedMs: Date.now() - started,
      collisions,
    };
  }

  // One pass over the distinct frames, in ascending order — which is the order
  // a single forward decode will produce them in.
  const frames = [...new Set(entries.map((entry) => entry.frame))].sort((a, b) => a - b);

  const stagingDir = join(outputDir, `.breadcrumbs-staging-${process.pid}`);
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  let command: string[] = [];
  try {
    const run = extract(index.path, index, frames, stagingDir, format, quality);
    command = run.command;
    await run.done;

    const staged = (await readdir(stagingDir)).filter((name) => name.startsWith('frame_')).sort();

    if (staged.length !== frames.length) {
      throw new MediaError(
        index.path,
        `asked for ${frames.length} frames but ffmpeg produced ${staged.length}. Nothing has been written.`,
      );
    }

    // Staged file i is frame[i], because the pass is forward and ordered.
    const byFrame = new Map<number, string>();
    frames.forEach((frame, position) => byFrame.set(frame, staged[position] as string));

    const written: string[] = [];
    /** Frames already placed, so a frame wanted twice is copied, not re-decoded. */
    const placed = new Map<number, string>();

    for (const entry of entries) {
      const stagedName = byFrame.get(entry.frame);
      if (!stagedName) continue;

      const destination = join(outputDir, entry.filename);
      await rm(destination, { force: true });

      const alreadyPlaced = placed.get(entry.frame);
      if (alreadyPlaced === undefined) {
        await rename(join(stagingDir, stagedName), destination);
        placed.set(entry.frame, entry.filename);
      } else {
        await copyFile(join(outputDir, alreadyPlaced), destination);
      }

      written.push(entry.filename);
      options.onProgress?.(written.length, entries.length);
    }

    // SPEC §8 — the manifest sits alongside the images.
    const manifestPath = join(outputDir, 'manifest.csv');
    await writeFile(manifestPath, manifestCsv(entries), 'utf8');

    return { written, manifestPath, command, elapsedMs: Date.now() - started, collisions: [] };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

/** Bytes on disk for a written file, for the inspect report. */
export async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
