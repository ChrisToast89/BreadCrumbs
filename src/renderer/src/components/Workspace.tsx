/**
 * Workspace — SPEC §7's three panes.
 *
 * Fixed 200px board on the left; the remainder split horizontally between
 * preview (top) and timeline (bottom), user-draggable.
 *
 * The keyboard map is SPEC §7's. Phase 5 wires only the read-only half of it:
 * up and down step through every frame on the board, and Tab toggles between
 * A and B within the selected shot. The editing keys land in phase 6.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { picksForShot } from '../../../shared/picks.js';
import { useStore } from '../store.js';
import { durationTimecode } from '../timecode.js';
import { Board } from './Board.js';
import { Preview } from './Preview.js';
import { Timeline } from './Timeline.js';

/** Bounds for the draggable split, so neither pane can be dragged away. */
const MIN_TIMELINE = 150;
const MIN_PREVIEW = 200;

function Header(): JSX.Element {
  const project = useStore((state) => state.project);
  const shots = useStore((state) => state.shots);
  const picks = useStore((state) => state.picks);
  const reset = useStore((state) => state.reset);

  if (!project) return <header className="header" />;

  const toCheck = shots.filter((shot, position) => position > 0 && shot.confidence < 0.5).length;

  return (
    <header className="header">
      <span className="header__name">{project.sourceName}</span>
      <span className="header__meta">
        {durationTimecode(project.index)} · {project.index.fps.toFixed(2)} fps ·{' '}
        {project.index.displayWidth} × {project.index.displayHeight}
      </span>
      {project.index.variableFrameRate ? <span className="header__badge">VFR</span> : null}
      {project.index.hdr ? <span className="header__badge">HDR</span> : null}
      <span className="header__spacer" />
      <span className="header__meta">
        {shots.length} shots · {picks.length} frames
        {toCheck > 0 ? ` · ${toCheck} to check` : ''}
      </span>
      <button type="button" className="button" onClick={() => void reset()}>
        Choose another
      </button>
      <button type="button" className="button" disabled title="Export arrives in phase 7">
        Export frames
      </button>
    </header>
  );
}

export function Workspace(): JSX.Element {
  const shots = useStore((state) => state.shots);
  const picks = useStore((state) => state.picks);
  const selectedShotId = useStore((state) => state.selectedShotId);
  const selectedPickId = useStore((state) => state.selectedPickId);
  const selectPick = useStore((state) => state.selectPick);
  const stepPick = useStore((state) => state.stepPick);

  const [timelineHeight, setTimelineHeight] = useState(246);
  const splitRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onPointerMove = useCallback((event: PointerEvent) => {
    if (!dragging.current || !splitRef.current) return;
    const box = splitRef.current.getBoundingClientRect();
    const next = box.bottom - event.clientY;
    setTimelineHeight(Math.max(MIN_TIMELINE, Math.min(box.height - MIN_PREVIEW, next)));
  }, []);

  const stopDrag = useCallback(() => {
    dragging.current = false;
  }, []);

  useEffect(() => {
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDrag);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopDrag);
    };
  }, [onPointerMove, stopDrag]);

  // SPEC §7 keyboard map — the read-only subset.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Up and down step through every frame on the board, A and B alike.
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        stepPick(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        stepPick(-1);
        return;
      }
      // Tab toggles between A and B within the selected shot.
      if (event.key === 'Tab' && selectedShotId) {
        const mine = picksForShot(picks, selectedShotId);
        if (mine.length < 2) return;
        event.preventDefault();
        const other = mine.find((pick) => pick.id !== selectedPickId);
        if (other) selectPick(other.id);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [picks, selectPick, selectedPickId, selectedShotId, stepPick, shots]);

  return (
    <div className="workspace">
      <Header />
      <div className="workspace__panes">
        <Board />
        <div className="workspace__right" ref={splitRef}>
          <Preview />
          <div
            className="splitter"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize preview and timeline"
            tabIndex={0}
            onPointerDown={(event) => {
              dragging.current = true;
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp') setTimelineHeight((height) => height + 16);
              if (event.key === 'ArrowDown') setTimelineHeight((height) => Math.max(MIN_TIMELINE, height - 16));
            }}
          >
            <span className="splitter__grip" aria-hidden="true" />
          </div>
          <div className="workspace__timeline" style={{ height: `${timelineHeight}px` }}>
            <Timeline />
          </div>
        </div>
      </div>
    </div>
  );
}
