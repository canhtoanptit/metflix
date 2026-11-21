import { useEffect, useState, useSyncExternalStore } from "react";
import { WatchLifecycle, type WatchLifecycleOptions, type WatchState } from "./lifecycle.ts";

/**
 * One `WatchLifecycle` per watch page, alive exactly as long as the page. React StrictMode
 * mounts, unmounts and remounts effects in development; leaving is therefore deferred by a
 * task, and a remount in between cancels it, so the double effect never releases the session.
 */
export function useWatchLifecycle(
  options: WatchLifecycleOptions,
  callbacks: {
    start: (lifecycle: WatchLifecycle) => void;
    left: (finished: Promise<void>) => void;
  },
): { lifecycle: WatchLifecycle; state: WatchState } {
  const [lifecycle] = useState(() => new WatchLifecycle(options));
  const state = useSyncExternalStore(lifecycle.subscribe, lifecycle.getState, lifecycle.getState);
  const [handles] = useState(() => ({ started: false, leaveTimer: 0, callbacks }));
  handles.callbacks = callbacks;

  useEffect(() => {
    window.clearTimeout(handles.leaveTimer);
    if (!handles.started) {
      handles.started = true;
      handles.callbacks.start(lifecycle);
    }
    const onOnline = () => lifecycle.online();
    const onPageHide = () => lifecycle.pageHide();
    const onPageShow = (event: PageTransitionEvent) => lifecycle.pageShow(event.persisted);
    window.addEventListener("online", onOnline);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      handles.leaveTimer = window.setTimeout(() => {
        handles.callbacks.left(lifecycle.finish());
      }, 0);
    };
  }, [lifecycle, handles]);

  return { lifecycle, state };
}
