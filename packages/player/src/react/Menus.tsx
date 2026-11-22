/**
 * Settings menus: Audio & Subtitles (two columns), Playback speed (a five-stop selector) and
 * Quality. ARIA menu pattern: arrows move focus, Enter/Space select, Esc and Tab close and
 * return focus to the trigger. Selection applies immediately and keeps the menu open, so
 * audio and subtitles can both be changed in one visit.
 */
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { formatRate } from "../core/format.ts";
import { PLAYBACK_RATES } from "../core/preferences.ts";
import type { MenuId } from "../core/state.ts";
import {
  languageLabel,
  menuTextTracks,
  qualityBadge,
  qualityOptions,
  qualityTier,
  titleQualityLimit,
} from "../core/tracks.ts";
import { shallowEqual, usePlayer, usePlayerState } from "./context.ts";
import { Icon } from "./icons.tsx";

interface MenuShellProps {
  id: MenuId;
  label: string;
  anchor: RefObject<HTMLElement | null>;
  className?: string;
  /** Arrow keys that move between items: vertical lists use ↑/↓, the speed row ←/→. */
  orientation: "vertical" | "horizontal" | "grid";
  /** A sentence under the items, read as the menu's description. */
  note?: string | null;
  children: ReactNode;
}

function focusables(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>("[role='menuitemradio']:not([disabled])")];
}

function MenuShell({ id, label, anchor, className, orientation, note, children }: MenuShellProps) {
  const { controller, labels, layout, rootRef } = usePlayer();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [right, setRight] = useState<number | null>(null);

  // Hang the popover above its trigger, right-aligned to it and clamped inside the player.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const trigger = anchor.current;
    if (!root || !trigger || layout === "touch") {
      setRight(null);
      return;
    }
    const rootRect = root.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const offset = rootRect.right - triggerRect.right - 12;
    setRight(Math.max(16, offset));
  }, [anchor, layout, rootRef]);

  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const checked = menu.querySelector<HTMLElement>("[role='menuitemradio'][aria-checked='true']");
    (checked ?? focusables(menu)[0])?.focus({ preventScroll: true });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menu.contains(target) || anchor.current?.contains(target)) return;
      controller.openMenu(null);
    };
    const doc = menu.ownerDocument;
    doc.addEventListener("pointerdown", onPointerDown, true);
    return () => doc.removeEventListener("pointerdown", onPointerDown, true);
  }, [anchor, controller]);

  const close = (returnFocus: boolean) => {
    controller.openMenu(null);
    if (returnFocus) anchor.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const menu = menuRef.current;
    if (!menu) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      close(true);
      return;
    }
    const items = focusables(menu);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      event.stopPropagation();
      items[(to + items.length) % items.length]?.focus({ preventScroll: true });
    };
    const forward = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
    const backward = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
    if (event.key === forward) move(current + 1);
    else if (event.key === backward) move(current - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(items.length - 1);
    else if (orientation === "grid" && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      // Jump to the checked item of the neighbouring column.
      const columns = [...menu.querySelectorAll<HTMLElement>("[role='group']")];
      const column = columns.findIndex((group) => group.contains(document.activeElement));
      const target = columns[column + (event.key === "ArrowRight" ? 1 : -1)];
      if (target) {
        event.preventDefault();
        event.stopPropagation();
        const item =
          target.querySelector<HTMLElement>("[aria-checked='true']") ??
          target.querySelector<HTMLElement>("[role='menuitemradio']");
        item?.focus({ preventScroll: true });
      }
    } else if (event.key.startsWith("Arrow")) {
      // Keep arrows from reaching the global seek/volume shortcuts while a menu is open.
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return (
    <div
      ref={menuRef}
      id={`wfp-menu-${id}`}
      className={`wfp-menu${className ? ` ${className}` : ""}`}
      role="menu"
      aria-label={label}
      aria-orientation={orientation === "horizontal" ? "horizontal" : "vertical"}
      aria-describedby={note ? `wfp-menu-${id}-note` : undefined}
      style={right !== null ? { right: `${right}px` } : undefined}
      onKeyDown={onKeyDown}
    >
      {layout === "touch" ? (
        <div className="wfp-menu__sheet-header">
          <span className="wfp-menu__sheet-title">{label}</span>
          <button
            type="button"
            className="wfp-btn wfp-btn--plain"
            aria-label={labels.close}
            onClick={() => close(false)}
          >
            <Icon name="close" />
          </button>
        </div>
      ) : null}
      {children}
      {note ? (
        <p id={`wfp-menu-${id}-note`} className="wfp-menu__note" role="none">
          {note}
        </p>
      ) : null}
    </div>
  );
}

function MenuItem({
  checked,
  onSelect,
  children,
  detail,
}: {
  checked: boolean;
  onSelect: () => void;
  children: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      tabIndex={-1}
      className="wfp-menu__item"
      onClick={onSelect}
    >
      <span className="wfp-menu__check" aria-hidden="true">
        {checked ? <Icon name="check" /> : null}
      </span>
      <span className="wfp-menu__label">{children}</span>
      {detail ? <span className="wfp-menu__detail">{detail}</span> : null}
    </button>
  );
}

export function AudioSubtitlesMenu({ anchor }: { anchor: RefObject<HTMLElement | null> }) {
  const { controller, labels, session, layout } = usePlayer();
  const { audioTracks, activeAudioTrackId, textTrackId } = usePlayerState(
    (s) => ({
      audioTracks: s.audioTracks,
      activeAudioTrackId: s.activeAudioTrackId,
      textTrackId: s.textTrackId,
    }),
    shallowEqual,
  );
  const subtitles = menuTextTracks(session.textTracks);
  const selectedSubtitle = subtitles.some((track) => track.id === textTrackId) ? textTrackId : null;
  const showAudio = audioTracks.length > 1;
  return (
    <MenuShell
      id="audio-subtitles"
      label={showAudio ? labels.audioAndSubtitles : labels.subtitles}
      anchor={anchor}
      orientation="grid"
      className={showAudio ? "wfp-menu--columns" : undefined}
    >
      {showAudio ? (
        <div className="wfp-menu__column">
          <div className="wfp-menu__heading" aria-hidden="true">
            {labels.audio}
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements: an ARIA menu group of menuitemradio items; <fieldset> groups form controls. */}
          <div role="group" aria-label={labels.audio}>
            {audioTracks.map((track) => (
              <MenuItem
                key={track.id}
                checked={track.id === activeAudioTrackId}
                onSelect={() => controller.setAudioTrack(track.id, "pointer")}
              >
                {track.name || languageLabel(track.language)}
              </MenuItem>
            ))}
          </div>
        </div>
      ) : null}
      <div className="wfp-menu__column">
        {/* A lone column on a touch sheet: the sheet title already says "Subtitles". */}
        {showAudio || layout !== "touch" ? (
          <div className="wfp-menu__heading" aria-hidden="true">
            {labels.subtitles}
          </div>
        ) : null}
        {/* biome-ignore lint/a11y/useSemanticElements: an ARIA menu group of menuitemradio items; <fieldset> groups form controls. */}
        <div role="group" aria-label={labels.subtitles}>
          <MenuItem
            checked={selectedSubtitle === null}
            onSelect={() => controller.selectTextTrack(null, "pointer")}
          >
            {labels.subtitlesOff}
          </MenuItem>
          {subtitles.map((track) => (
            <MenuItem
              key={track.id}
              checked={track.id === selectedSubtitle}
              onSelect={() => controller.selectTextTrack(track.id, "pointer")}
            >
              {track.label || languageLabel(track.language)}
              {track.kind === "captions" ? " [CC]" : ""}
            </MenuItem>
          ))}
        </div>
      </div>
    </MenuShell>
  );
}

