import { PreviewPlayer, type PreviewPlayerHandle } from "@webflix/player";
import type { CSSProperties, Ref } from "react";

export interface PreviewVideoProps {
  src: string;
  /** Host intent: false pauses on the current frame (an overlay or another preview took over). */
  active: boolean;
  muted: boolean;
  onMutedChange?: (muted: boolean) => void;
  onFirstFrame?: () => void;
  onEnded?: () => void;
  onError?: () => void;
  /** Cross-fade length from the still to the first frame (a duration token name). */
  fade?: "--duration-slow" | "--duration-cinematic";
  /** Fraction of the picture that must be on screen to play (billboard: half; cards: most). */
  visibilityThreshold?: number;
  /** Where the clip starts (a hand-over from the billboard); read once, when it mounts. */
  startPositionSec?: number;
  handle?: Ref<PreviewPlayerHandle>;
}

/**
 * The muted, chrome-less preview clip (billboard, hover card, detail hero), on top of the still
 * artwork that the caller draws underneath: the player has no poster of its own, so the
 * responsive, blur-up artwork stays the single source of the still and the clip fades in over it
 * on its first presented frame. Loaded lazily: browse pages pay for the player code only once a
 * clip is about to play. Clips are progressive MP4, so hls.js is never requested here.
 */
export function PreviewVideo({
  src,
  active,
  muted,
  onMutedChange,
  onFirstFrame,
  onEnded,
  onError,
  fade = "--duration-slow",
  visibilityThreshold = 0.5,
  startPositionSec = 0,
  handle,
}: PreviewVideoProps) {
  return (
    <div className="absolute inset-0">
      <PreviewPlayer
        ref={handle}
        src={src}
        active={active}
        muted={muted}
        onMutedChange={onMutedChange}
        onFirstFrame={onFirstFrame}
        onEnded={onEnded}
        onError={onError}
        visibilityThreshold={visibilityThreshold}
        startPositionSec={startPositionSec}
        // Reduced motion and the profile's autoplay setting are decided before this mounts.
        respectReducedMotion={false}
        maxVideoHeight={720}
        style={
          {
            "--wfp-preview-fade": `var(${fade})`,
            "--wfp-ease": "var(--ease-standard)",
          } as CSSProperties
        }
      />
    </div>
  );
}
