/**
 * Phase 6 gate checks, run against the data layer with no interface involved.
 *
 * MILESTONES phase 6 asks that a third frame on a shot be impossible "through
 * any path, including undo replay", and says to "verify at the store level, not
 * just the UI". These functions therefore drive `shared/editing.ts` directly:
 * whatever the interface does, it goes through the same code, so a rule proved
 * here holds there too.
 */

import type { FrameMetrics, Pick, Shot } from '../src/shared/types.js';
import type { Settings } from '../src/shared/settings.js';
import {
  addOutFrame,
  mergeIntoPrevious,
  movePickTo,
  remember,
  removeOutFrame,
  splitAt,
  toggleRejected,
  undo,
  UNDO_LIMIT,
  type Board,
  type History,
} from '../src/shared/editing.js';
import { assertPickRules, findPick, picksForShot } from '../src/shared/picks.js';
import { chooseOutFrame } from '../src/shared/frameChoice.js';

export interface CheckResult {
  label: string;
  passed: boolean;
  detail: string;
}

/** Compare two boards for exact equality, including pick positions and pinning. */
function sameBoard(a: Board, b: Board): boolean {
  const shots = (list: Shot[]): string =>
    list.map((s) => `${s.id}:${s.startFrame}-${s.endFrame}:${s.boundary}:${s.rejected}`).join('|');
  const picks = (list: Pick[]): string =>
    [...list]
      .sort((x, y) => x.id.localeCompare(y.id))
      .map((p) => `${p.id}:${p.shotId}:${p.frame}:${p.role}:${p.pinned}`)
      .join('|');
  return shots(a.shots) === shots(b.shots) && picks(a.picks) === picks(b.picks);
}

