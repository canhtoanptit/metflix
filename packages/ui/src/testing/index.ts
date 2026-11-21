/**
 * Test helpers shared by `@webflix/ui` and the web app (import from `@webflix/ui/testing` in
 * tests only; it pulls axe-core).
 */
import axe from "axe-core";

type MediaMatcher = (query: string) => boolean;
let mediaMatcher: MediaMatcher = (query) =>
  query.includes("hover: hover") || query.includes("pointer: fine");

/**
 * Control `matchMedia` in tests: `setMediaMatcher((q) => q.includes("reduce"))` simulates
 * reduced motion; the default reports a hover-capable fine pointer (desktop).
 */
export function setMediaMatcher(matcher: MediaMatcher): void {
  mediaMatcher = matcher;
}

export function resetMediaMatcher(): void {
  mediaMatcher = (query) => query.includes("hover: hover") || query.includes("pointer: fine");
}

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class ImmediateIntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly thresholds = [0];
  private readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    this.callback(
      [{ isIntersecting: true, target, intersectionRatio: 1 } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

/** jsdom lacks layout APIs the components touch; install inert stand-ins. Idempotent. */
export function installDomPolyfills(): void {
  if (typeof window === "undefined") return;
  window.matchMedia = (query: string) =>
    ({
      matches: mediaMatcher(query),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
  if (!("ResizeObserver" in window)) {
    Object.assign(window, { ResizeObserver: NoopResizeObserver });
  }
  if (!("IntersectionObserver" in window)) {
    Object.assign(window, { IntersectionObserver: ImmediateIntersectionObserver });
  }
  const proto = window.HTMLElement.prototype;
  proto.scrollIntoView ??= () => {};
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
}

export interface A11yOptions {
  /** axe rule ids to disable for this check (document why at the call site). */
  disable?: string[];
}

/**
 * Run axe-core on a rendered container and throw a readable error listing every violation.
 * Colour contrast is checked in the browser (Playwright), not in jsdom, which has no layout.
 */
export async function expectNoA11yViolations(
  container: Element,
  { disable = [] }: A11yOptions = {},
): Promise<void> {
  const rules: Record<string, { enabled: boolean }> = {
    "color-contrast": { enabled: false },
    region: { enabled: false },
  };
  for (const id of disable) rules[id] = { enabled: false };
  const result = await axe.run(container, { rules, resultTypes: ["violations"] });
  if (result.violations.length === 0) return;
  const lines = result.violations.map(
    (violation) =>
      `• ${violation.id} (${violation.impact}): ${violation.help}\n${violation.nodes
        .map(
          (node) => `    ${node.target.join(" ")} — ${node.failureSummary?.split("\n").join(" ")}`,
        )
        .join("\n")}`,
  );
  throw new Error(`Accessibility violations:\n${lines.join("\n")}`);
}
