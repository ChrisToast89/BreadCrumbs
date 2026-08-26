/**
 * Hint bar along the bottom of the window.
 *
 * SPEC §7 gives a keyboard map and a set of mouse interactions but no way to
 * discover either. This is that: a quiet, always-present line of what the keys
 * and the mouse do right now. It is the only addition to the three-pane layout.
 *
 * The hints are contextual — merge is only offered when there is a shot before
 * the selected one, the out-frame hint says add or remove depending on what
 * the shot already has — so the bar describes the state in front of you rather
 * than reciting a manual.
 */

import { picksForShot } from '../../../shared/picks.js';
import { useStore } from '../store.js';

interface Hint {
  keys: string;
  label: string;
}

export function HintBar(): JSX.Element {
  const shots = useStore((state) => state.shots);
  const picks = useStore((state) => state.picks);
  const selectedShotId = useStore((state) => state.selectedShotId);
  const undoDepth = useStore((state) => state.undoDepth);

  const shot = shots.find((candidate) => candidate.id === selectedShotId) ?? null;
  const mine = shot ? picksForShot(picks, shot.id) : [];
  const hasOutFrame = mine.some((pick) => pick.role === 'B');
  const isFirst = shot !== null && shots.indexOf(shot) === 0;
  const steps = undoDepth();

  const keyHints: Hint[] = [
    { keys: '← →', label: 'nudge frame' },
    { keys: '⇧← →', label: 'by 10' },
    { keys: '↑ ↓', label: 'next frame on board' },
    ...(mine.length > 1 ? [{ keys: 'tab', label: 'A / B' }] : []),
    { keys: 'B', label: hasOutFrame ? 'remove out frame' : 'add out frame' },
    ...(isFirst ? [] : [{ keys: 'M', label: 'merge into previous' }]),
    { keys: 'S', label: 'split here' },
    { keys: 'X', label: shot?.rejected ? 'include in export' : 'exclude from export' },
    { keys: 'space', label: 'play shot' },
    { keys: 'L', label: 'loop' },
    ...(steps > 0 ? [{ keys: 'ctrl+Z', label: `undo (${steps})` }] : []),
  ];

  const mouseHints: Hint[] = [
    { keys: 'drag', label: 'move carrot' },
    { keys: 'right-click', label: 'set in / out' },
    { keys: 'double-click', label: 'add out frame' },
    { keys: 'wheel', label: 'zoom row' },
    { keys: '⇧drag', label: 'pan row' },
    { keys: 'drag overview', label: 'scrub' },
  ];

  return (
    <footer className="hints" aria-label="Shortcuts">
      <ul className="hints__group">
        {keyHints.map((hint) => (
          <li className="hints__item" key={hint.keys + hint.label}>
            <kbd className="hints__keys">{hint.keys}</kbd>
            <span className="hints__label">{hint.label}</span>
          </li>
        ))}
      </ul>
      <span className="hints__spacer" />
      <ul className="hints__group hints__group--mouse">
        {mouseHints.map((hint) => (
          <li className="hints__item" key={hint.keys}>
            <span className="hints__keys hints__keys--mouse">{hint.keys}</span>
            <span className="hints__label">{hint.label}</span>
          </li>
        ))}
      </ul>
    </footer>
  );
}
