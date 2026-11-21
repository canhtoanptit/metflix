/**
 * Controls auto-hide. Pure apart from an injected scheduler, so the rules are unit-tested:
 *
 * - Pointer or keyboard activity shows the controls and restarts the hide timer.
 * - While playing, the controls hide after `hideAfterMs` (`touchHideAfterMs` after a touch).
 * - While paused they stay up; after `pausedIdleAfterMs` without activity the paused-state
 *   overlay takes over (controls hide, `pausedIdle` turns on).
 * - Holds (an open menu, scrubbing, the pointer resting on the control bar, keyboard focus in
 *   the controls…) keep the controls up and stop every timer until released.
 * - A tap on the video toggles the controls; the pointer leaving the player hides them.
 */

export interface IdleState {
  controlsVisible: boolean;
  pausedIdle: boolean;
}

export interface IdleConfig {
  hideAfterMs: number;
  touchHideAfterMs: number;
  pausedIdleAfterMs: number;
}

export const DEFAULT_IDLE_CONFIG: IdleConfig = {
  hideAfterMs: 3000,
  touchHideAfterMs: 4000,
  pausedIdleAfterMs: 8000,
};

export interface Scheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type ActivityKind = "pointer" | "keyboard" | "touch";

export interface IdleTracker {
  readonly state: IdleState;
  activity(kind: ActivityKind): void;
  /** A tap on the picture (touch): hide if shown, show if hidden. */
  toggle(): void;
  /** Hide now if nothing holds the controls (pointer left the player). */
  hideNow(): void;
  setPlaying(playing: boolean): void;
  setHold(reason: string, active: boolean): void;
  dispose(): void;
}

export function createIdleTracker(
  config: IdleConfig,
  scheduler: Scheduler,
  onChange: (state: IdleState) => void,
): IdleTracker {
  let state: IdleState = { controlsVisible: true, pausedIdle: false };
  let playing = false;
  let lastKind: ActivityKind = "pointer";
  let timer: unknown = null;
  const holds = new Set<string>();
  let disposed = false;

  const set = (next: IdleState) => {
    if (next.controlsVisible === state.controlsVisible && next.pausedIdle === state.pausedIdle) {
      return;
    }
    state = next;
    onChange(state);
  };

  const clear = () => {
    if (timer !== null) scheduler.clearTimeout(timer);
    timer = null;
  };

  const arm = () => {
    clear();
    if (disposed || holds.size > 0) return;
    if (playing) {
      const delay = lastKind === "touch" ? config.touchHideAfterMs : config.hideAfterMs;
      timer = scheduler.setTimeout(() => {
        timer = null;
        if (holds.size === 0) set({ controlsVisible: false, pausedIdle: false });
      }, delay);
    } else {
      timer = scheduler.setTimeout(() => {
        timer = null;
        if (holds.size === 0) set({ controlsVisible: false, pausedIdle: true });
      }, config.pausedIdleAfterMs);
    }
  };

  return {
    get state() {
      return state;
    },
    activity(kind) {
      lastKind = kind;
      set({ controlsVisible: true, pausedIdle: false });
      arm();
    },
    toggle() {
      lastKind = "touch";
      if (state.controlsVisible && holds.size === 0) {
        clear();
        set({ controlsVisible: false, pausedIdle: false });
      } else {
        set({ controlsVisible: true, pausedIdle: false });
        arm();
      }
    },
    hideNow() {
      if (holds.size > 0 || !playing) return;
      clear();
      set({ controlsVisible: false, pausedIdle: false });
    },
    setPlaying(next) {
      if (next === playing) return;
      playing = next;
      // Pausing brings the controls back (the overlay comes later); resuming keeps whatever is
      // visible and lets the normal timer hide it.
      if (!playing) set({ controlsVisible: true, pausedIdle: false });
      else if (state.pausedIdle) set({ controlsVisible: false, pausedIdle: false });
      arm();
    },
    setHold(reason, active) {
      const had = holds.has(reason);
      if (active === had) return;
      if (active) {
        holds.add(reason);
        clear();
        set({ controlsVisible: true, pausedIdle: false });
      } else {
        holds.delete(reason);
        arm();
      }
    },
    dispose() {
      disposed = true;
      clear();
      holds.clear();
    },
  };
}
