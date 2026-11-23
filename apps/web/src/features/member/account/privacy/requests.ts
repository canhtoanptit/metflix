/**
 * The account's privacy requests (`GET /privacy/requests`): data exports and deletions, newest
 * first, with this deployment's terms (how long a deletion waits, how long an export takes and
 * stays available, how long activity is kept), and what the privacy page makes of them. An
 * export is a wait the member can walk away from: the request lives on the server, so the page
 * shows where it stands whenever they come back, and polls (gently, slower as it goes) only while
 * one is being prepared and the tab is visible.
 */
import { queryOptions } from "@tanstack/react-query";
import type { PrivacyRequest, PrivacyRequestList, PrivacyTerms } from "@webflix/contracts";
import { api } from "../../../../app/api.ts";
import { qk } from "../../../../app/query/keys.ts";

/** Under the account scope: dropped on sign-out with everything else of the account's. */
export const privacyRequestsKey = () => [...qk.account.all(), "privacy-requests"] as const;

export type ExportStage =
  | { stage: "none" }
  | { stage: "preparing"; request: PrivacyRequest }
  | { stage: "ready"; request: PrivacyRequest & { downloadUrl: string } }
  | { stage: "expired"; request: PrivacyRequest }
  | { stage: "failed"; request: PrivacyRequest };

export function latestExport(items: readonly PrivacyRequest[]): PrivacyRequest | undefined {
  return items.find((item) => item.kind === "export");
}

/** Where the latest export stands. A cancelled one (the account's deletion ended it) is none. */
export function exportStage(items: readonly PrivacyRequest[], now = Date.now()): ExportStage {
  const request = latestExport(items);
  if (!request || request.status === "canceled") return { stage: "none" };
  if (request.status === "pending" || request.status === "processing") {
    return { stage: "preparing", request };
  }
  if (request.status === "failed") return { stage: "failed", request };
  if (request.status === "completed") {
    const expired = request.expiresAt !== null && Date.parse(request.expiresAt) <= now;
    if (request.downloadUrl && !expired) {
      return { stage: "ready", request: { ...request, downloadUrl: request.downloadUrl } };
    }
    return { stage: "expired", request };
  }
  return { stage: "none" };
}

/** The deletion waiting out its cooling-off period, if any. */
export function scheduledDeletion(
  items: readonly PrivacyRequest[],
): (PrivacyRequest & { scheduledFor: string }) | undefined {
  const request = items.find((item) => item.kind === "deletion" && item.status === "scheduled");
  return request?.scheduledFor ? { ...request, scheduledFor: request.scheduledFor } : undefined;
}

/** A deletion whose erasure has started: it cannot be stopped, and the account is locked. */
export function deletionInProgress(items: readonly PrivacyRequest[]): PrivacyRequest | undefined {
  return items.find((item) => item.kind === "deletion" && item.status === "processing");
}

/**
 * What the request's email will do, in a sentence (privacy review L10): promised only when one is
 * on its way, and said plainly when the address cannot receive it. Null when there is nothing
 * worth saying (no email for this request).
 */
export function exportEmailLine(request: PrivacyRequest, address: string): string | null {
  switch (request.email) {
    case "pending":
      return `We'll email ${address} when it's ready.`;
    case "sent":
      return `We emailed ${address} when it was ready.`;
    case "suppressed":
      return `We can't email ${address} (earlier emails to it didn't arrive), so check back here.`;
    default:
      return null;
  }
}

/**
 * The membership a kept account still has set to end (the member cancelled their deletion after
 * it stopped the renewals): offer to resume it.
 */
export function resumableAfterDeletion(
  items: readonly PrivacyRequest[],
): (PrivacyRequest & { membership: NonNullable<PrivacyRequest["membership"]> }) | undefined {
  const latest = items.find((item) => item.kind === "deletion");
  if (latest?.status !== "canceled" || !latest.membership?.resumable) return undefined;
  return { ...latest, membership: latest.membership };
}

/**
 * How often to look again while an export is being prepared: every few seconds at first where it
 * takes seconds (inline), then less often; a batch export (the deployment's scheduled job, many
 * minutes) is looked at every half minute, then every minute. False when nothing is in progress.
 */
export function pollInterval(list: PrivacyRequestList | undefined, now = Date.now()) {
  const preparing = list ? exportStage(list.items, now) : null;
  if (preparing?.stage !== "preparing") return false;
  const age = now - Date.parse(preparing.request.requestedAt);
  if (list?.terms.exportMode === "batch") return age < 10 * 60_000 ? 30_000 : 60_000;
  if (age < 60_000) return 3_000;
  if (age < 10 * 60_000) return 15_000;
  return 60_000;
}

/** Past this, the page says the export is taking longer than usual (and that it will finish). */
export function slowAfterMs(terms: PrivacyTerms): number {
  return Math.max(2 * terms.exportTypicalSec * 1000, terms.exportTypicalSec * 1000 + 5 * 60_000);
}

export const privacyRequestsQuery = () =>
  queryOptions({
    queryKey: privacyRequestsKey(),
    queryFn: ({ signal }) => api().listPrivacyRequests(undefined, { signal }),
    refetchInterval: (query) => pollInterval(query.state.data),
  });

// --- Saying the terms -----------------------------------------------------------------------

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** "30 seconds", "10 minutes", "14 days", "13 months": a period in its largest whole unit. */
export function formatPeriod(seconds: number): string {
  if (seconds < MINUTE) return plural(Math.max(1, Math.round(seconds)), "second");
  if (seconds < HOUR) return plural(Math.round(seconds / MINUTE), "minute");
  if (seconds < 2 * DAY) return plural(Math.round(seconds / HOUR), "hour");
  if (seconds < 60 * DAY) return plural(Math.round(seconds / DAY), "day");
  return plural(Math.round(seconds / (30.44 * DAY)), "month");
}

/** A retention in days, said the same way ("13 months"). */
export function formatRetention(days: number): string {
  return formatPeriod(days * DAY);
}

/**
 * How long an export usually takes, said as a member would ("about a minute", "up to half an
 * hour"), from the deployment's typical time: what is usual, never a promise.
 */
export function typicalWait(terms: PrivacyTerms): string {
  const seconds = terms.exportTypicalSec;
  if (seconds <= 90) return "about a minute";
  if (seconds <= 10 * MINUTE) return "a few minutes";
  if (seconds <= 35 * MINUTE) return "up to half an hour";
  if (seconds <= 75 * MINUTE) return "up to an hour";
  return `up to ${formatPeriod(seconds)}`;
}
