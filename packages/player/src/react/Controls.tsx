/**
 * Control chrome: the top bar (back, title), the touch-layout centre cluster and the bottom
 * controls (scrubber + button bar + menus). Desktop and touch layouts share the components and
 * differ in arrangement only.
 */
import { imageUrl, pickImageWidth } from "@webflix/contracts";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
  useRef,
  useState,
} from "react";
import { formatEpisodeCode } from "../core/format.ts";
import { SEEK_STEP_SEC, VOLUME_STEP } from "../core/keymap.ts";
import type { MenuId } from "../core/state.ts";
import { menuTextTracks } from "../core/tracks.ts";
import { shallowEqual, usePlayer, usePlayerState } from "./context.ts";
import { Icon, type IconName } from "./icons.tsx";
import { AudioSubtitlesMenu, QualityMenu, SpeedMenu } from "./Menus.tsx";
import { Scrubber } from "./Scrubber.tsx";

interface ControlButtonProps {
  icon: IconName;
  label: string;
  onPress: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  /** Keyboard shortcut shown in the tooltip, e.g. "F". */
  shortcut?: string;
  /** Visible text label (touch layout). */
  text?: string;
  className?: string;
  /** Keep focus on the button after a mouse click (menu triggers). */
  keepFocus?: boolean;
  expanded?: boolean;
  controls?: string;
  hasPopup?: "menu" | "dialog";
  buttonRef?: Ref<HTMLButtonElement>;
  disabled?: boolean;
}

export function ControlButton(props: ControlButtonProps) {
  const { focusRoot } = usePlayer();
  const tooltip = props.shortcut ? `${props.label} (${props.shortcut})` : props.label;
  return (
    <button
      ref={props.buttonRef}
      type="button"
      className={`wfp-btn${props.text ? " wfp-btn--labelled" : ""}${props.className ? ` ${props.className}` : ""}`}
      // Always named by aria-label: the visible text label is dropped on narrow screens.
      aria-label={props.label}
      aria-expanded={props.expanded}
      aria-controls={props.expanded ? props.controls : undefined}
      aria-haspopup={props.hasPopup}
      data-tooltip={props.text ? undefined : tooltip}
      disabled={props.disabled}
      onClick={(event) => {
        props.onPress(event);
        // A mouse click must not leave focus on the button, or the next Space would press it
        // again instead of toggling playback. Keyboard activations (detail 0) keep focus.
        if (event.detail > 0 && !props.keepFocus) focusRoot();
      }}
    >
      <Icon name={props.icon} />
      {props.text ? <span className="wfp-btn__text">{props.text}</span> : null}
    </button>
  );
}

function PlayPauseButton({ large = false }: { large?: boolean }) {
  const { controller, labels } = usePlayer();
  const { playing, ended } = usePlayerState(
    (s) => ({
      playing: s.playIntent && s.phase !== "ended" && s.phase !== "error",
      ended: s.phase === "ended",
    }),
    shallowEqual,
  );
  const icon: IconName = ended ? "replay" : playing ? "pause" : "play";
  const label = ended ? labels.replay : playing ? labels.pause : labels.play;
  return (
    <ControlButton
      icon={icon}
      label={label}
      shortcut="Space"
      className={large ? "wfp-btn--hero" : "wfp-btn--primary"}
      onPress={() => (ended ? controller.replay() : controller.togglePlay("pointer"))}
    />
  );
}

function SeekButton({ direction, large = false }: { direction: -1 | 1; large?: boolean }) {
  const { controller, labels } = usePlayer();
  return (
    <ControlButton
      icon={direction < 0 ? "back10" : "forward10"}
      label={direction < 0 ? labels.seekBack(SEEK_STEP_SEC) : labels.seekForward(SEEK_STEP_SEC)}
      shortcut={direction < 0 ? "←" : "→"}
      className={large ? "wfp-btn--large" : undefined}
      onPress={(event) =>
        controller.seekBy(direction * SEEK_STEP_SEC, event.detail > 0 ? "pointer" : "host")
      }
    />
  );
}

