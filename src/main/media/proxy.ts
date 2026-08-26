/**
 * Phase 2 — Proxy. A small, all-intra copy of the clip used for scrubbing and
 * analysis. SPEC §5, phase 2.
 *
 * I2 — proxy frame N must be source frame N. That is what `-fps_mode
 * passthrough` guarantees: every decoded frame is written once, none dropped,
 * none duplicated. Never `-r`, never `-vsync cfr`. If this is broken, every
 * handle in the interface silently points at a different frame than the one the
 * preview is showing, and nothing else in the application can be trusted.
 *
 * I3 — this file is for looking at, never for exporting from. It is 480p and
 * re-encoded. Export reads the original.
 *
 * I5 — rotation and pixel aspect are baked in here, once, from the values
 * resolved during indexing. ffmpeg rotates automatically on decode; scaling to
 * the already-corrected display size applies the pixel aspect at the same time.
 * The result carries square pixels and no rotation flag, so every later stage
 * can treat it as plain upright video.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { VideoIndex } from '../../shared/types.js';
import { FFMPEG_PATH, FFPROBE_PATH, assertBinaries } from './binaries.js';
import { MediaError } from './indexVideo.js';
import { runOrThrow } from './run.js';

/** Vertical resolution of the proxy. "480p" per SPEC §5. */
const PROXY_HEIGHT = 480;

export interface ProxyResult {
  path: string;
  /** Pixel size of the proxy, already upright and square-pixelled. */
  width: number;
  height: number;
  /** Frames counted in the finished proxy. Must equal index.frameCount (I2). */
  frameCount: number;
  bytes: number;
  elapsedMs: number;
  /** True when an existing proxy was reused rather than encoded. */
  reused: boolean;
}

/** Written next to the proxy so a later run can tell whether it is still valid. */
interface ProxySidecar {
  version: 1;
  sourcePath: string;
  sourceBytes: number;
  sourceModifiedMs: number;
  frameCount: number;
  width: number;
  height: number;
}

export interface BuildProxyOptions {
  index: VideoIndex;
  /** Folder for this clip's generated files. Created if absent. */
  projectDir: string;
  /** 0..1 across this phase only. Called roughly once per encoded second. */
  onProgress?: (fraction: number, framesDone: number) => void;
  /** Encode even if a valid cached proxy exists. */
  force?: boolean;
}

/**
 * A stable folder name for one source file. Includes size and modification time
 * so that replacing a file with a different one under the same name does not
 * quietly reuse the old proxy.
 */
export function projectKey(sourcePath: string, bytes: number, modifiedMs: number): string {
  return createHash('sha1').update(`${sourcePath}:${bytes}:${modifiedMs}`).digest('hex').slice(0, 16);
}

/**
 * Proxy pixel size: 480 lines tall, keeping the corrected display shape, never
 * upscaled beyond the source. Both dimensions are forced even, which H.264
 * requires.
 */
export function proxySize(index: VideoIndex): { width: number; height: number } {
  const targetHeight = Math.min(PROXY_HEIGHT, index.displayHeight);
  const scale = targetHeight / index.displayHeight;
  const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
  return { width: even(index.displayWidth * scale), height: even(targetHeight) };
}

/** Count frames in a finished file the same way indexing does — packet timestamps. */
async function countProxyFrames(file: string): Promise<number> {
  const { stdout } = await runOrThrow(
    FFPROBE_PATH,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file],
    'Counting proxy frames',
  );
  return stdout.split('\n').filter((line) => line.trim() !== '').length;
}

async function readSidecar(path: string): Promise<ProxySidecar | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as ProxySidecar;
  } catch {
    return null;
  }
}

/**
 * Encode the proxy, reporting progress from ffmpeg's own frame counter.
 * Resolves with the number of frames ffmpeg says it wrote.
 */
