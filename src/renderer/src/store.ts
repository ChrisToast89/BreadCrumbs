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

  choose: () => Promise<void>;
  analyze: (path: string) => Promise<void>;
  reset: () => void;

  selectShot: (shotId: string) => void;
  selectPick: (pickId: string) => void;
  /** Step through every pick on the board in order, A and B alike (SPEC §7). */
  stepPick: (delta: number) => void;
}

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

  choose: async () => {
    const path = await window.breadcrumbs.invoke('project:choose', undefined);
    if (path) await get().analyze(path);
  },

  analyze: async (path: string) => {
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
      progress: null,
    });
  },

  reset: () => {
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
    });
  },

  selectShot: (shotId: string) => {
    const { picks } = get();
    const first = picksForShot(picks, shotId)[0];
    set({ selectedShotId: shotId, selectedPickId: first?.id ?? null });
  },

  selectPick: (pickId: string) => {
    const pick = get().picks.find((candidate) => candidate.id === pickId);
    if (!pick) return;
    // Clicking either half of a pair selects that frame; the shot stays
    // selected in the timeline either way (SPEC §7).
    set({ selectedPickId: pick.id, selectedShotId: pick.shotId });
  },

  stepPick: (delta: number) => {
    const { shots, picks, selectedPickId } = get();
    const order = orderedPicks(shots, picks);
    if (order.length === 0) return;

    const current = order.findIndex((pick) => pick.id === selectedPickId);
    const next = order[Math.max(0, Math.min(order.length - 1, (current < 0 ? 0 : current) + delta))];
    if (next) set({ selectedPickId: next.id, selectedShotId: next.shotId });
  },
}));

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
