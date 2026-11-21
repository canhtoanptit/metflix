/**
 * `<Player>`: the full-screen watch experience. Takes a `PlaybackSession`-shaped `session`,
 * emits events, never calls the Webflix API. See README for the integration contract.
 */
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type LoadRequest, PlayerController } from "../controller/controller.ts";
import { canFullscreen, canPictureInPicture } from "../controller/display.ts";
import { zoneForPosition } from "../core/gestures.ts";
import { isEditableTarget } from "../core/keymap.ts";
import { resolveLabels } from "../core/labels.ts";
import {
  createLocalPreferenceStorage,
  DEFAULT_PREFERENCES_KEY,
  type PreferenceStorage,
} from "../core/preferences.ts";
import { type SourceInfo, selectMomentsView } from "../core/state.ts";
import type { PlayerHandle, PlayerProps } from "../types.ts";
import { BottomControls, CenterControls, TopBar } from "./Controls.tsx";
import {
  type Layout,
  PlayerContext,
  type PlayerContextValue,
  shallowEqual,
  usePlayer,
  usePlayerState,
} from "./context.ts";
import { EpisodesPanel } from "./EpisodesPanel.tsx";
import {
  Advisory,
  AutoplayBlocked,
  BlockingLayer,
  BufferingIndicator,
  Captions,
  EndScreen,
  ErrorLayer,
  FeedbackLayer,
  LiveRegion,
  NextEpisodeCard,
  PausedOverlay,
  PipPlaceholder,
  SkipButton,
} from "./Overlays.tsx";
import "../styles/player.css";

const DEFAULT_COUNTDOWN_SEC = 10;
const TOUCH_LAYOUT_MAX_WIDTH = 640;

function resolveStorage(option: PlayerProps["preferenceStorage"]): PreferenceStorage | null {
  if (option === false) return null;
  if (typeof option === "object" && option !== null) return option;
  return createLocalPreferenceStorage(
    typeof option === "string" ? option : DEFAULT_PREFERENCES_KEY,
  );
}

/** `touch` for coarse pointers or narrow players; `desktop` otherwise. */
function useLayout(rootRef: RefObject<HTMLElement | null>): Layout {
  const [layout, setLayout] = useState<Layout>("desktop");
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const coarse = typeof matchMedia === "function" ? matchMedia("(pointer: coarse)") : null;
    const update = () => {
      const narrow = root.clientWidth > 0 && root.clientWidth < TOUCH_LAYOUT_MAX_WIDTH;
      setLayout(coarse?.matches || narrow ? "touch" : "desktop");
    };
    update();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(root);
    coarse?.addEventListener("change", update);
    return () => {
      observer?.disconnect();
      coarse?.removeEventListener("change", update);
    };
  }, [rootRef]);
  return layout;
}

