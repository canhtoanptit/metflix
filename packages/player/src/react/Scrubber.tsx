/**
 * The scrubber: played / buffered ranges, a hover time bubble with the trick-play thumbnail,
 * drag-to-seek (mouse, pen, touch) with the thumbnail following the finger, and slider
 * keyboard semantics. The picture only seeks on release; while dragging the thumbnail is the
 * preview, as in premium players (seeking an MSE stream on every pointermove stalls it).
 */
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { formatPlaybackTime, formatRemainingTime, formatSpokenDuration } from "../core/format.ts";
import { SEEK_STEP_SEC } from "../core/keymap.ts";
import { clampPreviewLeft, trickPlayFrame, trickPlaySheets } from "../core/trickplay.ts";
import { shallowEqual, usePlayer, usePlayerState } from "./context.ts";

const PAGE_STEP_SEC = 60;
const PREVIEW_GUTTER = 12;

interface Preview {
  /** Pointer x within the track, px. */
  x: number;
  time: number;
  /** Track width and thumbnail width at that moment, px (measured on input, not in render). */
  trackWidth: number;
  thumbWidth: number;
}

export function Scrubber() {
  const { controller, labels, session, layout, rootRef } = usePlayer();
  const { duration, currentTime, buffered } = usePlayerState(
    (s) => ({
      duration: s.duration || s.source?.durationHint || 0,
      currentTime: s.currentTime,
      buffered: s.buffered,
    }),
    shallowEqual,
  );
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<Preview | null>(null);
  const [drag, setDrag] = useState<Preview | null>(null);
  const dragPointer = useRef<number | null>(null);
  const preloaded = useRef(false);
  const trickPlay = session.trickPlay;

  // Drop a drag that outlives its source (episode swap mid-drag).
  useEffect(() => {
    setDrag(null);
    setHover(null);
    dragPointer.current = null;
    preloaded.current = false;
  }, [session.id]);

  const preload = () => {
    if (preloaded.current) return;
    preloaded.current = true;
    for (const url of trickPlaySheets(trickPlay)) {
      const image = new Image();
      image.decoding = "async";
      image.src = url;
    }
  };

  const previewAt = (clientX: number): Preview | null => {
    const track = trackRef.current;
    if (!track || duration <= 0) return null;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const x = Math.min(rect.width, Math.max(0, clientX - rect.left));
    const rootWidth = rootRef.current?.clientWidth ?? rect.width;
    const touch = layout === "touch";
    const thumbWidth = Math.round(
      Math.min(touch ? 200 : 300, Math.max(144, rootWidth * (touch ? 0.36 : 0.17))),
    );
    return { x, time: (x / rect.width) * duration, trackWidth: rect.width, thumbWidth };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const preview = previewAt(event.clientX);
    if (!preview) return;
    preload();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragPointer.current = event.pointerId;
    setDrag(preview);
    controller.setScrubbing(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const preview = previewAt(event.clientX);
    if (dragPointer.current === event.pointerId) {
      if (preview) setDrag(preview);
      return;
    }
    if (event.pointerType !== "touch" && preview) {
      preload();
      setHover(preview);
    }
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    if (dragPointer.current !== event.pointerId) return;
    dragPointer.current = null;
    const preview = previewAt(event.clientX) ?? drag;
    if (commit && preview) controller.seek(preview.time, "pointer");
    setDrag(null);
    controller.setScrubbing(false);
    if (event.pointerType !== "mouse") setHover(null);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = {
      ArrowLeft: -SEEK_STEP_SEC,
      ArrowDown: -SEEK_STEP_SEC,
      ArrowRight: SEEK_STEP_SEC,
      ArrowUp: SEEK_STEP_SEC,
      PageDown: -PAGE_STEP_SEC,
      PageUp: PAGE_STEP_SEC,
    };
    const step = steps[event.key];
    if (step !== undefined) controller.seekBy(step, "host");
    else if (event.key === "Home") controller.seek(0, "host");
    else if (event.key === "End") controller.seek(duration, "host");
    else return;
    event.preventDefault();
    event.stopPropagation();
    controller.activity("keyboard");
  };

  const active = drag ?? hover;
  const shownTime = drag ? drag.time : currentTime;
  const playedFraction = duration > 0 ? Math.min(1, shownTime / duration) : 0;
  const frame =
    active && trickPlay ? trickPlayFrame(trickPlay, active.time, active.thumbWidth) : null;
  const bubbleWidth = frame ? frame.width : 72;
  const bubbleLeft = active
    ? clampPreviewLeft(active.x, bubbleWidth, active.trackWidth, -PREVIEW_GUTTER)
    : 0;

  return (
    <div className="wfp-scrubber" data-dragging={drag ? "" : undefined}>
      <div
        className="wfp-scrubber__hit"
        role="slider"
        tabIndex={0}
        aria-label={labels.seekSlider}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(shownTime)}
        aria-valuetext={labels.timeOf(
          formatSpokenDuration(shownTime),
          formatSpokenDuration(duration),
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => endDrag(event, true)}
        onPointerCancel={(event) => endDrag(event, false)}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
      >
        <div className="wfp-scrubber__track" ref={trackRef}>
          {buffered.map((range) => (
            <div
              key={`${range.start}-${range.end}`}
              className="wfp-scrubber__buffered"
              style={{
                left: `${(range.start / (duration || 1)) * 100}%`,
                width: `${(Math.max(0, Math.min(range.end, duration) - range.start) / (duration || 1)) * 100}%`,
              }}
            />
          ))}
          <div
            className="wfp-scrubber__played"
            style={{ transform: `scaleX(${playedFraction})` }}
          />
        </div>
        {hover && !drag ? (
          <div className="wfp-scrubber__hover-mark" style={{ left: `${hover.x}px` }} />
        ) : null}
        <div className="wfp-scrubber__thumb" style={{ left: `${playedFraction * 100}%` }} />
        {active ? (
          <div
            className="wfp-scrubber__preview"
            style={{ transform: `translateX(${bubbleLeft}px)`, width: `${bubbleWidth}px` }}
            aria-hidden="true"
          >
            {frame ? (
              <div
                className="wfp-scrubber__frame"
                style={{
                  width: `${frame.width}px`,
                  height: `${frame.height}px`,
                  backgroundImage: `url("${frame.sheetUrl}")`,
                  backgroundSize: `${frame.sheetWidth}px ${frame.sheetHeight}px`,
                  backgroundPosition: `${frame.offsetX}px ${frame.offsetY}px`,
                }}
              />
            ) : null}
            <span className="wfp-scrubber__time">{formatPlaybackTime(active.time)}</span>
          </div>
        ) : null}
      </div>
      {/* Remaining time is already in the slider's value text. */}
      <span className="wfp-scrubber__remaining" aria-hidden="true">
        {formatRemainingTime(shownTime, duration).slice(1)}
      </span>
    </div>
  );
}
