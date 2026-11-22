import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { CLIENT_HEADERS } from "./api.ts";

/**
 * Helpers for the personalised home page's specs: the page the server sent, the events it
 * received from the browser (read back through the dev API's diagnostics route), and consent.
 */

export interface PageCard {
  id: string;
  name: string;
  /** `footage` clips play in a card's preview; `motion` art keeps the still there. */
  preview?: { kind?: string; url?: string } | null;
}

export interface ServerRow {
  id: string;
  kind: string;
  title: string;
  layout: "standard" | "tall" | "ranked" | "continue";
  items: Array<PageCard | { title: PageCard }>;
  nextCursor: string | null;
}

export interface ServerPage {
  view: string;
  billboard: { title: PageCard } | null;
  rows: ServerRow[];
  nextCursor: string | null;
  policy?: { id: string; explore: boolean };
}

export interface EventContext {
  surface: string | null;
  rowId: string | null;
  rowRank: number | null;
  rank: number | null;
  experiments: Record<string, string>;
  policy: { id: string; explore: boolean } | null;
}

export interface StoredEvent {
  eventId: string;
  type: string;
  occurredAt: string;
  context: EventContext;
  payload: Record<string, unknown>;
}

export function cardOf(item: PageCard | { title: PageCard }): PageCard {
  return "title" in item ? item.title : item;
}

/** Grant both purposes, as the member would on Account › Privacy (opt-in mode asks first). */
export async function grantConsent(request: APIRequestContext): Promise<void> {
  for (const purpose of ["analytics", "personalisation"] as const) {
    const response = await request.put("/api/v1/privacy/consent", {
      headers: CLIENT_HEADERS,
      data: { purpose, granted: true, source: "settings" },
    });
    expect(response.status(), `consent: ${await response.text()}`).toBeLessThan(300);
  }
}

/** The next browse page the browser receives for `view` (start waiting before navigating). */
export function browsePageResponse(page: Page, view = "home"): Promise<ServerPage> {
  return page
    .waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/v1/browse" &&
        (url.searchParams.get("view") ?? "home") === view &&
        !url.searchParams.has("cursor") &&
        response.request().method() === "GET"
      );
    })
    .then(async (response) => {
      expect(response.status()).toBe(200);
      return (await response.json()) as ServerPage;
    });
}

/** What ingestion accepted for this profile, oldest first. */
export async function storedEvents(
  request: APIRequestContext,
  profileId: string,
): Promise<StoredEvent[]> {
  const response = await request.get(`/api/v1/diagnostics/events?profileId=${profileId}&limit=500`);
  expect(response.status(), `read back: ${await response.text()}`).toBe(200);
  const { items } = (await response.json()) as { items: StoredEvent[] };
  return [...items].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

/**
 * Wait until the read-back satisfies `done` (the browser sends its queue every few seconds, and
 * when the page is hidden). Returns what was read last.
 */
export async function eventsUntil(
  request: APIRequestContext,
  profileId: string,
  done: (events: StoredEvent[]) => boolean,
  timeout = 20_000,
): Promise<StoredEvent[]> {
  let events: StoredEvent[] = [];
  await expect
    .poll(
      async () => {
        events = await storedEvents(request, profileId);
        return done(events);
      },
      { timeout, intervals: [500, 1000] },
    )
    .toBe(true);
  return events;
}

/** The modules of a page in screen order, numbered as the member sees them (billboard first). */
export function expectedPlaces(page: ServerPage): Map<string, { rowRank: number; row: ServerRow }> {
  const places = new Map<string, { rowRank: number; row: ServerRow }>();
  let rowRank = page.billboard ? 1 : 0;
  for (const row of page.rows) {
    if (row.items.length === 0) continue;
    rowRank += 1;
    places.set(row.id, { rowRank, row });
  }
  return places;
}

/** One line per event, for failure messages. */
export function describeEvents(events: StoredEvent[]): string {
  return events
    .map((event) => {
      const { rowId, rowRank, rank, surface } = event.context;
      return `${event.type} ${String(event.payload.titleId ?? "")} ${surface ?? "-"} ${rowId ?? "-"} r${rowRank ?? "-"}/${rank ?? "-"}`;
    })
    .join("\n");
}
