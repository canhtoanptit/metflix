import {
  formatMoney,
  type Plan,
  videoQualityForHeight,
  videoQualityLabel,
} from "@webflix/contracts";

/**
 * Display formatting for the member screens. Dates and amounts come from `@webflix/contracts`
 * (one set for the member app, the staff console and email: docs/DESIGN_SYSTEM.md "Dates and
 * amounts"); the rest is the member app's own.
 */
export {
  formatDateRange,
  formatLongDate,
  formatLongDateTime,
  formatMoney,
  formatShortDate,
  formatShortDateTime as formatDateTime,
} from "@webflix/contracts";

/**
 * Whole sentences placed after a colon ("If you delete your account today: you can watch…"):
 * the first word loses its capital, unless it is a name (Webflix) or "I".
 */
export function afterColon(sentences: string): string {
  return /^(Webflix|I)\b/.test(sentences)
    ? sentences
    : sentences.charAt(0).toLowerCase() + sentences.slice(1);
}

export function formatMonthlyPrice(plan: Plan): string {
  return `${formatMoney(plan.monthlyPrice)}/month`;
}

const relative = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

/** "just now", "5 minutes ago", "yesterday", "3 weeks ago". */
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return "just now";
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), "hour");
  if (abs < 7 * 86_400) return relative.format(Math.round(seconds / 86_400), "day");
  if (abs < 30 * 86_400) return relative.format(Math.round(seconds / (7 * 86_400)), "week");
  if (abs < 365 * 86_400) return relative.format(Math.round(seconds / (30 * 86_400)), "month");
  return relative.format(Math.round(seconds / (365 * 86_400)), "year");
}

/** `0:42`, `2:05` for countdowns. */
export function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** "1 screen at a time", "4 screens at a time": the stream limit, never "devices". */
export function formatScreens(count: number): string {
  return count === 1 ? "1 screen at a time" : `${count} screens at a time`;
}

/**
 * Quality name for a plan's cap, in the one vocabulary the player's Quality menu and the plan
 * features also use ("HD", "Full HD", "4K").
 */
export function describeQuality(plan: Pick<Plan, "maxVideoHeight">): string {
  return videoQualityLabel(videoQualityForHeight(plan.maxVideoHeight));
}

/** "Mara's", "Kids'", "James'" */
export function possessive(name: string): string {
  return /s$/i.test(name.trim()) ? `${name}'` : `${name}'s`;
}

const languageNames =
  typeof Intl.DisplayNames === "function"
    ? new Intl.DisplayNames("en-US", { type: "language" })
    : null;

/** `es` → `Spanish`; falls back to the tag. */
export function languageName(tag: string): string {
  try {
    return languageNames?.of(tag) ?? tag;
  } catch {
    return tag;
  }
}
