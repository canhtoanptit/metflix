import { useCallback, useRef } from "react";

/**
 * A synchronous latch against double submission. `useMutation().isPending` updates on the next
 * tick, so two clicks in the same frame (a double click, Enter + click) would both pass an
 * `isPending` check; this ref flips before the first request leaves.
 *
 *   const flight = useSingleFlight();
 *   flight.run(() => mutation.mutateAsync());
 */
export function useSingleFlight() {
  const busy = useRef(false);
  const run = useCallback(<T>(task: () => Promise<T>): void => {
    if (busy.current) return;
    busy.current = true;
    task()
      .catch(() => {
        // The mutation reports its own error state.
      })
      .finally(() => {
        busy.current = false;
      });
  }, []);
  const isBusy = useCallback(() => busy.current, []);
  return { run, isBusy };
}
