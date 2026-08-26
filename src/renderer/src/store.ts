/**
 * The single store. SPEC §2: one Zustand store, no context plumbing.
 *
 * See I7 — nothing here touches localStorage, sessionStorage or IndexedDB.
 * The store lives in memory for the session; persistence goes through IPC to
 * disk in the main process.
 *
 * Phase 5 is read-only: load a clip, select a shot or pick, look at it. The
 * editing actions arrive in phase 6.
 */

import { create } from 'zustand';
import type {
  AnalyzedProject,
  Pick,
  PipelineProgressEvent,
  PipelineStepName,
  PipelineStepState,
  Shot,
} from '../../shared/types.js';
import { picksForShot } from '../../shared/picks.js';
import {
  addOutFrame,
  mergeIntoPrevious,
  movePickTo,
  nudgePick,
  remember,
  removeOutFrame,
  splitAt,
  toggleOutFrame,
  toggleRejected,
  undo as undoHistory,
  type Board,
  type History,
} from '../../shared/editing.js';

export type Screen = 'intake' | 'analyzing' | 'workspace' | 'error';

/** Plain-language step names for the intake screen (SPEC §7). */
export const STEP_LABELS: Record<PipelineStepName, string> = {
  index: 'Read the video',
  proxy: 'Build a preview copy',
  analyze: 'Look at every frame',
  detect: 'Find the cuts',
};

export const STEP_ORDER: PipelineStepName[] = ['index', 'proxy', 'analyze', 'detect'];

interface Thumbnails {
  urls: string[];
  width: number;
  height: number;
}

interface State {
  screen: Screen;
  problem: string | null;

  progress: PipelineProgressEvent | null;

  project: AnalyzedProject | null;
  shots: Shot[];
  picks: Pick[];
  thumbnails: Thumbnails | null;

  /** The shot whose row is expanded below. Always set once loaded. */
  selectedShotId: string | null;
  /** The pick being previewed. A shot stays selected whichever half is chosen. */
  selectedPickId: string | null;

  /**
   * A frame being scrubbed to on the overview, independent of any pick. While
   * set, the preview shows this frame instead of the selected pick's. Cleared
   * as soon as the selection moves, so scrubbing is a look, not an edit.
   */
  scrubFrame: number | null;

  /**
   * Whether the board also lists excluded shots. Off by default, which is
   * SPEC §7's behaviour — the board is the answer to "what am I exporting?",
   * so what it lists is exactly what will be written.
   */
  showExcluded: boolean;

  choose: () => Promise<void>;
  analyze: (path: string) => Promise<void>;
  reset: () => void;

  selectShot: (shotId: string) => void;
  selectPick: (pickId: string) => void;
  setScrubFrame: (frame: number | null) => void;
  toggleShowExcluded: () => void;
  /** Step through every pick on the board in order, A and B alike (SPEC §7). */
  stepPick: (delta: number) => void;

  // --- Editing (SPEC §7). Every one of these is undoable.
  /** Drag or click the carrot to a frame. Clamped to the shot and partner (I8). */
  movePick: (pickId: string, frame: number) => void;
  /** Arrow keys: 1 frame, or 10 with shift. */
  nudgeSelected: (delta: number) => void;
  /** `B` — add an out-frame at its default position, or remove it. */
  toggleOutFrame: () => void;
  /** Double-click on the shot row — add an out-frame at that frame. */
  addOutFrameAt: (frame: number) => void;
  /** `Delete` — remove the out-frame. Never removes A. */
  removeOutFrame: () => void;
  /** `M` — merge the selected shot into the previous one. */
  mergeSelected: () => void;
  /** `S` — split the selected shot at the selected frame. */
  splitSelected: () => void;
  /** `X` — reject or unreject the selected shot. */
  toggleRejectSelected: () => void;
  /** Ctrl/Cmd+Z. */
  undo: () => void;
  /** How many steps are available, for the interface to disable undo. */
  undoDepth: () => number;
}

/** Undo history, kept outside the store's render-visible state. */
let history: History = { past: [] };

