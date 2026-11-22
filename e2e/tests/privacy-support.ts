/**
 * Helpers for the privacy and telemetry specs (privacy-*.spec.ts): the deployment's consent
 * mode, answering for an account, what the browser sends to `POST /events`, and what the server
 * kept (`GET /diagnostics/events`, a non-production read-back: specs that need it skip where it
 * is not served).
 */
import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import type { ClientEventInput, ConsentState, LakeEvent } from "@webflix/contracts";
import { CLIENT_HEADERS } from "./api.ts";

/** Where the telemetry SDK keeps the anonymous device id (`@webflix/telemetry`). */
export const DEVICE_ID_KEY = "webflix.deviceId";

export async function consentOf(request: APIRequestContext): Promise<ConsentState> {
  const response = await request.get("/api/v1/privacy/consent");
  expect(response.status(), `GET /privacy/consent: ${await response.text()}`).toBe(200);
  return (await response.json()) as ConsentState;
}

/** Skip unless the deployment runs this consent mode (`WEBFLIX_CONSENT_MODE`). */
export async function requireMode(
  request: APIRequestContext,
  mode: ConsentState["mode"],
): Promise<void> {
  const actual = (await consentOf(request)).mode;
  test.skip(
    actual !== mode,
    `the deployment's consent mode is ${actual}; this spec proves ${mode} (WEBFLIX_CONSENT_MODE=${mode})`,
  );
}

/** Answer both purposes for the signed-in account (`source: settings`). */
export async function answer(
  request: APIRequestContext,
  granted: { analytics: boolean; personalisation: boolean },
): Promise<void> {
  for (const purpose of ["analytics", "personalisation"] as const) {
    const response = await request.put("/api/v1/privacy/consent", {
      headers: CLIENT_HEADERS,
      data: { purpose, granted: granted[purpose], source: "settings" },
    });
    expect(response.status(), `PUT /privacy/consent: ${await response.text()}`).toBe(200);
  }
}

export interface SentBatch {
  at: number;
  events: ClientEventInput[];
}

/** Every `POST /api/v1/events` the context's pages send, with its events. */
export function recordEventRequests(context: BrowserContext): SentBatch[] {
  const sent: SentBatch[] = [];
  context.on("request", (request) => {
    if (request.method() !== "POST" || !new URL(request.url()).pathname.endsWith("/api/v1/events"))
      return;
    try {
      const body = request.postDataJSON() as { events?: ClientEventInput[] };
      sent.push({ at: Date.now(), events: body.events ?? [] });
    } catch {
      sent.push({ at: Date.now(), events: [] });
    }
  });
  return sent;
}

/**
 * What the server accepted for the signed-in account, newest first; skips the test where the
 * read-back is not served (production configurations).
 */
export async function readBack(
  request: APIRequestContext,
  query: Record<string, string | number> = {},
): Promise<LakeEvent[]> {
  const params = new URLSearchParams(
    Object.entries({ limit: 200, ...query }).map(([key, value]) => [key, String(value)]),
  );
  const response = await request.get(`/api/v1/diagnostics/events?${params}`);
  if (response.status() === 404) {
    test.skip(true, "the events read-back (GET /diagnostics/events) is not served here");
  }
  expect(response.status(), `GET /diagnostics/events: ${await response.text()}`).toBe(200);
  return ((await response.json()) as { items: LakeEvent[] }).items;
}

/** Poll the read-back until `done` holds; returns what it last read. */
export async function readBackUntil(
  request: APIRequestContext,
  what: string,
  done: (events: LakeEvent[]) => boolean,
  options: { timeoutMs?: number; query?: Record<string, string | number> } = {},
): Promise<LakeEvent[]> {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  let events: LakeEvent[] = [];
  for (;;) {
    events = await readBack(request, options.query);
    if (done(events)) return events;
    if (Date.now() > deadline) {
      throw new Error(
        `${what}: not seen within ${options.timeoutMs ?? 20_000} ms (read back: ${events.map((event) => event.type).join(", ") || "nothing"})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export async function storedDeviceId(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), DEVICE_ID_KEY);
}

/**
 * Move within the single-page app without reloading it (a reload would hide the page and flush
 * what telemetry holds, which is exactly what some specs must rule out): the router follows the
 * history like a Back/Forward would.
 */
export async function navigateInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState(window.history.state, "", to);
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  }, path);
}

/** Leave the page the way a member closing the tab does: it is hidden, then unloaded. */
export async function leavePage(page: Page): Promise<void> {
  await page.goto("about:blank");
}

/** The consent prompt or notice, by its heading. */
export function consentPrompt(page: Page) {
  return page.getByRole("region", {
    name: /^(Your viewing data, your choice|Webflix learns from what you browse)$/,
  });
}
