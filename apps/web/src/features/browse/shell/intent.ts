import { useCallback, useMemo, useState } from "react";

/**
 * Load-on-intent for navigation menus. Menus (Radix menu, popper, focus scope, scroll lock —
 * about 30 KB) are only needed once someone reaches for them, so the page's first load carries
 * a lightweight trigger with the same look; the pointer arriving, focus, or a press loads the
 * real menu, which then takes over the trigger in place:
 *
 * - a press before the code arrived opens the menu as soon as it mounts (`openOnLoad`),
 * - a focused trigger hands focus to the real one (`hadFocus`).
 *
 * Radix menus open on pointerdown, so the stand-in records pointerdown as a press too.
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
      onPointerDown: (event: { button: number; ctrlKey: boolean }) => {
        if (event.button === 0 && !event.ctrlKey) request({ openOnLoad: true });
      },
      onClick: () => request({ openOnLoad: true }),
    }),
    [request],
  );

  return { ...state, triggerProps };
}
