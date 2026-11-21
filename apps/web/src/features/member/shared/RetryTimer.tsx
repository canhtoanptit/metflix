import { useState } from "react";
import { formatCountdown } from "./format.ts";

/**
 * A visible countdown inside an alert. The ticking digits are hidden from assistive tech (an
 * alert whose text changes every second would be re-announced every second); screen readers
 * hear the wait once, when the alert appears.
 */
export function RetryTimer({ seconds }: { seconds: number }) {
  const [initial] = useState(seconds);
  return (
    <>
      <span aria-hidden className="tabular-nums">
        {formatCountdown(seconds)}
      </span>
      <span className="sr-only">{initial === 1 ? "1 second" : `${initial} seconds`}</span>
    </>
  );
}
