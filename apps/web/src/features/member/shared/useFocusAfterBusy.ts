import { type RefObject, useEffect, useRef } from "react";

/**
 * A button that shows a spinner is disabled while its request runs, and a browser drops focus
 * from a disabled element to the page itself. When the request settles and nothing else took
 * focus meanwhile (an alert, a dialog), put it back on the button (UX review 2.7).
 */
export function useFocusAfterBusy(
  busy: boolean,
  target: RefObject<{ focus: () => void } | null>,
): void {
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      return;
    }
    if (!wasBusy.current) return;
    wasBusy.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) target.current?.focus();
  }, [busy, target]);
}
