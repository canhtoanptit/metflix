import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, type TitleCard, type TitleDetail } from "@webflix/contracts";
import {
  Button,
  CloseIcon,
  cx,
  ErrorState,
  IconButton,
  SkeletonText,
  useMediaQuery,
} from "@webflix/ui";
import { Dialog as RadixDialog } from "radix-ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDocumentTitle } from "../../../app/head/DocumentTitle.tsx";
import {
  getTitleOverlayOrigin,
  setTitleOverlayOrigin,
  useTitleOverlay,
} from "../../../app/overlay/titleOverlay.ts";
import { describeError } from "../../../app/query/errors.ts";
import { queries } from "../../../app/query/queries.ts";
import { canAnimate, durationMs, easing } from "../common/motion.ts";
import { findCachedCard } from "../library/cache.ts";
import { PHONE_QUERY } from "../shell/TopNav.tsx";
import { AboutSection } from "./AboutSection.tsx";
import { DetailHero } from "./DetailHero.tsx";
import { DetailInfo } from "./DetailInfo.tsx";
import { EpisodeList } from "./EpisodeList.tsx";
import { MoreLikeThis } from "./MoreLikeThis.tsx";
import { takeOverlayReturnFocus } from "./returnFocus.ts";

/** Opening without an origin (a shared link, Forward): rise slightly, scaled about the top centre. */
const RISE_FROM = "translateY(2rem) translateX(50%) scale(0.96) translateX(-50%)";

export interface TitleDetailOverlayProps {
  titleId: string;
  /** The URL no longer names a title: play the exit, then call `onExited`. */
  closing: boolean;
  onExited: () => void;
}

/**
 * The title detail modal (`?title=<id>`). It grows out of whatever opened it — a card, a hover
 * preview's picture, the billboard — and shrinks back into it when closed (Esc, backdrop, the
 * close button or Back all go through the URL). The card already in the cache paints the hero at
 * once while the detail loads; the backdrop, logo and preview clip take over as they arrive.
 * Opening a title from "More Like This" stacks it (Back returns). Full screen on phones.
 */
