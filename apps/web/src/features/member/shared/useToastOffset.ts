import { type RefObject, useLayoutEffect } from "react";

/**
 * While `ref`'s element (a bar fixed to the bottom of the viewport) is mounted, lift toasts
 * above it: the toast viewport reads `--wf-toast-offset` (packages/ui ToastViewport).
 */
export function useToastOffset(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const root = document.documentElement;
    const apply = () => root.style.setProperty("--wf-toast-offset", `${element.offsetHeight}px`);
    apply();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(apply) : null;
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      root.style.removeProperty("--wf-toast-offset");
    };
  }, [ref]);
}
