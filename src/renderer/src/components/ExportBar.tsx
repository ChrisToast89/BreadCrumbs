/**
 * Export — SPEC §8.
 *
 * A user-editable filename template with tokens, previewed live as the
 * resulting filename. The preview runs the same `planExport` the main process
 * writes from, so what is listed here is exactly what lands on disk.
 *
 * A pattern that would write two frames to one name is refused, and the
 * message names the token that fixes it. If paired shots exist and the pattern
 * omits {ab}, it is added rather than colliding — and the panel says so.
 */

import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_PATTERN, planExport } from '../../../shared/exportPattern.js';
import type { ExportPlanEntry } from '../../../shared/types.js';
import { useStore } from '../store.js';

const TOKENS: { token: string; means: string }[] = [
  { token: '{name}', means: 'source filename' },
  { token: '{index}', means: 'position, 1-based' },
  { token: '{shot}', means: 'shot number' },
  { token: '{ab}', means: 'A or B, empty for singles' },
  { token: '{frame}', means: 'source frame number' },
  { token: '{tc}', means: 'timecode' },
];

export function ExportBar({ onClose }: { onClose: () => void }): JSX.Element {
  const project = useStore((state) => state.project);
  const shots = useStore((state) => state.shots);
  const picks = useStore((state) => state.picks);

  const [pattern, setPattern] = useState(DEFAULT_PATTERN);
  const [format, setFormat] = useState<'png' | 'jpeg'>('png');
  const [quality, setQuality] = useState(90);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ written: number; total: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<{ count: number; dir: string; ms: number } | null>(null);
  const [pendingOverwrite, setPendingOverwrite] = useState<string[] | null>(null);

  const plan = useMemo(() => {
    if (!project) return null;
    return planExport({
      pattern,
      sourceName: project.sourceName,
      index: project.index,
      shots,
      picks,
      extension: format === 'png' ? 'png' : 'jpg',
    });
  }, [pattern, project, shots, picks, format]);

  useEffect(() => {
    return window.breadcrumbs.on('export:progress', setProgress);
  }, []);

  if (!project || !plan) return <div className="export" />;

  const run = async (overwrite: boolean): Promise<void> => {
    if (!outputDir || plan.problem) return;

    setBusy(true);
    setProblem(null);
    setDone(null);
    setPendingOverwrite(null);

    const result = await window.breadcrumbs.invoke('export:run', {
      sourcePath: project.sourcePath,
      outputDir,
      format,
      quality,
      overwrite,
      entries: plan.entries as ExportPlanEntry[],
    });

    setBusy(false);
    setProgress(null);

    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    if (result.value.collisions.length > 0) {
      setPendingOverwrite(result.value.collisions);
      return;
    }
    setDone({ count: result.value.written.length, dir: result.value.outputDir, ms: result.value.elapsedMs });
  };

  const chooseFolder = async (): Promise<void> => {
    const chosen = await window.breadcrumbs.invoke('export:chooseFolder', { current: outputDir });
    if (chosen) setOutputDir(chosen);
  };

  return (
    <div className="export" role="dialog" aria-label="Export frames">
      <div className="export__head">
        <span className="export__title">Export frames</span>
        <span className="export__count">
          {plan.entries.length} {plan.entries.length === 1 ? 'frame' : 'frames'}
        </span>
        <span className="header__spacer" />
        <button type="button" className="button" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="export__body">
        <label className="field">
          <span className="field__label">Filename pattern</span>
          <input
            className="field__input"
            value={pattern}
            spellCheck={false}
            onChange={(event) => setPattern(event.target.value)}
          />
        </label>

        <div className="tokens">
          {TOKENS.map((entry) => (
            <button
              key={entry.token}
              type="button"
              className="tokens__item"
              title={`Insert ${entry.token} — ${entry.means}`}
              onClick={() => setPattern((current) => current + entry.token)}
            >
              <code>{entry.token}</code>
              <span>{entry.means}</span>
            </button>
          ))}
        </div>

        {/* Live preview: the first few names exactly as they will be written. */}
        <div className="preview-names">
          <span className="field__label">Will be written as</span>
          {plan.problem ? (
            <p className="preview-names__problem">{plan.problem.message}</p>
          ) : (
            <>
              {plan.abWasAdded ? (
                <p className="preview-names__note">
                  Added {'{ab}'} to the end — without it, the two frames of a paired shot would collide.
                </p>
              ) : null}
              <ul className="preview-names__list">
                {plan.entries.slice(0, 4).map((entry) => (
                  <li key={entry.filename}>{entry.filename}</li>
                ))}
                {plan.entries.length > 4 ? <li className="preview-names__more">…and {plan.entries.length - 4} more</li> : null}
              </ul>
            </>
          )}
        </div>

        <div className="export__row">
          <div className="segmented" role="group" aria-label="Format">
            {(['png', 'jpeg'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`segmented__option${format === option ? ' segmented__option--on' : ''}`}
                onClick={() => setFormat(option)}
                aria-pressed={format === option}
              >
                {option.toUpperCase()}
              </button>
            ))}
          </div>

          {format === 'jpeg' ? (
            <label className="field field--inline">
              <span className="field__label">Quality</span>
              <input
                type="range"
                min={1}
                max={100}
                value={quality}
                onChange={(event) => setQuality(Number(event.target.value))}
              />
              <span className="field__value">{quality}</span>
            </label>
          ) : null}
        </div>

        <div className="export__row">
          <button type="button" className="button" onClick={() => void chooseFolder()}>
            {outputDir ? 'Change folder' : 'Choose folder'}
          </button>
          <span className="export__path">{outputDir ?? 'No folder chosen yet'}</span>
        </div>

        {pendingOverwrite ? (
          <div className="export__confirm" role="alert">
            <p>
              {pendingOverwrite.length} {pendingOverwrite.length === 1 ? 'file' : 'files'} already exist in that
              folder. Overwrite them?
            </p>
            <div className="export__row">
              <button type="button" className="button" onClick={() => void run(true)}>
                Overwrite
              </button>
              <button type="button" className="button" onClick={() => setPendingOverwrite(null)}>
                Keep them
              </button>
            </div>
          </div>
        ) : null}

        {problem ? (
          <p className="export__problem" role="alert">
            {problem}
          </p>
        ) : null}

        {done ? (
          <div className="export__done">
            <p>
              Wrote {done.count} {done.count === 1 ? 'file' : 'files'} and manifest.csv in{' '}
              {(done.ms / 1000).toFixed(1)}s.
            </p>
            <button
              type="button"
              className="button"
              onClick={() => void window.breadcrumbs.invoke('export:reveal', { path: done.dir })}
            >
              Show the folder
            </button>
          </div>
        ) : null}
      </div>

      <div className="export__foot">
        {busy && progress ? (
          <div className="progress">
            <div
              className="progress__bar"
              style={{ width: `${Math.round((progress.written / Math.max(1, progress.total)) * 100)}%` }}
            />
          </div>
        ) : null}
        <span className="header__spacer" />
        <button
          type="button"
          className="button button--primary"
          disabled={busy || !outputDir || plan.problem !== null || plan.entries.length === 0}
          onClick={() => void run(false)}
        >
          {busy ? `Exporting ${progress?.written ?? 0} of ${progress?.total ?? plan.entries.length}` : 'Export'}
        </button>
      </div>
    </div>
  );
}
