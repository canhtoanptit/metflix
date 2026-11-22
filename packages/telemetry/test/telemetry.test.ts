/**
 * The web event SDK in a simulated DOM (jsdom): envelopes, batching, delivery, page lifecycle,
 * sampling and impressions. Driving it in a real browser belongs to the browser suites.
 */
import {
  ClientEventInput,
  EVENT_BATCH_MAX_BYTES,
  EVENT_BATCH_MAX_EVENTS,
  EventBatch,
} from "@webflix/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTelemetry,
  type KeyValueStorage,
  type TelemetryOptions,
  uuidV7,
} from "../src/index.ts";

interface Sent {
  url: string;
  init: RequestInit;
  body: { events: ClientEventInput[]; consent?: unknown };
}

function fakeServer(statuses: (number | Error | { status: number; retryAfter: string })[] = []) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Sent["body"];
    sent.push({ url: String(url), init: init ?? {}, body });
    const next = statuses.shift() ?? 202;
    if (next instanceof Error) throw next;
    const status = typeof next === "number" ? next : next.status;
    const headers: Record<string, string> =
      typeof next === "number" ? {} : { "Retry-After": next.retryAfter };
    return new Response(JSON.stringify({ accepted: body.events.length, dropped: 0 }), {
      status,
      headers,
    });
  });
  return { sent, fetch: fetch as unknown as typeof globalThis.fetch };
}

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

function telemetry(overrides: Partial<TelemetryOptions> = {}) {
  const server = fakeServer();
  const sdk = createTelemetry({
    app: { platform: "web", version: "2026.11.22" },
    fetch: server.fetch,
    storage: memoryStorage(),
    IntersectionObserver: null,
    ...overrides,
  });
  return { sdk, server };
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 10, 22, 10, 0, 0) });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("envelopes", () => {
  it("builds events the server's schema accepts, with no identity of any kind", async () => {
    const { sdk, server } = telemetry();
    sdk.setDefaults({ experiments: { "recs.learned-vs-rules": "treatment" } });
    sdk.track(
      "impression",
      { titleId: "t-sintel" },
      {
        surface: "home",
        rowId: "home:trending",
        rowRank: 3,
        rank: 2,
        policy: { id: "rules-v1", explore: false },
      },
    );
    sdk.track("title.open", { titleId: "t-sintel" }, { surface: "home", rowRank: 3, rank: 2 });
    sdk.track("search.query", { queryLength: 6, resultCount: 14 }, { surface: "search" });
    await sdk.flush();
    expect(server.sent).toHaveLength(1);
    const [request] = server.sent;
    expect(EventBatch.safeParse(request?.body).success).toBe(true);
    const events = request?.body.events ?? [];
    for (const event of events) {
      expect(ClientEventInput.safeParse(event).success).toBe(true);
      expect(event).not.toHaveProperty("subject");
      expect(event).not.toHaveProperty("source");
      expect(event).not.toHaveProperty("receivedAt");
    }
    expect(events.map((event) => event.sessionSeq)).toEqual([0, 1, 2]);
    expect(events[0]?.context).toEqual({
      surface: "home",
      rowId: "home:trending",
      rowRank: 3,
      rank: 2,
      experiments: { "recs.learned-vs-rules": "treatment" },
      policy: { id: "rules-v1", explore: false },
    });
    expect(events[0]?.payload).toEqual({ titleId: "t-sintel", sampleRate: 1 });
    expect(events[0]?.occurredAt).toBe("2026-11-22T10:00:00.000Z");
    expect(request?.init.headers).toMatchObject({ "X-Webflix-Client": "web" });
    expect(request?.init.credentials).toBe("same-origin");
    expect(request?.url).toBe("/api/v1/events");
  });

  it("keeps one anonymous device id across app sessions (localStorage)", () => {
    const storage = memoryStorage();
    const first = telemetry({ storage }).sdk.deviceId;
    const second = telemetry({ storage }).sdk.deviceId;
    expect(first).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(second).toBe(first);
    expect(telemetry({ storage: memoryStorage() }).sdk.deviceId).not.toBe(first);
    expect(telemetry({ storage: null }).sdk.deviceId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("mints UUIDv7 event ids", () => {
    const id = uuidV7(Date.UTC(2026, 10, 22, 10));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16)).toBe(
      Date.UTC(2026, 10, 22, 10),
    );
  });
});

describe("batching", () => {
  it("sends at most 50 events per request, and a full batch at once", async () => {
    const { sdk, server } = telemetry();
    for (let index = 0; index < 120; index += 1) sdk.track("title.open", { titleId: `t-${index}` });
    await vi.runAllTimersAsync();
    expect(server.sent.map((request) => request.body.events.length)).toEqual([50, 50, 20]);
    const seqs = server.sent.flatMap((request) =>
      request.body.events.map((event) => event.sessionSeq),
    );
    expect(seqs).toEqual(Array.from({ length: 120 }, (_, index) => index));
  });

  it("keeps every request within 64 KiB", async () => {
    const { sdk, server } = telemetry();
    const context = {
      surface: "home" as const,
      rowId: "r".repeat(128),
      experiments: Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [`e${index}-${"k".repeat(50)}`, "v".repeat(64)]),
      ),
    };
    for (let index = 0; index < EVENT_BATCH_MAX_EVENTS; index += 1) {
      sdk.track("title.open", { titleId: `t-${index}` }, context);
    }
    await vi.runAllTimersAsync();
    expect(server.sent.length).toBeGreaterThan(1);
    for (const request of server.sent) {
      expect(new TextEncoder().encode(String(request.init.body)).length).toBeLessThanOrEqual(
        EVENT_BATCH_MAX_BYTES,
      );
    }
    expect(server.sent.reduce((sum, request) => sum + request.body.events.length, 0)).toBe(50);
  });

  it("flushes on its timer", async () => {
    const { sdk, server } = telemetry({ flushIntervalMs: 2000 });
    sdk.track("list.add", { titleId: "t-1" });
    await vi.advanceTimersByTimeAsync(1999);
    expect(server.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.sent).toHaveLength(1);
  });
});