/** Picks in board order: by shot, then A before B (SPEC §4). */
export function orderedPicks(shots: readonly Shot[], picks: readonly Pick[]): Pick[] {
  const order: Pick[] = [];
  for (const shot of shots) {
    if (shot.rejected) continue;
    order.push(...picksForShot(picks, shot.id));
  }
  return order;
}

export const useStore = create<State>((set, get) => ({
  screen: 'intake',
  problem: null,
  progress: null,
  project: null,
  shots: [],
  picks: [],
  thumbnails: null,
  selectedShotId: null,
  selectedPickId: null,
  scrubFrame: null,
  showExcluded: false,

  choose: async () => {
    const path = await window.breadcrumbs.invoke('project:choose', undefined);
    if (path) await get().analyze(path);
  },

  analyze: async (path: string) => {
    history = { past: [] };
    // One run at a time. Two analyses of the same clip would write the same
    // proxy file concurrently and corrupt it, and the frame-count check cannot
    // catch that because the container header still reads correctly.
    if (get().screen === 'analyzing') return;

    // Release the previous clip's thumbnails before loading another.
    for (const url of get().thumbnails?.urls ?? []) URL.revokeObjectURL(url);

    set({
      screen: 'analyzing',
      problem: null,
      progress: null,
      project: null,
      shots: [],
      picks: [],
      thumbnails: null,
      selectedShotId: null,
      selectedPickId: null,
      scrubFrame: null,
    });

    const result = await window.breadcrumbs.invoke('project:analyze', { path });

    if (!result.ok) {
      set({ screen: 'error', problem: result.problem, progress: null });
      return;
    }

    const project = result.value;

    // Slice the packed thumbnail buffer into one blob URL per frame. Done once,
    // here; after this every thumbnail read is an array index (SPEC §5).
    const bytes = new Uint8Array(project.thumbnails.data);
    const urls: string[] = [];
    for (let frame = 0; frame + 1 < project.thumbnails.offsets.length; frame += 1) {
      const from = project.thumbnails.offsets[frame] as number;
      const to = project.thumbnails.offsets[frame + 1] as number;
      urls.push(URL.createObjectURL(new Blob([bytes.subarray(from, to)], { type: 'image/jpeg' })));
    }

    const firstShot = project.shots[0] ?? null;
    const firstPick = firstShot ? picksForShot(project.picks, firstShot.id)[0] : undefined;

    set({
      screen: 'workspace',
      project,
      shots: project.shots,
      picks: project.picks,
      thumbnails: { urls, width: project.thumbnails.width, height: project.thumbnails.height },
      selectedShotId: firstShot?.id ?? null,
      selectedPickId: firstPick?.id ?? null,
      scrubFrame: null,
      progress: null,
    });
  },

  reset: () => {
    history = { past: [] };
    for (const url of get().thumbnails?.urls ?? []) URL.revokeObjectURL(url);
    set({
      screen: 'intake',
      problem: null,
      progress: null,
      project: null,
      shots: [],
      picks: [],
      thumbnails: null,
      selectedShotId: null,
      selectedPickId: null,
      scrubFrame: null,
    });
  },

  selectShot: (shotId: string) => {
    const { picks } = get();
    const first = picksForShot(picks, shotId)[0];
    set({ selectedShotId: shotId, selectedPickId: first?.id ?? null, scrubFrame: null });
  },

  selectPick: (pickId: string) => {
    const pick = get().picks.find((candidate) => candidate.id === pickId);
    if (!pick) return;
    // Clicking either half of a pair selects that frame; the shot stays
    // selected in the timeline either way (SPEC §7).
    set({ selectedPickId: pick.id, selectedShotId: pick.shotId, scrubFrame: null });
  },

  movePick: (pickId, frame) => applyEdit(set, get, (board) => movePickTo(board, pickId, frame)),

  nudgeSelected: (delta) => {
    const pickId = get().selectedPickId;
    if (!pickId) return;
    applyEdit(set, get, (board) => nudgePick(board, pickId, delta));
  },

  toggleOutFrame: () => {
    const { selectedShotId, project } = get();
    if (!selectedShotId || !project) return;
    applyEdit(set, get, (board) =>
      toggleOutFrame(board, selectedShotId, project.metrics, project.settings),
    );
  },

  addOutFrameAt: (frame) => {
    const { selectedShotId, project } = get();
    if (!selectedShotId || !project) return;
    applyEdit(set, get, (board) =>
      addOutFrame(board, selectedShotId, project.metrics, project.settings, frame),
    );
  },

  removeOutFrame: () => {
    const shotId = get().selectedShotId;
    if (!shotId) return;
    applyEdit(set, get, (board) => removeOutFrame(board, shotId));
  },

  mergeSelected: () => {
    const shotId = get().selectedShotId;
    if (!shotId) return;
    applyEdit(set, get, (board) => mergeIntoPrevious(board, shotId));
  },

  splitSelected: () => {
    const { selectedShotId, selectedPickId, picks, project } = get();
    if (!selectedShotId || !project) return;
    const at = picks.find((pick) => pick.id === selectedPickId)?.frame;
    if (at === undefined) return;
    applyEdit(set, get, (board) => splitAt(board, selectedShotId, at, project.metrics, project.settings));
  },

  toggleRejectSelected: () => {
    const shotId = get().selectedShotId;
    if (!shotId) return;
    applyEdit(set, get, (board) => toggleRejected(board, shotId));
  },

  undo: () => {
    const result = undoHistory(history);
    if (!result.board) return;
    history = result.history;
    set({ shots: result.board.shots, picks: result.board.picks });
    reselect(set, get, result.board);
  },

  undoDepth: () => history.past.length,

  stepPick: (delta: number) => {
    const { shots, picks, selectedPickId } = get();
    const order = orderedPicks(shots, picks);
    if (order.length === 0) return;

    const current = order.findIndex((pick) => pick.id === selectedPickId);
    const next = order[Math.max(0, Math.min(order.length - 1, (current < 0 ? 0 : current) + delta))];
    if (next) set({ selectedPickId: next.id, selectedShotId: next.shotId, scrubFrame: null });
  },

  setScrubFrame: (frame) => set({ scrubFrame: frame }),

  toggleShowExcluded: () => set({ showExcluded: !get().showExcluded }),
}));

