/**
 * Phase 1 — Index. Produces the VideoIndex defined in SPEC §4.
 *
 * The important output here is `ptsList`: the presentation time of every frame,
 * in display order. See I1 — this table is the ONLY frame<->time mapping in the
 * application. Nothing anywhere may compute `time * fps` or `frame / fps`,
 * because variable-frame-rate sources are common and the drift lands directly
 * on the frames the user exports.
 *
 * Display geometry (rotation and pixel aspect) is resolved once, here, and
 * every later stage reads it from this object. See I5.
 */

import { basename } from 'node:path';
import type { VideoIndex } from '../../shared/types.js';
import { FFPROBE_PATH, assertBinaries } from './binaries.js';
import { runOrThrow } from './run.js';

/** A source we cannot index, phrased for a person rather than a log. SPEC §9. */
export class MediaError extends Error {
  constructor(
    readonly file: string,
    readonly problem: string,
  ) {
    super(`${basename(file)}: ${problem}`);
    this.name = 'MediaError';
  }
}

// --- ffprobe payload shapes (only the fields we read) ----------------------

interface ProbeSideData {
  side_data_type?: string;
  rotation?: number | string;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  nb_frames?: string;
  color_primaries?: string;
  color_transfer?: string;
  color_space?: string;
  side_data_list?: ProbeSideData[];
  tags?: Record<string, string>;
}

interface ProbeFormat {
  duration?: string;
  format_name?: string;
}

interface ProbeOutput {
  streams?: ProbeStream[];
  format?: ProbeFormat;
}

// --- helpers ---------------------------------------------------------------

/**
 * Parse an ffprobe rational. ffprobe uses two separators depending on the
 * field: frame rates come as "30000/1001", pixel aspect ratios as "2:1". Both
 * must be handled — reading only the slash form silently turns every
 * anamorphic source back into square pixels, which breaks I5.
 */
function parseRational(value: string | undefined): number {
  if (!value) return 0;
  const [numerator, denominator] = value.split(/[/:]/);
  const n = Number(numerator);
  const d = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  return n / d;
}

/**
 * The clockwise rotation to apply to the stored pixels so the picture is
 * upright. ffprobe reports the display-matrix angle counter-clockwise, so a
 * portrait phone clip shows `rotation: -90` and needs +90 clockwise. See I5.
 */
function resolveRotation(stream: ProbeStream): 0 | 90 | 180 | 270 {
  let raw: number | undefined;

  const displayMatrix = stream.side_data_list?.find(
    (entry) => entry.side_data_type === 'Display Matrix' || entry.rotation !== undefined,
  );
  if (displayMatrix?.rotation !== undefined) raw = Number(displayMatrix.rotation);

  // Older containers carry it as a stream tag instead.
  const tagged = stream.tags?.rotate;
  if (raw === undefined && tagged !== undefined) raw = -Number(tagged);

  if (raw === undefined || !Number.isFinite(raw)) return 0;

  const clockwise = (((Math.round(-raw / 90) * 90) % 360) + 360) % 360;
  return clockwise === 90 || clockwise === 180 || clockwise === 270 ? clockwise : 0;
}

function resolveSampleAspectRatio(stream: ProbeStream): number {
  const sar = parseRational(stream.sample_aspect_ratio);
  // ffprobe writes "0:1" when the ratio is unknown; square pixels are the
  // right assumption there.
  return sar > 0 ? sar : 1;
}

/**
 * BT.2020 primaries, or a PQ / HLG transfer curve, mean the source is HDR and
 * export has to tonemap (SPEC §8).
 */
function resolveHdr(stream: ProbeStream): boolean {
  const primaries = stream.color_primaries ?? '';
  const transfer = stream.color_transfer ?? '';
  const space = stream.color_space ?? '';

  // PQ or HLG is unambiguous. BT.2020 can also arrive tagged only on the
  // colour space, with primaries left unknown, so all three are checked.
  return (
    transfer === 'smpte2084' ||
    transfer === 'arib-std-b67' ||
    primaries.startsWith('bt2020') ||
    space.startsWith('bt2020')
  );
}

/** Median of a numeric array. Does not mutate the input. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * A source is variable-frame-rate when the gaps between presentation times are
 * genuinely uneven — not merely jittery from timebase rounding, which is
 * normal in mp4 and would otherwise flag every constant-rate file.
 */
function detectVariableFrameRate(ptsList: number[]): boolean {
  if (ptsList.length < 3) return false;

  const deltas: number[] = [];
  for (let i = 1; i < ptsList.length; i += 1) {
    deltas.push((ptsList[i] as number) - (ptsList[i - 1] as number));
  }

  const typical = median(deltas);
  if (typical <= 0) return false;

  // 1ms is far above container rounding jitter and far below a real rate change.
  const tolerance = 0.001;
  const uneven = deltas.filter((delta) => Math.abs(delta - typical) > tolerance).length;
  return uneven / deltas.length > 0.01;
}

