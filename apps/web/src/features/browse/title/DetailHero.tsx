import { Link } from "@tanstack/react-router";
import type { TitleCard, TitleDetail } from "@webflix/contracts";
import type { PreviewPlayerHandle } from "@webflix/player";
import {
  Button,
  cx,
  IconButton,
  PlayIcon,
  RefreshIcon,
  ResponsiveImage,
  Skeleton,
  sliderImageSizes,
  Tooltip,
  VolumeHighIcon,
  VolumeMuteIcon,
} from "@webflix/ui";
import {
  lazy,
  type Ref,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTrack } from "../../../app/telemetry/index.ts";
import { type ClipHandoff, sameClip } from "../common/clipHandoff.ts";
import { episodeCode } from "../common/format.ts";
import { clipHasAudio, usePreviewMuted, usePreviewsEnabled } from "../common/previews.ts";
import { TitleTreatment } from "../common/TitleTreatment.tsx";
import { watchedSeconds } from "../common/telemetry.ts";
import { playLabel, watchLink } from "../common/watch.ts";
import { MyListButton } from "../library/MyListButton.tsx";
import { RatingControl } from "../library/RatingControl.tsx";

const PreviewVideo = lazy(() =>
  import("../common/PreviewVideo.tsx").then((module) => ({ default: module.PreviewVideo })),
);

/** The hero clip starts this long after the overlay has finished opening. */
export const DETAIL_VIDEO_DELAY_MS = 700;
const HERO_SIZES = "(min-width: 848px) 848px, 100vw";

export interface DetailHeroProps {
  title: TitleDetail | null;
  /** The card already cached (rows, search…): paints the hero before the detail arrives. */
  seed: TitleCard | null;
  /** The opening animation has finished (and the overlay is not closing). */
  entered: boolean;
  playRef: RefObject<HTMLAnchorElement | null>;
  /** The picture: the overlay flies it from (and back into) the card it was opened from. */
  pictureRef?: Ref<HTMLDivElement>;
  /** The decoded image that was clicked, painted first (no fade) for the shared-element flight. */
  originImage?: string | null;
  /** The billboard's clip of this title, handed over by "More info": continue it from there. */
  handoff?: ClipHandoff | null;
  phone: boolean;
}

/**
 * Picture first: the card art (instant, it is what the overlay grew from), then the backdrop
 * with the title logo, then the muted preview clip (footage or motion). Opened from the
 * billboard of the same title, it flies out as the billboard's current frame and the clip carries
 * on from that position, without the usual pause. Actions sit on the picture from tablet up and
 * under it on phones. The name here is visual: the dialog's title is its one heading.
 */
