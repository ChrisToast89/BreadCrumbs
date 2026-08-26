/**
 * Editing operations — merge, split, reject, and the pick moves.
 *
 * These are pure functions over `{ shots, picks }`, deliberately living in
 * `shared` and not in the store. MILESTONES phase 6 requires that a third frame
 * on a shot be impossible "through any path, including undo replay", and asks
 * for that verified "at the store level, not just the UI" — so the rules have
 * to sit somewhere both the store and the inspect CLI can exercise, with no
 * React and no window involved.
 *
 * Every operation ends by running `assertPickRules`, so I8 is checked at the
 * moment a change is introduced rather than discovered later as a wrong file
 * at export time.
 *
 * Merge, split and reject are the correction path. SPEC §7 is explicit that the
 * tool's usability depends entirely on how cheap it is to fix detection, which
 * is why these are one keystroke each and why undo restores exactly.
 */

import type { FrameMetrics, Pick, Shot } from './types.js';
import type { Settings } from './settings.js';
import { chooseFrame, chooseOutFrame } from './frameChoice.js';
import {
  assertPickRules,
  collapseToPair,
  findPick,
  nextPickId,
  PickRuleError,
  picksForShot,
} from './picks.js';

/** The whole editable state. Undo snapshots one of these. */
export interface Board {
  shots: Shot[];
  picks: Pick[];
}

let shotCounter = 1_000_000;

/** Ids for shots created by splitting, distinct from detection's own. */
function nextShotId(): string {
  shotCounter += 1;
  return `shot-${shotCounter}`;
}

/** Validate and return, so no operation can hand back a board that breaks I8. */
function sealed(board: Board): Board {
  assertPickRules(board.picks, board.shots);
  return board;
}

/**
 * Give a shot an A pick if it has none, and normalise roles so the earliest is
 * A and a second is B. Used after structural changes.
 */
function ensurePicks(board: Board, shotId: string, metrics: FrameMetrics, settings: Settings): Board {
  const shot = board.shots.find((candidate) => candidate.id === shotId);
  if (!shot) return board;

  const { kept } = collapseToPair(board.picks, shotId);
  let picks = kept;

  if (!findPick(picks, shotId, 'A')) {
    // A new half of a split has no frame of its own yet; the SPEC §6 rule
    // chooses one exactly as detection would have.
    const choice = chooseFrame(shot, metrics, settings);
    picks = [...picks, { id: nextPickId(), shotId, frame: choice.frame, role: 'A', pinned: false }];
  }

  return { shots: board.shots, picks };
}

// ---------------------------------------------------------------------------
// Picks
// ---------------------------------------------------------------------------

/**
 * Move a pick to a frame, clamped to its own shot and to its partner.
 * I8: "if a drag would cross them, clamp rather than reorder."
 * I6: touching a pick pins it, so re-detection will not overwrite it.
 */
export function movePickTo(board: Board, pickId: string, frame: number): Board {
  const target = board.picks.find((pick) => pick.id === pickId);
  if (!target) return board;

  const shot = board.shots.find((candidate) => candidate.id === target.shotId);
  if (!shot) return board;

  let low = shot.startFrame;
  let high = shot.endFrame;

  const partner = findPick(board.picks, target.shotId, target.role === 'A' ? 'B' : 'A');
  if (partner) {
    if (target.role === 'A') high = Math.min(high, partner.frame - 1);
    else low = Math.max(low, partner.frame + 1);
  }

  const clamped = Math.max(low, Math.min(high, Math.round(frame)));

  return sealed({
    shots: board.shots,
    picks: board.picks.map((pick) => (pick.id === pickId ? { ...pick, frame: clamped, pinned: true } : pick)),
  });
}

/** Nudge by a number of frames, same clamping. SPEC §7 arrow keys. */
export function nudgePick(board: Board, pickId: string, delta: number): Board {
  const target = board.picks.find((pick) => pick.id === pickId);
  if (!target) return board;
  return movePickTo(board, pickId, target.frame + delta);
}

/**
 * Add an out-frame at its default position (SPEC §6), or at a given frame when
 * the user double-clicked one. Refuses when the shot already has one — a shot
 * yields at most two frames (I8).
 */
export function addOutFrame(
  board: Board,
  shotId: string,
  metrics: FrameMetrics,
  settings: Settings,
  atFrame?: number,
): Board {
  const shot = board.shots.find((candidate) => candidate.id === shotId);
  if (!shot) return board;

  const a = findPick(board.picks, shotId, 'A');
  if (!a) return board;
  if (findPick(board.picks, shotId, 'B')) return board;
  if (a.frame >= shot.endFrame) return board;

  const requested = atFrame ?? chooseOutFrame(shot, a.frame, metrics, settings);
  const frame = Math.max(a.frame + 1, Math.min(shot.endFrame, Math.round(requested)));

  return sealed({
    shots: board.shots,
    // Pinned: the user asked for this frame, so re-detection leaves it alone (I6).
    picks: [...board.picks, { id: nextPickId(), shotId, frame, role: 'B', pinned: true }],
  });
}

