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
 *   detect          phase 4    Shot table, chosen frame per shot and why,
 *                              plus a plot with the detected cuts marked
 *   export          phase 6/7  Dry run — the filenames that would be written
 *
 * Flags:
 *   --verify   Cross-check results against an independent ffprobe call. Slow;
 *              this is the gate check, not the everyday path.
 *   --force    Rebuild the proxy from scratch instead of reusing a cached one.
 */

import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexVideo, MediaError } from '../src/main/media/indexVideo.js';
import { buildProxy, projectDirFor, proxySize } from '../src/main/media/proxy.js';
import { runPipeline, STEP_LABELS } from '../src/main/pipeline.js';
import { chooseOutFrame, detectShots } from '../src/main/detect.js';
import { DEFAULT_SETTINGS } from '../src/shared/settings.js';
import { assertPickRules } from '../src/shared/picks.js';
import type { Shot } from '../src/shared/types.js';
import { plotSeries } from './png.js';
import { FFPROBE_PATH } from '../src/main/media/binaries.js';
import { run } from '../src/main/media/run.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(projectRoot, 'fixtures');

/** Containers named in SPEC §1. */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm']);

interface Options {
  verify: boolean;
  /** Re-encode the proxy even when a valid cached one exists. */
  force: boolean;
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

interface ProxyGeometry {
  width: number;
  height: number;
  rotation: number;
  sar: number;
}

/** Read the proxy's own geometry back off disk, to confirm I5 was applied. */
async function readProxyGeometry(file: string): Promise<ProxyGeometry> {
  const { stdout } = await run(FFPROBE_PATH, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_streams',
    '-of',
    'json',
    file,
  ]);
  const stream = (JSON.parse(stdout) as { streams?: Record<string, unknown>[] }).streams?.[0] ?? {};

  const sarText = String(stream['sample_aspect_ratio'] ?? '1:1');
  const [sarNum, sarDen] = sarText.split(/[/:]/).map(Number);
  const sar = sarNum && sarDen ? sarNum / sarDen : 1;

  const sideData = (stream['side_data_list'] as { rotation?: number }[] | undefined) ?? [];
  const rotation = sideData.find((entry) => entry.rotation !== undefined)?.rotation ?? 0;

  return {
    width: Number(stream['width'] ?? 0),
    height: Number(stream['height'] ?? 0),
    rotation,
    sar,
  };
}

/** Presentation times of a file, in display order — same method as indexing. */
async function readPtsListOf(file: string): Promise<number[]> {
  const { stdout } = await run(FFPROBE_PATH, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'packet=pts_time',
    '-of',
    'csv=p=0',
    file,
  ]);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    // Number('') is 0, not NaN — dropping blank lines before converting keeps a
    // trailing newline from being read as a frame at time zero.
    .filter((line) => line !== '')
    .map(Number)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
}

/** How many frames in the file are keyframes. */
async function countKeyframes(file: string): Promise<number> {
  const { stdout } = await run(FFPROBE_PATH, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'packet=flags',
    '-of',
    'csv=p=0',
    file,
  ]);
  return stdout.split('\n').filter((line) => line.trim().startsWith('K')).length;
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

