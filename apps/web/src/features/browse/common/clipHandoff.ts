/**
 * Motion continuity from the billboard into the detail overlay of the same title: "More info"
 * hands over the clip's position and the frame on screen, so the overlay's picture flies out as
 * that very frame and the hero clip carries on from there (instead of restarting from the
 * still). Taken once, by the overlay that opens next, and only for the same title moments later.
 */
export interface ClipHandoff {
  titleId: string;
  /** The playing clip's URL (absolute). */
  src: string;
  positionSec: number;
  hasAudio: boolean;
  /** The frame on screen when it was handed over (null when it could not be captured). */
  frame: HTMLCanvasElement | null;
  at: number;
}

/** The overlay opens within a frame or two of the click; anything older is stale. */
const FRESH_MS = 2500;

let offered: ClipHandoff | null = null;

export function offerClipHandoff(
  titleId: string,
  video: HTMLVideoElement | null | undefined,
  hasAudio: boolean,
): void {
  offered = null;
  // HAVE_CURRENT_DATA: there is a frame to show.
  if (!video || video.readyState < 2 || video.ended || !video.currentSrc) return;
  offered = {
    titleId,
    src: video.currentSrc,
    positionSec: video.currentTime,
    hasAudio,
    frame: captureFrame(video),
    at: performance.now(),
  };
}

export function takeClipHandoff(titleId: string): ClipHandoff | null {
  const handoff = offered;
  offered = null;
  if (!handoff || handoff.titleId !== titleId) return null;
  return performance.now() - handoff.at <= FRESH_MS ? handoff : null;
}

/** Whether `url` (possibly relative) names the same clip as `src`. */
export function sameClip(url: string, src: string): boolean {
  try {
    return new URL(url, window.location.href).href === new URL(src, window.location.href).href;
  } catch {
    return url === src;
  }
}

function captureFrame(video: HTMLVideoElement): HTMLCanvasElement | null {
  if (!video.videoWidth || !video.videoHeight) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) return null;
    // A cross-origin clip taints the canvas: it still displays, which is all it is for.
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch {
    return null;
  }
}
