import {
  type RefCallback,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

function subscribeMedia(query: string) {
  return (onChange: () => void) => {
    if (typeof window === "undefined" || !window.matchMedia) return () => {};
    const list = window.matchMedia(query);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  };
}

/** Live `matchMedia` result. Returns `fallback` where media queries are unavailable (tests, SSR). */
export function useMediaQuery(query: string, fallback = false): boolean {
  const subscribe = useCallback((onChange: () => void) => subscribeMedia(query)(onChange), [query]);
  return useSyncExternalStore(
    subscribe,
    () =>
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia(query).matches
        : fallback,
    () => fallback,
  );
}

const MOTION_ATTRIBUTE = "data-motion";

function subscribeMotionAttribute(onChange: () => void): () => void {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [MOTION_ATTRIBUTE],
  });
  return () => observer.disconnect();
}

function readMotionAttribute(): string | null {
  return typeof document === "undefined"
    ? null
    : document.documentElement.getAttribute(MOTION_ATTRIBUTE);
}

/**
 * True when motion should be reduced: the OS preference, unless `<html data-motion="full">`
 * overrides it, or `<html data-motion="reduce">` forces it. CSS tokens follow the same rules, so
 * script-driven and CSS-driven motion always agree.
 */
export function useReducedMotion(): boolean {
  const prefersReduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const attribute = useSyncExternalStore(subscribeMotionAttribute, readMotionAttribute, () => null);
  if (attribute === "reduce") return true;
  if (attribute === "full") return false;
  return prefersReduced;
}

/** Non-hook variant for event handlers. */
export function prefersReducedMotion(): boolean {
  const attribute = readMotionAttribute();
  if (attribute === "reduce") return true;
  if (attribute === "full") return false;
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

/** Pointer devices that can hover precisely (mouse, trackpad). Touch-first devices return false. */
export function useCanHover(): boolean {
  return useMediaQuery("(hover: hover) and (pointer: fine)", true);
}

export interface InViewOptions {
  /** Grow the viewport for early triggering, e.g. "600px 0px". */
  rootMargin?: string;
  /** Stop observing after the first intersection (lazy mounting). Default true. */
  once?: boolean;
}

/**
 * Observe whether an element is near the viewport. Returns a ref callback and the state.
 * Without IntersectionObserver (old browsers, tests) it reports `true` so content still renders.
 */
export function useInView<T extends Element>({
  rootMargin = "0px",
  once = true,
}: InViewOptions = {}): [RefCallback<T>, boolean] {
  const [inView, setInView] = useState(
    () => typeof window !== "undefined" && typeof IntersectionObserver === "undefined",
  );
  const observerRef = useRef<IntersectionObserver | null>(null);

  const ref = useCallback(
    (node: T | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!node || typeof IntersectionObserver === "undefined") return;
      const observer = new IntersectionObserver(
        (entries) => {
          const visible = entries.some((entry) => entry.isIntersecting);
          if (visible && once) {
            setInView(true);
            observer.disconnect();
          } else if (!once) {
            setInView(visible);
          }
        },
        { rootMargin },
      );
      observer.observe(node);
      observerRef.current = observer;
    },
    [rootMargin, once],
  );

  useEffect(() => () => observerRef.current?.disconnect(), []);
  return [ref, inView];
}

/** Keep the latest value in a ref (for stable callbacks that read fresh props). */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** Merge several refs into one callback ref. */
export function mergeRefs<T>(
  ...refs: Array<RefCallback<T> | RefObject<T | null> | null | undefined>
): RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    }
  };
}
