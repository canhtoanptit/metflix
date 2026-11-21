import { BrandMark } from "@webflix/ui";

/**
 * Shown while the session bootstraps and while a route chunk loads for the first time. Matches
 * the static splash in index.html, so the hand-over from HTML to React is invisible.
 */
export function Splash() {
  return (
    <div className="grid min-h-dvh place-items-center bg-canvas" aria-busy="true">
      <BrandMark className="size-16 animate-pulse-soft motion-reduce:animate-none" />
      <span className="sr-only">Loading Webflix</span>
    </div>
  );
}