const proxyReporter: Reporter = {
  name: 'proxy',
  phase: 2,
  async run(file, options) {
    const index = await indexVideo(file);
    const projectDir = await projectDirFor(join(projectRoot, 'inspect-out'), file);

    let lastReported = -1;
    const result = await buildProxy({
      index,
      projectDir,
      force: options.force,
      onProgress: (fraction) => {
        // Print at each 25% so the CLI shows progress is real without flooding.
        const quarter = Math.floor(fraction * 4);
        if (quarter > lastReported && quarter < 4) {
          lastReported = quarter;
          write(`    ...  encoding ${quarter * 25}%`);
        }
      },
    });

    section('proxy');
    field('path', result.path);
    field('size', `${result.width} x ${result.height}`);
    field('file size', formatBytes(result.bytes));
    field('source', `${result.reused ? 'reused cached proxy' : 'encoded'} in ${result.elapsedMs}ms`);
    if (!result.reused && index.durationSec > 0) {
      field('encode speed', `${(index.durationSec / (result.elapsedMs / 1000)).toFixed(1)}x realtime`);
    }

    section('proxy checks');

    // I2 — the single most important check in the build (MILESTONES phase 2).
    checkLine(
      'proxy frames == source frames',
      result.frameCount === index.frameCount,
      `proxy ${result.frameCount}, source ${index.frameCount}`,
    );

    // I5 — a sideways phone clip must come out upright, with no rotation flag
    // left on the proxy for a later stage to apply a second time.
    const proxyGeometry = await readProxyGeometry(result.path);
    const expected = proxySize(index);
    checkLine(
      'proxy is upright, square pixels',
      proxyGeometry.width === expected.width &&
        proxyGeometry.height === expected.height &&
        proxyGeometry.rotation === 0 &&
        proxyGeometry.sar === 1,
      `${proxyGeometry.width} x ${proxyGeometry.height}, rotation ${proxyGeometry.rotation}, pixel aspect ${proxyGeometry.sar}`,
    );

    // I2 goes further than counting: the preview seeks by the source's own
    // presentation times (I1), so those times must survive into the proxy. A
    // matching frame count with shifted timestamps would still land the
    // preview on the wrong frame.
    const proxyPts = await readPtsListOf(result.path);
    let worstDriftMs = 0;
    let worstFrame = -1;
    const sourcePts = Array.from(index.ptsList);
    for (let i = 0; i < Math.min(proxyPts.length, sourcePts.length); i += 1) {
      const drift = Math.abs((proxyPts[i] as number) - (sourcePts[i] as number)) * 1000;
      if (drift > worstDriftMs) {
        worstDriftMs = drift;
        worstFrame = i;
      }
    }
    // Half a frame at 240fps — well inside any container's rounding, far below
    // a genuine one-frame slip.
    checkLine(
      'proxy timestamps match source',
      worstDriftMs < 2,
      `worst drift ${worstDriftMs.toFixed(3)}ms${worstFrame >= 0 ? ` at frame ${worstFrame}` : ''}`,
    );

    // Every frame a keyframe, so scrubbing lands exactly (SPEC §2).
    const keyframes = await countKeyframes(result.path);
    checkLine(
      'every proxy frame is a keyframe',
      keyframes === result.frameCount,
      `${keyframes} of ${result.frameCount}`,
    );
  },
};

interface Summary {
  min: number;
  max: number;
  mean: number;
}

function summarise(values: ArrayLike<number>): Summary {
  if (values.length === 0) return { min: 0, max: 0, mean: 0 };
  let min = Infinity;
  let max = -Infinity;
  let total = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i] as number;
    if (value < min) min = value;
    if (value > max) max = value;
    total += value;
  }
  return { min, max, mean: total / values.length };
}

