/**
 * The public marketing showcase (cacheable, nothing personal) and the popularity diagnostics
 * that make the views pipeline observable outside production.
 */
import {
  API_BASE_PATH,
  ApiError,
  SHOWCASE_MATURITY_CEILING,
  SHOWCASE_SIZE,
  type Showcase,
} from "@webflix/contracts";
import { isWithinMaturityCeiling } from "@webflix/core";
import { FIXTURE_CATALOG, TEST_NOW } from "@webflix/core/testing";
import { describe, expect, it } from "vitest";
import { createTestApp, DEMO, onboard, signIn } from "./support.ts";

describe("GET /showcase", () => {
  it("serves curated public artwork to guests, cacheable by shared caches", async () => {
    const t = await createTestApp();
    const response = await t.request(`${API_BASE_PATH}/showcase`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toMatch(/^public, max-age=\d+/);
    expect(response.headers.get("Vary") ?? "").not.toMatch(/cookie/i);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    const etag = response.headers.get("ETag");
    expect(etag).toMatch(/^W\/"sc-[0-9a-f]+"$/);

    const showcase = (await response.json()) as Showcase;
    expect(showcase.items.length).toBeGreaterThan(0);
    expect(showcase.items.length).toBeLessThanOrEqual(SHOWCASE_SIZE);
    const maturity = new Map(FIXTURE_CATALOG.titles.map((title) => [title.id, title.maturity]));
    for (const item of showcase.items) {
      const rating = maturity.get(item.id);
      expect(rating && isWithinMaturityCeiling(rating, SHOWCASE_MATURITY_CEILING), item.id).toBe(
        true,
      );
      expect(Object.keys(item).sort()).toEqual(["id", "images", "name", "type"]);
    }
    // Most popular first; the packaged artwork keeps its content-hash version.
    const popularity = new Map(FIXTURE_CATALOG.titles.map((title) => [title.id, title.popularity]));
    const scores = showcase.items.map((item) => popularity.get(item.id) ?? 0);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    const orbit = showcase.items.find((item) => item.id === "t-orbit");
    expect(orbit?.images.poster.template).toContain("?v=abc123");

    // Revalidation is a 304 that keeps the caching headers.
    const again = await t.request(`${API_BASE_PATH}/showcase`, {
      headers: { "If-None-Match": etag ?? "" },
    });
    expect(again.status).toBe(304);
    expect(again.headers.get("ETag")).toBe(etag);
    expect(again.headers.get("Cache-Control")).toBe(response.headers.get("Cache-Control"));
  });

  it("is the same for a signed-in member as for a guest", async () => {
    const t = await createTestApp();
    const guest = await (await t.request(`${API_BASE_PATH}/showcase`)).json();
    const device = await signIn(t, DEMO.email, DEMO.password, "Member/1.0", "pr-kids");
    expect(await device.api.getShowcase()).toEqual(guest);
  });

  it("keeps the session-bound API uncacheable", async () => {
    const t = await createTestApp();
    const response = await t.request(`${API_BASE_PATH}/session`);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Vary")).toMatch(/Cookie/);
  });
});

describe("GET /titles/:id/popularity", () => {
  it("shows a real view arriving: exactly one, once a minute of watching was credited", async () => {
    const t = await createTestApp();
    const { device } = await onboard(t, { email: "viewer@example.com" });
    const today = (await device.api.getTitlePopularity({ params: { id: "t-lowlands" } })).days[0];
    expect(today?.day).toBe(new Date(TEST_NOW).toISOString().slice(0, 10));
    const before = today?.playbackViews ?? 0;
    expect(today?.baselineViews).toBeGreaterThan(0);

    const session = await device.api.createPlaybackSession({ body: { titleId: "t-lowlands" } });
    for (let beat = 1; beat <= 3; beat += 1) {
      t.clock.advance(25_000);
      await device.api.sendHeartbeat({
        params: { id: session.id },
        body: { positionSec: 25 * beat, durationSec: 600, state: "playing" },
      });
    }
    t.clock.advance(5_000);
    // The release carries the last five seconds.
    await device.api.endPlaybackSession({
      params: { id: session.id },
      body: { positionSec: 80, durationSec: 600, state: "paused" },
    });
    t.clock.advance(10_000);
    await t.queue.drain();

    const after = (await device.api.getTitlePopularity({ params: { id: "t-lowlands" } })).days[0];
    expect(after?.playbackViews).toBe(before + 1);
    expect(after?.playbackProfiles).toBe((today?.playbackProfiles ?? 0) + 1);
    expect(after?.playbackWatchSec).toBeCloseTo(80);
    expect(after?.baselineViews).toBe(today?.baselineViews);
  });

  it("does not count a minute claimed in a few seconds", async () => {
    const t = await createTestApp();
    const { device } = await onboard(t, { email: "rapid@example.com" });
    const session = await device.api.createPlaybackSession({ body: { titleId: "t-lowlands" } });
    for (let beat = 1; beat <= 12; beat += 1) {
      t.clock.advance(200);
      await device.api.sendHeartbeat({
        params: { id: session.id },
        body: { positionSec: 5 * beat, durationSec: 600, state: "playing" },
      });
    }
    await device.api.endPlaybackSession({ params: { id: session.id } });
    t.clock.advance(10_000);
    await t.queue.drain();
    const today = (await device.api.getTitlePopularity({ params: { id: "t-lowlands" } })).days[0];
    expect(today?.playbackViews).toBe(0);
    expect(today?.playbackProfiles).toBe(1);
    expect(today?.playbackWatchSec).toBeCloseTo(2.4);
  });

  it("lists the last seven days and is not served in production", async () => {
    const t = await createTestApp();
    const device = await signIn(t, DEMO.email, DEMO.password, "Ops/1.0");
    const popularity = await device.api.getTitlePopularity({ params: { id: "t-orbit" } });
    expect(popularity.days.map((day) => day.day)).toHaveLength(7);
    expect(
      await device.api
        .getTitlePopularity({ params: { id: "t-nope" } })
        .catch((error: unknown) => ApiError.is(error, "not_found")),
    ).toBe(true);

    const production = await createTestApp({
      config: {
        WEBFLIX_ENV: "production",
        WEBFLIX_MEDIA_TOKEN_KEYS: "prod:a-production-signing-secret-of-enough-length",
      },
    });
    const member = await signIn(production, DEMO.email, DEMO.password, "Ops/1.0");
    const refused = await member.api
      .getTitlePopularity({ params: { id: "t-orbit" } })
      .catch((error: unknown) => error);
    expect(ApiError.is(refused, "not_found")).toBe(true);
  });
});