describe("delivery", () => {
  it("retries network errors and 5xx with backoff, keeping the batch and its order", async () => {
    const server = fakeServer([new TypeError("offline"), 503]);
    const { sdk } = telemetry({ fetch: server.fetch });
    sdk.track("list.add", { titleId: "t-1" });
    sdk.track("list.remove", { titleId: "t-1" });
    await sdk.flush();
    expect(sdk.pending).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.sent).toHaveLength(2);
    expect(sdk.pending).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(server.sent).toHaveLength(3);
    expect(sdk.pending).toBe(0);
    const ids = server.sent.map((request) => request.body.events.map((event) => event.eventId));
    expect(ids[0]).toEqual(ids[2]); // the same events, in the same order: the server dedups
  });

  it("waits as long as Retry-After says on 429", async () => {
    const server = fakeServer([{ status: 429, retryAfter: "20" }]);
    const { sdk } = telemetry({ fetch: server.fetch });
    sdk.track("list.add", { titleId: "t-1" });
    await sdk.flush();
    await vi.advanceTimersByTimeAsync(19_000);
    expect(server.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.sent).toHaveLength(2);
    expect(sdk.pending).toBe(0);
  });

  it("drops a batch the server refuses as invalid, and reports it", async () => {
    const errors: unknown[] = [];
    const server = fakeServer([400]);
    const { sdk } = telemetry({ fetch: server.fetch, onError: (error) => errors.push(error) });
    sdk.track("list.add", { titleId: "t-1" });
    await sdk.flush();
    expect(sdk.pending).toBe(0);
    expect(errors).toEqual([{ kind: "refused", status: 400, events: 1 }]);
  });

  it("bounds what it keeps while the server is unreachable, dropping the oldest", async () => {
    const errors: { kind: string; events: number }[] = [];
    const server = fakeServer(Array.from({ length: 50 }, () => new TypeError("offline")));
    const { sdk } = telemetry({
      fetch: server.fetch,
      maxBufferedEvents: 10,
      onError: (e) => errors.push(e),
    });
    for (let index = 0; index < 15; index += 1) sdk.track("title.open", { titleId: `t-${index}` });
    expect(sdk.pending).toBe(10);
    expect(
      errors.filter((error) => error.kind === "overflow").reduce((n, e) => n + e.events, 0),
    ).toBe(5);
  });
});

