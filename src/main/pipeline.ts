/**
 * The analysis run: index, proxy, analyze, detect. SPEC §5.
 *
 * One run, four steps, reported as a single weighted progress bar. The weights
 * are fixed by SPEC §5 rather than measured, so the bar moves predictably
 * instead of stalling and lurching:
 *
 *   index    10%   indeterminate
 *   proxy    40%   determinate, from ffmpeg's frame counter
 *   analyze  40%   determinate, two decode passes
 *   detect   10%   fast, pure computation over cached metrics
 *
 * The intake screen shows each step's own state alongside the overall bar
 * (SPEC §7), which is why per-step status is reported here and not just a
 * single number.
 */

import type { FrameMetrics, Pick, Shot, VideoIndex } from '../shared/types.js';
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings.js';
import { detectShots, type DetectionResult } from './detect.js';
import { indexVideo } from './media/indexVideo.js';
import { buildProxy, type ProxyResult } from './media/proxy.js';
import { analyze, type AnalyzeResult } from './media/analyze.js';

export type PipelineStep = 'index' | 'proxy' | 'analyze' | 'detect';

export type StepState = 'pending' | 'running' | 'done';

/** Weights from SPEC §5. They must total 1. */
export const STEP_WEIGHTS: Record<PipelineStep, number> = {
  index: 0.1,
  proxy: 0.4,
  analyze: 0.4,
  detect: 0.1,
};

export const STEP_ORDER: PipelineStep[] = ['index', 'proxy', 'analyze', 'detect'];

/** Plain-language step names for the intake screen (SPEC §7). */
export const STEP_LABELS: Record<PipelineStep, string> = {
  index: 'Read the video',
  proxy: 'Build a preview copy',
  analyze: 'Look at every frame',
  detect: 'Find the cuts',
};

export interface PipelineProgress {
  /** 0..1 across the whole run. */
  overall: number;
  step: PipelineStep;
  /** 0..1 within the current step. Null while a step is indeterminate. */
  stepFraction: number | null;
  states: Record<PipelineStep, StepState>;
}

export interface PipelineResult {
  index: VideoIndex;
  proxy: ProxyResult;
  metrics: FrameMetrics;
  analysis: AnalyzeResult;
  shots: Shot[];
  picks: Pick[];
  detection: DetectionResult;
  elapsedMs: number;
}

export interface RunPipelineOptions {
  sourcePath: string;
  projectDir: string;
  onProgress?: (progress: PipelineProgress) => void;
  force?: boolean;
  settings?: Settings;
}

/** Progress accumulated from the steps already finished. */
function completedWeight(step: PipelineStep): number {
  let total = 0;
  for (const candidate of STEP_ORDER) {
    if (candidate === step) break;
    total += STEP_WEIGHTS[candidate];
  }
  return total;
}

export async function runPipeline(options: RunPipelineOptions): Promise<PipelineResult> {
  const started = Date.now();
  const states: Record<PipelineStep, StepState> = {
    index: 'pending',
    proxy: 'pending',
    analyze: 'pending',
    detect: 'pending',
  };

  const report = (step: PipelineStep, stepFraction: number | null): void => {
    const within = stepFraction === null ? 0 : stepFraction * STEP_WEIGHTS[step];
    options.onProgress?.({
      overall: Math.min(1, completedWeight(step) + within),
      step,
      stepFraction,
      states: { ...states },
    });
  };

  const begin = (step: PipelineStep): void => {
    states[step] = 'running';
    report(step, step === 'index' ? null : 0);
  };

  const finish = (step: PipelineStep): void => {
    states[step] = 'done';
    report(step, 1);
  };

  begin('index');
  const index = await indexVideo(options.sourcePath);
  finish('index');

  begin('proxy');
  const proxy = await buildProxy({
    index,
    projectDir: options.projectDir,
    ...(options.force === undefined ? {} : { force: options.force }),
    onProgress: (fraction) => report('proxy', fraction),
  });
  finish('proxy');

  begin('analyze');
  const analysis = await analyze({
    index,
    proxyPath: proxy.path,
    projectDir: options.projectDir,
    onProgress: (fraction) => report('analyze', fraction),
  });
  finish('analyze');

  begin('detect');
  const detection = detectShots(index, analysis.metrics, options.settings ?? DEFAULT_SETTINGS);
  finish('detect');

  return {
    index,
    proxy,
    metrics: analysis.metrics,
    analysis,
    shots: detection.shots,
    picks: detection.picks,
    detection,
    elapsedMs: Date.now() - started,
  };
}
