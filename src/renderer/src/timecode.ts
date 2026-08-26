/**
 * Frame to timecode, and frame to seconds.
 *
 * See I1 — every conversion goes through the PTS table. `fps` appears here only
 * to render the frames field of a timecode, which is a display convention, and
 * never to derive a time from a frame number or the reverse.
 */

import type { VideoIndex } from '../../shared/types.js';

/** Presentation time of a frame, straight out of the table. See I1. */
export function secondsOf(index: VideoIndex, frame: number): number {
  const pts = index.ptsList;
  const clamped = Math.max(0, Math.min(pts.length - 1, Math.round(frame)));
  return (pts[clamped] as number) ?? 0;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/**
 * `HH:MM:SS:FF`. The seconds come from the PTS table; only the frames field is
 * derived from the nominal rate, because a timecode's last pair is by
 * definition a count of frames within a second.
 */
export function timecodeOf(index: VideoIndex, frame: number, separator = ':'): string {
  const seconds = secondsOf(index, frame);
  const whole = Math.floor(seconds);
  const rate = index.fps > 0 ? index.fps : 1;
  const frames = Math.min(Math.ceil(rate) - 1, Math.round((seconds - whole) * rate));

  return [
    pad(Math.floor(whole / 3600)),
    pad(Math.floor(whole / 60) % 60),
    pad(whole % 60),
    pad(frames),
  ].join(separator);
}

/** `MM:SS`, for the timeline ruler where a full timecode is too wide. */
export function shortTimecodeOf(index: VideoIndex, frame: number): string {
  const seconds = secondsOf(index, frame);
  const whole = Math.floor(seconds);
  return `${pad(Math.floor(whole / 60))}:${pad(whole % 60)}`;
}

/** Duration of a clip, as `HH:MM:SS:FF`, for the header. */
export function durationTimecode(index: VideoIndex): string {
  return timecodeOf(index, index.frameCount - 1);
}
