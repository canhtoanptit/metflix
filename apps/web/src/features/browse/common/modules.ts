import { useSyncExternalStore } from "react";

/**
 * Code-split modules for interaction layers (detail overlay, hover preview, menus) that must
 * appear on the very next frame once someone asks for them.
 *
 * `React.lazy` is the wrong tool there: a lazy component suspends on its first render even when
 * its code has already been fetched, and React throttles revealing suspended content (about
 * 300 ms) — the overlay would open a third of a second after the click. Instead the module is
 * preloaded (on idle, or on intent), and components render it directly once it has arrived:
 * no suspension, no throttle.
 */
export interface Preloadable<T> {
  /** Start (or join) loading; resolves with the module. */
  load: () => Promise<T>;
  /** The module if it has arrived. */
  get: () => T | undefined;
  subscribe: (listener: () => void) => () => void;
}

export function preloadable<T>(loader: () => Promise<T>): Preloadable<T> {
  let value: T | undefined;
  let pending: Promise<T> | undefined;
  const listeners = new Set<() => void>();
  return {
    load() {
      pending ??= loader().then(
        (module) => {
          value = module;
          for (const listener of listeners) listener();
          return module;
        },
        (error: unknown) => {
          // A failed chunk (offline, deploy in between) may be retried on the next intent.
          pending = undefined;
          throw error;
        },
      );
      return pending;
    },
    get: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The module once loaded (re-renders when it arrives); undefined until then. */
export function useModule<T>(module: Preloadable<T>): T | undefined {
  return useSyncExternalStore(module.subscribe, module.get, module.get);
}
