/**
 * The player keyboard map (blueprint §9): a pure function from a key event to a command, so the
 * map is unit-tested without a browser and documented in one place.
 *
 * | Key                    | Command                              |
 * | ---------------------- | ------------------------------------ |
 * | Space, K               | play / pause                         |
 * | ←, J  /  →, L          | back / forward 10 s                  |
 * | ↑ / ↓                  | volume up / down 10 %                |
 * | M                      | mute / unmute                        |
 * | F                      | fullscreen                           |
 * | C                      | subtitles on / off                   |
 * | Esc                    | close menu or panel, exit fullscreen |
 * | 0 … 9                  | jump to 0 % … 90 %                   |
 * | Home / End             | start / end                          |
 * | S                      | Skip Intro / Skip Recap when shown   |
 * | Shift + N              | next episode                         |
 * | Shift + . / Shift + ,  | faster / slower                      |
 * | P                      | picture-in-picture                   |
 */

export const SEEK_STEP_SEC = 10;
export const VOLUME_STEP = 0.1;

export type PlayerCommand =
  | { type: "togglePlay" }
  | { type: "seekBy"; seconds: number }
  | { type: "seekToFraction"; fraction: number }
  | { type: "seekToStart" }
  | { type: "seekToEnd" }
  | { type: "volumeBy"; delta: number }
  | { type: "toggleMute" }
  | { type: "toggleFullscreen" }
  | { type: "toggleCaptions" }
  | { type: "togglePip" }
  | { type: "skipMoment" }
  | { type: "nextEpisode" }
  | { type: "rateStep"; direction: 1 | -1 }
  | { type: "escape" };

/** The subset of `KeyboardEvent` the map reads. */
export interface KeyInput {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
}

/** Commands that make sense to auto-repeat while a key is held. Toggles must not flicker. */
const REPEATABLE = new Set<PlayerCommand["type"]>(["seekBy", "volumeBy"]);

export function resolveKeyCommand(input: KeyInput): PlayerCommand | null {
  // Leave browser and OS shortcuts (Cmd+F, Ctrl+L, Alt+←…) alone.
  if (input.ctrlKey || input.metaKey || input.altKey) return null;
  const command = mapKey(input);
  if (command && input.repeat && !REPEATABLE.has(command.type)) return null;
  return command;
}

function mapKey({ key, shiftKey = false }: KeyInput): PlayerCommand | null {
  if (key.length === 1 && key >= "0" && key <= "9" && !shiftKey) {
    return { type: "seekToFraction", fraction: Number(key) / 10 };
  }
  switch (key) {
    case " ":
    case "Spacebar":
      return { type: "togglePlay" };
    case "ArrowLeft":
      return { type: "seekBy", seconds: -SEEK_STEP_SEC };
    case "ArrowRight":
      return { type: "seekBy", seconds: SEEK_STEP_SEC };
    case "ArrowUp":
      return { type: "volumeBy", delta: VOLUME_STEP };
    case "ArrowDown":
      return { type: "volumeBy", delta: -VOLUME_STEP };
    case "Home":
      return { type: "seekToStart" };
    case "End":
      return { type: "seekToEnd" };
    case "Escape":
    case "Esc":
      return { type: "escape" };
    case ">":
      return { type: "rateStep", direction: 1 };
    case "<":
      return { type: "rateStep", direction: -1 };
    default:
      break;
  }
  const letter = key.length === 1 ? key.toLowerCase() : "";
  if (shiftKey) {
    if (letter === "n") return { type: "nextEpisode" };
    // Shift+. / Shift+, on layouts where the browser reports the unshifted character.
    if (key === ".") return { type: "rateStep", direction: 1 };
    if (key === ",") return { type: "rateStep", direction: -1 };
    return null;
  }
  switch (letter) {
    case "k":
      return { type: "togglePlay" };
    case "j":
      return { type: "seekBy", seconds: -SEEK_STEP_SEC };
    case "l":
      return { type: "seekBy", seconds: SEEK_STEP_SEC };
    case "m":
      return { type: "toggleMute" };
    case "f":
      return { type: "toggleFullscreen" };
    case "c":
      return { type: "toggleCaptions" };
    case "s":
      return { type: "skipMoment" };
    case "p":
      return { type: "togglePip" };
    default:
      return null;
  }
}

/** Elements that own their own keys: never hijack typing. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as { tagName?: unknown }).tagName !== "string") return false;
  const element = target as HTMLElement;
  const tag = element.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (element as HTMLInputElement).type;
    return !["button", "checkbox", "radio", "range", "reset", "submit"].includes(type);
  }
  return element.isContentEditable === true;
}