export function TitleDetailOverlay({ titleId, closing, onExited }: TitleDetailOverlayProps) {
  const queryClient = useQueryClient();
  const { close } = useTitleOverlay();
  const detail = useQuery(queries.title(titleId));
  const seed = useMemo<TitleCard | null>(
    () => (detail.data ? null : findCachedCard(queryClient, titleId)),
    [queryClient, titleId, detail.data],
  );
  const phone = useMediaQuery(PHONE_QUERY);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const playRef = useRef<HTMLAnchorElement>(null);
  const [origin] = useState(() => getTitleOverlayOrigin());
  // The picture that was clicked (card, preview, billboard), already decoded: the hero paints it
  // on its first frame so the element that flies out of the card *is* the card.
  const [originImage] = useState(() => imageAt(origin));
  // Radix returns focus to a Dialog.Trigger, and the overlay has none (cards, previews and links
  // open it through the URL): remember what had focus when it opened.
  const [opener] = useState(() =>
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );
  const [entered, setEntered] = useState(false);
  const shownTitle = useRef(titleId);

  const title = detail.data ?? null;
  const name = title?.name ?? seed?.name ?? "Title details";
  useDocumentTitle(title?.name ?? seed?.name);

  // The origin belongs to this opening only (a later Forward must not reuse a stale rect).
  useEffect(() => setTitleOverlayOrigin(null), []);

  /** The panel's content other than the picture: text, controls, the picture's scrims. */
  const surroundings = (): HTMLElement[] =>
    [
      bodyRef.current,
      closeRef.current,
      ...(heroRef.current?.querySelectorAll<HTMLElement>("[data-hero-chrome]") ?? []),
    ].filter(canAnimate);

  // Enter: the picture flies from the card (a shared element: the hero first paints the card's
  // own, already loaded artwork) while the panel's surface, text and controls fade in around it.
  // Without an origin the panel rises into place. Started from the panel's ref callback: Radix
  // mounts portal content a render after the dialog, so it is not there in this component's own
  // mount effects; the ref fires in the commit that attaches it (children first), before paint.
  const entering = useRef<Animation | null>(null);
  const attachPanel = useCallback(
    (panel: HTMLDivElement | null) => {
      panelRef.current = panel;
      if (!panel || entering.current) return;
      if (!canAnimate(panel)) {
        setEntered(true);
        return;
      }
      const duration = durationMs("--duration-slow", 400);
      const reduced = duration === 0;
      const fade = durationMs("--duration-fade", 120);
      backdropRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: reduced ? fade : durationMs("--duration-base", 240),
        easing: "linear",
      });
      const hero = heroRef.current;
      const from = !reduced && origin && hero ? transformFromOrigin(hero, origin) : null;
      let animation: Animation;
      if (reduced) {
        animation = panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fade });
      } else if (from && hero) {
        animation = hero.animate([{ transform: from }, { transform: "none" }], {
          duration,
          easing: easing("--ease-standard"),
        });
        // The surface arrives first, then what sits on it: text never shows over the page.
        frameRef.current?.animate(
          [
            { opacity: 0 },
            { opacity: 0, offset: 0.2 },
            { opacity: 1, offset: 0.6 },
            { opacity: 1 },
          ],
          { duration, easing: "linear" },
        );
        for (const element of surroundings()) {
          element.animate([{ opacity: 0 }, { opacity: 0, offset: 0.55 }, { opacity: 1 }], {
            duration,
            easing: "linear",
          });
        }
      } else {
        animation = panel.animate(
          [
            { transform: RISE_FROM, opacity: 0 },
            { transform: "none", opacity: 1 },
          ],
          { duration, easing: easing("--ease-standard") },
        );
      }
      entering.current = animation;
      animation.onfinish = () => setEntered(true);
    },
    [origin],
  );
  useEffect(() => () => entering.current?.cancel(), []);

  // Exit: the picture shrinks back into the card (when the card is still on screen and the
  // picture in view) while the rest fades; otherwise the panel sinks away.
  useLayoutEffect(() => {
    if (!closing) return;
    const panel = panelRef.current;
    const hero = heroRef.current;
    if (!canAnimate(panel)) {
      onExited();
      return;
    }
    const duration = durationMs("--duration-base", 240);
    const reduced = duration === 0;
    const scrolled = (scrollerRef.current?.scrollTop ?? 0) > 120;
    const target =
      origin && hero && !reduced && !scrolled ? transformFromOrigin(hero, origin) : null;
    const length = reduced ? durationMs("--duration-fade", 120) : duration;
    backdropRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: length,
      fill: "forwards",
    });
    let animation: Animation;
    if (target && hero) {
      for (const element of [...surroundings(), frameRef.current].filter(canAnimate)) {
        element.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: Math.max(1, length * 0.45),
          fill: "forwards",
        });
      }
      animation = hero.animate(
        [
          { transform: "none", opacity: 1 },
          { transform: target, opacity: 1, offset: 0.75 },
          { transform: target, opacity: 0 },
        ],
        { duration: length, easing: easing("--ease-standard"), fill: "forwards" },
      );
    } else {
      animation = panel.animate(
        reduced
          ? [{ opacity: 1 }, { opacity: 0 }]
          : [
              { transform: "none", opacity: 1 },
              { transform: RISE_FROM, opacity: 0 },
            ],
        { duration: length, easing: easing("--ease-exit"), fill: "forwards" },
      );
    }
    animation.onfinish = onExited;
    return () => animation.cancel();
  }, [closing]);

  // Another title opened from inside (More Like This): back to the top, with a soft swap.
  useEffect(() => {
    if (shownTitle.current === titleId) return;
    shownTitle.current = titleId;
    scrollerRef.current?.scrollTo({ top: 0 });
    if (canAnimate(panelRef.current) && durationMs("--duration-base", 240) > 0) {
      panelRef.current.animate(
        [
          { opacity: 0.4, transform: "translateY(0.75rem)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: durationMs("--duration-base", 240), easing: easing("--ease-enter") },
      );
    }
  }, [titleId]);

  const blocking = detail.isError && !title;

  return (
    <RadixDialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !closing) close();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          ref={scrollerRef}
          data-testid="title-overlay"
          className="fixed inset-0 z-(--z-overlay) overflow-y-auto overscroll-contain"
        >
          <div ref={backdropRef} aria-hidden className="fixed inset-0 bg-scrim" />
          <div className="relative flex min-h-full justify-center sm:px-6 sm:py-8 md:py-10">
            <RadixDialog.Content
              ref={attachPanel}
              aria-describedby={undefined}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                (playRef.current ?? panelRef.current)?.focus({ preventScroll: true });
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                const target =
                  takeOverlayReturnFocus() ??
                  (opener?.isConnected && opener !== document.body ? opener : null);
                target?.focus({ preventScroll: true });
              }}
              onEscapeKeyDown={(event) => {
                // A control with its own Escape (the rating choices) closes first.
                if ((event.target as Element | null)?.closest?.("[data-escape-local]")) {
                  event.preventDefault();
                }
              }}
              tabIndex={-1}
              // Every transform below is written for a top-left origin.
              style={{ transformOrigin: "0 0" }}
              className="relative w-full max-w-detail self-start text-fg outline-none max-sm:min-h-dvh"
            >
              {/* The panel's surface, separate from its content so the picture can fly in
                  ahead of it. */}
              <div
                ref={frameRef}
                aria-hidden
                className="absolute inset-0 bg-surface-2 shadow-xl sm:rounded-dialog"
              />
              <RadixDialog.Title className="sr-only">{name}</RadixDialog.Title>
              <RadixDialog.Close asChild>
                <IconButton
                  ref={closeRef}
                  label="Close"
                  icon={CloseIcon}
                  variant="glass"
                  size="md"
                  className={cx("z-(--z-raised) end-3 top-3", phone ? "fixed" : "absolute")}
                />
              </RadixDialog.Close>

              {blocking ? (
                <BlockedTitle
                  error={detail.error}
                  onRetry={() => detail.refetch()}
                  onClose={close}
                />
              ) : (
                <>
                  <DetailHero
                    key={titleId}
                    pictureRef={heroRef}
                    originImage={originImage}
                    title={title}
                    seed={seed}
                    entered={entered && !closing}
                    playRef={playRef}
                    phone={phone}
                  />
                  <div ref={bodyRef} className="relative px-5 pb-12 sm:px-10 md:px-12">
                    {title ? (
                      <DetailBody title={title} phone={phone} />
                    ) : (
                      <div className="grid gap-8 pt-2 md:grid-cols-[2fr_1fr]">
                        <SkeletonText lines={4} />
                        <SkeletonText lines={3} />
                      </div>
                    )}
                  </div>
                </>
              )}
            </RadixDialog.Content>
          </div>
        </RadixDialog.Overlay>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