/** Remove the out-frame. Never removes A — a shot always has A (SPEC §7). */
export function removeOutFrame(board: Board, shotId: string): Board {
  return sealed({
    shots: board.shots,
    picks: board.picks.filter((pick) => !(pick.shotId === shotId && pick.role === 'B')),
  });
}

/** `B` toggles: add an out-frame at the default position, or remove it. */
export function toggleOutFrame(
  board: Board,
  shotId: string,
  metrics: FrameMetrics,
  settings: Settings,
): Board {
  return findPick(board.picks, shotId, 'B')
    ? removeOutFrame(board, shotId)
    : addOutFrame(board, shotId, metrics, settings);
}

// ---------------------------------------------------------------------------
// Shots
// ---------------------------------------------------------------------------

/**
 * Merge a shot into the one before it. SPEC §7, `M`.
 *
 * The combined shot keeps the earlier shot's start and boundary — the cut that
 * began it is still the cut that begins the merged shot — and the later shot's
 * end. Their picks combine and collapse to a legal pair (I8): earliest as A,
 * latest as B, anything in between discarded. Undo restores those.
 */
export function mergeIntoPrevious(board: Board, shotId: string): Board {
  const index = board.shots.findIndex((shot) => shot.id === shotId);
  if (index <= 0) return board;

  const previous = board.shots[index - 1] as Shot;
  const current = board.shots[index] as Shot;

  const merged: Shot = {
    ...previous,
    endFrame: current.endFrame,
    // A merged shot is only as certain as the boundary that opens it.
    rejected: previous.rejected && current.rejected,
  };

  const shots = [...board.shots.slice(0, index - 1), merged, ...board.shots.slice(index + 1)];

  // Re-home the absorbed shot's picks, then reduce to at most two.
  const rehomed = board.picks.map((pick) =>
    pick.shotId === current.id ? { ...pick, shotId: merged.id } : pick,
  );
  const { kept } = collapseToPair(rehomed, merged.id);

  return sealed({ shots, picks: kept });
}

/**
 * Split a shot at a frame. SPEC §7, `S`. The frame becomes the first frame of
 * the second shot, so the two ranges are contiguous and non-overlapping.
 *
 * Picks fall to whichever side contains their frame, then each side is
 * normalised: earliest becomes A, a second becomes B, and a side left with
 * nothing gets a default frame by the SPEC §6 rule.
 */
export function splitAt(
  board: Board,
  shotId: string,
  frame: number,
  metrics: FrameMetrics,
  settings: Settings,
): Board {
  const index = board.shots.findIndex((shot) => shot.id === shotId);
  if (index < 0) return board;

  const shot = board.shots[index] as Shot;
  const at = Math.round(frame);

  // A split needs a frame on each side.
  if (at <= shot.startFrame || at > shot.endFrame) return board;

  const first: Shot = { ...shot, endFrame: at - 1 };
  const second: Shot = {
    id: nextShotId(),
    startFrame: at,
    endFrame: shot.endFrame,
    // The user asserted this boundary, so it is certain and it is hard.
    confidence: 1,
    boundary: 'hard',
    rejected: shot.rejected,
  };

  const shots = [...board.shots.slice(0, index), first, second, ...board.shots.slice(index + 1)];
  const picks = board.picks.map((pick) =>
    pick.shotId === shot.id && pick.frame >= at ? { ...pick, shotId: second.id } : pick,
  );

  let next: Board = { shots, picks };
  next = ensurePicks(next, first.id, metrics, settings);
  next = ensurePicks(next, second.id, metrics, settings);

  return sealed(next);
}

/**
 * Reject or unreject a shot. SPEC §7, `X`.
 *
 * A rejected shot leaves the board but stays visible in the overview,
 * desaturated — so the user can see the clip is still whole.
 */
export function toggleRejected(board: Board, shotId: string): Board {
  return sealed({
    shots: board.shots.map((shot) => (shot.id === shotId ? { ...shot, rejected: !shot.rejected } : shot)),
    picks: board.picks,
  });
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/** SPEC §7: undo covers frame moves, out-frame add and remove, merge, split, reject. */
export const UNDO_LIMIT = 50;

export interface History {
  past: Board[];
}

/** Snapshot before a change. Bounded to UNDO_LIMIT steps. */
export function remember(history: History, board: Board): History {
  const past = [...history.past, { shots: board.shots, picks: board.picks }];
  return { past: past.slice(-UNDO_LIMIT) };
}

/**
 * Step back one change. Snapshots rather than inverse operations: a merge that
 * discarded picks, or a split that invented one, both come back exactly as they
 * were, and there is no way for an inverse to drift from its forward operation.
 */
export function undo(history: History): { history: History; board: Board | null } {
  if (history.past.length === 0) return { history, board: null };

  const board = history.past[history.past.length - 1] as Board;
  // A snapshot was legal when taken; re-check on the way back so that undo
  // replay can never reintroduce a state that breaks I8.
  assertPickRules(board.picks, board.shots);

  return { history: { past: history.past.slice(0, -1) }, board };
}

export { PickRuleError, picksForShot };