export function runEditingChecks(
  shots: Shot[],
  picks: Pick[],
  metrics: FrameMetrics,
  settings: Settings,
): CheckResult[] {
  const results: CheckResult[] = [];
  const start: Board = { shots, picks };

  const check = (label: string, passed: boolean, detail: string): void => {
    results.push({ label, passed, detail });
  };

  // --- A pick cannot be dragged outside its own shot ------------------------
  {
    const shot = start.shots[0] as Shot;
    const a = findPick(start.picks, shot.id, 'A') as Pick;

    const wayBefore = movePickTo(start, a.id, shot.startFrame - 500);
    const wayAfter = movePickTo(start, a.id, shot.endFrame + 500);
    const low = (findPick(wayBefore.picks, shot.id, 'A') as Pick).frame;
    const high = (findPick(wayAfter.picks, shot.id, 'A') as Pick).frame;

    check(
      'pick clamps to its own shot',
      low === shot.startFrame && high === shot.endFrame,
      `asked for ${shot.startFrame - 500} and ${shot.endFrame + 500}, got ${low} and ${high}`,
    );
    check('a moved pick is pinned (I6)', (findPick(wayBefore.picks, shot.id, 'A') as Pick).pinned, 'pinned');
  }

  // --- The default out-frame -----------------------------------------------
  let paired: Board = start;
  {
    const shot = start.shots.find((s) => s.endFrame - s.startFrame > 8) ?? (start.shots[0] as Shot);
    const a = findPick(start.picks, shot.id, 'A') as Pick;

    paired = addOutFrame(start, shot.id, metrics, settings);
    const b = findPick(paired.picks, shot.id, 'B');

    check('adding an out-frame yields a pair', b !== undefined, b ? `A ${a.frame}, B ${b.frame}` : 'no B');
    check(
      'default out-frame is not the last frame',
      b !== undefined && (b.frame < shot.endFrame || shot.endFrame - a.frame <= 2),
      b ? `B at ${b.frame}, shot ends ${shot.endFrame}` : 'no B',
    );
    check(
      'default out-frame lands after A (I8)',
      b !== undefined && b.frame > a.frame,
      b ? `A ${a.frame} < B ${b.frame}` : 'no B',
    );

    // --- A third frame must be impossible --------------------------------
    const third = addOutFrame(paired, shot.id, metrics, settings);
    check(
      'a third frame is refused',
      picksForShot(third.picks, shot.id).length === 2,
      `${picksForShot(third.picks, shot.id).length} picks after asking for a third`,
    );

    // ...including by forging one straight into the array, which is what an
    // undo replay of a bad snapshot would look like.
    let forgedRejected = false;
    try {
      assertPickRules(
        [...paired.picks, { id: 'forged', shotId: shot.id, frame: shot.endFrame, role: 'B', pinned: true }],
        paired.shots,
      );
    } catch {
      forgedRejected = true;
    }
    check('the data layer rejects a forged third frame', forgedRejected, 'assertPickRules threw');

    // --- Carrots clamp rather than cross (I8) ----------------------------
    const bPick = findPick(paired.picks, shot.id, 'B') as Pick;
    const aPick = findPick(paired.picks, shot.id, 'A') as Pick;

    const aPushedPastB = movePickTo(paired, aPick.id, bPick.frame + 20);
    const bPushedPastA = movePickTo(paired, bPick.id, aPick.frame - 20);
    const aAfter = findPick(aPushedPastB.picks, shot.id, 'A') as Pick;
    const bAfter = findPick(bPushedPastA.picks, shot.id, 'B') as Pick;

    check(
      'A clamps below B, never crossing (I8)',
      aAfter.frame < bPick.frame && aAfter.frame === bPick.frame - 1,
      `A stopped at ${aAfter.frame}, B at ${bPick.frame}`,
    );
    check(
      'B clamps above A, never crossing (I8)',
      bAfter.frame > aPick.frame && bAfter.frame === aPick.frame + 1,
      `B stopped at ${bAfter.frame}, A at ${aPick.frame}`,
    );

    // --- Remove never touches A ------------------------------------------
    const removed = removeOutFrame(paired, shot.id);
    check(
      'removing the out-frame leaves A alone',
      picksForShot(removed.picks, shot.id).length === 1 &&
        (findPick(removed.picks, shot.id, 'A') as Pick).frame === aPick.frame,
      `A still at ${(findPick(removed.picks, shot.id, 'A') as Pick).frame}`,
    );
  }

  // --- Split ----------------------------------------------------------------
  if (start.shots.length > 0) {
    const shot = start.shots.find((s) => s.endFrame - s.startFrame > 6) ?? (start.shots[0] as Shot);
    const at = shot.startFrame + Math.floor((shot.endFrame - shot.startFrame) / 2);
    const after = splitAt(start, shot.id, at, metrics, settings);

    const index = after.shots.findIndex((s) => s.id === shot.id);
    const first = after.shots[index] as Shot;
    const second = after.shots[index + 1] as Shot;

    check(
      'split makes two shots',
      after.shots.length === start.shots.length + 1,
      `${start.shots.length} -> ${after.shots.length}`,
    );
    check(
      'split ranges are contiguous and non-overlapping',
      first.endFrame + 1 === second.startFrame &&
        first.startFrame === shot.startFrame &&
        second.endFrame === shot.endFrame,
      `${first.startFrame}-${first.endFrame} then ${second.startFrame}-${second.endFrame}`,
    );
    check(
      'both halves have exactly one A',
      picksForShot(after.picks, first.id).filter((p) => p.role === 'A').length === 1 &&
        picksForShot(after.picks, second.id).filter((p) => p.role === 'A').length === 1,
      'one A each',
    );

    // The whole clip must still be covered, with no gaps.
    let contiguous = true;
    for (let i = 1; i < after.shots.length; i += 1) {
      if ((after.shots[i] as Shot).startFrame !== (after.shots[i - 1] as Shot).endFrame + 1) contiguous = false;
    }
    check('the clip is still tiled exactly after a split', contiguous, 'no gaps or overlaps');
  }

  // --- Merge, and undo restoring exactly -----------------------------------
  if (start.shots.length >= 2) {
    const target = start.shots[1] as Shot;
    const before: Board = start;

    let history: History = { past: [] };
    history = remember(history, before);
    const merged = mergeIntoPrevious(before, target.id);

    check(
      'merge joins into the previous shot',
      merged.shots.length === before.shots.length - 1 &&
        (merged.shots[0] as Shot).endFrame === target.endFrame,
      `${before.shots.length} -> ${merged.shots.length}`,
    );

    const restored = undo(history);
    check(
      'merge then undo restores the exact prior state',
      restored.board !== null && sameBoard(restored.board, before),
      restored.board ? 'shots and picks identical, including frames and pinning' : 'nothing to undo',
    );
  }

  // --- Merging two shots that each have an out-frame -----------------------
  if (start.shots.length >= 2) {
    const first = start.shots[0] as Shot;
    const second = start.shots[1] as Shot;

    let board: Board = start;
    board = addOutFrame(board, first.id, metrics, settings);
    board = addOutFrame(board, second.id, metrics, settings);

    const beforeMerge = board;
    const picksBefore =
      picksForShot(board.picks, first.id).length + picksForShot(board.picks, second.id).length;

    let history: History = { past: [] };
    history = remember(history, beforeMerge);
    const merged = mergeIntoPrevious(board, second.id);
    const survivors = picksForShot(merged.picks, first.id);

    check(
      'merging two paired shots yields exactly two frames (I8)',
      survivors.length === 2 && survivors[0]?.role === 'A' && survivors[1]?.role === 'B',
      `${picksBefore} picks became ${survivors.length}`,
    );
    check(
      'A precedes B in the merged shot',
      survivors.length === 2 && (survivors[0] as Pick).frame < (survivors[1] as Pick).frame,
      survivors.length === 2 ? `${(survivors[0] as Pick).frame} < ${(survivors[1] as Pick).frame}` : 'n/a',
    );

    const restored = undo(history);
    check(
      'the discarded frames come back on undo',
      restored.board !== null && sameBoard(restored.board, beforeMerge),
      restored.board
        ? `${restored.board.picks.length} picks restored, all four frames back`
        : 'nothing to undo',
    );
  }

  // --- Reject ---------------------------------------------------------------
  {
    const shot = start.shots[0] as Shot;
    const rejected = toggleRejected(start, shot.id);
    const back = toggleRejected(rejected, shot.id);

    check(
      'reject marks the shot but keeps it in the clip',
      (rejected.shots[0] as Shot).rejected &&
        rejected.shots.length === start.shots.length &&
        picksForShot(rejected.picks, shot.id).length === picksForShot(start.picks, shot.id).length,
      'still present, still has its picks, flagged rejected',
    );
    check('reject toggles back', !(back.shots[0] as Shot).rejected, 'unrejected');
  }

  // --- Undo depth -----------------------------------------------------------
  {
    let history: History = { past: [] };
    let board: Board = start;
    const shot = start.shots[0] as Shot;
    const a = findPick(start.picks, shot.id, 'A') as Pick;

    for (let i = 0; i < UNDO_LIMIT + 20; i += 1) {
      history = remember(history, board);
      board = movePickTo(board, a.id, shot.startFrame + (i % Math.max(1, shot.endFrame - shot.startFrame)));
    }
    check(
      `undo history is capped at ${UNDO_LIMIT} steps`,
      history.past.length === UNDO_LIMIT,
      `${history.past.length} steps held after ${UNDO_LIMIT + 20} edits`,
    );

    // Walking all the way back must never produce an illegal board.
    let legal = true;
    let steps = 0;
    let cursor = history;
    for (;;) {
      const result = undo(cursor);
      if (!result.board) break;
      try {
        assertPickRules(result.board.picks, result.board.shots);
      } catch {
        legal = false;
      }
      cursor = result.history;
      steps += 1;
    }
    check(
      'every step of undo replay is a legal board (I8)',
      legal && steps === UNDO_LIMIT,
      `${steps} steps replayed, all legal`,
    );
  }

  // --- The out-frame default, checked against the rule directly -------------
  {
    const roomy = start.shots.filter((s) => s.endFrame - s.startFrame > 4);
    const onFinal = roomy.filter((shot) => {
      const a = findPick(start.picks, shot.id, 'A') as Pick;
      return chooseOutFrame(shot, a.frame, metrics, settings) === shot.endFrame;
    }).length;
    check(
      'no default out-frame lands on the final frame',
      onFinal === 0,
      `${onFinal} of ${roomy.length} shots with room`,
    );
  }

  return results;
}
