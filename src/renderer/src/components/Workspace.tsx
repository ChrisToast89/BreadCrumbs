/**
 * Workspace — SPEC §7's three panes.
 *
 * Fixed 200px board on the left; the remainder split horizontally between
 * preview (top) and timeline (bottom), user-draggable.
 *
 * The SPEC §7 keyboard map is wired here, at the window, so it works wherever
 * focus happens to be — except inside a text field, which keeps its own keys.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { picksForShot } from '../../../shared/picks.js';
import { useStore } from '../store.js';
import { durationTimecode } from '../timecode.js';
import { Board } from './Board.js';
import { Preview } from './Preview.js';
import { Timeline } from './Timeline.js';
import { HintBar } from './HintBar.js';
import { ExportBar } from './ExportBar.js';

/** Bounds for the draggable split, so neither pane can be dragged away. */
const MIN_TIMELINE = 150;
const MIN_PREVIEW = 200;

function Header({ onExport }: { onExport: () => void }): JSX.Element {
  const project = useStore((state) => state.project);
  const shots = useStore((state) => state.shots);
  const picks = useStore((state) => state.picks);
  const reset = useStore((state) => state.reset);
  const showExcluded = useStore((state) => state.showExcluded);
  const toggleShowExcluded = useStore((state) => state.toggleShowExcluded);

  if (!project) return <header className="header" />;

  const toCheck = shots.filter((shot, position) => position > 0 && shot.confidence < 0.5).length;
  const excludedCount = shots.filter((shot) => shot.rejected).length;
  // The board lists what will be exported, so its count is frames on included
  // shots — not every pick that exists.
  const exportCount = picks.filter((pick) => {
    const shot = shots.find((candidate) => candidate.id === pick.shotId);
    return shot !== undefined && !shot.rejected;
  }).length;

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
        {shots.length} shots · {exportCount} frames
        {toCheck > 0 ? ` · ${toCheck} to check` : ''}
      </span>
      {excludedCount > 0 ? (
        <button
          type="button"
          className={`toggle${showExcluded ? ' toggle--on' : ''}`}
          onClick={toggleShowExcluded}
          aria-pressed={showExcluded}
          title={
            showExcluded
              ? 'Hide excluded shots in the board'
              : 'Show excluded shots in the board'
          }
        >
          {excludedCount} excluded
        </button>
      ) : null}
      <button type="button" className="button" onClick={() => void reset()}>
        Choose another
      </button>
      <button type="button" className="button button--primary" onClick={onExport}>
        Export frames
      </button>
    </header>
  );
}

export function Workspace(): JSX.Element {
  const picks = useStore((state) => state.picks);
  const selectedShotId = useStore((state) => state.selectedShotId);
  const selectedPickId = useStore((state) => state.selectedPickId);
  const selectPick = useStore((state) => state.selectPick);
  const stepPick = useStore((state) => state.stepPick);
  const nudgeSelected = useStore((state) => state.nudgeSelected);
  const mergeSelected = useStore((state) => state.mergeSelected);
  const splitSelected = useStore((state) => state.splitSelected);
  const toggleRejectSelected = useStore((state) => state.toggleRejectSelected);
  const toggleOutFrame = useStore((state) => state.toggleOutFrame);
  const removeOutFrame = useStore((state) => state.removeOutFrame);
  const undo = useStore((state) => state.undo);

  const [exporting, setExporting] = useState(false);
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

  // The SPEC §7 keyboard map, in full.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Never steal keys from a text field — the export pattern editor in
      // phase 7 will be one.
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }

      // Undo first: it must work regardless of what else is bound.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        undo();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      switch (event.key) {
        // Left and right nudge the pick by one frame, ten with shift.
        case 'ArrowLeft':
          event.preventDefault();
          nudgeSelected(event.shiftKey ? -10 : -1);
          return;
        case 'ArrowRight':
          event.preventDefault();
          nudgeSelected(event.shiftKey ? 10 : 1);
          return;
        // Up and down step through every frame on the board, A and B alike.
        case 'ArrowDown':
          event.preventDefault();
          stepPick(1);
          return;
        case 'ArrowUp':
          event.preventDefault();
          stepPick(-1);
          return;
        case 'Delete':
        case 'Backspace':
          // Removes the out-frame only. A shot always has A (SPEC §7).
          event.preventDefault();
          removeOutFrame();
          return;
        default:
          break;
      }

      // Tab toggles between A and B within the selected shot.
      if (event.key === 'Tab' && selectedShotId) {
        const mine = picksForShot(picks, selectedShotId);
        if (mine.length < 2) return;
        event.preventDefault();
        const other = mine.find((pick) => pick.id !== selectedPickId);
        if (other) selectPick(other.id);
        return;
      }

      switch (event.key.toLowerCase()) {
        case 'm':
          event.preventDefault();
          mergeSelected();
          break;
        case 's':
          event.preventDefault();
          splitSelected();
          break;
        case 'x':
          event.preventDefault();
          toggleRejectSelected();
          break;
        case 'b':
          event.preventDefault();
          toggleOutFrame();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    mergeSelected,
    nudgeSelected,
    picks,
    removeOutFrame,
    selectPick,
    selectedPickId,
    selectedShotId,
    splitSelected,
    stepPick,
    toggleOutFrame,
    toggleRejectSelected,
    undo,
  ]);

  return (
    <div className="workspace">
      <Header onExport={() => setExporting(true)} />
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
      <HintBar />
      {exporting ? <ExportBar onClose={() => setExporting(false)} /> : null}
    </div>
  );
}