/**
 * Turn an ffprobe failure into something a person can act on. SPEC §9 requires
 * a clear cause naming the file and the problem, never a stack trace or a raw
 * decoder dump.
 */
function describeProbeFailure(file: string, cause: unknown): MediaError {
  const detail = cause instanceof Error ? cause.message : String(cause);

  if (/no such file|cannot find|does not exist/i.test(detail)) {
    return new MediaError(file, 'the file could not be found');
  }
  if (/permission denied/i.test(detail)) {
    return new MediaError(file, 'the file could not be opened — check its permissions');
  }
  if (/invalid data|moov atom not found|end of file|truncat/i.test(detail)) {
    return new MediaError(
      file,
      'this does not look like a complete video file — it may be damaged or still copying',
    );
  }
  return new MediaError(file, 'this file could not be read as a video');
}

// --- the PTS table ---------------------------------------------------------

/**
 * Read the presentation time of every frame, in display order. See I1.
 *
 * Packets come out of ffprobe in decode order, which for anything with B-frames
 * is not display order — so they are sorted by presentation time here. Reading
 * packets rather than decoded frames keeps this fast; a 2-minute clip is one
 * short ffprobe call rather than a full decode.
 */
async function readPtsList(file: string): Promise<number[]> {
  let stdout: string;
  try {
    ({ stdout } = await runOrThrow(
      FFPROBE_PATH,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'packet=pts_time,dts_time',
        '-of',
        'csv=p=0',
        file,
      ],
      'Reading frame timestamps',
    ));
  } catch (cause) {
    throw describeProbeFailure(file, cause);
  }

  const times: number[] = [];
  let missing = 0;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const [ptsText, dtsText] = trimmed.split(',');
    let time = Number(ptsText);
    // Some containers omit presentation times; decode time is the only
    // remaining signal, and for those files the two are equal anyway.
    if (!Number.isFinite(time)) time = Number(dtsText);

    if (!Number.isFinite(time)) {
      missing += 1;
      continue;
    }
    times.push(time);
  }

  if (times.length === 0) {
    throw new MediaError(file, 'no frame timestamps could be read — the file may be damaged');
  }
  if (missing > 0 && missing / (times.length + missing) > 0.01) {
    throw new MediaError(file, `${missing} frames have no timestamp, so frame timing cannot be trusted`);
  }

  times.sort((a, b) => a - b);
  return times;
}

// --- entry point -----------------------------------------------------------

export async function indexVideo(file: string): Promise<VideoIndex> {
  assertBinaries();

  let stdout: string;
  try {
    ({ stdout } = await runOrThrow(
      FFPROBE_PATH,
      ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_format', '-of', 'json', file],
      'Reading video information',
    ));
  } catch (cause) {
    throw describeProbeFailure(file, cause);
  }

  let probe: ProbeOutput;
  try {
    probe = JSON.parse(stdout) as ProbeOutput;
  } catch {
    throw new MediaError(file, 'this file could not be read as a video');
  }

  const stream = probe.streams?.find((candidate) => candidate.codec_type === 'video');
  if (!stream) throw new MediaError(file, 'there is no video track in this file');

  const codedWidth = stream.width ?? 0;
  const codedHeight = stream.height ?? 0;
  if (codedWidth <= 0 || codedHeight <= 0) {
    throw new MediaError(file, 'the video track reports no picture size');
  }

  const ptsList = await readPtsList(file);
  const frameCount = ptsList.length;

  const rotationDegrees = resolveRotation(stream);
  const sampleAspectRatio = resolveSampleAspectRatio(stream);

  // Pixel aspect first, then rotation. See I5 — this is resolved once and read
  // everywhere; nothing downstream re-derives it.
  const correctedWidth = Math.round(codedWidth * sampleAspectRatio);
  const correctedHeight = codedHeight;
  const upright = rotationDegrees === 90 || rotationDegrees === 270;
  const displayWidth = upright ? correctedHeight : correctedWidth;
  const displayHeight = upright ? correctedWidth : correctedHeight;

  const firstPts = ptsList[0] as number;
  const lastPts = ptsList[frameCount - 1] as number;
  const durationSec = Number(probe.format?.duration) || Number(stream.duration) || lastPts - firstPts;

  // Nominal frame rate, for timecode display only. Never for frame maths (I1).
  let fps = parseRational(stream.avg_frame_rate);
  if (fps <= 0) fps = parseRational(stream.r_frame_rate);
  if (fps <= 0 && durationSec > 0) fps = frameCount / durationSec;

  return {
    path: file,
    codedWidth,
    codedHeight,
    displayWidth,
    displayHeight,
    rotationDegrees,
    sampleAspectRatio,
    fps,
    frameCount,
    durationSec,
    ptsList,
    variableFrameRate: detectVariableFrameRate(ptsList),
    codec: stream.codec_name ?? 'unknown',
    hdr: resolveHdr(stream),
  };
}
