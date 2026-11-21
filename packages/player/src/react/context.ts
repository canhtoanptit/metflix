import {
  createContext,
  type RefObject,
  useCallback,
  useContext,
  useRef,
  useSyncExternalStore,
} from "react";
import type { PlayerController } from "../controller/controller.ts";
import type { PlayerLabels } from "../core/labels.ts";
import type { PlayerState } from "../core/state.ts";
import type { EpisodeSummary, EpisodesSource, PlayerSession } from "../types.ts";

export type Layout = "desktop" | "touch";

export interface PlayerContextValue {
  controller: PlayerController;
  labels: PlayerLabels;
  session: PlayerSession;
  layout: Layout;
  episodes: EpisodesSource | null;
  hasBack: boolean;
  onBack: () => void;
  selectEpisode: (episode: EpisodeSummary) => void;
  /** Lets overlays return focus to the player root after acting. */
  focusRoot: () => void;
  /** What this browser can do with this element (known after mount). */
  capabilities: { fullscreen: boolean; pip: boolean };
  rootRef: RefObject<HTMLElement | null>;
}

export const PlayerContext = createContext<PlayerContextValue | null>(null);

export function usePlayer(): PlayerContextValue {
  const value = useContext(PlayerContext);
  if (!value) throw new Error("Player components must render inside <Player>");
  return value;
}

/**
 * Subscribe to a slice of the player state. Re-renders only when the selected value changes
 * (by `isEqual`, `Object.is` by default), so the 4 Hz time updates don't re-render menus.
 */
export function usePlayerState<T>(
  selector: (state: PlayerState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const { controller } = usePlayer();
  const cache = useRef<{ state: PlayerState; selector: unknown; value: T } | null>(null);
  const getSnapshot = useCallback(() => {
    const state = controller.store.getState();
    const cached = cache.current;
    if (cached && cached.state === state && cached.selector === selector) return cached.value;
    const value = selector(state);
    if (cached && isEqual(cached.value, value)) {
      cache.current = { state, selector, value: cached.value };
      return cached.value;
    }
    cache.current = { state, selector, value };
    return value;
  }, [controller, selector, isEqual]);
  return useSyncExternalStore(controller.store.subscribe, getSnapshot, getSnapshot);
}

export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  return keysA.every((key) =>
    Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}
