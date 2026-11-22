import {
  type Money,
  type Plan,
  videoQualityForHeight,
  videoQualityLabel,
} from "@webflix/contracts";

/**
 * Display formatting for the member screens. Locale-aware through `Intl`, with the formatter
 * instances cached (constructing them is the expensive part).
 */

const moneyFormatters = new Map<string, Intl.NumberFormat>();

/** `{ amountMinor: 1299, currency: "USD" }` → `$12.99`. */
export function formatMoney(money: Money): string {
  let formatter = moneyFormatters.get(money.currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat(undefined, { style: "currency", currency: money.currency });
    moneyFormatters.set(money.currency, formatter);
  }
  return formatter.format(money.amountMinor / 100);
}

export function formatMonthlyPrice(plan: Plan): string {
  return `${formatMoney(plan.monthlyPrice)}/month`;
}

const longDate = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });
const mediumDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** `November 21, 2026` */
export function formatLongDate(iso: string): string {
  return longDate.format(new Date(iso));
}

/** `Nov 21, 2026` */
export function formatShortDate(iso: string): string {
  return mediumDate.format(new Date(iso));
}

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

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

/** "1 screen", "4 screens". */
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
    ? new Intl.DisplayNames(undefined, { type: "language" })
    : null;

/** `es` → `Spanish`; falls back to the tag. */
export function languageName(tag: string): string {
  try {
    return languageNames?.of(tag) ?? tag;
  } catch {
    return tag;
  }
}
