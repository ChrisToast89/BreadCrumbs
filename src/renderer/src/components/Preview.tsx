/**
 * Preview — SPEC §7, top right.
 *
 * The selected frame, letterboxed to fit, with a readout of timecode, frame
 * number and shot number, plus controls to play the selected shot.
 *
 * It plays the proxy in a <video> element (SPEC §2): every proxy frame is a
 * keyframe, so setting `currentTime` lands exactly with no decode backtrack.
 * The time comes from the PTS table (I1) — never from frame / fps.
 *
 * Display geometry needs no work here (I5): rotation and pixel aspect were
 * baked into the proxy during phase 2, so the proxy is already upright with
 * square pixels and the element renders it as-is.
 *
 * Playback is a review aid, not an edit: it runs between the selected shot's
 * first and last frame and returns to the selected frame when it stops, so
 * nothing about the board changes by watching it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store.js';
import { secondsOf, timecodeOf } from '../timecode.js';

type PlayMode = 'stopped' | 'once' | 'loop';

export function Preview(): JSX.Element {
  const project = useStore((state) => state.project);
  const shots = useStore((state) => state.shots);
  const picks = useStore((state) => state.picks);
  const selectedPickId = useStore((state) => state.selectedPickId);
  const scrubFrame = useStore((state) => state.scrubFrame);

  const videoRef = useRef<HTMLVideoElement>(null);
  const [seekMs, setSeekMs] = useState<number | null>(null);
  /** Set when the video landed somewhere other than the frame we asked for. */
  const [outOfSync, setOutOfSync] = useState(false);
  const [mode, setMode] = useState<PlayMode>('stopped');
  /** Frame currently on screen while playing, so the readout keeps up. */
  const [playingFrame, setPlayingFrame] = useState<number | null>(null);

  const pick = picks.find((candidate) => candidate.id === selectedPickId) ?? null;
  const shot = shots.find((candidate) => candidate.id === pick?.shotId) ?? null;
  const shotPosition = shot ? shots.indexOf(shot) + 1 : 0;

  /** What the preview should be showing: a playing frame, a scrub, or the pick. */
  const frame = playingFrame ?? scrubFrame ?? pick?.frame ?? 0;

  const stop = useCallback(() => {
    setMode('stopped');
    setPlayingFrame(null);
    videoRef.current?.pause();
  }, []);

  // Stop playing whenever the selection moves, so the picture always belongs
  // to whatever is selected.
  useEffect(() => {
    stop();
  }, [selectedPickId, stop]);

  // Seek to the frame being shown. Skipped while playing, when the video is
  // driving its own position.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !project || mode !== 'stopped') return;

    // I1 — the presentation time comes out of the table, never from arithmetic.
    const target = secondsOf(project.index, frame);
    const started = performance.now();

    const onSeeked = (): void => {
      setSeekMs(performance.now() - started);

      // A seek that silently does nothing is the dangerous case: the element
      // still fires `seeked`, so it reads as a fast success while the preview
      // sits on the wrong frame. Checking where it actually landed turns that
      // into something visible instead of something believed.
      //
      // The tolerance is half the gap to the neighbouring frame, taken from
      // the PTS table (I1) rather than computed from the frame rate.
      const neighbour = secondsOf(project.index, frame + 1);
      const gap = Math.abs(neighbour - target) || Math.abs(target - secondsOf(project.index, frame - 1));
      setOutOfSync(Math.abs(video.currentTime - target) > Math.max(0.001, gap / 2));

      video.removeEventListener('seeked', onSeeked);
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = target;

    return () => video.removeEventListener('seeked', onSeeked);
  }, [project, frame, mode]);

  // Playback: run from the shot's first frame to its last, then stop or loop.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !project || !shot || mode === 'stopped') return;

    const from = secondsOf(project.index, shot.startFrame);
    const to = secondsOf(project.index, shot.endFrame);

    const onTimeUpdate = (): void => {
      // Report the frame under the playhead by searching the PTS table (I1),
      // never by multiplying elapsed time by a frame rate.
      const pts = project.index.ptsList;
      let low = shot.startFrame;
      let high = shot.endFrame;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if ((pts[middle] as number) <= video.currentTime) low = middle;
        else high = middle - 1;
      }
      setPlayingFrame(low);

      if (video.currentTime >= to) {
        if (mode === 'loop') {
          video.currentTime = from;
          void video.play();
        } else {
          stop();
        }
      }
    };

    video.addEventListener('timeupdate', onTimeUpdate);

    // Start from the shot's beginning if the playhead is outside it.
    if (video.currentTime < from || video.currentTime >= to) video.currentTime = from;
    void video.play();

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
    };
  }, [mode, project, shot, stop]);

  // Playback keys, kept here because they belong to this pane (SPEC §7's map
  // has no playback, so these are additions and must not shadow its keys).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      if (event.code === 'Space') {
        event.preventDefault();
        setMode((current) => (current === 'once' ? 'stopped' : 'once'));
      } else if (event.key.toLowerCase() === 'l') {
        event.preventDefault();
        setMode((current) => (current === 'loop' ? 'stopped' : 'loop'));
      } else if (event.key === 'Escape') {
        stop();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [stop]);

  if (!project || !pick) return <div className="preview" />;

  const hasPair = picks.filter((candidate) => candidate.shotId === pick.shotId).length > 1;
  const playing = mode !== 'stopped';

  return (
    <section className="preview" aria-label="Preview">
      <div className="preview__stage">
        <div
          className="preview__frame"
          style={{ aspectRatio: `${project.index.displayWidth} / ${project.index.displayHeight}` }}
        >
          <video
            ref={videoRef}
            className="preview__video"
            src={project.proxyUrl}
            preload="auto"
            muted
            playsInline
            controls={false}
          />

          {/* Controls sit over the picture and appear on hover, so they are
              there when wanted and out of the way while judging a frame. */}
          <div className="osd" role="group" aria-label="Playback">
            <button
              type="button"
              className={`osd__button${mode === 'once' ? ' osd__button--on' : ''}`}
              onClick={() => setMode(mode === 'once' ? 'stopped' : 'once')}
              aria-label={mode === 'once' ? 'Pause' : 'Play this shot once'}
              title={mode === 'once' ? 'Pause (space)' : 'Play this shot once (space)'}
            >
              {mode === 'once' ? '❚❚' : '▶'}
            </button>
            <button
              type="button"
              className={`osd__button${mode === 'loop' ? ' osd__button--on' : ''}`}
              onClick={() => setMode(mode === 'loop' ? 'stopped' : 'loop')}
              aria-label={mode === 'loop' ? 'Stop looping' : 'Loop this shot'}
              title="Loop this shot (L)"
            >
              ↻
            </button>
            <button
              type="button"
              className="osd__button"
              onClick={stop}
              disabled={!playing}
              aria-label="Back to the selected frame"
              title="Back to the selected frame (esc)"
            >
              ■
            </button>
            {playing && shot ? (
              <span className="osd__progress" aria-hidden="true">
                <span
                  className="osd__progress-bar"
                  style={{
                    width: `${
                      ((frame - shot.startFrame) / Math.max(1, shot.endFrame - shot.startFrame)) * 100
                    }%`,
                  }}
                />
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="readout">
        <span className="readout__tc">{timecodeOf(project.index, frame)}</span>
        <span>frame {frame}</span>
        <span>
          shot {shotPosition} of {shots.length}
        </span>
        {hasPair && !playing && scrubFrame === null ? <span>frame {pick.role} of 2</span> : null}
        {shot ? <span>{shot.endFrame - shot.startFrame + 1} frames in shot</span> : null}
        {shot?.rejected ? <span className="readout__excluded">excluded from export</span> : null}
        {scrubFrame !== null ? <span className="readout__quiet">scrubbing</span> : null}
        {playing ? <span className="readout__quiet">{mode === 'loop' ? 'looping' : 'playing'}</span> : null}
        <span className="readout__spacer" />
        {project.index.variableFrameRate ? <span className="readout__badge">VFR</span> : null}
        {project.index.hdr ? <span className="readout__badge">HDR</span> : null}
        {outOfSync ? <span className="readout__badge">PREVIEW OUT OF SYNC</span> : null}
        {seekMs !== null && !playing ? (
          <span className="readout__quiet">seek {Math.round(seekMs)}ms</span>
        ) : null}
      </div>
    </section>
  );
}
