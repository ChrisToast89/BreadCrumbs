/**
 * Thin wrapper around spawning ffmpeg/ffprobe. Kept free of any Electron
 * import so that the `inspect` CLI can use the same code path the app does —
 * if these ever diverged, the CLI would stop being evidence about the app.
 */

import { spawn } from 'node:child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  elapsedMs: number;
}

export class ToolError extends Error {
  constructor(
    message: string,
    readonly tool: string,
    readonly code: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export function run(tool: string, args: string[]): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (cause) => reject(cause));
    child.on('close', (code) => {
      resolve({ stdout, stderr, code: code ?? -1, elapsedMs: Date.now() - started });
    });
  });
}

export async function runOrThrow(tool: string, args: string[], label: string): Promise<RunResult> {
  const result = await run(tool, args);
  if (result.code !== 0) {
    const detail = result.stderr.trim().split('\n').slice(-3).join(' ').trim();
    throw new ToolError(`${label} failed: ${detail || `exit code ${result.code}`}`, tool, result.code, result.stderr);
  }
  return result;
}
