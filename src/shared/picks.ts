/**
 * The rules governing picks. See I8.
 *
 * "A shot yields at most two frames, A then B. Never three. A always exists;
 * B is optional. A.frame < B.frame always — if a drag would cross them, clamp
 * rather than reorder. Enforce it in the data layer, not only the UI."
 *
 * That is why this module exists and why it is in `shared`: detection, the
 * store, undo replay and export all go through these functions, so there is no
 * path that can produce a third pick or an out-of-order pair. Every function
 * here returns a new array; nothing mutates its input.
 */

import type { Pick, PickRole, Shot } from './types.js';

/** Thrown when a caller tries to break I8 rather than being clamped into it. */
export class PickRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PickRuleError';
  }
}

let idCounter = 0;

export function nextPickId(): string {
  idCounter += 1;
  return `pick-${idCounter}`;
}

/** The picks belonging to one shot, A first. See I8 for the ordering. */
export function picksForShot(picks: readonly Pick[], shotId: string): Pick[] {
  return picks.filter((pick) => pick.shotId === shotId).sort(byRole);
}

export function byRole(a: Pick, b: Pick): number {
  if (a.role === b.role) return a.frame - b.frame;
  return a.role === 'A' ? -1 : 1;
}

export function findPick(picks: readonly Pick[], shotId: string, role: PickRole): Pick | undefined {
  return picks.find((pick) => pick.shotId === shotId && pick.role === role);
}

/**
 * Check I8 across a whole pick list. Used by the store after every edit and by
 * the inspect CLI, so a violation surfaces at the point it is introduced rather
 * than as a wrong file at export time.
 */
export function assertPickRules(picks: readonly Pick[], shots: readonly Shot[]): void {
  const byShot = new Map<string, Pick[]>();
  for (const pick of picks) {
    const list = byShot.get(pick.shotId) ?? [];
    list.push(pick);
    byShot.set(pick.shotId, list);
  }

  for (const [shotId, list] of byShot) {
    if (list.length > 2) {
      throw new PickRuleError(`Shot ${shotId} has ${list.length} picks. A shot may have at most two (I8).`);
    }

    const a = list.filter((pick) => pick.role === 'A');
    const b = list.filter((pick) => pick.role === 'B');

    if (a.length !== 1) {
      throw new PickRuleError(`Shot ${shotId} has ${a.length} A picks. Every shot has exactly one A (I8).`);
    }
    if (b.length > 1) {
      throw new PickRuleError(`Shot ${shotId} has ${b.length} B picks. A shot may have at most one B (I8).`);
    }
    if (b.length === 1 && (b[0] as Pick).frame <= (a[0] as Pick).frame) {
      throw new PickRuleError(
        `Shot ${shotId} has B at frame ${(b[0] as Pick).frame}, not after A at ${(a[0] as Pick).frame} (I8).`,
      );
    }

    const shot = shots.find((candidate) => candidate.id === shotId);
    if (!shot) {
      throw new PickRuleError(`Pick refers to shot ${shotId}, which does not exist.`);
    }
    for (const pick of list) {
      if (pick.frame < shot.startFrame || pick.frame > shot.endFrame) {
        throw new PickRuleError(
          `Shot ${shotId} has a pick at frame ${pick.frame}, outside its range ${shot.startFrame}-${shot.endFrame}.`,
        );
      }
    }
  }
}

/**
 * Move a pick to a frame, clamped to its own shot and to the other pick in the
 * pair. I8: "if a drag would cross them, clamp rather than reorder."
 *
 * Any move marks the pick pinned, so re-detection cannot overwrite it (I6).
 */
export function movePick(
  picks: readonly Pick[],
  shots: readonly Shot[],
  pickId: string,
  requestedFrame: number,
): Pick[] {
  const target = picks.find((pick) => pick.id === pickId);
  if (!target) return [...picks];

  const shot = shots.find((candidate) => candidate.id === target.shotId);
  if (!shot) return [...picks];

  let low = shot.startFrame;
  let high = shot.endFrame;

  // A must stay before B, and B after A — clamp to one frame clear of the other.
  const other = findPick(picks, target.shotId, target.role === 'A' ? 'B' : 'A');
  if (other) {
    if (target.role === 'A') high = Math.min(high, other.frame - 1);
    else low = Math.max(low, other.frame + 1);
  }

  const frame = Math.max(low, Math.min(high, Math.round(requestedFrame)));

  return picks.map((pick) =>
    pick.id === pickId ? { ...pick, frame, pinned: true } : pick,
  );
}

/**
 * Add an out-frame to a shot. Refuses if the shot already has one — a shot
 * yields at most two frames (I8), and this is the data-layer guard, not a UI
 * convenience.
 */
export function addOutFrame(
  picks: readonly Pick[],
  shots: readonly Shot[],
  shotId: string,
  frame: number,
): Pick[] {
  const shot = shots.find((candidate) => candidate.id === shotId);
  if (!shot) throw new PickRuleError(`Shot ${shotId} does not exist.`);

  const a = findPick(picks, shotId, 'A');
  if (!a) throw new PickRuleError(`Shot ${shotId} has no A pick to pair with.`);
  if (findPick(picks, shotId, 'B')) {
    throw new PickRuleError(`Shot ${shotId} already has an out-frame. A shot may have at most two frames (I8).`);
  }

  // B must land after A and inside the shot; there is no room if A is on the
  // last frame.
  if (a.frame >= shot.endFrame) {
    throw new PickRuleError(
      `Shot ${shotId} has no frame after A at ${a.frame} for an out-frame to occupy.`,
    );
  }
  const clamped = Math.max(a.frame + 1, Math.min(shot.endFrame, Math.round(frame)));

  return [...picks, { id: nextPickId(), shotId, frame: clamped, role: 'B', pinned: true }];
}

/**
 * Remove the out-frame. Never removes A — a shot always has A (SPEC §7,
 * Delete key).
 */
export function removeOutFrame(picks: readonly Pick[], shotId: string): Pick[] {
  return picks.filter((pick) => !(pick.shotId === shotId && pick.role === 'B'));
}

/**
 * Reduce a shot's picks to a legal pair after a structural change such as a
 * merge, where two shots each carrying two frames become one.
 *
 * Keeps the earliest as A and the latest as B, which is what a merged shot
 * means: the frame it settles into and the frame it ends on. The discarded
 * picks are returned so undo can put them back.
 */
export function collapseToPair(
  picks: readonly Pick[],
  shotId: string,
): { kept: Pick[]; discarded: Pick[] } {
  const mine = picks.filter((pick) => pick.shotId === shotId).sort((a, b) => a.frame - b.frame);
  const others = picks.filter((pick) => pick.shotId !== shotId);

  if (mine.length === 0) return { kept: [...others], discarded: [] };

  const first = mine[0] as Pick;
  const last = mine[mine.length - 1] as Pick;

  if (mine.length === 1 || first.frame === last.frame) {
    return { kept: [...others, { ...first, role: 'A' }], discarded: mine.slice(1) };
  }

  const kept: Pick[] = [
    { ...first, role: 'A' },
    { ...last, role: 'B' },
  ];
  const discarded = mine.filter((pick) => pick !== first && pick !== last);

  return { kept: [...others, ...kept], discarded };
}
