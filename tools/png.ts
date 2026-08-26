/**
 * A minimal PNG writer and line-plot helper for the `inspect` CLI.
 *
 * The build plan asks phase 3 to emit a plot of motion and histogram distance
 * so the spikes can be eyeballed against the cuts in the clip. That is a
 * debugging aid, not part of the application, and it is about sixty lines of
 * PNG chunk assembly over Node's own zlib — not worth a dependency.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32, as PNG requires on every chunk. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = ((CRC_TABLE[(c ^ (buffer[i] as number)) & 0xff] as number) ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** Write an 8-bit RGB image. `rgb` is width * height * 3 bytes. */
export function writePng(path: string, width: number, height: number, rgb: Uint8Array): void {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // colour type: truecolour
  header.writeUInt8(0, 10); // compression
  header.writeUInt8(0, 11); // filter
  header.writeUInt8(0, 12); // interlace

  // Each scanline is prefixed with a filter byte; 0 means "no filter".
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  writeFileSync(
    path,
    Buffer.concat([
      PNG_SIGNATURE,
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw, { level: 6 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Plotting
// ---------------------------------------------------------------------------

export interface Series {
  label: string;
  values: ArrayLike<number>;
  colour: [number, number, number];
  /** Values are drawn against 0..max. */
  max: number;
}

export interface PlotOptions {
  width: number;
  laneHeight: number;
  /** Frame numbers to mark with a vertical rule — detected cuts, for instance. */
  marks?: number[];
}

/**
 * Draw one lane per series, time along x, value along y. Lanes are stacked so
 * that a spike in one signal can be compared against the same moment in
 * another by looking straight up or down.
 */
export function plotSeries(path: string, series: Series[], options: PlotOptions): void {
  const { width, laneHeight } = options;
  const height = laneHeight * series.length;
  const rgb = new Uint8Array(width * height * 3);

  const background: [number, number, number] = [16, 16, 20];
  const gridline: [number, number, number] = [42, 42, 52];
  const markColour: [number, number, number] = [120, 90, 40];

  const setPixel = (x: number, y: number, colour: [number, number, number]): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 3;
    rgb[offset] = colour[0];
    rgb[offset + 1] = colour[1];
    rgb[offset + 2] = colour[2];
  };

  for (let i = 0; i < width * height; i += 1) {
    rgb[i * 3] = background[0];
    rgb[i * 3 + 1] = background[1];
    rgb[i * 3 + 2] = background[2];
  }

  const frameCount = series[0]?.values.length ?? 0;

  // Vertical rules first, so the traces draw over them.
  for (const mark of options.marks ?? []) {
    const x = frameCount > 1 ? Math.round((mark / (frameCount - 1)) * (width - 1)) : 0;
    for (let y = 0; y < height; y += 1) setPixel(x, y, markColour);
  }

  series.forEach((entry, lane) => {
    const top = lane * laneHeight;
    const bottom = top + laneHeight - 1;

    // Lane baseline.
    for (let x = 0; x < width; x += 1) setPixel(x, bottom, gridline);

    const count = entry.values.length;
    if (count === 0) return;

    let previousY: number | null = null;
    for (let x = 0; x < width; x += 1) {
      // Each column covers a span of frames; take the peak so that a
      // single-frame spike cannot be skipped over by the sampling.
      const from = Math.floor((x / width) * count);
      const to = Math.max(from + 1, Math.floor(((x + 1) / width) * count));
      let peak = 0;
      for (let i = from; i < to && i < count; i += 1) {
        const value = entry.values[i] as number;
        if (value > peak) peak = value;
      }

      const normalised = entry.max > 0 ? Math.min(1, peak / entry.max) : 0;
      const y = bottom - Math.round(normalised * (laneHeight - 2));

      // Join to the previous column so the trace reads as a line.
      if (previousY !== null) {
        // Step towards y, not away from it.
        const step = y < previousY ? -1 : 1;
        for (let fill: number = previousY; fill !== y; fill += step) setPixel(x, fill, entry.colour);
      }
      setPixel(x, y, entry.colour);
      previousY = y;
    }
  });

  writePng(path, width, height, rgb);
}