function VolumeControl() {
  const { controller, labels, layout } = usePlayer();
  const { volume, muted } = usePlayerState(
    (s) => ({ volume: s.volume, muted: s.muted }),
    shallowEqual,
  );
  const level = muted ? 0 : volume;
  const icon: IconName = level === 0 ? "volumeOff" : level < 0.5 ? "volumeLow" : "volumeHigh";
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef<number | null>(null);

  const setFromPointer = (clientY: number) => {
    const slider = sliderRef.current;
    if (!slider) return;
    const rect = slider.getBoundingClientRect();
    controller.setVolume(1 - (clientY - rect.top) / rect.height, "pointer");
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = event.pointerId;
    controller.setHold("volume", true);
    setFromPointer(event.clientY);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging.current === event.pointerId) setFromPointer(event.clientY);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging.current !== event.pointerId) return;
    dragging.current = null;
    controller.setHold("volume", false);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const delta =
      event.key === "ArrowUp" || event.key === "ArrowRight"
        ? VOLUME_STEP
        : event.key === "ArrowDown" || event.key === "ArrowLeft"
          ? -VOLUME_STEP
          : null;
    if (delta !== null) controller.setVolume(level + delta, "host");
    else if (event.key === "Home") controller.setVolume(0, "host");
    else if (event.key === "End") controller.setVolume(1, "host");
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const button = (
    <ControlButton
      icon={icon}
      label={level === 0 ? labels.unmute : labels.mute}
      shortcut="M"
      onPress={() => controller.toggleMute("pointer")}
    />
  );
  if (layout === "touch") return button;
  return (
    <div className="wfp-volume">
      {button}
      <div className="wfp-volume__popover">
        <div
          ref={sliderRef}
          className="wfp-volume__slider"
          role="slider"
          tabIndex={0}
          aria-label={labels.volume}
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(level * 100)}
          aria-valuetext={level === 0 ? labels.muted : `${Math.round(level * 100)}%`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
        >
          <div className="wfp-volume__track">
            <div className="wfp-volume__fill" style={{ transform: `scaleY(${level})` }} />
            <div className="wfp-volume__thumb" style={{ bottom: `${level * 100}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function TitleLabel({ stacked = false }: { stacked?: boolean }) {
  const { session } = usePlayer();
  const { titleName, episode } = session.display;
  return (
    <div className={`wfp-title${stacked ? " wfp-title--stacked" : ""}`}>
      <span className="wfp-title__name">{titleName}</span>
      {episode ? (
        <span className="wfp-title__episode">
          <span className="wfp-title__code">
            {formatEpisodeCode(episode.seasonNumber, episode.number)}
          </span>{" "}
          {episode.name}
        </span>
      ) : null}
    </div>
  );
}

function NextEpisodeButton({ withText = false }: { withText?: boolean }) {
  const { controller, labels, session, layout } = usePlayer();
  const next = session.nextEpisode;
  if (!next) return null;
  const still = next.still;
  return (
    <div className="wfp-next-trigger">
      <ControlButton
        icon="next"
        label={labels.nextEpisode}
        shortcut="Shift+N"
        text={withText ? labels.nextEpisode : undefined}
        onPress={() => controller.requestNext("user")}
      />
      {layout === "desktop" ? (
        <div className="wfp-next-trigger__card" aria-hidden="true">
          <div className="wfp-next-trigger__eyebrow">{labels.nextEpisode}</div>
          <div className="wfp-next-trigger__body">
            {still ? (
              <img
                className="wfp-next-trigger__still"
                src={imageUrl(still, pickImageWidth(still, 160, 2), still.formats[0] ?? "webp")}
                alt=""
                style={{ backgroundColor: still.dominantColor }}
              />
            ) : null}
            <div>
              <div className="wfp-next-trigger__title">
                <span className="wfp-title__code">
                  {formatEpisodeCode(next.episode.seasonNumber, next.episode.number)}
                </span>{" "}
                {next.episode.name}
              </div>
              <p className="wfp-next-trigger__synopsis">{next.synopsis}</p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FullscreenButton({ withText = false }: { withText?: boolean }) {
  const { controller, labels, capabilities } = usePlayer();
  const fullscreen = usePlayerState((s) => s.fullscreen);
  if (!capabilities.fullscreen) return null;
  const label = fullscreen ? labels.exitFullscreen : labels.fullscreen;
  return (
    <ControlButton
      icon={fullscreen ? "fullscreenExit" : "fullscreen"}
      label={label}
      shortcut="F"
      text={withText ? label : undefined}
      onPress={() => void controller.toggleFullscreen()}
    />
  );
}

function PipButton() {
  const { controller, labels, capabilities } = usePlayer();
  const pip = usePlayerState((s) => s.pip);
  if (!capabilities.pip) return null;
  return (
    <ControlButton
      icon={pip ? "pipExit" : "pip"}
      label={pip ? labels.exitPip : labels.pip}
      shortcut="P"
      onPress={() => void controller.togglePip()}
    />
  );
}

function BackButton() {
  const { hasBack, onBack, labels } = usePlayer();
  if (!hasBack) return null;
  return (
    <ControlButton
      icon="back"
      label={labels.back}
      className="wfp-btn--back"
      onPress={onBack}
      keepFocus
    />
  );
}

export function TopBar() {
  const { layout, controller, labels } = usePlayer();
  const muted = usePlayerState((s) => s.muted || s.volume === 0);
  return (
    <div className="wfp-top">
      <BackButton />
      {layout === "touch" ? (
        <>
          <TitleLabel stacked />
          <div className="wfp-top__end">
            <ControlButton
              icon={muted ? "volumeOff" : "volumeHigh"}
              label={muted ? labels.unmute : labels.mute}
              onPress={() => controller.toggleMute("pointer")}
            />
            <PipButton />
          </div>
        </>
      ) : null}
    </div>
  );
}

export function CenterControls() {
  return (
    <div className="wfp-center">
      <SeekButton direction={-1} large />
      <PlayPauseButton large />
      <SeekButton direction={1} large />
    </div>
  );
}

function useMenuTriggers() {
  const audio = useRef<HTMLButtonElement | null>(null);
  const speed = useRef<HTMLButtonElement | null>(null);
  const quality = useRef<HTMLButtonElement | null>(null);
  return { "audio-subtitles": audio, speed, quality } as const;
}

export function BottomControls() {
  const { controller, labels, session, layout, episodes } = usePlayer();
  const { menu, panel, qualityControllable, qualityCount, audioCount } = usePlayerState(
    (s) => ({
      menu: s.menu,
      panel: s.panel,
      qualityControllable: s.qualityControllable,
      qualityCount: s.qualityLevels.length,
      audioCount: s.audioTracks.length,
    }),
    shallowEqual,
  );
  const triggers = useMenuTriggers();
  const episodesButton = useRef<HTMLButtonElement | null>(null);
  const [hovering, setHovering] = useState(false);
  const touch = layout === "touch";
  const hasSubtitles = menuTextTracks(session.textTracks).length > 0 || audioCount > 1;
  const hasQuality = qualityControllable && qualityCount > 1;

  const menuButton = (id: MenuId, icon: IconName, label: string, shortcut?: string) => (
    <ControlButton
      buttonRef={triggers[id]}
      icon={icon}
      label={label}
      shortcut={shortcut}
      text={touch ? label : undefined}
      keepFocus
      hasPopup="menu"
      expanded={menu === id}
      controls={`wfp-menu-${id}`}
      onPress={() => controller.toggleMenu(id)}
    />
  );

  const secondary = (
    <>
      {touch ? menuButton("speed", "speed", labels.speed) : null}
      {episodes ? (
        <ControlButton
          buttonRef={episodesButton}
          icon="episodes"
          label={labels.episodes}
          text={touch ? labels.episodes : undefined}
          keepFocus
          hasPopup="dialog"
          expanded={panel === "episodes"}
          controls="wfp-episodes"
          onPress={() => controller.openPanel(panel === "episodes" ? null : "episodes")}
        />
      ) : null}
      {hasSubtitles
        ? menuButton("audio-subtitles", "subtitles", labels.audioAndSubtitles, "C")
        : null}
      {touch ? null : menuButton("speed", "speed", labels.speed)}
      {hasQuality ? menuButton("quality", "quality", labels.quality) : null}
      <NextEpisodeButton withText={touch} />
    </>
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only keeps the controls visible.
    <div
      className="wfp-bottom"
      data-hovering={hovering ? "" : undefined}
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse") return;
        setHovering(true);
        controller.setHold("hover", true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "mouse") return;
        setHovering(false);
        controller.setHold("hover", false);
      }}
      onFocus={(event) => {
        if (event.target.matches(":focus-visible")) controller.setHold("focus", true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          controller.setHold("focus", false);
        }
      }}
    >
      <Scrubber />
      {touch ? (
        <div className="wfp-bar wfp-bar--touch">
          {secondary}
          <FullscreenButton withText />
        </div>
      ) : (
        <div className="wfp-bar">
          <div className="wfp-bar__group">
            <PlayPauseButton />
            <SeekButton direction={-1} />
            <SeekButton direction={1} />
            <VolumeControl />
          </div>
          <TitleLabel />
          <div className="wfp-bar__group wfp-bar__group--end">
            {secondary}
            <PipButton />
            <FullscreenButton />
          </div>
        </div>
      )}
      {menu === "audio-subtitles" ? (
        <AudioSubtitlesMenu anchor={triggers["audio-subtitles"]} />
      ) : null}
      {menu === "speed" ? <SpeedMenu anchor={triggers.speed} /> : null}
      {menu === "quality" ? <QualityMenu anchor={triggers.quality} /> : null}
    </div>
  );
}
