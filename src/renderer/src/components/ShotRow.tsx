/**
 * Shot row — SPEC §7, bottom of the timeline.
 *
 * The selected shot expanded to frame resolution: a thumbnail per frame, with
 * the carrot handles dragging at 1:1 so precision does not depend on clip
 * length. Wheel zooms about the cursor; middle-drag or shift+left-drag pans.
 *
 * When a shot has an out-frame, two carrots appear, labelled A and B, with the
 * span between them tinted. Each drags independently but cannot cross the
 * other — the clamp lives in the data layer (I8), not here, so dragging past
 * the partner simply stops.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type WheelEvent,
} from 'react';
import type { Pick, Shot } from '../../../shared/types.js';
import { useStore } from '../store.js';
import { ContextMenu, type MenuItem } from './ContextMenu.js';

/** Zoom limits, as a multiplier on the design's frame cell width. */
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 6;

interface Props {
  shot: Shot;
  mine: Pick[];
}

export function ShotRow({ shot, mine }: Props): JSX.Element {
  const project = useStore((state) => state.project);
  const thumbnails = useStore((state) => state.thumbnails);
  const selectedPickId = useStore((state) => state.selectedPickId);
  const selectPick = useStore((state) => state.selectPick);
  const movePick = useStore((state) => state.movePick);
  const addOutFrameAt = useStore((state) => state.addOutFrameAt);
  const removeOutFrame = useStore((state) => state.removeOutFrame);

  /** Open right-click menu, positioned at the cursor. */
  const [menu, setMenu] = useState<{ x: number; y: number; frame: number } | null>(null);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);

  /** The pick currently being dragged, if any. */
  const dragging = useRef<{ pickId: string; pointerId: number } | null>(null);
  /** Pan origin while middle-dragging. */
  const panning = useRef<{ x: number; scrollLeft: number } | null>(null);

  const a = mine.find((pick) => pick.role === 'A');
  const b = mine.find((pick) => pick.role === 'B');

  const cellWidth = 46 * zoom;

  /** What right-clicking a frame offers. */
  const menuItems = (frame: number): MenuItem[] => {
    const canBeOut = a !== undefined && frame > a.frame;
    return [
      {
        label: 'Set as in frame (A)',
        hint: b !== undefined && frame >= b.frame ? 'must be before B' : undefined,
        disabled: a === undefined || (b !== undefined && frame >= b.frame),
        onSelect: () => {
          if (a) movePick(a.id, frame);
        },
      },
      {
        label: b === undefined ? 'Set as out frame (B)' : 'Move out frame (B) here',
        hint: canBeOut ? undefined : 'must be after A',
        disabled: !canBeOut,
        onSelect: () => {
          if (b) movePick(b.id, frame);
          else addOutFrameAt(frame);
        },
      },
      {
        label: 'Remove out frame',
        disabled: b === undefined,
        onSelect: () => removeOutFrame(),
      },
    ];
  };
  const frameCount = shot.endFrame - shot.startFrame + 1;

  /** Which frame sits under a client x position. */
  const frameAt = useCallback(
    (clientX: number): number => {
      const scroller = scrollerRef.current;
      if (!scroller) return shot.startFrame;
      const box = scroller.getBoundingClientRect();
      const offset = clientX - box.left + scroller.scrollLeft - 10; // 10px strip padding
      const index = Math.round(offset / (cellWidth + 2));
      return shot.startFrame + Math.max(0, Math.min(frameCount - 1, index));
    },
    [cellWidth, frameCount, shot.startFrame],
  );

  // Dragging a carrot. Pointer events are tracked on the window so the drag
  // survives the cursor leaving the row.
  useEffect(() => {
    const onMove = (event: globalThis.PointerEvent): void => {
      if (panning.current && scrollerRef.current) {
        scrollerRef.current.scrollLeft = panning.current.scrollLeft - (event.clientX - panning.current.x);
        return;
      }
      const drag = dragging.current;
      if (!drag) return;
      // Reading an array and setting state: no decode, no IPC, no lag.
      movePick(drag.pickId, frameAt(event.clientX));
    };

    const onUp = (): void => {
      dragging.current = null;
      panning.current = null;
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [frameAt, movePick]);

  // Keep the selected carrot in view when selection moves between shots.
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
  }, [shot.id]);

  /** Wheel zooms about the cursor, so the frame under the pointer stays put. */
  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    event.preventDefault();

    const box = scroller.getBoundingClientRect();
    const pointerOffset = event.clientX - box.left;
    const contentUnderPointer = scroller.scrollLeft + pointerOffset;
    const ratio = contentUnderPointer / Math.max(1, scroller.scrollWidth);

    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
    setZoom(next);

    // Restore the pointer's position within the content after the relayout.
    requestAnimationFrame(() => {
      scroller.scrollLeft = ratio * scroller.scrollWidth - pointerOffset;
    });
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    // Middle-drag, or shift + left-drag, pans (SPEC §7).
    if (event.button === 1 || (event.button === 0 && event.shiftKey)) {
      event.preventDefault();
      panning.current = { x: event.clientX, scrollLeft: scrollerRef.current?.scrollLeft ?? 0 };
    }
  };

  if (!project || !thumbnails) return <div className="shotrow" />;

  const frames: number[] = [];
  for (let frame = shot.startFrame; frame <= shot.endFrame; frame += 1) frames.push(frame);

  return (
    <div
      className={`shotrow${panning.current ? ' shotrow--panning' : ''}`}
      ref={scrollerRef}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
    >
      <div
        className="shotrow__strip"
        style={
          {
            '--frame-aspect': `${project.index.displayWidth} / ${project.index.displayHeight}`,
            '--frame-cell-width': `${cellWidth}px`,
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
              onClick={(event) => {
                if (event.shiftKey) return; // shift+drag is a pan, not a click
                if (pickHere) selectPick(pickHere.id);
                else if (a) movePick(a.id, frame);
              }}
              onDoubleClick={() => {
                // Double-click adds an out-frame here, if the shot has none.
                if (!b) addOutFrameAt(frame);
              }}
              onPointerDown={(event) => {
                if (event.button !== 0 || event.shiftKey || !pickHere) return;
                dragging.current = { pickId: pickHere.id, pointerId: event.pointerId };
                selectPick(pickHere.id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                selectPick(pickHere?.id ?? a?.id ?? '');
                setMenu({ x: event.clientX, y: event.clientY, frame });
              }}
              aria-label={`Frame ${frame}${isA ? ', frame A' : ''}${isB ? ', frame B' : ''}`}
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

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.frame)} onClose={() => setMenu(null)} />
      ) : null}
    </div>
  );
}
