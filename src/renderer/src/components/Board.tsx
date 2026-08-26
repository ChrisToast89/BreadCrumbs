/**
 * Board — SPEC §7, left pane, 200px, locked.
 *
 * A vertical filmstrip of shots in source order. Each cell carries a
 * thumbnail, the shot number and a timecode. Clicking selects. The selected
 * cell scrolls into view.
 *
 * A shot with an out-frame renders as a paired cell: the design's device is a
 * bracket down the left edge spanning both frames, with A and B shown at
 * half width side by side under one shot number. The bracket and the shared
 * backing are what stop the pair reading as two separate shots — which is the
 * thing SPEC §7 explicitly warns against.
 *
 * Read-only in phase 5. The hover remove control and editing arrive in phase 6.
 */

import { useEffect, useRef, type CSSProperties } from 'react';
import type { Pick, Shot, VideoIndex } from '../../../shared/types.js';
import { picksForShot } from '../../../shared/picks.js';
import { timecodeOf } from '../timecode.js';
import { useStore } from '../store.js';

interface CellProps {
  shot: Shot;
  position: number;
  index: VideoIndex;
  picks: Pick[];
  thumbnails: string[];
  selectedPickId: string | null;
  selected: boolean;
  onSelectPick: (pickId: string) => void;
  onReject: (shotId: string) => void;
}

function BoardCell({
  shot,
  position,
  index,
  picks,
  thumbnails,
  selectedPickId,
  selected,
  onSelectPick,
  onReject,
}: CellProps): JSX.Element {
  const mine = picksForShot(picks, shot.id);
  const a = mine.find((pick) => pick.role === 'A');
  const b = mine.find((pick) => pick.role === 'B');
  const paired = b !== undefined;

  const flag =
    shot.confidence < 0.5 ? 'check' : shot.boundary === 'soft' ? 'diss' : '';

  return (
    <div
      className={`cell${selected ? ' cell--selected' : ''}`}
      data-shot={shot.id}
      role="listitem"
    >
      <div className="cell__gutter">
        <span className="cell__number">{String(position + 1).padStart(2, '0')}</span>
        {paired ? <span className="cell__bracket" aria-hidden="true" /> : null}
      </div>

      <div className="cell__body">
        {paired && a && b ? (
          <div className="pair">
            <span className="pair__badge">A/B</span>
            <button
              type="button"
              className={`pair__half${selectedPickId === a.id ? ' pair__half--selected' : ''}`}
              onClick={() => onSelectPick(a.id)}
              aria-label={`Shot ${position + 1}, frame A, frame ${a.frame}`}
            >
              <img className="thumb" src={thumbnails[a.frame]} alt="" draggable={false} />
              <span className="pair__letter">A</span>
            </button>
            <button
              type="button"
              className={`pair__half${selectedPickId === b.id ? ' pair__half--selected' : ''}`}
              onClick={() => onSelectPick(b.id)}
              aria-label={`Shot ${position + 1}, frame B, frame ${b.frame}`}
            >
              <img className="thumb" src={thumbnails[b.frame]} alt="" draggable={false} />
              <span className="pair__letter">B</span>
            </button>
          </div>
        ) : a ? (
          <button
            type="button"
            className={`cell__single${selectedPickId === a.id ? ' cell__single--selected' : ''}`}
            onClick={() => onSelectPick(a.id)}
            aria-label={`Shot ${position + 1}, frame ${a.frame}`}
          >
            <img className="thumb" src={thumbnails[a.frame]} alt="" draggable={false} />
          </button>
        ) : null}

        <div className="cell__meta">
          <span className="cell__tc">{timecodeOf(index, a?.frame ?? shot.startFrame)}</span>
          <span className={`cell__flag${flag === 'check' ? ' cell__flag--check' : ''}`}>{flag}</span>
          <button
            type="button"
            className="cell__remove"
            onClick={() => onReject(shot.id)}
            aria-label={`Remove shot ${position + 1} from the board`}
            title="Remove from the board (X)"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
}

export function Board(): JSX.Element {
  const shots = useStore((state) => state.shots);
  const picks = useStore((state) => state.picks);
  const thumbnails = useStore((state) => state.thumbnails);
  const project = useStore((state) => state.project);
  const selectedShotId = useStore((state) => state.selectedShotId);
  const selectedPickId = useStore((state) => state.selectedPickId);
  const selectPick = useStore((state) => state.selectPick);
  const toggleReject = useStore((state) => state.toggleRejectSelected);
  const selectShot = useStore((state) => state.selectShot);

  const scrollerRef = useRef<HTMLDivElement>(null);

  // The selected cell scrolls into view (SPEC §7). The whole clip is in memory,
  // so this is a lookup and a scroll, never a load.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !selectedShotId) return;

    const cell = scroller.querySelector<HTMLElement>(`[data-shot="${selectedShotId}"]`);
    if (!cell) return;

    const cellBox = cell.getBoundingClientRect();
    const viewBox = scroller.getBoundingClientRect();
    if (cellBox.top < viewBox.top || cellBox.bottom > viewBox.bottom) {
      scroller.scrollTop += cellBox.top - viewBox.top - viewBox.height / 3;
    }
  }, [selectedShotId]);

  if (!project || !thumbnails) return <div className="board" />;

  const visible = shots.filter((shot) => !shot.rejected);

  return (
    <section className="board" aria-label="Board">
      <header className="pane-label">
        <span>Board</span>
        <span className="pane-label__count">{picks.length}</span>
      </header>
      <div
        className="board__scroller"
        ref={scrollerRef}
        role="list"
        // Display geometry drives thumbnail shape everywhere (I5).
        style={
          {
            '--frame-aspect': `${project.index.displayWidth} / ${project.index.displayHeight}`,
          } as CSSProperties
        }
      >
        {visible.map((shot) => (
          <BoardCell
            key={shot.id}
            shot={shot}
            position={shots.indexOf(shot)}
            index={project.index}
            picks={picks}
            thumbnails={thumbnails.urls}
            selectedPickId={selectedPickId}
            selected={shot.id === selectedShotId}
            onSelectPick={selectPick}
            onReject={(id) => {
              selectShot(id);
              toggleReject();
            }}
          />
        ))}
      </div>
    </section>
  );
}
