/**
 * `<PreviewPlayer>`: muted, chrome-less autoplay of a short clip for the billboard and hover
 * cards. Progressive MP4 or HLS; fades in on the first frame over an optional poster; pauses
 * when scrolled out of view, when the tab is hidden or when `active` turns false; releases the
 * decoder on unmount. No keyboard shortcuts, no progress reporting.
 */
import {
  type CSSProperties,
  type ReactNode,
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { classifyMediaElementError, type PlayerError } from "../core/errors.ts";
import { defaultEngineFactory, resolveEngineKind } from "../engine/create-engine.ts";
import type { PlaybackEngine } from "../engine/types.ts";
import { Icon } from "./icons.tsx";
import "../styles/preview.css";

export interface PreviewPlayerHandle {
  play(): Promise<void>;
  pause(): void;
  /** Back to the first frame of the clip. */
  restart(): void;
  readonly media: HTMLVideoElement | null;
}

export interface PreviewPlayerProps {
  /** Progressive MP4/WebM or an HLS `.m3u8` URL. */
  src: string;
  /** Image shown until the first frame (and again after the clip ends). */
  poster?: string | null;
  /** Host intent (hover, billboard in view…). Playback also needs visibility. Default true. */
  active?: boolean;
  /** Controlled mute. Omit to let the built-in toggle manage it (starts muted). */
  muted?: boolean;
  onMutedChange?: (muted: boolean) => void;
  loop?: boolean;
  startPositionSec?: number;
  /** Fraction of the element that must be visible to play. Default 0.5. */
  visibilityThreshold?: number;
  /** Skip autoplay under `prefers-reduced-motion: reduce` (poster stays). Default true. */
  respectReducedMotion?: boolean;
  /** Cap HLS renditions (previews never need full HD). Default 720. */
  maxVideoHeight?: number;
  /** Render a round mute toggle in the bottom-right corner. Default false. */
  showMuteToggle?: boolean;
  muteLabel?: string;
  unmuteLabel?: string;
  fit?: "cover" | "contain";
  onFirstFrame?: () => void;
  onEnded?: () => void;
  onError?: (error: Pick<PlayerError, "code" | "detail" | "httpStatus">) => void;
  className?: string;
  style?: CSSProperties;
  /** Overlay content (title treatment, badges) drawn above the video. */
  children?: ReactNode;
  ref?: Ref<PreviewPlayerHandle>;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

export function PreviewPlayer(props: PreviewPlayerProps) {
  const {
    src,
    poster = null,
    active = true,
    loop = false,
    startPositionSec = 0,
    visibilityThreshold = 0.5,
    respectReducedMotion = true,
    maxVideoHeight = 720,
    showMuteToggle = false,
    muteLabel = "Mute",
    unmuteLabel = "Unmute",
    fit = "cover",
    ref,
  } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [ownMuted, setOwnMuted] = useState(true);
  const muted = props.muted ?? ownMuted;
  const [ready, setReady] = useState(false);
  const [ended, setEnded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [engineReady, setEngineReady] = useState(false);
  const [visible, setVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const reducedMotion = useReducedMotion();

  // Source lifecycle: one engine per src, fully released on change or unmount.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let engine: PlaybackEngine | null = null;
    let cancelled = false;
    const abort = new AbortController();
    setReady(false);
    setEnded(false);
    setFailed(false);
    setEngineReady(false);
    const fail = (error: Pick<PlayerError, "code" | "detail" | "httpStatus">) => {
      if (cancelled) return;
      setFailed(true);
      setReady(false);
      latest.current.onError?.(error);
    };
    const onFrame = () => {
      if (cancelled) return;
      setReady(true);
      latest.current.onFirstFrame?.();
    };
    const requestFrame = (
      video as HTMLVideoElement & {
        requestVideoFrameCallback?: (callback: () => void) => number;
      }
    ).requestVideoFrameCallback;
    video.addEventListener(
      "playing",
      () => {
        // Fade in on a presented frame, not on `playing` (which can precede the first paint).
        if (requestFrame) requestFrame.call(video, onFrame);
        else onFrame();
      },
      { once: true, signal: abort.signal },
    );
    video.addEventListener(
      "ended",
      () => {
        if (latest.current.loop) return;
        setEnded(true);
        latest.current.onEnded?.();
      },
      { signal: abort.signal },
    );
    video.addEventListener(
      "error",
      () => {
        if (engine?.kind === "hls.js") return;
        const code = classifyMediaElementError(video.error?.code ?? 0);
        if (code) fail({ code, detail: video.error?.message ?? "", httpStatus: null });
      },
      { signal: abort.signal },
    );
    void (async () => {
      const kind = await resolveEngineKind(src, "auto", video);
      if (cancelled) return;
      if (!kind) {
        fail({ code: "unsupported", detail: "no playback path", httpStatus: null });
        return;
      }
      const created = await defaultEngineFactory(
        kind,
        video,
        {
          url: src,
          startPositionSec: latest.current.startPositionSec ?? 0,
          maxVideoHeight,
          preferredAudioLanguage: null,
          hlsConfig: { maxBufferLength: 12, backBufferLength: 0 },
        },
        {
          levels: () => {},
          levelSwitched: () => {},
          audioTracks: () => {},
          audioSwitched: () => {},
          fatal: (error) => fail(error),
        },
      );
      if (cancelled) {
        created.destroy();
        return;
      }
      engine = created;
      if (kind !== "hls.js" && startPositionSec > 0) {
        video.addEventListener(
          "loadedmetadata",
          () => {
            video.currentTime = startPositionSec;
          },
          { once: true, signal: abort.signal },
        );
      }
      setEngineReady(true);
    })().catch((error: unknown) =>
      fail({ code: "unknown", detail: String(error), httpStatus: null }),
    );
    return () => {
      cancelled = true;
      abort.abort();
      engine?.destroy();
      video.pause();
      video.removeAttribute("src");
      try {
        video.load();
      } catch {
        // Not implemented in some environments.
      }
    };
  }, [src, maxVideoHeight, startPositionSec]);

  // Visibility: in viewport (IntersectionObserver) and tab visible.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (typeof IntersectionObserver !== "function") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setVisible(entry.intersectionRatio >= visibilityThreshold);
      },
      { threshold: [0, visibilityThreshold, 1] },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, [visibilityThreshold]);

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  const shouldPlay =
    engineReady &&
    active &&
    visible &&
    pageVisible &&
    !ended &&
    !failed &&
    !(respectReducedMotion && reducedMotion);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = muted;
  }, [muted]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!shouldPlay) {
      video.pause();
      return;
    }
    // Autoplay policy: only muted playback may start without a gesture. If an unmuted resume
    // is refused, fall back to muted and tell the host.
    video.play().catch((error: unknown) => {
      if ((error as { name?: string })?.name === "NotAllowedError" && !video.muted) {
        video.muted = true;
        if (latest.current.muted === undefined) setOwnMuted(true);
        latest.current.onMutedChange?.(true);
        video.play().catch(() => {});
      }
    });
  }, [shouldPlay]);

  useImperativeHandle(
    ref,
    () => ({
      play: async () => {
        setEnded(false);
        await videoRef.current?.play();
      },
      pause: () => videoRef.current?.pause(),
      restart: () => {
        const video = videoRef.current;
        if (!video) return;
        setEnded(false);
        video.currentTime = latest.current.startPositionSec ?? 0;
      },
      get media() {
        return videoRef.current;
      },
    }),
    [],
  );

  const toggleMute = () => {
    const next = !muted;
    if (props.muted === undefined) setOwnMuted(next);
    props.onMutedChange?.(next);
  };

  return (
    <div
      ref={rootRef}
      className={props.className ? `wfp-preview ${props.className}` : "wfp-preview"}
      style={props.style}
      data-ready={ready && !ended && !failed ? "" : undefined}
      data-fit={fit}
    >
      {poster ? <img className="wfp-preview__poster" src={poster} alt="" decoding="async" /> : null}
      <video
        ref={videoRef}
        className="wfp-preview__video"
        muted
        playsInline
        loop={loop}
        preload="metadata"
        disablePictureInPicture
        disableRemotePlayback
        aria-hidden="true"
        tabIndex={-1}
      />
      {props.children ? <div className="wfp-preview__overlay">{props.children}</div> : null}
      {showMuteToggle ? (
        <button
          type="button"
          className="wfp-preview__mute"
          aria-label={muted ? unmuteLabel : muteLabel}
          aria-pressed={!muted}
          onClick={toggleMute}
        >
          <Icon name={muted ? "volumeOff" : "volumeHigh"} />
        </button>
      ) : null}
    </div>
  );
}