function encode(source: string, destination: string, index: VideoIndex, options: BuildProxyOptions): Promise<void> {
  const { width, height } = proxySize(index);

  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    source,
    // Video only. Audio is out of scope for v1 (SPEC §11).
    '-an',
    '-sn',
    '-dn',
    // I2 — one frame in, one frame out. The single most important flag here.
    '-fps_mode',
    'passthrough',
    // I5 — bake in the corrected display size and drop the pixel-aspect flag.
    '-vf',
    `scale=${width}:${height}:flags=bicubic,setsar=1`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    // All-intra: every frame is a keyframe, so seeking lands exactly with no
    // decode backtrack (SPEC §2, preview scrubbing).
    '-g',
    '1',
    '-keyint_min',
    '1',
    '-sc_threshold',
    '0',
    '-x264-params',
    'keyint=1:min-keyint=1:scenecut=0',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    destination,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, args, { windowsHide: true });
    let stderr = '';
    let pending = '';

    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';

      for (const line of lines) {
        const match = /^frame=(\d+)/.exec(line.trim());
        if (!match) continue;
        const framesDone = Number(match[1]);
        const fraction = index.frameCount > 0 ? Math.min(1, framesDone / index.frameCount) : 0;
        options.onProgress?.(fraction, framesDone);
      }
    });

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
      reject(new MediaError(source, `the preview copy could not be created — ${detail || `ffmpeg exit ${code}`}`));
    });
  });
}

export async function buildProxy(options: BuildProxyOptions): Promise<ProxyResult> {
  assertBinaries();

  const { index, projectDir } = options;
  const source = index.path;
  const started = Date.now();

  const sourceStat = await stat(source);
  await mkdir(projectDir, { recursive: true });

  const proxyPath = join(projectDir, 'proxy.mp4');
  const sidecarPath = join(projectDir, 'proxy.json');
  const { width, height } = proxySize(index);

  // Reuse a cached proxy when it was built from this exact source and still has
  // the right number of frames.
  if (!options.force && existsSync(proxyPath)) {
    const sidecar = await readSidecar(sidecarPath);
    const matches =
      sidecar !== null &&
      sidecar.version === 1 &&
      sidecar.sourcePath === source &&
      sidecar.sourceBytes === sourceStat.size &&
      sidecar.sourceModifiedMs === Math.round(sourceStat.mtimeMs) &&
      sidecar.frameCount === index.frameCount;

    if (matches) {
      // A cached proxy can be damaged — a previous run killed mid-encode, or
      // the file was touched. Treat anything unreadable as a cache miss and
      // encode again rather than surfacing it as a failure.
      const frameCount = await countProxyFrames(proxyPath).catch(() => -1);
      if (frameCount === index.frameCount) {
        options.onProgress?.(1, frameCount);
        return {
          path: proxyPath,
          width: sidecar.width,
          height: sidecar.height,
          frameCount,
          bytes: (await stat(proxyPath)).size,
          elapsedMs: Date.now() - started,
          reused: true,
        };
      }
    }
  }

  await encode(source, proxyPath, index, options);

  const frameCount = await countProxyFrames(proxyPath);

  // I2 — if this does not hold, everything downstream points at the wrong
  // frames. Fail loudly here rather than exporting the wrong stills later.
  if (frameCount !== index.frameCount) {
    throw new MediaError(
      source,
      `the preview copy has ${frameCount} frames but the original has ${index.frameCount}. ` +
        'Frame numbers would not line up, so analysis has been stopped.',
    );
  }

  const sidecar: ProxySidecar = {
    version: 1,
    sourcePath: source,
    sourceBytes: sourceStat.size,
    sourceModifiedMs: Math.round(sourceStat.mtimeMs),
    frameCount,
    width,
    height,
  };
  await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf8');

  options.onProgress?.(1, frameCount);

  return {
    path: proxyPath,
    width,
    height,
    frameCount,
    bytes: (await stat(proxyPath)).size,
    elapsedMs: Date.now() - started,
    reused: false,
  };
}

/** Folder name for a source file, used by both the app and the inspect CLI. */
export async function projectDirFor(root: string, sourcePath: string): Promise<string> {
  const sourceStat = await stat(sourcePath);
  const key = projectKey(sourcePath, sourceStat.size, Math.round(sourceStat.mtimeMs));
  const label = basename(sourcePath).replace(/[^\w.-]+/g, '_').slice(0, 40);
  return join(root, `${label}-${key}`);
}
