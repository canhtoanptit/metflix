import { useCallback, useMemo, useState } from "react";

/**
 * Load-on-intent for navigation menus. Menus (Radix menu, popper, focus scope, scroll lock —
 * about 30 KB) are not in the page's first load: it carries a lightweight trigger with the same
 * look. The pointer arriving, focus or a press loads the real menu (and the shell preloads them
 * all once the page is idle); the real menu takes over the trigger in place as soon as its code
 * is there:
 *
 * - a click before the code arrived opens the menu as soon as it mounts (`openOnLoad`),
 * - a focused trigger hands focus to the real one (`hadFocus`).
 *
 * Only a completed click counts as a press, never pointerdown: a tap is pointerdown … click,
 * and if the real trigger took over in between (already opened on load), the tap's own click
 * would land on it and toggle the menu shut again — the "first tap does nothing" bug on phones.
 */
export interface IntentState {
  requested: boolean;
  openOnLoad: boolean;
  hadFocus: boolean;
}

export function useLoadOnIntent() {
  const [state, setState] = useState<IntentState>({
    requested: false,
    openOnLoad: false,
    hadFocus: false,
  });

  const request = useCallback(
    (patch: Partial<IntentState> = {}) =>
      setState((current) => {
        const next = { ...current, ...patch, requested: true };
        return next.requested === current.requested &&
          next.openOnLoad === current.openOnLoad &&
          next.hadFocus === current.hadFocus
          ? current
          : next;
      }),
    [],
  );

  const triggerProps = useMemo(
    () => ({
      "aria-expanded": false,
      onPointerEnter: () => request(),
      onFocus: () => request({ hadFocus: true }),
      onBlur: () =>
        setState((current) => (current.hadFocus ? { ...current, hadFocus: false } : current)),
      onPointerDown: () => request(),
      onClick: () => request({ openOnLoad: true }),
    }),
    [request],
  );

  return { ...state, triggerProps };
}