export function DetailHero({
  title,
  seed,
  entered,
  playRef,
  pictureRef,
  originImage = null,
  handoff = null,
  phone,
}: DetailHeroProps) {
  const card = title ?? seed;
  const previewsEnabled = usePreviewsEnabled();
  const [muted, setMuted] = usePreviewMuted();
  const [backdropLoaded, setBackdropLoaded] = useState(false);
  const [phase, setPhase] = useState<"still" | "playing" | "ended">("still");
  const video = useRef<PreviewPlayerHandle>(null);
  const clip = previewsEnabled && !phone ? (card?.preview ?? null) : null;
  // Read once: the hand-over is for this opening (the details may not have arrived yet).
  const [continued] = useState(() => (handoff && previewsEnabled && !phone ? handoff : null));
  const continues = !!continued && (!clip || sameClip(clip.url, continued.src));
  const clipSrc = continues && continued ? continued.src : (clip?.url ?? null);
  // The clip is a preview of this title, reported from the details (the overlay's scope).
  const clipTitleId = card?.id ?? null;
  const trackClip = useTrack();
  const sound = continues && continued ? continued.hasAudio : clipHasAudio(clip);
  // A continued clip loads during the flight and plays as it lands; otherwise it waits a beat.
  const [armed, setArmed] = useState(continues);
  const [frameShown, setFrameShown] = useState(true);

  useEffect(() => {
    if (!entered || !clipSrc || armed) return;
    const timer = setTimeout(() => setArmed(true), DETAIL_VIDEO_DELAY_MS);
    return () => clearTimeout(timer);
  }, [entered, clipSrc, armed]);

  // The card art carries its own title treatment; draw ours once the clean backdrop or the clip
  // is showing (and always when there is nothing cached to draw).
  const showTreatment = backdropLoaded || phase !== "still" || continues || (!seed && !originImage);

  return (
    <div className="relative">
      <div
        ref={pictureRef}
        style={{ transformOrigin: "0 0" }}
        className="relative aspect-video w-full overflow-hidden bg-surface-1 sm:rounded-t-dialog"
      >
        {originImage ? (
          // Already decoded in the page: synchronous, no fade, so the flight starts as the card.
          <img
            src={originImage}
            alt=""
            decoding="sync"
            draggable={false}
            className="absolute inset-0 size-full object-cover"
          />
        ) : card ? (
          <ResponsiveImage
            image={card.images.card}
            alt=""
            fill
            sizes={sliderImageSizes("standard")}
            priority
          />
        ) : (
          <Skeleton radius="none" className="absolute inset-0" />
        )}
        {title ? (
          <ResponsiveImage
            image={title.images.backdrop}
            alt=""
            fill
            priority
            sizes={HERO_SIZES}
            placeholder={seed || originImage ? "none" : "blur"}
            onLoad={() => setBackdropLoaded(true)}
          />
        ) : null}
        {continues && continued?.frame && frameShown ? (
          <HandoffFrame frame={continued.frame} />
        ) : null}
        {armed && clipSrc ? (
          <Suspense fallback={null}>
            <PreviewVideo
              handle={video}
              src={clipSrc}
              startPositionSec={continues && continued ? continued.positionSec : 0}
              active={entered}
              muted={muted}
              onMutedChange={setMuted}
              onFirstFrame={() => {
                setPhase("playing");
                // A clip handed over by the billboard carries on: it started there.
                if (clipTitleId && !continues) {
                  trackClip("preview.start", { titleId: clipTitleId });
                }
              }}
              onEnded={() => {
                setPhase("ended");
                setFrameShown(false);
                if (clipTitleId) {
                  trackClip("preview.complete", {
                    titleId: clipTitleId,
                    watchedSec: watchedSeconds(video.current),
                  });
                }
              }}
              onError={() => {
                setPhase("still");
                setFrameShown(false);
              }}
              fade="--duration-cinematic"
            />
          </Suspense>
        ) : null}
        <div
          aria-hidden
          data-hero-chrome
          className="pointer-events-none absolute inset-0 bg-linear-to-t from-surface-2 via-surface-2/5 to-transparent"
        />
        {!phone && card ? (
          <div
            data-hero-chrome
            className="absolute inset-x-0 bottom-0 flex flex-col items-start gap-5 px-10 pb-8 md:px-12 md:pb-10"
          >
            <div
              className={cx(
                "transition-opacity duration-slow ease-standard",
                showTreatment ? "opacity-100" : "opacity-0",
              )}
            >
              <TitleTreatment
                name={card.name}
                logo={card.images.logo}
                as="p"
                aria-hidden
                sizes="22rem"
                logoClassName="block max-h-32 w-80 max-w-[60vw] md:w-96"
                textClassName="type-display-md max-w-[16ch] line-clamp-2"
              />
            </div>
            <div className="flex w-full items-center gap-3">
              <PlayButton title={title} playRef={playRef} size="lg" />
              {title ? (
                <>
                  <RestartButton title={title} />
                  <MyListButton title={title} card={title} size="lg" />
                  <RatingControl title={title} size="lg" />
                </>
              ) : (
                <>
                  <Skeleton radius="full" className="size-12" />
                  <Skeleton radius="full" className="size-12" />
                </>
              )}
              {phase === "ended" || (phase === "playing" && sound) ? (
                <IconButton
                  label={
                    phase === "ended"
                      ? "Replay preview"
                      : muted
                        ? "Turn sound on"
                        : "Turn sound off"
                  }
                  icon={phase === "ended" ? RefreshIcon : muted ? VolumeMuteIcon : VolumeHighIcon}
                  variant="outline"
                  size="lg"
                  pressed={phase === "playing" ? !muted : undefined}
                  className="ms-auto"
                  onClick={() => {
                    if (phase === "ended") {
                      video.current?.restart();
                      // A continued clip "starts" where the billboard was: replay from the top.
                      const media = video.current?.media;
                      if (media) media.currentTime = 0;
                      void video.current?.play().catch(() => {});
                      setPhase("playing");
                    } else {
                      setMuted(!muted);
                    }
                  }}
                />
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {phone ? (
        <div className="flex flex-col gap-4 px-5 pt-1">
          {/* Visual: the dialog's title (one h2) already names the title. */}
          <p aria-hidden className="type-title-lg text-fg">
            {card?.name ?? <Skeleton radius="sm" className="h-7 w-48" />}
          </p>
          <PlayButton title={title} playRef={playRef} size="lg" fullWidth />
          {title ? (
            <div className="flex items-start gap-4">
              <MyListButton title={title} card={title} labelled />
              <RatingControl title={title} labelled />
              {title.playTarget?.action === "resume" && title.type === "movie" ? (
                <Link
                  {...watchLink(title.id, { t: 0 })}
                  className="focus-ring flex min-w-16 flex-col items-center gap-1.5 rounded-sm px-2 py-1 text-fg"
                >
                  <RefreshIcon size="lg" />
                  <span className="type-caption text-fg-muted">Restart</span>
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The billboard frame that was on screen, shown until the continued clip presents its own. */
function HandoffFrame({ frame }: { frame: HTMLCanvasElement }) {
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      frame.className = "absolute inset-0 size-full object-cover";
      node.replaceChildren(frame);
    },
    [frame],
  );
  return <div ref={attach} aria-hidden data-handoff-frame="" className="absolute inset-0" />;
}

function PlayButton({
  title,
  playRef,
  size,
  fullWidth = false,
}: {
  title: TitleDetail | null;
  playRef: RefObject<HTMLAnchorElement | null>;
  size: "lg";
  fullWidth?: boolean;
}) {
  if (!title) return <Skeleton radius="md" className={cx("h-12", fullWidth ? "w-full" : "w-36")} />;
  if (!title.isPlayable || !title.playTarget) {
    return (
      <Button size={size} variant="secondary" disabled fullWidth={fullWidth}>
        Coming soon
      </Button>
    );
  }
  const target = title.playTarget;
  const label = playLabel(target);
  const episode = target.episode;
  return (
    <Button size={size} variant="primary" icon={PlayIcon} asChild fullWidth={fullWidth}>
      {/* The visible label is the accessible name ("Resume S2:E3"); the dialog names the title. */}
      <Link ref={playRef} {...watchLink(title.id, episode ? { episodeId: episode.id } : {})}>
        {label}
        {episode && title.type === "series" && target.action === "resume" ? (
          <span className="font-normal opacity-70">{episodeCode(episode)}</span>
        ) : null}
      </Link>
    </Button>
  );
}

/** "Start from the beginning" next to Resume, for a movie already started. */
function RestartButton({ title }: { title: TitleDetail }) {
  if (title.type !== "movie" || title.playTarget?.action !== "resume") return null;
  return (
    <Tooltip content="Start from the beginning">
      <IconButton
        label={`Start ${title.name} from the beginning`}
        icon={RefreshIcon}
        variant="outline"
        size="lg"
        asChild
      >
        <Link {...watchLink(title.id, { t: 0 })} />
      </IconButton>
    </Tooltip>
  );
}
