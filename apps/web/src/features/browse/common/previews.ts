import { useReducedMotion } from "@webflix/ui";
import { useCallback, useSyncExternalStore } from "react";
import { useBrowseProfile } from "./session.ts";

/**
 * Whether video previews (billboard, hover cards, detail hero) may autoplay: the profile's
 * "Autoplay previews" setting, reduced motion (a moving picture is motion), and the browser's
 * data-saver hint. When false every surface keeps its still artwork.
 */
export function usePreviewsEnabled(): boolean {
  const profile = useBrowseProfile();
  const reducedMotion = useReducedMotion();
  return profile.settings.autoplayPreviews && !reducedMotion && !saveData();
}

function saveData(): boolean {
  if (typeof navigator === "undefined") return false;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

// One sound setting for every preview in the session: unmuting the billboard keeps hover
// previews audible too, as people expect after they asked for sound once.
let muted = true;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setPreviewMuted(next: boolean): void {
  if (next === muted) return;
  muted = next;
  for (const listener of listeners) listener();
}

export function usePreviewMuted(): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => muted,
    () => true,
  );
  return [value, useCallback((next: boolean) => setPreviewMuted(next), [])];
}
