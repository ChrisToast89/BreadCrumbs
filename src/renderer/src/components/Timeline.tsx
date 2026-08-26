/**
 * Timeline — SPEC §7, bottom right. Two rows.
 *
 * Overview: the entire clip, always fitting the pane width. Shots are adjacent
 * blocks with their cut boundaries marked — the design uses a hairline at each
 * boundary, a soft wash for a dissolve, and an amber tick for a low-confidence
 * cut so the eye is drawn to what needs checking. This row does not zoom or
 * pan; it is orientation only.
 *
 * Shot row: the selected shot at frame resolution, one thumbnail per frame,
 * with A (and B, when present) marked by the design's tab-and-outline device.
 *
 * The shot row itself, with its draggable carrots and zoom, is its own module.
 */

import { useCallback, useEffect, useRef } from 'react';
import { picksForShot } from '../../../shared/picks.js';
import { useStore } from '../store.js';
import { shortTimecodeOf, timecodeOf } from '../timecode.js';
import { ShotRow } from './ShotRow.js';

function Overview(): JSX.Element {
  const project = useStore((state) => state.project);
  const shots = useStore((state) => state.shots);
  const picks = useStore((state) => state.picks);
  const selectedShotId = useStore((state) => state.selectedShotId);
  const selectedPickId = useStore((state) => state.selectedPickId);
  const selectShot = useStore((state) => state.selectShot);
  const scrubFrame = useStore((state) => state.scrubFrame);
  const setScrubFrame = useStore((state) => state.setScrubFrame);

  const trackRef = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);
  const frameCount = project?.index.frameCount ?? 0;

  /** Which frame a client x position falls on, across the whole clip. */
  const frameAtX = useCallback(
    (clientX: number): number => {
      const track = trackRef.current;
      if (!track || frameCount === 0) return 0;
      const box = track.getBoundingClientRect();
      const ratio = (clientX - box.left) / Math.max(1, box.width);
      return Math.max(0, Math.min(frameCount - 1, Math.round(ratio * (frameCount - 1))));
    },
    [frameCount],
  );

  // Scrubbing the whole clip. SPEC §7 keeps this row zoom-free and pan-free —
  // dragging here moves a playhead, it does not reshape the row.
  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      if (!scrubbing.current) return;
      setScrubFrame(frameAtX(event.clientX));
    };
    const onUp = (): void => {
      scrubbing.current = false;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [frameAtX, setScrubFrame]);

  if (!project) return <div className="overview" />;

  // The playhead sits at whatever is being previewed: the scrub if there is
  // one, otherwise the selected frame.
  const selectedFrame = picks.find((pick) => pick.id === selectedPickId)?.frame ?? 0;
  const playheadFrame = scrubFrame ?? selectedFrame;
  const playheadPercent = (playheadFrame / Math.max(1, frameCount - 1)) * 100;

  const total = project.index.frameCount;

  // A tick roughly every ten seconds, placed by frame so the ruler agrees with
  // the PTS table rather than with elapsed wall time (I1).
  const tickCount = Math.min(9, Math.max(2, Math.floor(project.index.durationSec / 10)));
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => {
    const frame = Math.round((i / tickCount) * (total - 1));
    return { frame, percent: (frame / Math.max(1, total - 1)) * 100 };
  });

  return (
    <>
      <div className="ticks" aria-hidden="true">
        {ticks.map((tick) => (
          <span className="ticks__tick" key={tick.frame} style={{ left: `${tick.percent}%` }}>
            <span className="ticks__label">{shortTimecodeOf(project.index, tick.frame)}</span>
          </span>
        ))}
      </div>

      <div
        className="overview"
        role="list"
        aria-label="Whole clip"
        ref={trackRef}
        onPointerDown={(event) => {
          // Dragging anywhere on the row scrubs; a plain click still selects
          // the shot underneath, handled by the block below.
          if (event.button !== 0) return;
          scrubbing.current = true;
          setScrubFrame(frameAtX(event.clientX));
        }}
      >
        {shots.map((shot, position) => {
          const width = ((shot.endFrame - shot.startFrame + 1) / total) * 100;
          const paired = picksForShot(picks, shot.id).length > 1;
          const lowConfidence = position > 0 && shot.confidence < 0.5;

          return (
            <button
              type="button"
              key={shot.id}
              role="listitem"
              className={[
                'block',
                shot.id === selectedShotId ? 'block--selected' : '',
                shot.rejected ? 'block--rejected' : '',
                shot.boundary === 'soft' ? 'block--soft' : '',
                position % 2 === 1 ? 'block--alt' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ width: `${width}%` }}
              onClick={() => selectShot(shot.id)}
              aria-label={`Shot ${position + 1}, ${shot.boundary} cut${lowConfidence ? ', low confidence' : ''}`}
            >
              {shot.boundary === 'soft' ? <span className="block__soft" aria-hidden="true" /> : null}
              {lowConfidence ? <span className="block__check" aria-hidden="true" /> : null}
              {paired ? <span className="block__pair" aria-hidden="true">AB</span> : null}
            </button>
          );
        })}

        <span
          className="playhead"
          style={{ left: `${playheadPercent}%` }}
          aria-hidden="true"
        >
          <span className="playhead__head" />
        </span>
      </div>
    </>
  );
}

export function Timeline(): JSX.Element {
  const project = useStore((state) => state.project);
  const shots = useStore((state) => state.shots);
  const picks = useStore((state) => state.picks);
  const selectedShotId = useStore((state) => state.selectedShotId);

  const shot = shots.find((candidate) => candidate.id === selectedShotId) ?? null;
  const mine = shot ? picksForShot(picks, shot.id) : [];
  const a = mine.find((pick) => pick.role === 'A');
  const b = mine.find((pick) => pick.role === 'B');

  if (!project) return <div className="timeline" />;

  return (
    <section className="timeline" aria-label="Timeline">
      <Overview />

      <div className="shotmeta">
        {shot ? (
          <>
            <span className="shotmeta__strong">
              shot {shots.indexOf(shot) + 1} · {shot.endFrame - shot.startFrame + 1} frames ·{' '}
              {timecodeOf(project.index, shot.startFrame)} → {timecodeOf(project.index, shot.endFrame)}
            </span>
            <span>A at {a ? String(a.frame - shot.startFrame).padStart(3, '0') : '—'}</span>
            <span>B at {b ? String(b.frame - shot.startFrame).padStart(3, '0') : '—'}</span>
            <span>span {a && b ? b.frame - a.frame : 0} frames</span>
            <span className="shotmeta__spacer" />
            <span>{shot.boundary === 'soft' ? 'dissolve in' : 'hard cut in'}</span>
          </>
        ) : null}
      </div>

      {shot ? <ShotRow shot={shot} mine={mine} /> : <div className="shotrow" />}
    </section>
  );
}