const metricsReporter: Reporter = {
  name: 'metrics',
  phase: 3,
  async run(file, options) {
    const projectDir = await projectDirFor(join(projectRoot, 'inspect-out'), file);

    // Measure the whole run, phases 1 through 3, which is what the gate budgets.
    const before = process.memoryUsage();
    let lastQuarter = -1;

    const result = await runPipeline({
      sourcePath: file,
      projectDir,
      ...(options.force ? { force: true } : {}),
      onProgress: (progress) => {
        const quarter = Math.floor(progress.overall * 4);
        if (quarter > lastQuarter && quarter < 4) {
          lastQuarter = quarter;
          write(`    ...  ${quarter * 25}% overall — ${STEP_LABELS[progress.step].toLowerCase()}`);
        }
      },
    });

    const after = process.memoryUsage();
    const { index, metrics, analysis } = result;

    section('analysis');
    field('metrics pass', `${analysis.metricsMs}ms`);
    field('thumbnail pass', `${analysis.thumbnailsMs}ms`);
    field('thumbnails', `${analysis.thumbnails.length} at ${analysis.thumbnailWidth}x${analysis.thumbnailHeight}`);
    field('thumbnail cache', formatBytes(analysis.thumbnailBytes));
    field('mean thumbnail', formatBytes(Math.round(analysis.thumbnailBytes / Math.max(1, analysis.thumbnails.length))));
    field('phases 1-3 total', `${(result.elapsedMs / 1000).toFixed(2)}s`);
    field('heap growth', formatBytes(Math.max(0, after.heapUsed - before.heapUsed)));
    field('resident memory', formatBytes(after.rss));

    section('metric summary');
    write('    signal        min       max       mean');
    const signals: [string, ArrayLike<number>][] = [
      ['motion', metrics.motion],
      ['histogram', metrics.histogram],
      ['sharpness', metrics.sharpness],
      ['luma', metrics.luma],
      ['scene', metrics.scene],
    ];
    for (const [label, values] of signals) {
      const { min, max, mean } = summarise(values);
      write(
        `    ${label.padEnd(12)}${min.toFixed(4).padStart(8)}  ${max.toFixed(4).padStart(8)}  ${mean.toFixed(4).padStart(8)}`,
      );
    }

    // Where the biggest content changes are. On a clip with known cuts these
    // frame numbers should be the cut frames — a numeric version of "the spikes
    // line up", which is easier to trust than reading a plot.
    const ranked = Array.from(metrics.histogram, (value, frame) => ({ value, frame }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
    field('biggest changes', ranked.map((entry) => `${entry.frame} (${entry.value.toFixed(2)})`).join(', '));

    // The plot the gate asks for: spikes here should line up with the visible
    // cuts in the clip.
    const plotPath = join(projectDir, 'metrics.png');
    plotSeries(
      plotPath,
      [
        { label: 'motion', values: metrics.motion, colour: [90, 200, 255], max: Math.max(0.05, summarise(metrics.motion).max) },
        { label: 'histogram', values: metrics.histogram, colour: [255, 170, 80], max: Math.max(0.05, summarise(metrics.histogram).max) },
        { label: 'scene', values: metrics.scene, colour: [180, 130, 255], max: 1 },
        { label: 'sharpness', values: metrics.sharpness, colour: [130, 230, 150], max: 1 },
        { label: 'luma', values: metrics.luma, colour: [220, 220, 220], max: 1 },
      ],
      { width: Math.min(1400, Math.max(600, index.frameCount)), laneHeight: 90 },
    );
    field('plot', plotPath);

    section('metric checks');
    for (const [label, values] of signals) {
      checkLine(`${label} length == frame count`, values.length === index.frameCount, `${values.length}`);
    }
    checkLine(
      'thumbnail count == frame count',
      analysis.thumbnails.length === index.frameCount,
      `${analysis.thumbnails.length}`,
    );

    // Ranges declared in SPEC §4.
    const motionRange = summarise(metrics.motion);
    const histogramRange = summarise(metrics.histogram);
    const lumaRange = summarise(metrics.luma);
    const sharpnessRange = summarise(metrics.sharpness);
    checkLine(
      'signals within declared ranges',
      motionRange.min >= 0 &&
        motionRange.max <= 1 &&
        histogramRange.min >= 0 &&
        histogramRange.max <= 2 &&
        lumaRange.min >= 0 &&
        lumaRange.max <= 1 &&
        sharpnessRange.min >= 0 &&
        sharpnessRange.max <= 1,
      `motion<=1, histogram<=2, luma<=1, sharpness<=1`,
    );
  },
};

/** Timecode from the PTS table — never from frame / fps. See I1. */
function timecodeOf(index: { ptsList: Float64Array | number[]; fps: number }, frame: number): string {
  const pts = Array.from(index.ptsList);
  const seconds = (pts[Math.max(0, Math.min(pts.length - 1, frame))] as number) ?? 0;
  const whole = Math.floor(seconds);
  const hh = String(Math.floor(whole / 3600)).padStart(2, '0');
  const mm = String(Math.floor((whole % 3600) / 60)).padStart(2, '0');
  const ss = String(whole % 60).padStart(2, '0');
  const ff = String(Math.round((seconds - whole) * (index.fps || 1))).padStart(2, '0');
  return `${hh}:${mm}:${ss}:${ff}`;
}

const detectReporter: Reporter = {
  name: 'detect',
  phase: 4,
  async run(file, options) {
    const projectDir = await projectDirFor(join(projectRoot, 'inspect-out'), file);
    const result = await runPipeline({
      sourcePath: file,
      projectDir,
      ...(options.force ? { force: true } : {}),
    });
    const { index, metrics, detection, shots, picks } = result;

    section('detection');
    field('candidates', `${detection.candidatesBeforeCollapse} before collapse`);
    field('shots', shots.length);
    field('hard / soft', `${shots.filter((s) => s.boundary === 'hard').length} / ${shots.filter((s) => s.boundary === 'soft').length}`);
    field('detect time', `${detection.elapsedMs}ms`);

    // Re-detection must be instant — it reads cached metrics and touches no
    // disk at all (SPEC §5). Timed over several runs so the number is not a
    // single lucky sample.
    const runs = 5;
    const redetectStarted = Date.now();
    for (let i = 0; i < runs; i += 1) detectShots(index, metrics, DEFAULT_SETTINGS);
    const redetectMs = (Date.now() - redetectStarted) / runs;
    field('re-detect', `${redetectMs.toFixed(1)}ms average over ${runs} runs`);

    section('shots');
    write('     #  start    end  frames  bound  conf   pick  timecode        B?  chose by');
    shots.forEach((shot, position) => {
      const choice = detection.choices.find((entry) => entry.shotId === shot.id);
      const pick = picks.find((entry) => entry.shotId === shot.id && entry.role === 'A');
      const frames = shot.endFrame - shot.startFrame + 1;
      const offset = pick ? pick.frame - shot.startFrame : 0;
      // Where an out-frame would land if the user asked for one. B is never
      // created automatically in v1 (SPEC §6) — this is the default position.
      const outFrame = pick ? chooseOutFrame(shot, pick.frame, metrics, DEFAULT_SETTINGS) : -1;
      const skipped = (choice?.skippedForLuma ?? 0) + (choice?.skippedForSharpness ?? 0);
      write(
        `    ${String(position + 1).padStart(2)}  ` +
          `${String(shot.startFrame).padStart(5)}  ${String(shot.endFrame).padStart(5)}  ` +
          `${String(frames).padStart(6)}  ${shot.boundary.padEnd(5)}  ` +
          `${shot.confidence.toFixed(2)}  ${String(pick?.frame ?? -1).padStart(5)}  ` +
          `${timecodeOf(index, pick?.frame ?? 0)}  ${String(outFrame).padStart(5)}  ` +
          `${choice?.reason ?? '?'} (+${offset}${skipped > 0 ? `, skipped ${skipped}` : ''})`,
      );
    });

    // SPEC §6: the default out-frame must not be the literal last frame — those
    // are so often blurred or already fading that the user would fix it every
    // time — and it must never land on or before A (I8).
    const outFrames = shots.map((shot) => {
      const pick = picks.find((entry) => entry.shotId === shot.id && entry.role === 'A');
      return pick ? { shot, a: pick.frame, b: chooseOutFrame(shot, pick.frame, metrics, DEFAULT_SETTINGS) } : null;
    });
    const roomy = outFrames.filter((entry) => entry !== null && entry.shot.endFrame - entry.a > 2);
    const onLastFrame = roomy.filter((entry) => entry !== null && entry.b === entry.shot.endFrame).length;

    section('detection checks');
    checkLine('at least one shot', shots.length >= 1, `${shots.length}`);

    // Shots must tile the clip exactly: contiguous, non-overlapping, covering
    // every frame from 0 to the last.
    let contiguous = shots[0]?.startFrame === 0;
    for (let i = 1; i < shots.length; i += 1) {
      if ((shots[i] as Shot).startFrame !== (shots[i - 1] as Shot).endFrame + 1) contiguous = false;
    }
    const coversEnd = shots[shots.length - 1]?.endFrame === index.frameCount - 1;
    checkLine('shots tile the clip exactly', contiguous && coversEnd, contiguous && coversEnd ? 'no gaps or overlaps' : 'gap, overlap or short coverage');

    checkLine(
      'every shot has exactly one A',
      shots.every((shot) => picks.filter((pick) => pick.shotId === shot.id && pick.role === 'A').length === 1),
      `${picks.filter((pick) => pick.role === 'A').length} A picks for ${shots.length} shots`,
    );

    checkLine(
      'every pick sits inside its shot',
      picks.every((pick) => {
        const shot = shots.find((candidate) => candidate.id === pick.shotId);
        return shot !== undefined && pick.frame >= shot.startFrame && pick.frame <= shot.endFrame;
      }),
      'no pick outside its shot range',
    );

    // I8, checked at the data layer rather than the UI.
    let pickRules = 'ok';
    try {
      assertPickRules(picks, shots);
    } catch (cause) {
      pickRules = cause instanceof Error ? cause.message : String(cause);
    }
    checkLine('pick rules hold (I8)', pickRules === 'ok', pickRules);

    checkLine(
      'default B never on or before A (I8)',
      outFrames.every((entry) => entry === null || entry.b > entry.a || entry.a >= entry.shot.endFrame),
      'every out-frame lands after its A',
    );
    checkLine(
      'default B backs off the last frame',
      onLastFrame === 0,
      `${onLastFrame} of ${roomy.length} shots with room landed on the final frame`,
    );

    // I6 — any frame the user has touched is pinned and survives re-detection.
    // Simulated here by moving a pick, pinning it, and re-running detection.
    const firstA = picks.find((pick) => pick.role === 'A');
    if (firstA) {
      const hostShot = shots.find((shot) => shot.id === firstA.shotId) as Shot;
      const movedFrame = Math.min(hostShot.endFrame, firstA.frame + 3);
      const edited = picks.map((pick) =>
        pick.id === firstA.id ? { ...pick, frame: movedFrame, pinned: true } : pick,
      );

      const again = detectShots(index, metrics, DEFAULT_SETTINGS, edited);
      const survivor = again.picks.find(
        (pick) => pick.role === 'A' && pick.frame === movedFrame && pick.pinned,
      );
      checkLine(
        'pinned pick survives re-detection (I6)',
        survivor !== undefined,
        survivor ? `frame ${movedFrame} kept` : `frame ${movedFrame} was overwritten`,
      );

      // And an untouched pick must be free to move when detection changes.
      checkLine(
        'unpinned picks stay unpinned',
        again.picks.filter((pick) => pick.pinned).length === 1,
        `${again.picks.filter((pick) => pick.pinned).length} pinned of ${again.picks.length}`,
      );
    }

    checkLine('re-detect under 100ms', redetectMs < 100, `${redetectMs.toFixed(1)}ms`);

    // The plot again, this time with the detected cuts marked, so a spike with
    // no marker (or a marker with no spike) is obvious.
    const plotPath = join(projectDir, 'detection.png');
    plotSeries(
      plotPath,
      [
        { label: 'histogram', values: metrics.histogram, colour: [255, 170, 80], max: Math.max(0.1, summarise(metrics.histogram).max) },
        { label: 'adaptive bar', values: detection.adaptiveThreshold, colour: [255, 90, 90], max: Math.max(0.1, summarise(metrics.histogram).max) },
        { label: 'scene', values: metrics.scene, colour: [180, 130, 255], max: 1 },
        { label: 'motion', values: metrics.motion, colour: [90, 200, 255], max: Math.max(0.05, summarise(metrics.motion).max) },
      ],
      {
        width: Math.min(1400, Math.max(600, index.frameCount)),
        laneHeight: 90,
        marks: shots.slice(1).map((shot) => shot.startFrame),
      },
    );
    field('plot', plotPath);
  },
};

/** Phases add their reporters here, in pipeline order. */
const reporters: Reporter[] = [fileReporter, indexReporter, proxyReporter, metricsReporter, detectReporter];

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
  const options: Options = { verify: args.includes('--verify'), force: args.includes('--force') };
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
