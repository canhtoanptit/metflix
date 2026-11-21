import { prefersReducedMotion } from "@webflix/ui";

/**
 * Script-driven motion (Web Animations API) reads its timing from the design tokens, so it
 * stays in step with CSS motion and collapses under reduced motion like the tokens do.
 */

const cache = new Map<string, string>();

export function cssVar(name: string): string {
  if (typeof document === "undefined") return "";
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  // Durations change with reduced motion; only easings are safe to cache.
  if (name.startsWith("--ease")) cache.set(name, value);
  return value;
}

/** A duration token in milliseconds (0 under reduced motion for movement tokens). */
export function durationMs(name: string, fallback: number): number {
  const raw = cssVar(name);
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return raw.endsWith("s") && !raw.endsWith("ms") ? value * 1000 : value;
}

export function easing(name: string, fallback = "ease"): string {
  return cssVar(name) || fallback;
}

export function canAnimate(element: Element | null | undefined): element is HTMLElement {
  return !!element && typeof (element as HTMLElement).animate === "function";
}

/** A small celebratory "pop" (rating chosen, added to My List). Skipped under reduced motion. */
export function pop(element: Element | null | undefined): void {
  if (!canAnimate(element) || prefersReducedMotion()) return;
  element.animate(
    [{ transform: "scale(1)" }, { transform: "scale(1.32)" }, { transform: "scale(1)" }],
    { duration: durationMs("--duration-slow", 400), easing: easing("--ease-spring") },
  );
}
