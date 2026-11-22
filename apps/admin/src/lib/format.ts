/**
 * Dates, durations and money for staff, in the browser's locale and time zone. Every absolute
 * time is also given in UTC on hover (`<time title>`), so two staff members in different zones
 * can compare what they see with the audit log.
 */

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const dateTimeSeconds = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
  .formatToParts(new Date())
  .find((part) => part.type === "timeZoneName")?.value;

export function formatDateTime(iso: string, options: { seconds?: boolean } = {}): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return (options.seconds ? dateTimeSeconds : dateTime).format(date);
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : dateOnly.format(date);
}

/** "Nov 30 – Dec 30, 2026": a period, said once. */
export function formatDateRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "—";
  return dateOnly.formatRange(start, end);
}

/** "2026-11-23 14:32:05 UTC", for hover titles and copies. */
export function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "")} UTC`;
}

export function localZoneName(): string {
  return zone ?? "local time";
}

/** "in 48 s", "3 min ago", "in 2 days": coarse, for orientation next to an absolute time. */
export function formatRelative(iso: string, now: number): string {
  const delta = new Date(iso).getTime() - now;
  if (Number.isNaN(delta)) return "";
  const abs = Math.abs(delta);
  const future = delta > 0;
  const say = (value: number, unit: string) =>
    future ? `in ${value} ${unit}` : `${value} ${unit} ago`;
  if (abs < 1_000) return "now";
  if (abs < 60_000) return say(Math.round(abs / 1000), "s");
  if (abs < 3_600_000) return say(Math.round(abs / 60_000), "min");
  if (abs < 86_400_000) return say(Math.round(abs / 3_600_000), "h");
  const days = Math.round(abs / 86_400_000);
  return say(days, days === 1 ? "day" : "days");
}

export function fractionDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

export function formatMoney(amount: { amountMinor: number; currency: string }): string {
  const digits = fractionDigits(amount.currency);
  const major = amount.amountMinor / 10 ** digits;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: amount.currency,
    }).format(major);
  } catch {
    return `${major.toFixed(digits)} ${amount.currency}`;
  }
}

/**
 * A typed amount in major units ("12.5", "12,50") to minor units, or null when it is not a
 * plain non-negative amount with at most the currency's decimals.
 */
export function parseMajorAmount(text: string, currency: string): number | null {
  const digits = fractionDigits(currency);
  const normalised = text.trim().replace(/\s/g, "").replace(",", ".");
  const pattern = digits === 0 ? /^\d+$/ : new RegExp(`^\\d+(?:\\.\\d{1,${digits}})?$`);
  if (!pattern.test(normalised)) return null;
  const [whole = "0", fraction = ""] = normalised.split(".");
  const minor = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, "0") || "0");
  return Number.isSafeInteger(minor) ? minor : null;
}

export function minorToMajorText(amountMinor: number, currency: string): string {
  const digits = fractionDigits(currency);
  return (amountMinor / 10 ** digits).toFixed(digits);
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}