function DetailBody({ title, phone }: { title: TitleDetail; phone: boolean }) {
  return (
    <>
      <DetailInfo title={title} phone={phone} />
      {title.type === "series" && title.seasons.length > 0 ? <EpisodeList title={title} /> : null}
      <MoreLikeThis titleId={title.id} />
      <AboutSection title={title} />
    </>
  );
}

/** Not found, not allowed on this profile, or the detail failed to load. */
function BlockedTitle({
  error,
  onRetry,
  onClose,
}: {
  error: unknown;
  onRetry: () => void;
  onClose: () => void;
}) {
  const described = describeError(error);
  const restricted = ApiError.is(error, "maturity_restricted");
  return (
    <div className="relative px-6 pt-16 pb-12">
      <ErrorState
        title={restricted ? "Not available on this profile" : described.title}
        description={
          restricted
            ? "This title is rated above this profile's maturity setting."
            : described.description
        }
        reference={described.reference}
        action={
          <>
            {described.retryable ? (
              <Button variant="primary" onClick={onRetry}>
                Try again
              </Button>
            ) : null}
            <Button variant="outline" onClick={onClose}>
              Back to browsing
            </Button>
          </>
        }
      />
    </div>
  );
}

/**
 * The URL of the image showing at the centre of `origin` (outside any overlay), if one is
 * loaded there. Read before the overlay's own content is in the document.
 */
function imageAt(origin: DOMRect | null): string | null {
  if (!origin || typeof document === "undefined") return null;
  try {
    const x = origin.left + origin.width / 2;
    const y = origin.top + origin.height / 2;
    for (const element of document.elementsFromPoint(x, y)) {
      const image =
        element instanceof HTMLImageElement
          ? element
          : element.querySelector?.<HTMLImageElement>("img.wf-image__img");
      if (image?.complete && image.naturalWidth > 0 && image.currentSrc) return image.currentSrc;
    }
  } catch {
    // Hit testing unavailable (old engines, test DOMs): the hero paints the card's artwork.
  }
  return null;
}

/**
 * The transform that lays a 16:9 picture over `origin` (centre on centre, width on width), for
 * the grow-from / shrink-to animation. The element must use a top-left transform origin. Null
 * when the origin is off screen.
 */
export function transformFromOrigin(element: HTMLElement, origin: DOMRect): string | null {
  const box = element.getBoundingClientRect();
  if (box.width === 0 || origin.width === 0) return null;
  if (origin.bottom < 0 || origin.top > window.innerHeight) return null;
  const scale = origin.width / box.width;
  const dx = origin.left + origin.width / 2 - (box.left + box.width / 2);
  const dy = origin.top + origin.height / 2 - (box.top + box.height / 2);
  const ox = box.width / 2;
  const oy = box.height / 2;
  return `translate(${dx}px, ${dy}px) translate(${ox}px, ${oy}px) scale(${scale}) translate(${-ox}px, ${-oy}px)`;
}
