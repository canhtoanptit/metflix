import { Link } from "@tanstack/react-router";
import type { Billboard as BillboardData, BrowseView, RankingPolicy } from "@webflix/contracts";
import type { PreviewPlayerHandle } from "@webflix/player";
import {
  Button,
  CheckIcon,
  cx,
  InfoIcon,
  OriginalLabel,
  PlayIcon,
  PlusIcon,
  RefreshIcon,
  ResponsiveImage,
  Skeleton,
  useMediaQuery,
  useMergedRefs,
  VolumeHighIcon,
  VolumeMuteIcon,
} from "@webflix/ui";
import {
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTitleOverlay } from "../../../app/overlay/titleOverlay.ts";
import { TelemetryScope } from "../../../app/telemetry/index.ts";
import { offerClipHandoff } from "../common/clipHandoff.ts";
import { genreLine } from "../common/format.ts";
import { clipHasAudio, usePreviewMuted, usePreviewsEnabled } from "../common/previews.ts";
import { TitleTreatment } from "../common/TitleTreatment.tsx";
import {
  billboardRowId,
  noteTitleOpen,
  type Placement,
  track,
  useCardImpression,
  usePlacementContext,
  useRowView,
  watchedSeconds,
} from "../common/telemetry.ts";
import { playLabel, watchLink } from "../common/watch.ts";
import { useMyListToggle } from "../library/useMyListToggle.ts";
import { usePreviewOpen } from "../preview/store.ts";
import { PHONE_QUERY } from "../shell/TopNav.tsx";

const PreviewVideo = lazy(() =>
  import("../common/PreviewVideo.tsx").then((module) => ({ default: module.PreviewVideo })),
);

/** The still holds the stage this long (after it has loaded) before the clip starts. */
export const BILLBOARD_VIDEO_DELAY_MS = 2000;
/** Once the clip plays, the synopsis gives way to the picture after this long. */
export const BILLBOARD_COLLAPSE_DELAY_MS = 3500;

type Phase = "still" | "playing" | "ended";

interface BillboardProps {
  billboard: BillboardData;
  view: BrowseView;
  /** The ranking policy of the page that brought it. */
  policy: RankingPolicy | null;
}

/** The billboard is the page's first module: `rowRank` 1, its one card `rank` 1. */
function billboardPlacement(view: BrowseView, policy: RankingPolicy | null): Placement {
  return { rowId: billboardRowId(view), rowRank: 1, rank: 1, policy };
}

/**
 * What the billboard reports: one row view and one impression per appearance (it is a module
 * with one card), and its title opens (More info, Play) from that place.
 */
function useBillboardTelemetry(
  billboard: BillboardData,
  view: BrowseView,
  policy: RankingPolicy | null,
) {
  const placement = billboardPlacement(view, policy);
  const rowView = useRowView({ rowKind: "billboard", itemCount: 1, placement });
  const impression = useCardImpression({ titleId: billboard.title.id, placement });
  return {
    ref: useMergedRefs<HTMLElement>(rowView, impression),
    context: usePlacementContext(placement),
  };
}

export function Billboard({ billboard, view, policy }: BillboardProps) {
  const phone = useMediaQuery(PHONE_QUERY);
  return phone ? (
    <BillboardCard billboard={billboard} view={view} policy={policy} />
  ) : (
    <BillboardHero billboard={billboard} view={view} policy={policy} />
  );
}

/**
 * Landscape hero (tablet and up): the backdrop, then after a beat the muted preview cross-fades
 * in and the synopsis makes way; title treatment, Play / More info, sound or replay, maturity.
 * The clip pauses (on its frame) when the detail overlay or a hover preview takes over, when it
 * is scrolled half out of view or the tab is hidden; it never starts when the profile turned
 * previews off, under reduced motion or data saver.
 */
