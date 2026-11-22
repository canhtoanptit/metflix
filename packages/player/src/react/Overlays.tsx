/**
 * Everything layered over the picture: captions, buffering and input feedback, the maturity
 * advisory, Skip Intro / Recap, the next-episode card, the end screen, the paused-state
 * overlay, and the autoplay / error / host-blocking layers.
 */
import {
  type ImageFormat,
  type ImageSet,
  imageSrcSet,
  imageUrl,
  pickImageWidth,
} from "@webflix/contracts";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CueNode } from "../core/cue-text.ts";
import { formatBitrate, formatEpisodeCode, formatPlaybackTime } from "../core/format.ts";
import {
  bufferedEndAt,
  isBuffering,
  pausedOverlayVisible,
  type RenderedCue,
  selectMomentsView,
  selectOffers,
} from "../core/state.ts";
import { qualityBadge } from "../core/tracks.ts";
import type { EndScreenContext } from "../types.ts";
import { shallowEqual, usePlayer, usePlayerState } from "./context.ts";
import { Icon } from "./icons.tsx";

// --- captions -------------------------------------------------------------------------------

function renderCueNodes(nodes: readonly CueNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${node.type}-${index}`;
    switch (node.type) {
      case "text":
        return node.text;
      case "br":
        return <br key={key} />;
      case "i":
        return <i key={key}>{renderCueNodes(node.children)}</i>;
      case "b":
        return <b key={key}>{renderCueNodes(node.children)}</b>;
      case "u":
        return <u key={key}>{renderCueNodes(node.children)}</u>;
      case "ruby":
        return <ruby key={key}>{renderCueNodes(node.children)}</ruby>;
      case "rt":
        return <rt key={key}>{renderCueNodes(node.children)}</rt>;
      default:
        return (
          <span
            key={key}
            className={node.classes.map((c) => `wfp-cue--${c}`).join(" ") || undefined}
          >
            {renderCueNodes(node.children)}
          </span>
        );
    }
  });
}

function Cue({ cue }: { cue: RenderedCue }) {
  const align =
    cue.align === "left" || cue.align === "start"
      ? "start"
      : cue.align === "right" || cue.align === "end"
        ? "end"
        : "center";
  return (
    <div className="wfp-cue" data-align={align}>
      <span className="wfp-cue__text">{renderCueNodes(cue.nodes)}</span>
    </div>
  );
}

/** A numeric `line` with snapToLines counts from the top when ≥ 0 (`line:0` = top). */
const isTopCue = (cue: RenderedCue) =>
  typeof cue.line === "number" && cue.snapToLines && cue.line >= 0;

export function Captions() {
  const cues = usePlayerState((s) => s.cues);
  if (cues.length === 0) return <div className="wfp-captions" />;
  const top = cues.filter(isTopCue);
  const bottom = cues.filter((cue) => !isTopCue(cue));
  return (
    <div className="wfp-captions">
      {top.length > 0 ? (
        <div className="wfp-captions__region wfp-captions__region--top">
          {top.map((cue) => (
            <Cue key={cue.id} cue={cue} />
          ))}
        </div>
      ) : null}
      {bottom.length > 0 ? (
        <div className="wfp-captions__region wfp-captions__region--bottom">
          {bottom.map((cue) => (
            <Cue key={cue.id} cue={cue} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// --- feedback -------------------------------------------------------------------------------

export function BufferingIndicator() {
  const buffering = usePlayerState(
    (s) => isBuffering(s) && !s.autoplayBlocked && s.phase !== "error",
  );
  if (!buffering) return null;
  return (
    <div className="wfp-spinner" aria-hidden="true">
      <svg viewBox="0 0 48 48" className="wfp-spinner__svg" aria-hidden="true">
        <circle cx="24" cy="24" r="20" className="wfp-spinner__track" />
        <circle cx="24" cy="24" r="20" className="wfp-spinner__arc" />
      </svg>
    </div>
  );
}

export function FeedbackLayer() {
  const feedback = usePlayerState((s) => s.feedback);
  if (!feedback) return null;
  switch (feedback.kind) {
    case "play":
    case "pause":
      return (
        <div key={feedback.nonce} className="wfp-feedback wfp-feedback--pulse" aria-hidden="true">
          <Icon name={feedback.kind === "play" ? "play" : "pause"} />
        </div>
      );
    case "seek":
      return (
        <div
          key={feedback.nonce}
          className="wfp-feedback wfp-feedback--seek"
          data-direction={feedback.direction < 0 ? "back" : "forward"}
          aria-hidden="true"
        >
          <Icon name={feedback.direction < 0 ? "back10" : "forward10"} />
          <span>
            {feedback.direction < 0 ? "−" : "+"}
            {feedback.amountSec}s
          </span>
        </div>
      );
    case "volume":
      return (
        <div key={feedback.nonce} className="wfp-feedback wfp-feedback--volume" aria-hidden="true">
          <Icon
            name={feedback.muted ? "volumeOff" : feedback.level < 0.5 ? "volumeLow" : "volumeHigh"}
          />
          <span className="wfp-feedback__meter">
            <span style={{ transform: `scaleX(${feedback.muted ? 0 : feedback.level})` }} />
          </span>
          <span className="wfp-feedback__value">
            {feedback.muted ? 0 : Math.round(feedback.level * 100)}
          </span>
        </div>
      );
    case "toast":
      return (
        <div key={feedback.nonce} className="wfp-feedback wfp-feedback--toast" aria-hidden="true">
          {feedback.text}
        </div>
      );
  }
}

/** Announcements leave the live region after this, so none is found later by browsing. */
const ANNOUNCEMENT_TTL_MS = 7000;

export function LiveRegion() {
  const { announcement, takeover } = usePlayerState(
    (s) => ({
      announcement: s.announcement,
      // Layers that replace the picture: what was said before them no longer applies.
      takeover: s.blocked
        ? "blocked"
        : s.phase === "error"
          ? "error"
          : (selectMomentsView(s)?.endScreen ?? null),
    }),
    shallowEqual,
  );
  // Announcements up to this nonce are stale (expired, or said before the takeover).
  const [staleUpTo, setStaleUpTo] = useState(0);
  const [lastTakeover, setLastTakeover] = useState(takeover);
  if (takeover !== lastTakeover) {
    setLastTakeover(takeover);
    if (takeover && announcement) setStaleUpTo(announcement.nonce);
  }
  useEffect(() => {
    if (!announcement) return;
    const timer = setTimeout(() => setStaleUpTo(announcement.nonce), ANNOUNCEMENT_TTL_MS);
    return () => clearTimeout(timer);
  }, [announcement]);
  const current = announcement && announcement.nonce > staleUpTo ? announcement : null;
  return (
    <div className="wfp-sr-only" aria-live="polite" aria-atomic="true">
      {current ? <span key={current.nonce}>{current.text}</span> : null}
    </div>
  );
}

/**
 * Diagnostics (Shift+D): the rendition actually playing, which the quality menu deliberately
 * doesn't show, plus buffer and frame health. Sampled once a second while open.
 */
export function StatsOverlay() {
  const { controller, session, rootRef } = usePlayer();
  const visible = usePlayerState((s) => s.statsVisible);
  const [, setSample] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(() => setSample((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [visible]);
  if (!visible) return null;
  const s = controller.state;
  const media = controller.mediaElement;
  const level = s.qualityLevels.find((candidate) => candidate.id === s.activeQualityId);
  const frames = media?.getVideoPlaybackQuality?.();
  const root = rootRef.current;
  const ratio = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
  const rows: [string, string][] = [
    ["Engine", s.engine ?? "—"],
    [
      "Rendition",
      level
        ? `${level.width}×${level.height} · ${qualityBadge(level)} · ${formatBitrate(level.bitrate)}`
        : media?.videoWidth
          ? `${media.videoWidth}×${media.videoHeight}`
          : "—",
    ],
    ["Quality", s.qualityMode === "auto" ? "Auto" : "Fixed"],
    ["Plan cap", `${session.maxVideoHeight} lines`],
    [
      "Buffer",
      `${Math.max(0, bufferedEndAt(s.buffered, s.currentTime) - s.currentTime).toFixed(1)} s`,
    ],
    ["Frames", frames ? `${frames.droppedVideoFrames} dropped of ${frames.totalVideoFrames}` : "—"],
    ["Position", `${formatPlaybackTime(s.currentTime)} / ${formatPlaybackTime(s.duration)}`],
    ["Viewport", root ? `${root.clientWidth}×${root.clientHeight} @${ratio}x` : "—"],
  ];
  return (
    <dl className="wfp-stats" aria-label="Playback stats">
      {rows.map(([name, value]) => (
        <div key={name} className="wfp-stats__row">
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// --- moments --------------------------------------------------------------------------------

export function Advisory() {
  const { session, labels } = usePlayer();
  const visible = usePlayerState((s) => s.advisoryVisible && !s.blocked && s.phase !== "error");
  const { maturity, maturityDescriptors } = session.display;
  return (
    <div className="wfp-advisory" data-visible={visible ? "" : undefined} aria-hidden={!visible}>
      <span className="wfp-advisory__bar" />
      <div>
        <div className="wfp-advisory__rating">{labels.maturityRated(maturity)}</div>
        {maturityDescriptors.length > 0 ? (
          <div className="wfp-advisory__descriptors">{maturityDescriptors.join(", ")}</div>
        ) : null}
      </div>
    </div>
  );
}

export function SkipButton() {
  const { controller, labels, focusRoot } = usePlayer();
  // `skip`: the offer on screen (overlay precedence may hide it); `inWindow`: the skip window
  // the playhead is in, shown or not.
  const { skip, inWindow } = usePlayerState((s) => {
    const key = (offer: { kind: string; startSec: number } | null | undefined) =>
      offer ? `${offer.kind}:${offer.startSec}` : null;
    return { skip: key(selectOffers(s).skip), inWindow: key(selectMomentsView(s)?.skip) };
  }, shallowEqual);
  const kind = skip?.split(":")[0] as "intro" | "recap" | undefined;
  const label = kind === "recap" ? labels.skipRecap : labels.skipIntro;
  // Said when the offer first shows; hidden and shown again inside the same window, it stays
  // quiet. Leaving the window (or seeking back into it later) starts over.
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (inWindow === null) announced.current = null;
    if (!skip || announced.current === skip) return;
    announced.current = skip;
    controller.announce(labels.skipAvailable(label));
  }, [skip, inWindow, controller, labels, label]);
  if (!skip) return null;
  return (
    <button
      key={skip}
      type="button"
      className="wfp-skip"
      onClick={(event) => {
        controller.skipMoment();
        if (event.detail > 0) focusRoot();
      }}
    >
      {label}
      <Icon name="skip" />
    </button>
  );
}

function CountdownRing({ progress }: { progress: number }) {
  const circumference = 2 * Math.PI * 10;
  return (
    <svg className="wfp-ring" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" className="wfp-ring__track" />
      <circle
        cx="12"
        cy="12"
        r="10"
        className="wfp-ring__progress"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - progress)}
      />
      <path d="M10 8.6v6.8l5.2-3.4Z" fill="currentColor" />
    </svg>
  );
}

export function NextEpisodeCard() {
  const { controller, labels, session, focusRoot, layout } = usePlayer();
  const view = usePlayerState((s) => {
    const nextUp = selectOffers(s).nextUp;
    return {
      mode: nextUp?.mode ?? null,
      remainingSec: nextUp?.mode === "countdown" ? Math.ceil(nextUp.remainingMs / 1000) : null,
      progress:
        nextUp?.mode === "countdown" ? 1 - nextUp.remainingMs / Math.max(1, nextUp.totalMs) : 0,
      ended: s.phase === "ended",
    };
  }, shallowEqual);
  const next = session.nextEpisode;
  const counting = view.mode === "countdown";
  const announced = useRef(false);
  useEffect(() => {
    if (counting && !announced.current && view.remainingSec !== null) {
      announced.current = true;
      controller.announce(labels.nextEpisodeIn(view.remainingSec));
    }
    if (!counting) announced.current = false;
  }, [counting, view.remainingSec, controller, labels]);
  if (!view.mode || !next) return null;

  const primary = (
    <button
      type="button"
      className="wfp-next__primary"
      aria-label={
        counting && view.remainingSec !== null
          ? `${labels.playNextEpisode}. ${labels.nextEpisodeIn(view.remainingSec)}`
          : labels.playNextEpisode
      }
      onClick={() => controller.requestNext("user")}
    >
      {counting ? <CountdownRing progress={view.progress} /> : <Icon name="play" />}
      <span>{labels.nextEpisode}</span>
      {counting && view.remainingSec !== null ? (
        <span className="wfp-next__seconds" aria-hidden="true">
          {view.remainingSec}
        </span>
      ) : null}
    </button>
  );

  if (view.ended) {
    const still = next.still;
    return (
      <section className="wfp-postplay" aria-label={labels.nextEpisode}>
        <div className="wfp-postplay__media">
          {still ? (
            <img
              src={imageUrl(
                still,
                pickImageWidth(still, layout === "touch" ? 280 : 420, 2),
                still.formats[0] ?? "webp",
              )}
              alt=""
              style={{ backgroundColor: still.dominantColor }}
            />
          ) : (
            <div className="wfp-postplay__placeholder" />
          )}
        </div>
        <div className="wfp-postplay__body">
          <div className="wfp-postplay__eyebrow">{labels.nextEpisode}</div>
          <h2 className="wfp-postplay__title">
            <span className="wfp-title__code">
              {formatEpisodeCode(next.episode.seasonNumber, next.episode.number)}
            </span>{" "}
            {next.episode.name}
          </h2>
          <p className="wfp-postplay__synopsis">{next.synopsis}</p>
          <div className="wfp-next__actions">{primary}</div>
        </div>
      </section>
    );
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: groups two buttons for assistive tech; not a form.
    <div className="wfp-next" role="group" aria-label={labels.nextEpisode}>
      <button
        type="button"
        className="wfp-next__secondary"
        onClick={(event) => {
          controller.dismissCredits();
          if (event.detail > 0) focusRoot();
        }}
      >
        {labels.watchCredits}
      </button>
      {primary}
    </div>
  );
}

/** The format every browser decodes: the `<img>` fallback under the `<source>`s. */
function fallbackFormat(image: ImageSet): ImageFormat {
  return image.formats.includes("webp") ? "webp" : (image.formats[0] ?? "webp");
}

/** The host's still in the shrunken picture's frame, faded in once playback has ended. */
function EndScreenStill({ image, visible }: { image: ImageSet; visible: boolean }) {
  const fallback = fallbackFormat(image);
  const sizes = "(max-aspect-ratio: 1/1) 100vw, 32vw";
  return (
    <picture className="wfp-endscreen__still" data-visible={visible ? "" : undefined}>
      {image.formats
        .filter((format) => format !== fallback)
        .map((format) => (
          <source
            key={format}
            type={`image/${format}`}
            srcSet={imageSrcSet(image, format)}
            sizes={sizes}
          />
        ))}
      <img
        src={imageUrl(image, pickImageWidth(image, 640, 2), fallback)}
        srcSet={imageSrcSet(image, fallback)}
        sizes={sizes}
        alt=""
        decoding="async"
        style={{ backgroundColor: image.dominantColor }}
      />
    </picture>
  );
}

export function EndScreen({
  phase,
  render,
  backdrop,
}: {
  phase: "credits" | "ended";
  render: ((context: EndScreenContext) => ReactNode) | undefined;
  backdrop: ImageSet | null;
}) {
  const { controller, labels, session, onBack, hasBack, focusRoot } = usePlayer();
  const context: EndScreenContext = {
    phase,
    watchCredits: () => {
      controller.dismissCredits();
      focusRoot();
    },
    replay: () => controller.replay(),
    back: onBack,
  };
  return (
    <section
      className="wfp-endscreen"
      data-slot={render ? "" : undefined}
      aria-label={session.display.titleName}
    >
      <div className="wfp-endscreen__lead">
        {/* The shrunken video lines up with this box; the still covers it after the end. */}
        <div className="wfp-endscreen__frame" aria-hidden="true">
          {backdrop ? <EndScreenStill image={backdrop} visible={phase === "ended"} /> : null}
        </div>
        <div className="wfp-endscreen__info">
          <h2 className="wfp-endscreen__title">{session.display.titleName}</h2>
          {session.display.episode ? (
            <p className="wfp-endscreen__episode">
              {formatEpisodeCode(
                session.display.episode.seasonNumber,
                session.display.episode.number,
              )}{" "}
              {session.display.episode.name}
            </p>
          ) : null}
          <div className="wfp-endscreen__actions">
            {phase === "ended" ? (
              <button
                type="button"
                className="wfp-pill wfp-pill--primary"
                onClick={() => controller.replay()}
              >
                <Icon name="replay" />
                {labels.replay}
              </button>
            ) : (
              <button type="button" className="wfp-pill" onClick={context.watchCredits}>
                {labels.watchCredits}
              </button>
            )}
            {hasBack ? (
              <button type="button" className="wfp-pill" onClick={onBack}>
                <Icon name="back" />
                {labels.back}
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {render ? <div className="wfp-endscreen__slot">{render(context)}</div> : null}
    </section>
  );
}

export function PausedOverlay({ synopsis }: { synopsis: string | null }) {
  const { session, labels } = usePlayer();
  const visible = usePlayerState(pausedOverlayVisible);
  const { titleName, episode, logo } = session.display;
  return (
    <div className="wfp-paused" data-visible={visible ? "" : undefined} aria-hidden="true">
      <div className="wfp-paused__content">
        <div className="wfp-paused__eyebrow">{labels.youAreWatching}</div>
        {logo ? (
          <img
            className="wfp-paused__logo"
            src={imageUrl(logo, pickImageWidth(logo, 360, 2), logo.formats[0] ?? "webp")}
            alt={titleName}
          />
        ) : (
          <div className="wfp-paused__title">{titleName}</div>
        )}
        {episode ? (
          <div className="wfp-paused__episode">
            {formatEpisodeCode(episode.seasonNumber, episode.number)} {episode.name}
          </div>
        ) : null}
        {synopsis ? <p className="wfp-paused__synopsis">{synopsis}</p> : null}
      </div>
      <div className="wfp-paused__state">{labels.paused}</div>
    </div>
  );
}

export function PipPlaceholder() {
  const { labels } = usePlayer();
  return (
    <div className="wfp-pip-placeholder">
      <Icon name="pip" />
      <span>{labels.pipActive}</span>
    </div>
  );
}

// --- blocking layers ------------------------------------------------------------------------

export function AutoplayBlocked() {
  const { controller, labels } = usePlayer();
  const blocked = usePlayerState((s) => s.autoplayBlocked && s.phase !== "error" && !s.blocked);
  if (!blocked) return null;
  return (
    <div className="wfp-autoplay">
      <button
        type="button"
        className="wfp-autoplay__button"
        onClick={() => void controller.play("pointer")}
      >
        <Icon name="play" />
        <span className="wfp-sr-only">{labels.tapToPlay}</span>
      </button>
    </div>
  );
}

function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return ref;
}

export function ErrorLayer() {
  const { controller, labels, hasBack, onBack } = usePlayer();
  const error = usePlayerState((s) => (s.blocked ? null : s.error));
  if (!error) return null;
  const offline =
    error.code === "network" && typeof navigator !== "undefined" && navigator.onLine === false;
  const message = labels.errorMessages[offline ? "offline" : error.code];
  return (
    <ErrorDialog
      title={labels.errorTitle}
      message={message}
      code={`WFP-${error.code.toUpperCase()}${error.httpStatus ? `-${error.httpStatus}` : ""}`}
      retryLabel={labels.tryAgain}
      onRetry={() => controller.retry()}
      backLabel={hasBack ? labels.back : null}
      onBack={onBack}
      codeLabel={labels.errorCode}
    />
  );
}

function ErrorDialog(props: {
  title: string;
  message: string;
  code: string;
  retryLabel: string;
  onRetry: () => void;
  backLabel: string | null;
  onBack: () => void;
  codeLabel: (code: string) => string;
}) {
  const retryRef = useFocusOnMount<HTMLButtonElement>();
  return (
    <div className="wfp-layer wfp-layer--error">
      <div
        className="wfp-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="wfp-error-title"
        aria-describedby="wfp-error-message"
      >
        <Icon name="alert" className="wfp-dialog__icon" />
        <h2 id="wfp-error-title" className="wfp-dialog__title">
          {props.title}
        </h2>
        <p id="wfp-error-message" className="wfp-dialog__message">
          {props.message}
        </p>
        <p className="wfp-dialog__code">{props.codeLabel(props.code)}</p>
        <div className="wfp-dialog__actions">
          <button
            ref={retryRef}
            type="button"
            className="wfp-pill wfp-pill--primary"
            onClick={props.onRetry}
          >
            {props.retryLabel}
          </button>
          {props.backLabel ? (
            <button type="button" className="wfp-pill" onClick={props.onBack}>
              {props.backLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** Host overlay: modal inside the player, focus held within it. */
export function BlockingLayer({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const headingId = useId();
  // The dialog takes its accessible name from the overlay's first heading, so screen readers
  // announce "Playback stopped, dialog" rather than an unnamed dialog. Re-checked on every
  // render: the host may swap one overlay for another while the layer stays mounted.
  useLayoutEffect(() => {
    const layer = ref.current;
    if (!layer) return;
    const heading = layer.querySelector<HTMLElement>("h1, h2, h3, h4, h5, h6");
    if (!heading) {
      layer.removeAttribute("aria-labelledby");
      return;
    }
    if (!heading.id) heading.id = headingId;
    layer.setAttribute("aria-labelledby", heading.id);
  });
  useEffect(() => {
    const layer = ref.current;
    if (!layer) return;
    const first = layer.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? layer).focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = [...layer.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem?.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem?.focus();
      }
    };
    layer.addEventListener("keydown", onKeyDown);
    return () => layer.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <div className="wfp-layer wfp-layer--blocking">
      <div ref={ref} className="wfp-blocking" role="dialog" aria-modal="true" tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}