/**
 * Run one edit: snapshot for undo, apply, then keep the selection pointing at
 * something that still exists. Operations that change nothing (a merge on the
 * first shot, a third frame on a shot) leave no undo step behind.
 */
function applyEdit(
  set: (partial: Partial<State>) => void,
  get: () => State,
  operation: (board: Board) => Board,
): void {
  const before: Board = { shots: get().shots, picks: get().picks };
  const after = operation(before);

  if (after.shots === before.shots && after.picks === before.picks) return;

  history = remember(history, before);
  set({ shots: after.shots, picks: after.picks });
  reselect(set, get, after);
}

/** Keep the selection valid after a structural change. */
function reselect(set: (partial: Partial<State>) => void, get: () => State, board: Board): void {
  const { selectedShotId, selectedPickId } = get();

  const shot =
    board.shots.find((candidate) => candidate.id === selectedShotId) ??
    board.shots.find((candidate) => !candidate.rejected) ??
    board.shots[0];
  if (!shot) {
    set({ selectedShotId: null, selectedPickId: null });
    return;
  }

  const mine = picksForShot(board.picks, shot.id);
  const stillThere = mine.find((pick) => pick.id === selectedPickId);
  set({ selectedShotId: shot.id, selectedPickId: (stillThere ?? mine[0])?.id ?? null });
}

/** Subscribe once to progress events from the main process. */
export function attachProgressListener(): () => void {
  return window.breadcrumbs.on('pipeline:progress', (progress) => {
    useStore.setState({ progress });
  });
}

export function stepStateOf(
  progress: PipelineProgressEvent | null,
  step: PipelineStepName,
): PipelineStepState {
  return progress?.states[step] ?? 'pending';
}
