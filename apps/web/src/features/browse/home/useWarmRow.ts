import { useEffect, useState } from "react";

/**
 * When a paged row should load the artwork of its off-page cards (the pages either side of the
 * current one), so paging glides over pictures, never placeholders:
 *
 * - once the row has been on screen and the page is idle (its visible artwork goes first);
 * - at once when a paging arrow is hovered or focused (the click is coming).
 *
 * `id` is the row's element id. Scrolling rows (touch) keep native lazy loading: their cards
 * load as they near the viewport.
 */
export function useWarmRow(id: string): boolean {
  const [warm, setWarm] = useState(false);

  useEffect(() => {
    if (warm) return;
    const root = document.getElementById(id);
    if (!root) return;
    const heat = () => {
      if (root.getAttribute("data-mode") !== "scroll") setWarm(true);
    };
    const onIntent = (event: Event) => {
      if ((event.target as Element | null)?.closest?.(".wf-slider__handle")) heat();
    };
    root.addEventListener("pointerover", onIntent);
    root.addEventListener("focusin", onIntent);

    let idle: number | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    let observer: IntersectionObserver | undefined;
    if (typeof IntersectionObserver === "function") {
      observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer?.disconnect();
        if (typeof window.requestIdleCallback === "function") {
          idle = window.requestIdleCallback(heat, { timeout: 2000 });
        } else {
          fallback = setTimeout(heat, 600);
        }
      });
      observer.observe(root);
    }

    return () => {
      root.removeEventListener("pointerover", onIntent);
      root.removeEventListener("focusin", onIntent);
      observer?.disconnect();
      if (idle !== undefined) window.cancelIdleCallback?.(idle);
      if (fallback) clearTimeout(fallback);
    };
  }, [id, warm]);

  return warm;
}
