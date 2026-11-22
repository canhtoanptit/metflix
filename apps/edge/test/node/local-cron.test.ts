/**
 * The local Cron Trigger (lib/local-cron.ts): `wrangler dev` never fires crons, so `make cf-dev`
 * does, on the schedule wrangler.jsonc declares and at the platform's UTC minute boundaries.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { everyMinutes, startLocalCron, untilNextFiring } from "../../scripts/lib/local-cron.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("local cron", () => {
  it("understands every-N-minutes schedules only", () => {
    expect(everyMinutes("*/5 * * * *")).toBe(5);
    expect(everyMinutes("* * * * *")).toBe(1);
    expect(everyMinutes("*/7 * * * *")).toBeNull(); // does not divide the hour
    expect(everyMinutes("0 3 * * *")).toBeNull();
  });

  it("fires at the next UTC boundary, like the platform", () => {
    const at = Date.UTC(2026, 10, 22, 10, 3, 30);
    expect(untilNextFiring(at, 5)).toBe(90_000); // 10:05:00
    expect(untilNextFiring(Date.UTC(2026, 10, 22, 10, 5, 0), 5)).toBe(300_000);
  });

  it("calls the Worker's scheduled handler on schedule until stopped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 22, 10, 4, 0));
    const calls: string[] = [];
    const stop = startLocalCron({
      port: 8787,
      crons: ["*/5 * * * *", "0 3 * * *"],
      log: () => undefined,
      fetch: (async (url: string) => {
        calls.push(url);
        return new Response("ok");
      }) as typeof fetch,
    });
    await vi.advanceTimersByTimeAsync(60_000); // 10:05
    expect(calls).toEqual([
      "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*%2F5%20*%20*%20*%20*",
    ]);
    await vi.advanceTimersByTimeAsync(10 * 60_000); // 10:10, 10:15
    expect(calls).toHaveLength(3);
    stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toHaveLength(3);
  });
});

describe("local cron for conformance runs", () => {
  it("fires every N seconds when asked, whatever the schedule", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const stop = startLocalCron({
      port: 4620,
      crons: ["*/5 * * * *"],
      everySec: 30,
      log: () => undefined,
      fetch: (async (url: string) => {
        calls.push(url);
        return new Response("ok");
      }) as typeof fetch,
    });
    await vi.advanceTimersByTimeAsync(95_000);
    expect(calls).toHaveLength(3);
    stop();
  });
});