describe("page lifecycle", () => {
  it("flushes with keepalive when the page is hidden or unloaded", async () => {
    const { sdk, server } = telemetry({ document, window });
    sdk.track("preview.start", { titleId: "t-1" });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(server.sent).toHaveLength(1);
    expect(server.sent[0]?.init.keepalive).toBe(true);
    sdk.track("preview.complete", { titleId: "t-1", watchedSec: 28 });
    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(0);
    expect(server.sent).toHaveLength(2);
    expect(server.sent[1]?.init.keepalive).toBe(true);
    sdk.shutdown();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });
});

describe("consent and pausing", () => {
  it("queues nothing when the device refused both purposes, and sends its answer otherwise", async () => {
    let answer: { analytics: boolean; personalisation: boolean } | undefined = {
      analytics: false,
      personalisation: false,
    };
    const { sdk, server } = telemetry({ consent: () => answer });
    sdk.track("list.add", { titleId: "t-1" });
    expect(sdk.pending).toBe(0);
    answer = { analytics: true, personalisation: false };
    sdk.track("list.add", { titleId: "t-1" });
    await sdk.flush();
    expect(server.sent[0]?.body.consent).toEqual({ analytics: true, personalisation: false });
  });

  it("collects nothing while disabled (a kids profile is active)", () => {
    const { sdk } = telemetry();
    sdk.setEnabled(false);
    sdk.track("list.add", { titleId: "t-1" });
    expect(sdk.pending).toBe(0);
    sdk.setEnabled(true);
    sdk.track("list.add", { titleId: "t-1" });
    expect(sdk.pending).toBe(1);
  });
});

describe("sampling and impressions", () => {
  it("samples impressions and row views per app session, and says at what rate", async () => {
    const unsampled = telemetry({ impressionSampleRate: 0.25, random: () => 0.9 }).sdk;
    unsampled.track("impression", { titleId: "t-1" });
    unsampled.track("row.view", { rowKind: "trending", itemCount: 20 });
    unsampled.track("title.open", { titleId: "t-1" });
    expect(unsampled.pending).toBe(1);
    const { sdk, server } = telemetry({ impressionSampleRate: 0.25, random: () => 0.1 });
    sdk.track("impression", { titleId: "t-1" });
    sdk.track("row.view", { rowKind: "trending", itemCount: 20 });
    await sdk.flush();
    expect(server.sent[0]?.body.events.map((event) => event.payload)).toEqual([
      { titleId: "t-1", sampleRate: 0.25 },
      { rowKind: "trending", itemCount: 20, sampleRate: 0.25 },
    ]);
  });

  it("counts an impression once a card has been half visible for a second", async () => {
    const observers: { callback: (entries: unknown[]) => void; target?: Element }[] = [];
    class FakeObserver {
      callback: (entries: unknown[]) => void;
      constructor(callback: (entries: unknown[]) => void) {
        this.callback = callback;
        observers.push(this);
      }
      observe(target: Element) {
        (observers.at(-1) as { target?: Element }).target = target;
      }
      unobserve() {}
      disconnect() {}
    }
    const { sdk, server } = telemetry({
      IntersectionObserver: FakeObserver as unknown as TelemetryOptions["IntersectionObserver"],
    });
    const card = document.createElement("div");
    sdk.observeImpression(card, {
      titleId: "t-sintel",
      context: { surface: "home", rowId: "home:trending", rowRank: 2, rank: 5 },
    });
    const observer = observers[0];
    const see = (ratio: number) =>
      observer?.callback([{ target: card, isIntersecting: ratio > 0, intersectionRatio: ratio }]);
    see(0.6);
    await vi.advanceTimersByTimeAsync(900);
    see(0.2); // scrolled away before a second: no impression
    await vi.advanceTimersByTimeAsync(2000);
    expect(sdk.pending).toBe(0);
    see(0.8);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sdk.pending).toBe(1);
    see(0.1);
    see(0.9);
    await vi.advanceTimersByTimeAsync(5000);
    await sdk.flush();
    const impressions = server.sent.flatMap((request) => request.body.events);
    expect(impressions).toHaveLength(1); // once per card
    expect(impressions[0]?.context).toMatchObject({ rowRank: 2, rank: 5, rowId: "home:trending" });
  });
});
