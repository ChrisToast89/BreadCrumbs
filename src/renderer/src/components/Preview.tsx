/**
 * Preview — SPEC §7, top right.
 *
 * The selected frame, letterboxed to fit, with a readout of timecode, frame
 * number and shot number.
 *
 * It plays the proxy in a <video> element (SPEC §2): every proxy frame is a
 * keyframe, so setting `currentTime` lands exactly with no decode backtrack.
 * The time comes from the PTS table (I1) — never from frame / fps.
 *
 * Display geometry needs no work here (I5): rotation and pixel aspect were
 * baked into the proxy during phase 2, so the proxy is already upright with
 * square pixels and the element renders it as-is.
 */

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store.js';
import { secondsOf, timecodeOf } from '../timecode.js';

export function Preview(): JSX.Element {
  const project = useStore((state) => state.project);
  const shots = useStore((state) => state.shots);
  const picks = useStore((state) => state.picks);
  const selectedPickId = useStore((state) => state.selectedPickId);

  const videoRef = useRef<HTMLVideoElement>(null);
  const [seekMs, setSeekMs] = useState<number | null>(null);
  /** Set when the video landed somewhere other than the frame we asked for. */
  const [outOfSync, setOutOfSync] = useState(false);

  const pick = picks.find((candidate) => candidate.id === selectedPickId) ?? null;
  const shot = shots.find((candidate) => candidate.id === pick?.shotId) ?? null;
  const shotPosition = shot ? shots.indexOf(shot) + 1 : 0;

  // Seek to the selected frame. Timed, because the phase 5 gate budgets this.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !project || !pick) return;

    // I1 — the presentation time comes out of the table, never from arithmetic.
    const target = secondsOf(project.index, pick.frame);
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
      const neighbour = secondsOf(project.index, pick.frame + 1);
      const gap = Math.abs(neighbour - target) || Math.abs(target - secondsOf(project.index, pick.frame - 1));
      setOutOfSync(Math.abs(video.currentTime - target) > Math.max(0.001, gap / 2));

      video.removeEventListener('seeked', onSeeked);
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = target;

    return () => video.removeEventListener('seeked', onSeeked);
  }, [project, pick]);

  if (!project || !pick) return <div className="preview" />;

  const hasPair = picks.filter((candidate) => candidate.shotId === pick.shotId).length > 1;

  return (
    <section className="preview" aria-label="Preview">
      <div className="preview__stage">
        <video
          ref={videoRef}
          className="preview__video"
          src={project.proxyUrl}
          preload="auto"
          muted
          playsInline
          // The proxy carries no audio and is never played; it is a frame
          // source that happens to be a video file.
          controls={false}
          style={{ aspectRatio: `${project.index.displayWidth} / ${project.index.displayHeight}` }}
        />
      </div>

      <div className="readout">
        <span className="readout__tc">{timecodeOf(project.index, pick.frame)}</span>
        <span>frame {pick.frame}</span>
        <span>
          shot {shotPosition} of {shots.length}
        </span>
        {hasPair ? <span>frame {pick.role} of 2</span> : null}
        {shot ? <span>{shot.endFrame - shot.startFrame + 1} frames in shot</span> : null}
        <span className="readout__spacer" />
        {project.index.variableFrameRate ? <span className="readout__badge">VFR</span> : null}
        {project.index.hdr ? <span className="readout__badge">HDR</span> : null}
        {outOfSync ? <span className="readout__badge">PREVIEW OUT OF SYNC</span> : null}
        {seekMs !== null ? <span className="readout__quiet">seek {Math.round(seekMs)}ms</span> : null}
      </div>
    </section>
  );
}
