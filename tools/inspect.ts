/**
 * `npm run inspect -- <file>` — the headless debug CLI.
 *
 * MILESTONES.md, "Ground rule: build the headless path first": a coding agent
 * cannot click a carrot, so every phase before the UI has to be verifiable from
 * the terminal. Each phase adds a reporter to the list below; the reporters are
 * permanent debugging aids, not scaffolding to be deleted later.
 *
 * With no file argument, runs against every clip in `fixtures/`.
 *
 *   Reporter        Added in   Reports
 *   ------------    --------   --------------------------------------------
 *   file            phase 0    Path, size, container, readability
 *   index           phase 1    Dimensions, rotation, SAR, fps, frame count,
 *                              VFR/HDR flags, first and last 5 PTS values
 *   proxy           phase 2    Proxy path, size, encode duration, frame-count
 *                              equality with the source
 *   metrics         phase 3    Min/max/mean per signal, plus a PNG plot
 *   detect          phase 4    Shot table, chosen frame per shot and why
 *   export          phase 6/7  Dry run — the filenames that would be written
 *
 * Flags:
 *   --verify   Cross-check results against an independent ffprobe call. Slow;
 *              this is the gate check, not the everyday path.
 */

import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexVideo, MediaError } from '../src/main/media/indexVideo.js';
import { FFPROBE_PATH } from '../src/main/media/binaries.js';
import { run } from '../src/main/media/run.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(projectRoot, 'fixtures');

/** Containers named in SPEC §1. */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm']);

interface Options {
  verify: boolean;
}

interface Reporter {
  name: string;
  phase: number;
  run: (file: string, options: Options) => Promise<void>;
}

// --- output helpers --------------------------------------------------------

const write = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

const heading = (text: string): void => {
  write();
  write(text);
  write('='.repeat(text.length));
};

const section = (text: string): void => {
  write();
  write(`  ${text}`);
  write(`  ${'-'.repeat(text.length)}`);
};

const field = (label: string, value: string | number): void => {
  write(`    ${label.padEnd(20)}${value}`);
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
};

const formatSeconds = (seconds: number): string => {
  const whole = Math.floor(seconds);
  const hh = String(Math.floor(whole / 3600)).padStart(2, '0');
  const mm = String(Math.floor((whole % 3600) / 60)).padStart(2, '0');
  const ss = String(whole % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
};

/** Track whether any check in this run failed, so the exit code can say so. */
let failures = 0;

const checkLine = (label: string, passed: boolean, detail: string): void => {
  if (!passed) failures += 1;
  write(`    ${passed ? 'PASS' : 'FAIL'}  ${label.padEnd(34)}${detail}`);
};

// --- reporters -------------------------------------------------------------

const fileReporter: Reporter = {
  name: 'file',
  phase: 0,
  async run(file) {
    const stats = await stat(file);
    section('file');
    field('path', file);
    field('size', formatBytes(stats.size));
    field('container', extname(file).slice(1) || '(none)');
    field('modified', stats.mtime.toISOString());
  },
};

/**
 * Independent frame count, by asking ffprobe to actually count decoded frames.
 * This is deliberately NOT how indexVideo works — the point of the gate is that
 * two different methods agree.
 */
async function countFramesIndependently(file: string): Promise<number | null> {
  const { stdout, code } = await run(FFPROBE_PATH, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-count_frames',
    '-show_entries',
    'stream=nb_read_frames',
    '-of',
    'csv=p=0',
    file,
  ]);
  if (code !== 0) return null;
  const parsed = Number(stdout.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

const indexReporter: Reporter = {
  name: 'index',
  phase: 1,
  async run(file, options) {
    const started = Date.now();
    const index = await indexVideo(file);
    const elapsedMs = Date.now() - started;

    section('index');
    field('codec', index.codec);
    field('coded size', `${index.codedWidth} x ${index.codedHeight}`);
    field('display size', `${index.displayWidth} x ${index.displayHeight}`);
    field('rotation', `${index.rotationDegrees} deg clockwise`);
    field('pixel aspect', index.sampleAspectRatio.toFixed(4));
    field('fps (nominal)', index.fps.toFixed(3));
    field('frame count', index.frameCount);
    field('duration', `${index.durationSec.toFixed(3)}s  (${formatSeconds(index.durationSec)})`);
    field('variable rate', index.variableFrameRate ? 'yes' : 'no');
    field('HDR', index.hdr ? 'yes' : 'no');
    field('indexed in', `${elapsedMs}ms`);

    const pts = Array.from(index.ptsList);
    const show = (values: number[]): string => values.map((value) => value.toFixed(4)).join(', ');
    field('first 5 PTS', show(pts.slice(0, 5)));
    field('last 5 PTS', show(pts.slice(-5)));

    // Presentation times must increase — everything downstream indexes into
    // this table by frame number (I1).
    let outOfOrder = 0;
    for (let i = 1; i < pts.length; i += 1) {
      if ((pts[i] as number) < (pts[i - 1] as number)) outOfOrder += 1;
    }

    section('index checks');
    checkLine('PTS strictly ordered', outOfOrder === 0, `${outOfOrder} out-of-order entries`);
    checkLine(
      'display size consistent',
      index.displayWidth > 0 && index.displayHeight > 0,
      `${index.displayWidth} x ${index.displayHeight}`,
    );

    if (options.verify) {
      const counted = await countFramesIndependently(file);
      if (counted === null) {
        checkLine('ptsList length vs decode', false, 'ffprobe -count_frames failed');
      } else {
        checkLine(
          'ptsList length vs decode',
          counted === index.frameCount,
          `index ${index.frameCount}, decoded ${counted}`,
        );
      }
    } else {
      write('    ....  ptsList length vs decode      skipped (pass --verify)');
    }
  },
};

/** Phases add their reporters here, in pipeline order. */
const reporters: Reporter[] = [fileReporter, indexReporter];

// --- fixture discovery -----------------------------------------------------

async function discoverFixtures(): Promise<string[]> {
  if (!existsSync(fixturesDir)) return [];
  const entries = await readdir(fixturesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => join(fixturesDir, entry.name))
    .sort();
}

// --- entry point -----------------------------------------------------------

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const options: Options = { verify: args.includes('--verify') };
  const files = args.filter((arg) => !arg.startsWith('--'));

  const targets = files.length > 0 ? files.map((arg) => resolve(arg)) : await discoverFixtures();

  if (targets.length === 0) {
    write('No video to inspect.');
    write();
    write(`Pass a file, or drop clips into ${fixturesDir}`);
    write('See fixtures/README.md for the set the build plan expects.');
    return 1;
  }

  const missing = targets.filter((target) => !existsSync(target));
  if (missing.length > 0) {
    for (const target of missing) write(`Not found: ${target}`);
    return 1;
  }

  write(
    `BreadCrumbs inspect — ${targets.length} file(s), reporters: ${reporters.map((r) => r.name).join(', ')}` +
      (options.verify ? ', verifying' : ''),
  );

  for (const target of targets) {
    heading(basename(target));
    for (const reporter of reporters) {
      try {
        await reporter.run(target, options);
      } catch (cause) {
        failures += 1;
        const message = cause instanceof MediaError || cause instanceof Error ? cause.message : String(cause);
        write(`    ERROR in ${reporter.name}: ${message}`);
      }
    }
  }

  write();
  write(failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (cause: unknown) => {
    write(`inspect failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = 1;
  },
);
