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
 * Phase 5 is read-only. The draggable carrot, wheel zoom and middle-drag pan
 * arrive in phase 6.
 */

import { useEffect, useRef, type CSSProperties } from 'react';
import type { Pick, Shot } from '../../../shared/types.js';
import { picksForShot } from '../../../shared/picks.js';
import { useStore } from '../store.js';
import { shortTimecodeOf, timecodeOf } from '../timecode.js';

function Overview(): JSX.Element {
  const project = useStore((state) => state.project);
  const shots = useStore((state) => state.shots);
  const picks = useStore((state) => state.picks);
  const selectedShotId = useStore((state) => state.selectedShotId);
  const selectShot = useStore((state) => state.selectShot);

  if (!project) return <div className="overview" />;

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

      <div className="overview" role="list" aria-label="Whole clip">
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
      </div>
    </>
  );
}

interface ShotRowProps {
  shot: Shot;
  mine: Pick[];
}

function ShotRow({ shot, mine }: ShotRowProps): JSX.Element {
  const project = useStore((state) => state.project);
  const thumbnails = useStore((state) => state.thumbnails);
  const selectedPickId = useStore((state) => state.selectedPickId);
  const selectPick = useStore((state) => state.selectPick);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const a = mine.find((pick) => pick.role === 'A');
  const b = mine.find((pick) => pick.role === 'B');

  // Keep the selected frame in view as selection moves between shots.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const cell = scroller.querySelector<HTMLElement>('.frame--a');
    if (!cell) return;
    const cellBox = cell.getBoundingClientRect();
    const viewBox = scroller.getBoundingClientRect();
    if (cellBox.left < viewBox.left || cellBox.right > viewBox.right) {
      scroller.scrollLeft += cellBox.left - viewBox.left - viewBox.width / 3;
    }
  }, [shot.id, a?.frame]);

  if (!project || !thumbnails) return <div className="shotrow" />;

  const frames: number[] = [];
  for (let frame = shot.startFrame; frame <= shot.endFrame; frame += 1) frames.push(frame);

  return (
    <div className="shotrow" ref={scrollerRef}>
      <div
        className="shotrow__strip"
        // Display geometry drives the cell shape (I5).
        style={
          {
            '--frame-aspect': `${project.index.displayWidth} / ${project.index.displayHeight}`,
          } as CSSProperties
        }
      >
        {frames.map((frame) => {
          const isA = a?.frame === frame;
          const isB = b?.frame === frame;
          const inSpan = a !== undefined && b !== undefined && frame > a.frame && frame < b.frame;
          const pickHere = isA ? a : isB ? b : undefined;

          return (
            <button
              type="button"
              key={frame}
              className={[
                'frame',
                isA ? 'frame--a' : '',
                isB ? 'frame--b' : '',
                inSpan ? 'frame--span' : '',
                pickHere && pickHere.id === selectedPickId ? 'frame--current' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => {
                if (pickHere) selectPick(pickHere.id);
              }}
              aria-label={`Frame ${frame}`}
            >
              <img className="frame__image" src={thumbnails.urls[frame]} alt="" draggable={false} />
              {isA ? <span className="frame__tab frame__tab--a" aria-hidden="true" /> : null}
              {isB ? <span className="frame__tab frame__tab--b" aria-hidden="true" /> : null}
              {isA ? <span className="frame__letter">A</span> : null}
              {isB ? <span className="frame__letter">B</span> : null}
              <span className="frame__number">{String(frame - shot.startFrame).padStart(3, '0')}</span>
            </button>
          );
        })}
      </div>
    </div>
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