function BillboardHero({ billboard, view, policy }: BillboardProps) {
  const { title } = billboard;
  const telemetry = useBillboardTelemetry(billboard, view, policy);
  const { titleId: overlayTitle, open } = useTitleOverlay();
  const previewOpen = usePreviewOpen();
  const previewsEnabled = usePreviewsEnabled();
  const [muted, setMuted] = usePreviewMuted();
  const [backdropLoaded, setBackdropLoaded] = useState(false);
  const [armed, setArmed] = useState(false);
  const [phase, setPhase] = useState<Phase>("still");
  const [collapsed, setCollapsed] = useState(false);
  const video = useRef<PreviewPlayerHandle>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const sectionTelemetryRef = useMergedRefs<HTMLElement>(sectionRef, telemetry.ref);
  const synopsisRef = useRef<HTMLParagraphElement>(null);
  const [shift, setShift] = useState(0);
  // Footage and motion previews both play here; only a clip with sound gets a sound control.
  const clip = previewsEnabled ? title.preview : null;
  const sound = clipHasAudio(clip);

  // Cached backdrops never fire `load` after mount; treat an already-decoded image as loaded.
  useEffect(() => {
    const image = sectionRef.current?.querySelector<HTMLImageElement>(".wf-image__img");
    if (image?.complete) setBackdropLoaded(true);
  }, []);

  useEffect(() => {
    if (!clip || !backdropLoaded) return;
    const timer = setTimeout(() => setArmed(true), BILLBOARD_VIDEO_DELAY_MS);
    return () => clearTimeout(timer);
  }, [clip, backdropLoaded]);

  useEffect(() => {
    if (phase !== "playing") {
      setCollapsed(false);
      return;
    }
    const timer = setTimeout(() => setCollapsed(true), BILLBOARD_COLLAPSE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  // The title treatment slides down into the synopsis' place when it collapses (transform only).
  useLayoutEffect(() => {
    const synopsis = synopsisRef.current;
    if (!synopsis || typeof ResizeObserver === "undefined") return;
    const measure = () => setShift(synopsis.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(synopsis);
    return () => observer.disconnect();
  }, []);

  const active = !overlayTitle && !previewOpen;
  const target = billboard.playTarget;

  return (
    <section
      ref={sectionTelemetryRef}
      aria-label={`Featured: ${title.name}`}
      className="relative h-[56.25vw] max-h-dvh min-h-[28rem] w-full overflow-hidden bg-canvas"
    >
      <div className="absolute inset-0">
        <ResponsiveImage
          image={billboard.backdrop}
          alt=""
          fill
          priority
          sizes="100vw"
          position="center top"
          onLoad={() => setBackdropLoaded(true)}
        />
        {armed && clip ? (
          <Suspense fallback={null}>
            <PreviewVideo
              handle={video}
              src={clip.url}
              active={active}
              muted={muted}
              onMutedChange={setMuted}
              onFirstFrame={() => {
                setPhase("playing");
                track("preview.start", { titleId: title.id }, telemetry.context);
              }}
              onEnded={() => {
                setPhase("ended");
                track(
                  "preview.complete",
                  { titleId: title.id, watchedSec: watchedSeconds(video.current) },
                  telemetry.context,
                );
              }}
              onError={() => setPhase("still")}
              fade="--duration-cinematic"
            />
          </Suspense>
        ) : null}
      </div>
      <div aria-hidden className="absolute inset-0 scrim-start" />
      <div aria-hidden className="absolute inset-x-0 bottom-0 h-1/2 scrim-bottom" />

      <div className="absolute inset-x-0 bottom-[24%] flex flex-col items-start gap-[1.1vw] ps-gutter pe-gutter md:w-[46%] md:pe-0 lg:bottom-[28%] lg:w-[38%] 2xl:w-[34%]">
        <div
          className="flex origin-bottom-left flex-col items-start gap-[1vw] transition-transform duration-(--duration-cinematic) ease-standard"
          style={{ transform: collapsed ? `translateY(${shift}px) scale(0.78)` : undefined }}
        >
          {title.isOriginal ? (
            <OriginalLabel
              kind={title.type === "series" ? "series" : "film"}
              className="text-[max(0.8125rem,1.05vw)]"
            />
          ) : null}
          <TitleTreatment
            name={title.name}
            logo={title.images.logo}
            as="h2"
            priority
            sizes="(min-width: 1100px) 34vw, 46vw"
            logoClassName="block max-h-[min(11vw,11rem)] w-[32vw] max-w-[32rem] min-w-56"
            textClassName="type-display-lg max-w-[14ch] line-clamp-3"
          />
        </div>
        <p
          ref={synopsisRef}
          className={cx(
            "hidden max-w-prose type-body-lg text-fg drop-shadow-md md:line-clamp-3",
            "transition-opacity duration-slow ease-standard",
            collapsed ? "opacity-0" : "opacity-100",
          )}
          aria-hidden={collapsed || undefined}
        >
          {billboard.synopsis}
        </p>
        <div className="mt-[0.4vw] flex flex-wrap items-center gap-3">
          <Button size="hero" variant="primary" icon={PlayIcon} asChild>
            <Link
              {...watchLink(title.id)}
              onClick={() => track("title.open", { titleId: title.id }, telemetry.context)}
            >
              {playLabel(target)}
            </Link>
          </Button>
          <Button
            size="hero"
            variant="secondary"
            icon={InfoIcon}
            onClick={() => {
              // The detail hero continues this clip from this frame (same title, same clip).
              offerClipHandoff(title.id, phase === "playing" ? video.current?.media : null, sound);
              noteTitleOpen(title.id, telemetry.context);
              open(title.id, { origin: sectionRef.current });
            }}
          >
            More info
          </Button>
        </div>
      </div>

      <div className="absolute end-0 bottom-[24%] flex items-center gap-3 lg:bottom-[28%]">
        {phase === "playing" && sound ? (
          <RoundControl
            label={muted ? "Turn sound on" : "Turn sound off"}
            pressed={!muted}
            onClick={() => setMuted(!muted)}
          >
            {muted ? <VolumeMuteIcon size="inherit" /> : <VolumeHighIcon size="inherit" />}
          </RoundControl>
        ) : phase === "ended" ? (
          <RoundControl
            label="Replay preview"
            onClick={() => {
              video.current?.restart();
              void video.current?.play().catch(() => {});
              setPhase("playing");
              track("preview.start", { titleId: title.id }, telemetry.context);
            }}
          >
            <RefreshIcon size="inherit" />
          </RoundControl>
        ) : null}
        <div className="flex h-control-hero items-center border-s-3 border-fg-muted bg-glass ps-3 pe-gutter type-body text-fg">
          <span className="sr-only">Maturity rating </span>
          {title.maturity === "ALL" ? "All ages" : title.maturity}
          {billboard.maturityDescriptors.length > 0 ? (
            <span className="sr-only">: {billboard.maturityDescriptors.join(", ")}</span>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function RoundControl({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cx(
        "focus-ring grid size-control-hero place-items-center rounded-full border-2 border-fg-muted bg-glass text-[1.35em] text-fg",
        "transition-[border-color,background-color] duration-fast ease-standard hover:border-fg hover:bg-glass-hover",
        "animate-fade-in",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Phones: a poster card under the navigation (artwork carries the title treatment), its genres
 * and moods, Play and My List — the pattern people know from streaming apps. No autoplay on
 * phones: video previews are a desktop affordance, and data matters.
 */
function BillboardCard({ billboard, view, policy }: BillboardProps) {
  const { title } = billboard;
  const telemetry = useBillboardTelemetry(billboard, view, policy);
  const tags = [...title.moods.slice(0, 2), ...genreLine(title, 1)];
  return (
    <section
      ref={telemetry.ref}
      aria-label={`Featured: ${title.name}`}
      className="relative px-gutter pt-3"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-nav bottom-1/3 opacity-60"
        style={{
          backgroundImage: `linear-gradient(to bottom, ${title.images.poster.dominantColor}, var(--color-canvas))`,
        }}
      />
      <div className="relative mx-auto w-full max-w-[min(100%,19rem)] overflow-hidden rounded-xl border border-line-subtle bg-surface-1 shadow-xl">
        <div className="relative aspect-poster w-full">
          <ResponsiveImage image={title.images.poster} alt="" fill priority sizes="19rem" />
        </div>
        {/* Below the artwork, never on it: posters carry their own title treatment. */}
        <TelemetryScope context={telemetry.context}>
          <div className="flex flex-col items-center gap-3 px-4 pt-3 pb-4">
            <h2 className="sr-only">{title.name}</h2>
            {tags.length > 0 ? (
              <p className="flex flex-wrap items-center justify-center gap-x-2 type-body-sm text-fg">
                {tags.map((tag, index) => (
                  <span key={tag} className="flex items-center gap-2">
                    {index > 0 ? (
                      <span aria-hidden className="text-fg-subtle">
                        •
                      </span>
                    ) : null}
                    {tag}
                  </span>
                ))}
              </p>
            ) : null}
            <div className="grid w-full grid-cols-2 gap-3">
              <Button variant="primary" size="md" icon={PlayIcon} asChild>
                <Link
                  {...watchLink(title.id)}
                  onClick={() => track("title.open", { titleId: title.id }, telemetry.context)}
                >
                  {playLabel(billboard.playTarget)}
                </Link>
              </Button>
              <BillboardListButton billboard={billboard} />
            </div>
          </div>
        </TelemetryScope>
      </div>
    </section>
  );
}

function BillboardListButton({ billboard }: { billboard: BillboardData }) {
  const { title } = billboard;
  const toggle = useMyListToggle();
  const inList = title.viewer.inMyList;
  return (
    <Button
      variant="outline"
      size="md"
      icon={inList ? CheckIcon : PlusIcon}
      aria-pressed={inList}
      aria-label={inList ? `Remove ${title.name} from My List` : `Add ${title.name} to My List`}
      onClick={() =>
        toggle.mutate({ titleId: title.id, add: !inList, name: title.name, card: title })
      }
    >
      My List
    </Button>
  );
}

export function BillboardSkeleton() {
  const phone = useMediaQuery(PHONE_QUERY);
  if (phone) {
    return (
      <div className="px-gutter pt-3">
        <div className="mx-auto w-full max-w-[min(100%,19rem)] overflow-hidden rounded-xl border border-line-subtle">
          <Skeleton radius="none" className="aspect-poster w-full" />
          <div className="flex flex-col items-center gap-3 bg-surface-1 px-4 pt-3 pb-4">
            <Skeleton radius="sm" className="h-5 w-40" />
            <div className="grid w-full grid-cols-2 gap-3">
              <Skeleton radius="md" className="h-10" />
              <Skeleton radius="md" className="h-10" />
            </div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="relative h-[56.25vw] max-h-dvh min-h-[28rem] w-full">
      <Skeleton radius="none" className="absolute inset-0" />
      <div className="absolute inset-x-0 bottom-[24%] flex flex-col gap-4 ps-gutter lg:bottom-[28%]">
        <Skeleton radius="sm" className="h-[8vw] min-h-16 w-[30vw] min-w-48" />
        <Skeleton radius="sm" className="hidden h-4 w-[36vw] md:block" />
        <Skeleton radius="sm" className="hidden h-4 w-[30vw] md:block" />
        <div className="flex gap-3">
          <Skeleton radius="md" className="h-control-hero w-32" />
          <Skeleton radius="md" className="h-control-hero w-40" />
        </div>
      </div>
    </div>
  );
}
