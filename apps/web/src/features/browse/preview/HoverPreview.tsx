import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatTimeLeft, formatTimeLeftSpoken, progressFraction } from "@webflix/contracts";
import type { PreviewPlayerHandle } from "@webflix/player";
import {
  ChevronDownIcon,
  CloseIcon,
  cx,
  IconButton,
  MaturityBadge,
  PlayIcon,
  ProgressBar,
  QualityBadge,
  ResponsiveImage,
  TITLE_BADGE_LABELS,
  Tooltip,
  Top10Badge,
  VolumeHighIcon,
  VolumeMuteIcon,
} from "@webflix/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTitleOverlay } from "../../../app/overlay/titleOverlay.ts";
import { queries } from "../../../app/query/queries.ts";
import { TelemetryScope } from "../../../app/telemetry/index.ts";
import { episodeCode, formatLength, genreLine, qualityLabel } from "../common/format.ts";
import { canAnimate, durationMs, easing } from "../common/motion.ts";
import { PreviewVideo } from "../common/PreviewVideo.tsx";
import {
  clipHasAudio,
  hoverClip,
  usePreviewMuted,
  usePreviewsEnabled,
} from "../common/previews.ts";
import { useBrowseSession } from "../common/session.ts";
import { TitleTreatment } from "../common/TitleTreatment.tsx";
import { noteTitleOpen, track, watchedSeconds } from "../common/telemetry.ts";
import { watchLink } from "../common/watch.ts";
import { MyListButton } from "../library/MyListButton.tsx";
import { RatingControl } from "../library/RatingControl.tsx";
import { useLiveViewer } from "../library/useLiveViewer.ts";
import { useRemoveFromContinueWatching } from "../library/useRemoveFromContinueWatching.ts";
import { setOverlayReturnFocus } from "../title/returnFocus.ts";
import { type PreviewGeometry, previewGeometry } from "./geometry.ts";
import { loadArt, measureLayout, previewArtUrl } from "./prepare.ts";
import { type PreviewRequest, previewStore, usePreviewRequest } from "./store.ts";

/** After the card has finished growing, the clip waits this long before it starts. */
export const PREVIEW_VIDEO_DELAY_MS = 400;
/** Scrolling further than this closes the preview (small trackpad jitter does not). */
const SCROLL_CLOSE_PX = 24;

interface Entry {
  key: number;
  request: PreviewRequest;
  closing: boolean;
}

/**
 * The hover preview layer: renders the store's request in a portal on `document.body`, so the
 * preview escapes the row's horizontal clip and overlaps neighbouring rows. A replaced preview
 * plays its exit while the next one enters.
 */
export function HoverPreview() {
  const request = usePreviewRequest();
  const [entries, setEntries] = useState<Entry[]>([]);
  const sequence = useRef(0);

  useEffect(() => {
    setEntries((current) => {
      // Idempotent per request (effects can run twice for one change, e.g. StrictMode).
      const live = current.find((entry) => !entry.closing);
      if (request && live?.request === request) return current;
      const leaving = current.map((entry) => (entry.closing ? entry : { ...entry, closing: true }));
      if (!request) return leaving;
      sequence.current += 1;
      return [...leaving, { key: sequence.current, request, closing: false }];
    });
  }, [request]);

  if (entries.length === 0) return null;
  return createPortal(
    entries.map((entry) => (
      // Everything done in a preview (list, rating, its clip) reports from the card's place.
      <TelemetryScope key={entry.key} context={entry.request.context ?? {}}>
        <PreviewCard
          request={entry.request}
          closing={entry.closing}
          onExited={() => setEntries((current) => current.filter((item) => item.key !== entry.key))}
        />
      </TelemetryScope>
    )),
    document.body,
  );
}

