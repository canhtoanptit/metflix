import { useEffect, useState } from "react";

/** The current time, updated every `intervalMs` while `active` (countdowns, "3 min ago"). */
export function useNow(intervalMs = 1_000, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, active]);
  return now;
}

/** `document.title` for the current screen: never a member's personal data. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · Webflix Staff` : "Webflix Staff";
  }, [title]);
}
