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
 */

import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(projectRoot, 'fixtures');

/** Containers named in SPEC §1. */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm']);

interface Reporter {
  name: string;
  phase: number;
  run: (file: string) => Promise<void>;
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

const field = (label: string, value: string | number): void => {
  write(`  ${label.padEnd(22)}${value}`);
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

// --- reporters -------------------------------------------------------------

const fileReporter: Reporter = {
  name: 'file',
  phase: 0,
  async run(file) {
    const stats = await stat(file);
    field('path', file);
    field('size', formatBytes(stats.size));
    field('container', extname(file).slice(1) || '(none)');
    field('modified', stats.mtime.toISOString());
  },
};

/** Phases add their reporters here, in pipeline order. */
const reporters: Reporter[] = [fileReporter];

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
  const targets = args.length > 0 ? args.map((arg) => resolve(arg)) : await discoverFixtures();

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

  write(`BreadCrumbs inspect — ${targets.length} file(s), reporters: ${reporters.map((r) => r.name).join(', ')}`);

  for (const target of targets) {
    heading(basename(target));
    for (const reporter of reporters) {
      await reporter.run(target);
    }
  }

  write();
  return 0;
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