export function Player(props: PlayerProps) {
  const {
    session,
    ref,
    labels: labelOverrides,
    episodes = null,
    onBack,
    className,
    style,
    globalShortcuts = true,
    autoFocus = true,
  } = props;

  const latest = useRef(props);
  latest.current = props;

  const [controller] = useState(() => {
    const instance = new PlayerController({
      storage: resolveStorage(props.preferenceStorage),
      preferenceOverrides: props.preferences,
    });
    // Host callbacks are read at call time, so new closures never need a re-subscription.
    instance.host = {
      onProgress: (report) => latest.current.onProgress?.(report),
      onStateChange: (phase) => latest.current.onStateChange?.(phase),
      onEnded: () => latest.current.onEnded?.(),
      onNextEpisode: (reason) => {
        const next = latest.current.session.nextEpisode;
        if (next) latest.current.onNextEpisode?.(next, reason);
      },
      onQualityChange: (change) => latest.current.onQualityChange?.(change),
      onError: (error) => latest.current.onError?.(error),
      onPreferencesChange: (prefs, changed) => latest.current.onPreferencesChange?.(prefs, changed),
      onFullscreenChange: (value) => latest.current.onFullscreenChange?.(value),
    };
    return instance;
  });

  const labels = useMemo(() => resolveLabels(labelOverrides), [labelOverrides]);
  controller.labels = labels;

  const rootRef = useRef<HTMLElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const layout = useLayout(rootRef);

  const [capabilities, setCapabilities] = useState({ fullscreen: true, pip: false });
  // Attach before paint so the first load starts in the same frame as the mount.
  useLayoutEffect(() => {
    const video = videoRef.current;
    const root = rootRef.current;
    if (!video || !root) return;
    controller.attach(video, root);
    setCapabilities({ fullscreen: canFullscreen(root, video), pip: canPictureInPicture(video) });
    return () => controller.detach();
  }, [controller]);

  const autoplayNext = props.autoplayNextEpisode ?? session.autoplayNextEpisode;
  const countdownSec = props.nextEpisodeCountdownSec ?? DEFAULT_COUNTDOWN_SEC;
  const sourceKey = `${session.id}\u0000${session.manifestUrl}`;
  const source = useMemo<SourceInfo>(
    () => ({
      key: sourceKey,
      durationHint: session.durationSec,
      markers: session.markers,
      textTracks: session.textTracks,
      trickPlay: session.trickPlay,
      hasNextEpisode: session.nextEpisode !== null,
      autoplayNext,
      countdownSec,
      maxVideoHeight: session.maxVideoHeight,
    }),
    [
      sourceKey,
      session.durationSec,
      session.markers,
      session.textTracks,
      session.trickPlay,
      session.nextEpisode,
      session.maxVideoHeight,
      autoplayNext,
      countdownSec,
    ],
  );

  useEffect(() => {
    const current = latest.current;
    const display = current.session.display;
    const request: LoadRequest = {
      key: source.key,
      sessionId: current.session.id,
      url: current.session.manifestUrl,
      source,
      startPositionSec: current.startPositionSec ?? current.session.resumePositionSec,
      autoplay: current.autoPlay ?? true,
      enginePreference: current.engine ?? "auto",
      hlsConfig: current.hlsConfig,
      mediaSession: {
        title: display.episode ? display.episode.name : display.titleName,
        artist: display.episode ? display.titleName : "",
        artwork: display.logo,
      },
    };
    controller.load(request);
  }, [controller, source]);

  const progressInterval = props.progressIntervalSec ?? session.heartbeatIntervalSec ?? 30;
  useEffect(() => controller.setProgressInterval(progressInterval), [controller, progressInterval]);

  const blocked = Boolean(props.blockingOverlay);
  useEffect(() => controller.setBlocked(blocked), [controller, blocked]);

  const preferenceKey = props.preferences ? JSON.stringify(props.preferences) : "";
  useEffect(() => {
    if (preferenceKey) controller.applyPreferenceOverrides(JSON.parse(preferenceKey));
  }, [controller, preferenceKey]);

  const focusRoot = useCallback(() => rootRef.current?.focus({ preventScroll: true }), []);

  useImperativeHandle(
    ref,
    (): PlayerHandle => ({
      play: () => controller.play("host"),
      pause: () => controller.pause("host"),
      seek: (position) => controller.seek(position, "host"),
      getCurrentTime: () => controller.state.currentTime,
      getDuration: () => controller.state.duration || controller.state.source?.durationHint || 0,
      getPhase: () => controller.state.phase,
      getProgress: (reason = "interval") => controller.progressSnapshot(reason),
      setVolume: (volume) => controller.setVolume(volume, "host"),
      setMuted: (muted) => controller.setMuted(muted, "host"),
      enterFullscreen: () => controller.enterFullscreen(),
      exitFullscreen: () => controller.exitFullscreen(),
      retry: () => controller.retry(),
      showControls: () => controller.activity("pointer"),
      focus: focusRoot,
      get media() {
        return controller.mediaElement;
      },
    }),
    [controller, focusRoot],
  );

  useEffect(() => {
    if (autoFocus) focusRoot();
  }, [autoFocus, focusRoot]);

  // Keyboard modality: a focused control owns Space/Enter only while navigating by keyboard.
  const modality = useRef<"keyboard" | "pointer">("pointer");
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const doc = root.ownerDocument;
    const target: EventTarget = globalShortcuts ? doc : root;
    const onKeyDown = (event: Event) => {
      const key = event as KeyboardEvent;
      if (key.key === "Tab" || key.key.startsWith("Arrow")) modality.current = "keyboard";
      if (key.defaultPrevented || isEditableTarget(key.target)) return;
      const element = key.target instanceof Element ? key.target : null;
      const inside = element ? root.contains(element) : false;
      // Keys aimed at the host's own controls (outside the player) are theirs.
      if (
        globalShortcuts &&
        element &&
        !inside &&
        element !== doc.body &&
        element !== doc.documentElement
      ) {
        if (element.closest("button, a[href], [role], input, select, textarea, [contenteditable]"))
          return;
      }
      if (key.key === "Tab") {
        controller.activity("keyboard");
        return;
      }
      if (
        (key.key === " " || key.key === "Enter") &&
        inside &&
        element !== root &&
        element?.closest("button, [role='menuitemradio'], [role='option'], a[href], select") &&
        modality.current === "keyboard"
      ) {
        return;
      }
      if (controller.handleKey(key)) key.preventDefault();
    };
    target.addEventListener("keydown", onKeyDown);
    return () => target.removeEventListener("keydown", onKeyDown);
  }, [controller, globalShortcuts]);

  // The picture's aspect ratio positions captions on the picture, not the letterbox.
  useEffect(() => {
    const video = videoRef.current;
    const root = rootRef.current;
    if (!video || !root) return;
    const update = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        root.style.setProperty("--wfp-video-aspect", String(video.videoWidth / video.videoHeight));
      }
    };
    video.addEventListener("loadedmetadata", update);
    video.addEventListener("resize", update);
    return () => {
      video.removeEventListener("loadedmetadata", update);
      video.removeEventListener("resize", update);
    };
  }, []);

  const lastPointerType = useRef<string>("mouse");
  const onRootPointerDown = (event: ReactPointerEvent) => {
    modality.current = "pointer";
    lastPointerType.current = event.pointerType;
  };
  const onRootPointerMove = (event: ReactPointerEvent) => {
    if (event.pointerType !== "touch") controller.activity("pointer");
  };
  const onRootPointerLeave = (event: ReactPointerEvent) => {
    if (event.pointerType === "mouse") controller.pointerLeft();
  };

  // Touch taps are handled on `click`, not `pointerup`: revealing the controls on pointerup
  // would let the browser's synthesized click land on the button that just appeared under the
  // finger (tap to show controls → Pause pressed). Drags and scrolls produce no click.
  const onSurfaceClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (lastPointerType.current === "touch") {
      const rect = event.currentTarget.getBoundingClientRect();
      controller.tap(zoneForPosition(event.clientX - rect.left, rect.width));
      return;
    }
    controller.togglePlay("pointer");
    controller.activity("pointer");
  };
  const onSurfaceDoubleClick = () => {
    if (lastPointerType.current === "touch") return;
    void controller.toggleFullscreen();
  };

  const contextValue = useMemo<PlayerContextValue>(
    () => ({
      controller,
      labels,
      session,
      layout,
      episodes,
      hasBack: Boolean(onBack),
      onBack: () => latest.current.onBack?.(),
      selectEpisode: (episode) => latest.current.onSelectEpisode?.(episode),
      focusRoot,
      rootRef,
      capabilities,
    }),
    [controller, labels, session, layout, episodes, onBack, focusRoot, capabilities],
  );

  return (
    <PlayerContext.Provider value={contextValue}>
      <PlayerFrame
        className={className}
        style={style}
        rootRef={rootRef}
        videoRef={videoRef}
        crossOrigin={props.crossOrigin}
        onPointerDown={onRootPointerDown}
        onPointerMove={onRootPointerMove}
        onPointerLeave={onRootPointerLeave}
        surface={{ onClick: onSurfaceClick, onDoubleClick: onSurfaceDoubleClick }}
        renderEndScreen={props.renderEndScreen}
        blockingOverlay={props.blockingOverlay}
        synopsis={props.synopsis ?? null}
      />
    </PlayerContext.Provider>
  );
}

