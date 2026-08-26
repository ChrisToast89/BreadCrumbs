/**
 * Intake screen — SPEC §7.
 *
 * Before any file is loaded: the product's purpose in one or two plain
 * sentences, a drop zone that also accepts click-to-browse, and a visible
 * four-step list of what will happen. Once running, each step shows its own
 * state alongside the overall bar. Errors replace the bar with a readable
 * cause and a way to try another file — never a stack trace.
 *
 * Copy is plain language, active voice, sentence case, and names things by
 * what the user controls rather than by how the system works (SPEC §7).
 */

import { useCallback, useState, type DragEvent } from 'react';
import { STEP_LABELS, STEP_ORDER, stepStateOf, useStore } from '../store.js';

/** What each step is actually doing, in the user's terms. */
const STEP_DETAIL: Record<string, string> = {
  index: 'Work out where every frame sits in time.',
  proxy: 'Make a small copy so scrubbing stays instant.',
  analyze: 'Measure every frame and make a thumbnail of it.',
  detect: 'Work out where the cuts are and pick a frame for each shot.',
};

export function Intake(): JSX.Element {
  const screen = useStore((state) => state.screen);
  const problem = useStore((state) => state.problem);
  const progress = useStore((state) => state.progress);
  const choose = useStore((state) => state.choose);
  const analyze = useStore((state) => state.analyze);
  const reset = useStore((state) => state.reset);

  const [dragging, setDragging] = useState(false);
  const running = screen === 'analyzing';

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      if (running) return;

      const file = event.dataTransfer.files[0];
      // Electron exposes the real path on dropped files; without it there is
      // nothing for ffmpeg to read.
      const path = file ? window.breadcrumbs.pathForFile(file) : '';
      if (path) void analyze(path);
    },
    [analyze, running],
  );

  return (
    <div className="intake">
      <div className="intake__inner">
        <h1 className="intake__title">BreadCrumbs</h1>
        <p className="intake__lede">
          BreadCrumbs splits a video at its cuts and picks one still from each shot. Adjust anything
          it gets wrong, then export the set as image files.
        </p>

        {screen === 'error' ? (
          <div className="intake__problem" role="alert">
            <p className="intake__problem-text">{problem}</p>
            <button type="button" className="button" onClick={() => void reset()}>
              Try another file
            </button>
          </div>
        ) : (
          <div
            className={`dropzone${dragging ? ' dropzone--over' : ''}${running ? ' dropzone--busy' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              if (!running) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            {running ? (
              <p className="dropzone__label">Working on it</p>
            ) : (
              <>
                <p className="dropzone__label">Drop a video here</p>
                <button type="button" className="button" onClick={() => void choose()}>
                  Choose a video
                </button>
                <p className="dropzone__hint">mp4, mov, mkv or webm · up to about five minutes</p>
              </>
            )}
          </div>
        )}

        <ol className="steps">
          {STEP_ORDER.map((step, position) => {
            const state = stepStateOf(progress, step);
            const isCurrent = progress?.step === step && state === 'running';
            const percent =
              isCurrent && progress?.stepFraction !== null && progress?.stepFraction !== undefined
                ? Math.round(progress.stepFraction * 100)
                : null;

            return (
              <li key={step} className={`step step--${state}`}>
                <span className="step__number">{position + 1}</span>
                <span className="step__body">
                  <span className="step__label">{STEP_LABELS[step]}</span>
                  <span className="step__detail">{STEP_DETAIL[step]}</span>
                </span>
                <span className="step__state">
                  {state === 'done' ? 'done' : percent !== null ? `${percent}%` : state === 'running' ? 'working' : ''}
                </span>
              </li>
            );
          })}
        </ol>

        {running ? (
          <div className="progress">
            <div
              className="progress__bar"
              style={{ width: `${Math.round((progress?.overall ?? 0) * 100)}%` }}
            />
            <span className="progress__readout">{Math.round((progress?.overall ?? 0) * 100)}%</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