export function SpeedMenu({ anchor }: { anchor: RefObject<HTMLElement | null> }) {
  const { controller, labels, layout } = usePlayer();
  const rate = usePlayerState((s) => s.playbackRate);
  return (
    <MenuShell
      id="speed"
      label={labels.speed}
      anchor={anchor}
      orientation={layout === "touch" ? "vertical" : "horizontal"}
      className="wfp-menu--speed"
    >
      {layout === "touch" ? null : (
        <div className="wfp-menu__heading" aria-hidden="true">
          {labels.speed}
        </div>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: an ARIA menu group of menuitemradio items; <fieldset> groups form controls. */}
      <div className="wfp-speed" role="group" aria-label={labels.speed}>
        <span className="wfp-speed__rail" aria-hidden="true" />
        {PLAYBACK_RATES.map((value) => (
          <button
            key={value}
            type="button"
            role="menuitemradio"
            aria-checked={value === rate}
            tabIndex={-1}
            className="wfp-speed__stop"
            onClick={() => controller.setRate(value, "pointer")}
          >
            <span className="wfp-speed__dot" aria-hidden="true" />
            <span className="wfp-speed__label">
              {value === 1 ? labels.speedNormal : formatRate(value)}
            </span>
          </button>
        ))}
      </div>
    </MenuShell>
  );
}

export function QualityMenu({ anchor }: { anchor: RefObject<HTMLElement | null> }) {
  const { controller, labels, session, layout } = usePlayer();
  const { levels, mode, activeId } = usePlayerState(
    (s) => ({ levels: s.qualityLevels, mode: s.qualityMode, activeId: s.activeQualityId }),
    shallowEqual,
  );
  // Classes only ("Full HD", "HD", "SD"): pixel heights and bitrates are engineering detail.
  const options = qualityOptions(levels, session.maxVideoHeight);
  const active = levels.find((level) => level.id === activeId);
  const pinned = mode === "auto" ? undefined : levels.find((level) => level.id === mode);
  const pinnedTier = pinned ? qualityTier(pinned) : null;
  const limit = titleQualityLimit(session);
  return (
    <MenuShell
      id="quality"
      label={labels.quality}
      anchor={anchor}
      orientation="vertical"
      note={limit ? labels.qualityTitleLimit(limit) : null}
    >
      {layout === "touch" ? null : (
        <div className="wfp-menu__heading" aria-hidden="true">
          {labels.quality}
        </div>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: an ARIA menu group of menuitemradio items; <fieldset> groups form controls. */}
      <div role="group" aria-label={labels.quality}>
        <MenuItem
          checked={mode === "auto"}
          onSelect={() => controller.setQuality("auto", "pointer")}
          detail={active && mode === "auto" ? qualityBadge(active) : undefined}
        >
          {labels.qualityAuto}
        </MenuItem>
        {options.map((option) => (
          <MenuItem
            key={option.quality}
            checked={option.quality === pinnedTier}
            onSelect={() => controller.setQuality(option.id, "pointer")}
          >
            {option.label}
          </MenuItem>
        ))}
      </div>
    </MenuShell>
  );
}
