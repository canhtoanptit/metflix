import { BrandMark } from "@webflix/ui";
import { useLayoutEffect, useRef } from "react";

/**
 * When the static splash's pulse (index.html) started, on the document timeline. Read as this
 * module is evaluated, before React renders: the router's first commit replaces the static
 * splash before <Splash> itself renders.
 */
const BOOT_PULSE_START = readBootPulseStart();

/**
 * Shown while the session bootstraps and while a route chunk loads for the first time. Matches
 * the static splash in index.html (same mark, size, gradient and pulse), so the hand-over from
 * HTML to React is invisible.
 */
export function Splash() {
  const bootStart = BOOT_PULSE_START;
  const pulseRef = useRef<HTMLDivElement>(null);

  // Continue the static splash's pulse rather than restarting it: same start time, same phase,
  // wherever in the cycle React happens to take over.
  useLayoutEffect(() => {
    if (bootStart === null) return;
    try {
      const pulse = pulseRef.current?.getAnimations?.()[0];
      if (pulse) pulse.startTime = bootStart;
    } catch {
      // Web Animations unavailable: the pulse simply starts from the top.
    }
  }, [bootStart]);

  return (
    <div className="grid min-h-dvh place-items-center bg-canvas" aria-busy="true">
      <div ref={pulseRef} className="size-16 animate-pulse-soft motion-reduce:animate-none">
        <BrandMark className="size-full" />
      </div>
      <span className="sr-only">Loading Webflix</span>
    </div>
  );
}

function readBootPulseStart(): number | null {
  if (typeof document === "undefined") return null;
  try {
    const start = document.querySelector(".boot-splash svg")?.getAnimations?.()[0]?.startTime;
    return typeof start === "number" ? start : null;
  } catch {
    return null;
  }
}