function PreviewCard({
  request,
  closing,
  onExited,
}: {
  request: PreviewRequest;
  closing: boolean;
  onExited: () => void;
}) {
  const { card } = request;
  const queryClient = useQueryClient();
  const session = useBrowseSession();
  const { open: openOverlay } = useTitleOverlay();
  const previewsEnabled = usePreviewsEnabled();
  const [muted, setMuted] = usePreviewMuted();
  const viewer = useLiveViewer(card);
  const removeFromRow = useRemoveFromContinueWatching();
  const boxRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  const video = useRef<PreviewPlayerHandle>(null);
  const scrollAtOpen = useRef({ x: window.scrollX, y: window.scrollY });
  const [geometry, setGeometry] = useState<PreviewGeometry>(() =>
    previewGeometry({ rect: request.rect, edge: request.edge, ...measureLayout() }),
  );
  const [measured, setMeasured] = useState(false);
  const [entered, setEntered] = useState(false);
  const [armed, setArmed] = useState(false);
  const [playing, setPlaying] = useState(false);
  // First frame: artwork already decoded when the intent fired (see prepare.ts); after the lift,
  // the preview-width image takes over if it was not the one painted (same art, sharper).
  const [art] = useState(() => request.art ?? null);
  const [hiRes] = useState(() => previewArtUrl(card, geometry.width));
  const [sharpened, setSharpened] = useState(false);

  const live = { ...card, viewer };
  const compact = geometry.width < 300;
  const buttonSize = compact ? "sm" : "md";
  const clip = previewsEnabled ? hoverClip(card.preview) : null;
  const sound = clipHasAudio(clip);

  // Details are one click away: start loading them now.
  useEffect(() => {
    void queryClient.prefetchQuery(queries.title(card.id));
  }, [queryClient, card.id]);

  // Measure the info panel, then keep the whole preview inside the viewport (one layout pass,
  // before paint).
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    setGeometry(
      previewGeometry({
        rect: request.rect,
        edge: request.edge,
        ...measureLayout(),
        height: box.offsetHeight,
      }),
    );
    setMeasured(true);
  }, [request]);

  // Grow out of the card.
  useLayoutEffect(() => {
    if (!measured) return;
    const box = boxRef.current;
    if (!canAnimate(box)) {
      setEntered(true);
      return;
    }
    const duration = durationMs("--duration-base", 240);
    const reduced = duration === 0;
    // Posters are other artwork than the preview's picture: there the picture fades in as it grows.
    const poster = request.layout === "tall" || request.layout === "ranked";
    const animation = reduced
      ? box.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: durationMs("--duration-fade", 120),
          easing: "linear",
        })
      : box.animate(
          [
            { transform: `scale(${geometry.fromScale})`, opacity: poster ? 0 : 1 },
            { transform: "none", opacity: 1 },
          ],
          { duration, easing: easing("--ease-standard") },
        );
    // The panel (its surface and everything on it, rendered from the first frame) fades in as
    // one layer while the picture lifts: never an empty panel, never text over the page.
    if (!reduced) {
      for (const layer of [surfaceRef.current, panelRef.current]) {
        if (!canAnimate(layer)) continue;
        layer.animate([{ opacity: 0 }, { opacity: 1, offset: 0.7 }, { opacity: 1 }], {
          duration,
          easing: "linear",
        });
      }
    }
    animation.onfinish = () => setEntered(true);
    return () => animation.cancel();
    // Runs once, after the measured layout is committed.
  }, [measured]);

  useEffect(() => {
    if (!entered || !clip) return;
    const timer = setTimeout(() => setArmed(true), PREVIEW_VIDEO_DELAY_MS);
    return () => clearTimeout(timer);
  }, [entered, clip]);

  useEffect(() => {
    if (!entered || !art || art === hiRes) return;
    let live = true;
    void loadArt(hiRes).then((ready) => {
      if (live && ready) setSharpened(true);
    });
    return () => {
      live = false;
    };
  }, [entered, art, hiRes]);

  // Shrink back into the card (or simply fade when the card has gone or moved off screen).
  useLayoutEffect(() => {
    if (!closing) return;
    const box = boxRef.current;
    if (!canAnimate(box)) {
      onExited();
      return;
    }
    box.style.pointerEvents = "none";
    // Shrink back into the card only if it is still where the preview grew from (the row may
    // have paged, or the card left the row); otherwise just fade.
    const anchor = request.anchor.isConnected ? request.anchor.querySelector("a") : null;
    const rect = anchor?.getBoundingClientRect();
    const expectedLeft = request.rect.left - (window.scrollX - scrollAtOpen.current.x);
    const expectedTop = request.rect.top - (window.scrollY - scrollAtOpen.current.y);
    const inPlace =
      !!rect &&
      Math.abs(rect.left - expectedLeft) < 4 &&
      Math.abs(rect.top - expectedTop) < 4 &&
      Math.abs(rect.width - request.rect.width) < 4;
    const duration = durationMs("--duration-fast", 150);
    const shrink = request.rect.width / geometry.width;
    const keyframes: Keyframe[] =
      inPlace && duration > 0 && request.layout !== "tall" && request.layout !== "ranked"
        ? [
            { transform: "none", opacity: 1 },
            { transform: `scale(${shrink})`, opacity: 1, offset: 0.8 },
            { transform: `scale(${shrink})`, opacity: 0 },
          ]
        : [{ opacity: 1 }, { opacity: 0 }];
    for (const layer of [surfaceRef.current, panelRef.current]) {
      if (!canAnimate(layer)) continue;
      layer.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: Math.max(1, duration * 0.6),
        fill: "forwards",
      });
    }
    const animation = box.animate(keyframes, {
      duration: Math.max(1, duration || durationMs("--duration-fade", 120)),
      easing: easing("--ease-exit"),
      fill: "forwards",
    });
    animation.onfinish = onExited;
    return () => animation.cancel();
  }, [closing]);

  // Dismiss on scroll, resize, Escape or the window losing focus.
  useEffect(() => {
    if (closing) return;
    const onScroll = () => {
      const moved =
        Math.abs(window.scrollY - scrollAtOpen.current.y) +
        Math.abs(window.scrollX - scrollAtOpen.current.x);
      if (moved > SCROLL_CLOSE_PX) previewStore.scrolled();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") previewStore.close({ warm: false });
    };
    const close = () => previewStore.close({ warm: false });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [closing]);

  const expand = () => {
    request.onOpen?.();
    noteTitleOpen(card.id, request.context ?? {});
    setOverlayReturnFocus(request.anchor.querySelector("a"));
    // The detail overlay grows from this picture; hide the preview under it at once.
    if (boxRef.current) boxRef.current.style.visibility = "hidden";
    openOverlay(card.id, { origin: mediaRef.current });
  };

  const episode = request.episode ?? null;
  const progress = request.progress ?? null;
  const play = watchLink(card.id, episode ? { episodeId: episode.id } : {});
  const statusBadge = card.badge && card.badge !== "top-10" ? TITLE_BADGE_LABELS[card.badge] : null;
  const top10 = request.rankLabel ?? null;
  const quality = qualityLabel(card, session.plan);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a floating preview card, not a form group.
    <div
      ref={boxRef}
      role="group"
      aria-label={`${card.name} preview`}
      data-testid="hover-preview"
      data-title-id={card.id}
      className={cx("absolute z-(--z-preview)", !measured && "invisible")}
      style={{
        left: geometry.left + window.scrollX,
        top: geometry.top + window.scrollY,
        width: geometry.width,
        transformOrigin: `${geometry.originX}px ${geometry.originY}px`,
      }}
      onPointerEnter={() => previewStore.pointerEnteredPreview()}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") previewStore.pointerLeftPreview();
      }}
    >
      {/* The panel's surface: behind the picture, faded in with the panel's content. */}
      <div
        ref={surfaceRef}
        aria-hidden
        className="absolute inset-0 rounded-lg bg-surface-2 shadow-xl ring-1 ring-line-subtle"
      />
      {/* Clicking the picture opens the details, as people expect; the "More info" button is
          the same action for keyboard and assistive technology. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer shortcut duplicating the labelled More info button. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users have the More info button. */}
      <div
        ref={mediaRef}
        className={cx(
          "relative aspect-video w-full cursor-pointer overflow-hidden",
          // Rounded all round while it is still the card; square below once the panel is there.
          entered ? "rounded-t-lg" : "rounded-lg",
        )}
        onClick={(event) => {
          if ((event.target as Element).closest("button")) return;
          expand();
        }}
      >
        {art ? (
          // Decoded before the preview opened: painted synchronously on the first frame.
          <img
            src={art}
            alt=""
            decoding="sync"
            draggable={false}
            data-preview-art=""
            className="absolute inset-0 size-full object-cover"
          />
        ) : (
          // Nothing decoded in time (a slow network): the dominant colour, then the picture.
          <ResponsiveImage
            image={card.images.card}
            alt=""
            fill
            sizes={`${Math.round(geometry.width)}px`}
            priority
            placeholder="color"
          />
        )}
        {sharpened ? (
          <img
            src={hiRes}
            alt=""
            decoding="sync"
            draggable={false}
            className="absolute inset-0 size-full animate-fade-in object-cover"
          />
        ) : null}
        {armed && clip ? (
          <PreviewVideo
            handle={video}
            src={clip.url}
            active={!closing}
            muted={muted}
            onMutedChange={setMuted}
            onFirstFrame={() => {
              setPlaying(true);
              track("preview.start", { titleId: card.id }, request.context ?? {});
            }}
            onEnded={() => {
              setPlaying(false);
              track(
                "preview.complete",
                { titleId: card.id, watchedSec: watchedSeconds(video.current) },
                request.context ?? {},
              );
            }}
            onError={() => setPlaying(false)}
            visibilityThreshold={0.6}
          />
        ) : null}
        <div
          aria-hidden={!playing}
          className={cx(
            "pointer-events-none absolute inset-0 flex items-end justify-between gap-3 bg-linear-to-t from-black/60 via-transparent to-transparent p-3",
            // The logo arrives once the clip has covered the card art's own title treatment.
            "transition-opacity duration-slow ease-standard",
            playing ? "opacity-100 delay-(--duration-slow)" : "opacity-0",
          )}
        >
          <TitleTreatment
            name={card.name}
            logo={card.images.logo}
            as="p"
            sizes="160px"
            logoClassName="block max-h-12 w-2/5"
            textClassName="type-title line-clamp-2"
          />
          {playing && sound ? (
            <button
              type="button"
              aria-label={muted ? "Turn sound on" : "Turn sound off"}
              aria-pressed={!muted}
              onClick={() => setMuted(!muted)}
              className="focus-ring pointer-events-auto grid size-8 shrink-0 place-items-center rounded-full border border-fg-muted bg-glass text-fg transition-colors duration-fast ease-standard hover:border-fg"
            >
              {muted ? <VolumeMuteIcon size="sm" /> : <VolumeHighIcon size="sm" />}
            </button>
          ) : null}
        </div>
      </div>

      <div
        ref={panelRef}
        className={cx("relative flex flex-col", compact ? "gap-2.5 p-3" : "gap-3 p-4")}
      >
        <div className="flex items-center gap-2">
          <Tooltip
            content={episode ? `Resume ${episodeCode(episode)}` : progress ? "Resume" : "Play"}
          >
            <IconButton
              label={`Play ${card.name}`}
              icon={PlayIcon}
              variant="solid"
              size={buttonSize}
              asChild
            >
              <Link
                {...play}
                // Playing from a card is opening it: the ranker credits that card's impression.
                onClick={() => {
                  request.onOpen?.();
                  track("title.open", { titleId: card.id }, request.context ?? {});
                }}
              />
            </IconButton>
          </Tooltip>
          <MyListButton
            title={live}
            card={card}
            size={buttonSize}
            undoable={request.scope === "grid:my-list"}
          />
          <RatingControl title={live} size={buttonSize} />
          {request.removable ? (
            <Tooltip content="Remove from row">
              <IconButton
                label={`Remove ${card.name} from Continue Watching`}
                icon={CloseIcon}
                variant="outline"
                size={buttonSize}
                onClick={() => {
                  previewStore.close();
                  removeFromRow.mutate({ titleId: card.id, name: card.name });
                }}
              />
            </Tooltip>
          ) : null}
          <Tooltip content={card.type === "series" ? "Episodes and info" : "More info"}>
            <IconButton
              label={`More info about ${card.name}`}
              icon={ChevronDownIcon}
              variant="outline"
              size={buttonSize}
              className="ms-auto"
              onClick={expand}
            />
          </Tooltip>
        </div>

        {progress ? (
          <div className="flex flex-col gap-1.5">
            {episode ? (
              <p className="truncate type-label text-fg">
                {episodeCode(episode)}{" "}
                <span className="font-normal text-fg-muted">“{episode.name}”</span>
              </p>
            ) : null}
            <div className="flex items-center gap-3">
              <ProgressBar
                value={progressFraction(progress)}
                size="sm"
                className="flex-1"
                label="Watched"
                valueText={formatTimeLeftSpoken(progress)}
              />
              <span aria-hidden className="shrink-0 type-caption text-fg-muted tabular-nums">
                {formatTimeLeft(progress)}
              </span>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 type-body-sm">
          {card.matchScore !== null ? (
            <span className="font-semibold text-positive">{card.matchScore}% Match</span>
          ) : null}
          <MaturityBadge rating={card.maturity} />
          <span className="text-fg-muted">{formatLength(card)}</span>
          {quality ? <QualityBadge>{quality}</QualityBadge> : null}
        </div>

        {top10 || statusBadge ? (
          <p className="flex items-center gap-2 type-label text-fg">
            {top10 ? (
              <>
                <Top10Badge className="text-xs" />
                {top10}
              </>
            ) : (
              <span className="text-accent">{statusBadge}</span>
            )}
          </p>
        ) : null}

        <ul className="flex flex-wrap items-center gap-x-2 type-body-sm text-fg">
          {genreLine(card).map((genre, index) => (
            <li key={genre} className="flex items-center gap-2">
              {index > 0 ? (
                <span aria-hidden className="text-fg-subtle">
                  •
                </span>
              ) : null}
              {genre}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
