/**
 * Locations of the bundled ffmpeg and ffprobe binaries (SPEC §2).
 *
 * In development these resolve inside node_modules. Once the app is packaged
 * they live outside the asar archive, which is the single most common
 * packaging failure (MILESTONES phase 8) — hence the explicit rewrite rather
 * than trusting the package's own resolution.
 */

import { existsSync } from 'node:fs';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

function unpacked(path: string): string {
  // Inside a packaged app the binaries are unpacked alongside the archive.
  const rewritten = path.replace('app.asar', 'app.asar.unpacked');
  return existsSync(rewritten) ? rewritten : path;
}

export const FFMPEG_PATH: string = unpacked(ffmpegStatic ?? '');
export const FFPROBE_PATH: string = unpacked(ffprobeStatic.path);

export function assertBinaries(): void {
  for (const [name, path] of [
    ['ffmpeg', FFMPEG_PATH],
    ['ffprobe', FFPROBE_PATH],
  ] as const) {
    if (!path || !existsSync(path)) {
      throw new Error(`Bundled ${name} is missing. Expected it at: ${path || '(unresolved)'}`);
    }
  }
}