interface FrameProps {
  className: string | undefined;
  style: CSSProperties | undefined;
  rootRef: RefObject<HTMLElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  crossOrigin: PlayerProps["crossOrigin"];
  onPointerDown: (event: ReactPointerEvent) => void;
  onPointerMove: (event: ReactPointerEvent) => void;
  onPointerLeave: (event: ReactPointerEvent) => void;
  surface: {
    onClick: (event: ReactMouseEvent<HTMLDivElement>) => void;
    onDoubleClick: () => void;
  };
  renderEndScreen: PlayerProps["renderEndScreen"];
  blockingOverlay: PlayerProps["blockingOverlay"];
  synopsis: string | null;
}

/** The DOM skeleton. Split out so frequently changing state re-renders only this subtree. */
function PlayerFrame(props: FrameProps) {
  const view = usePlayerState(
    (s) => ({
      phase: s.phase,
      controlsVisible: s.controlsVisible,
      pausedIdle: s.pausedIdle,
      firstFrame: s.firstFrame,
      fullscreen: s.fullscreen,
      pip: s.pip,
      panel: s.panel,
      hasError: s.error !== null,
      blocked: s.blocked,
      endScreen: selectMomentsView(s)?.endScreen ?? null,
    }),
    shallowEqual,
  );
  const { layout, session, labels } = usePlayer();
  const chromeHidden = view.hasError || view.blocked;
  const endScreen = chromeHidden ? null : view.endScreen;
  const episode = session.display.episode;
  const title = episode
    ? `${session.display.titleName}, ${labels.episodeLabel(episode.seasonNumber, episode.number)} ${episode.name}`
    : session.display.titleName;

  return (
    <section
      ref={props.rootRef}
      className={props.className ? `wfp-root ${props.className}` : "wfp-root"}
      style={props.style}
      data-phase={view.phase}
      data-controls={view.controlsVisible ? "shown" : "hidden"}
      data-paused-idle={view.pausedIdle ? "" : undefined}
      data-layout={layout}
      data-fullscreen={view.fullscreen ? "" : undefined}
      data-endscreen={endScreen ?? undefined}
      data-ready={view.firstFrame ? "" : undefined}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the player region takes focus so its keyboard shortcuts work.
      tabIndex={0}
      aria-roledescription={labels.player}
      aria-label={title}
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerLeave={props.onPointerLeave}
    >
      {/* biome-ignore lint/a11y/useMediaCaption: captions are side-car <track>s added by the controller and drawn by <Captions>. */}
      <video
        ref={props.videoRef}
        className="wfp-video"
        playsInline
        preload="auto"
        crossOrigin={props.crossOrigin}
      />
      {view.pip ? <PipPlaceholder /> : null}
      <Captions />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the picture mirrors the Play button (click) and the ±10 s buttons (double tap). */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard equivalents are global shortcuts (Space/K, F, ←/→). */}
      <div
        className="wfp-surface"
        onClick={props.surface.onClick}
        onDoubleClick={props.surface.onDoubleClick}
      />
      <div className="wfp-scrim wfp-scrim--top" aria-hidden="true" />
      <div className="wfp-scrim wfp-scrim--bottom" aria-hidden="true" />
      <BufferingIndicator />
      <FeedbackLayer />
      <PausedOverlay synopsis={props.synopsis} />
      <Advisory />
      {endScreen ? <EndScreen phase={endScreen} render={props.renderEndScreen} /> : null}
      <div className="wfp-chrome" inert={chromeHidden}>
        <TopBar />
        {layout === "touch" ? <CenterControls /> : null}
        <SkipButton />
        <NextEpisodeCard />
        <BottomControls />
        {view.panel === "episodes" ? <EpisodesPanel /> : null}
      </div>
      <AutoplayBlocked />
      <ErrorLayer />
      {props.blockingOverlay ? <BlockingLayer>{props.blockingOverlay}</BlockingLayer> : null}
      <LiveRegion />
    </section>
  );
}
