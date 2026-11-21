import { useLatest } from "@webflix/ui";
import { type RefObject, useEffect } from "react";

/**
 * Move focus when a request fails, after the failure has rendered: the alert (or field) only
 * exists, and inputs are only re-enabled, once React has committed the error state. Focusing
 * from `onError` would target an element that is not there yet or is still disabled.
 *
 * `pick` chooses the target per error; return null to leave focus alone.
 */
export function useFocusOnError(
  error: unknown,
  pick: (error: unknown) => RefObject<{ focus: () => void } | null> | (() => void) | null,
): void {
  const latestPick = useLatest(pick);
  // Runs once per new error object (each failed request produces a new one).
  useEffect(() => {
    if (!error) return;
    const target = latestPick.current(error);
    if (typeof target === "function") target();
    else target?.current?.focus();
  }, [error, latestPick]);
}
