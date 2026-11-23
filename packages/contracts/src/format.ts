/**
 * Dates and amounts as people read them, one way in the member app, the staff console and email
 * (docs/DESIGN_SYSTEM.md "Dates and amounts"). US English, whatever the browser's language:
 *
 * - A **long date** in sentences: "December 7, 2026".
 * - A **short date** in tables, lists and compact lines: "Dec 7, 2026"; a period: "Nov 30 – Dec 30,
 *   2026".
 * - A **time** only where the time matters (a sign-in, a security change, a link that expires
 *   within the day, staff logs): "Dec 7, 2026, 5:02 AM" in a table, "December 7, 2026 at 5:02
 *   AM" in a sentence. Never two styles in one sentence.
 * - **Amounts** with the currency's symbol and its own decimals: "$12.99", including email subjects.
 *
 * The member app and the console show the viewer's time zone; email, which cannot know it, passes
 * `{ timeZone: "UTC" }` and says so. Web-standard `Intl` only (this package runs everywhere).
 */

const LOCALE = "en-US";

export interface FormatZone {
  /** IANA time zone; the runtime's own when absent (the viewer's, in a browser). */
  timeZone?: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * ICU puts a narrow no-break space before AM/PM; plain text everywhere else (emails, copies,
 * search) is easier on people and tools with an ordinary space.
 */
function plain(text: string): string {
  return text.replace(/\u202f/g, " ");
}

function dateFormat(options: Intl.DateTimeFormatOptions, zone: FormatZone): Intl.DateTimeFormat {
  const all = zone.timeZone ? { ...options, timeZone: zone.timeZone } : options;
  const key = JSON.stringify(all);
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(LOCALE, all);
    formatters.set(key, formatter);
  }
  return formatter;
}

/** An instant as a Date, or null when it is not one. */
function instant(value: string | number | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const NONE = "—";

/** "December 7, 2026": in a sentence. */
export function formatLongDate(value: string | number | Date, zone: FormatZone = {}): string {
  const date = instant(value);
  return date ? dateFormat({ dateStyle: "long" }, zone).format(date) : NONE;
}

/** "Dec 7, 2026": in a table, a list or a compact line. */
export function formatShortDate(value: string | number | Date, zone: FormatZone = {}): string {
  const date = instant(value);
  return date ? dateFormat({ dateStyle: "medium" }, zone).format(date) : NONE;
}

/** "December 7, 2026 at 5:02 AM": in a sentence, where the time matters. */
export function formatLongDateTime(value: string | number | Date, zone: FormatZone = {}): string {
  const date = instant(value);
  return date
    ? plain(dateFormat({ dateStyle: "long", timeStyle: "short" }, zone).format(date))
    : NONE;
}

/** "Dec 7, 2026, 5:02 AM" (with `seconds`, "5:02:17 AM"): in a table, where the time matters. */
export function formatShortDateTime(
  value: string | number | Date,
  options: FormatZone & { seconds?: boolean } = {},
): string {
  const date = instant(value);
  if (!date) return NONE;
  return plain(
    dateFormat(
      { dateStyle: "medium", timeStyle: options.seconds ? "medium" : "short" },
      options,
    ).format(date),
  );
}

/** "5:02 AM" (with `seconds`, "5:02:17 AM"): the time of day beside a date shown apart. */
export function formatTime(
  value: string | number | Date,
  options: FormatZone & { seconds?: boolean } = {},
): string {
  const date = instant(value);
  return date
    ? plain(dateFormat({ timeStyle: options.seconds ? "medium" : "short" }, options).format(date))
    : NONE;
}

/** "Nov 30 – Dec 30, 2026": a period, said once. */
export function formatDateRange(
  start: string | number | Date,
  end: string | number | Date,
  zone: FormatZone = {},
): string {
  const from = instant(start);
  const to = instant(end);
  if (!from || !to) return NONE;
  return plain(dateFormat({ dateStyle: "medium" }, zone).formatRange(from, to));
}

const moneyFormatters = new Map<string, Intl.NumberFormat>();

function moneyFormat(currency: string): Intl.NumberFormat {
  let formatter = moneyFormatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat(LOCALE, { style: "currency", currency });
    moneyFormatters.set(currency, formatter);
  }
  return formatter;
}

/** How many decimals a currency's amounts have (2 for USD, 0 for JPY). */
export function currencyDigits(currency: string): number {
  try {
    return moneyFormat(currency).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/**
 * `{ amountMinor: 1299, currency: "USD" }` → "$12.99"; an unknown currency code falls back to
 * "12.99 XYZ" rather than failing.
 */
export function formatMoney(amount: { amountMinor: number; currency: string }): string {
  const currency = amount.currency.toUpperCase();
  const digits = currencyDigits(currency);
  const major = amount.amountMinor / 10 ** digits;
  try {
    return moneyFormat(currency).format(major);
  } catch {
    return `${major.toFixed(digits)} ${currency}`;
  }
}
