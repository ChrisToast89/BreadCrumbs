/**
 * Generates `build/icon.png` — a PLACEHOLDER, meant to be replaced.
 *
 * It exists so the icon pipeline can be tested end to end rather than merely
 * configured. Configuration that has never been run is not plumbing, it is
 * hope; this project has already shipped one package that built perfectly and
 * was wrong inside.
 *
 * The mark is the design's own A/B bracket device (SPEC §12, direction 1a)
 * drawn in the design's own colours, so it is at least consistent with the
 * application rather than invented. It is still a placeholder.
 *
 *   npm run icon:placeholder
 */

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePng } from './png.js';

const SIZE = 1024;

/** Straight from src/renderer/src/styles/tokens.css. */
const SURFACE: [number, number, number] = [0x19, 0x1c, 0x20];
const ACCENT: [number, number, number] = [0x9f, 0xb0, 0xc0];
const INK: [number, number, number] = [0xdf, 0xe5, 0xeb];
const FRAME_A: [number, number, number] = [0x3a, 0x42, 0x4c];
const FRAME_B: [number, number, number] = [0x2c, 0x33, 0x3b];

function main(): void {
  const rgb = new Uint8Array(SIZE * SIZE * 3);

  const set = (x: number, y: number, colour: [number, number, number]): void => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    const offset = (y * SIZE + x) * 3;
    rgb[offset] = colour[0];
    rgb[offset + 1] = colour[1];
    rgb[offset + 2] = colour[2];
  };

  const rect = (x: number, y: number, w: number, h: number, colour: [number, number, number]): void => {
    for (let dy = 0; dy < h; dy += 1) for (let dx = 0; dx < w; dx += 1) set(x + dx, y + dy, colour);
  };

  // Background.
  rect(0, 0, SIZE, SIZE, SURFACE);

  // Two stacked frames — a shot that developed enough to need two stills.
  // Sized to fill the canvas and survive being shrunk: an icon is judged at
  // 16 pixels in a taskbar, where thin strokes and wide margins disappear.
  const frameX = 250;
  const frameW = 600;
  const frameH = 330;
  const gap = 80;
  const topY = (SIZE - (frameH * 2 + gap)) / 2;

  rect(frameX, topY, frameW, frameH, FRAME_A);
  rect(frameX, topY + frameH + gap, frameW, frameH, FRAME_B);

  // A hairline around each, as the design outlines its thumbnails.
  const outline = (x: number, y: number, w: number, h: number): void => {
    const t = 16;
    rect(x, y, w, t, ACCENT);
    rect(x, y + h - t, w, t, ACCENT);
    rect(x, y, t, h, ACCENT);
    rect(x + w - t, y, t, h, ACCENT);
  };
  outline(frameX, topY, frameW, frameH);
  outline(frameX, topY + frameH + gap, frameW, frameH);

  // The bracket down the left edge that binds a pair into one shot — the
  // device SPEC §7 relies on to stop a pair reading as two separate shots.
  const bracketX = 120;
  const bracketTop = topY;
  const bracketHeight = frameH * 2 + gap;
  const arm = 110;
  const weight = 40;

  rect(bracketX, bracketTop, weight, bracketHeight, ACCENT);
  rect(bracketX, bracketTop, arm, weight, ACCENT);
  rect(bracketX, bracketTop + bracketHeight - weight, arm, weight, ACCENT);

  // A carrot tab above the upper frame: the handle you drag.
  rect(frameX + frameW / 2 - 70, topY - 66, 140, 50, INK);

  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const out = join(root, 'build');
  mkdirSync(out, { recursive: true });
  writePng(join(out, 'icon.png'), SIZE, SIZE, rgb);

  process.stdout.write(`Wrote ${join(out, 'icon.png')} — ${SIZE}x${SIZE}\n`);
  process.stdout.write('This is a placeholder. Replace it with the real artwork.\n');
}

main();
