/**
 * Phase 7 gate checks.
 *
 * The one that matters: exported pixels must be identical to the frame ffmpeg
 * hands you when asked for it directly. MILESTONES calls this "the correctness
 * test the whole tool exists to pass", so it is done by extracting the frame a
 * second way, independently, and comparing the files byte for byte.
 */

import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { VideoIndex } from '../src/shared/types.js';
import { FFMPEG_PATH } from '../src/main/media/binaries.js';

export interface Comparison {
  frame: number;
  exportedBytes: number;
  referenceBytes: number;
  identical: boolean;
  note: string;
}

function run(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Pull one frame straight out of the source, the way the gate specifies:
 *
 *   ffmpeg -i source -vf "select='eq(n\,N)'" -frames:v 1
 *
 * This deliberately shares no code with the exporter. Two implementations
 * agreeing is the evidence; one implementation agreeing with itself is not.
 */
export async function referenceFrame(
  index: VideoIndex,
  frame: number,
  destination: string,
): Promise<boolean> {
  // A non-square-pixel source is the one case where the gate's bare command is
  // not the right comparison. SPEC §8 requires export to correct pixel aspect,
  // so the export is *meant* to differ from an uncorrected extract. Appending
  // the same correction here leaves it as the only difference — still an
  // independent command, still sharing no code with the exporter.
  const anamorphic = Math.abs(index.sampleAspectRatio - 1) > 0.001;
  const filter = anamorphic
    ? `select='eq(n\\,${frame})',scale=${index.displayWidth}:${index.displayHeight},setsar=1`
    : `select='eq(n\\,${frame})'`;

  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i',
    index.path,
    '-vf',
    filter,
    '-frames:v',
    '1',
    '-c:v',
    'png',
    destination,
  ];
  const { code } = await run(args);
  return code === 0;
}

/**
 * Compare exported files against independently extracted references.
 *
 * Only meaningful for PNG (lossless) and non-HDR sources: a tonemapped export
 * is deliberately not the same pixels as the raw frame, and JPEG is lossy.
 */
export async function compareExports(
  index: VideoIndex,
  exportedFiles: { frame: number; path: string }[],
  scratchDir: string,
): Promise<Comparison[]> {
  const results: Comparison[] = [];

  for (const { frame, path } of exportedFiles) {
    const reference = join(scratchDir, `reference_${frame}.png`);
    await rm(reference, { force: true });

    const ok = await referenceFrame(index, frame, reference);
    if (!ok) {
      results.push({
        frame,
        exportedBytes: 0,
        referenceBytes: 0,
        identical: false,
        note: 'the reference extraction failed',
      });
      continue;
    }

    const [exported, expected] = await Promise.all([readFile(path), readFile(reference)]);
    const identical = sha(exported) === sha(expected);

    results.push({
      frame,
      exportedBytes: exported.length,
      referenceBytes: expected.length,
      identical,
      note: identical
        ? `sha256 ${sha(exported).slice(0, 12)}`
        : `exported ${sha(exported).slice(0, 12)} vs reference ${sha(expected).slice(0, 12)}`,
    });

    await rm(reference, { force: true });
  }

  return results;
}

/** Pixel dimensions of a written image, to confirm full source resolution. */
export async function imageSize(path: string): Promise<{ width: number; height: number }> {
  const bytes = await readFile(path);

  // PNG: IHDR width and height are the first fields after the signature.
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }

  // JPEG: walk the segments to the frame header.
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] as number;
    const length = bytes.readUInt16BE(offset + 2);
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry the dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    offset += 2 + length;
  }

  return { width: 0, height: 0 };
}
