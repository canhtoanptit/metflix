/**
 * The whole API inside workerd on D1: `createApp` from @webflix/http, the application
 * services from @webflix/core, repositories and the FTS5 search index from this package over
 * the D1 binding. This is the portability proof for the Cloudflare mode: the platform engineer
 * only adds bindings-backed adapters (KV, R2, Durable Objects, Queues) around the same code.
 */
import { createRouteClient, routes } from "@webflix/contracts";
import { MemoryBlobStore, MemoryRateLimiter } from "@webflix/core/memory";
import { createTestServices, FIXTURE_MASTER_PLAYLIST } from "@webflix/core/testing";
import { createApp } from "@webflix/http";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/database.ts";
import { createRepositories } from "../../src/repositories/index.ts";
import { createSqlSearchIndex } from "../../src/search.ts";
import { freshD1Database } from "./setup.ts";

let database: Database;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  database = await freshD1Database();
  const t = await createTestServices({
    repos: createRepositories(database),
    search: createSqlSearchIndex(database),
  });
  const blobs = new MemoryBlobStore({ clock: t.clock });
  await blobs.put("vod/v-pkg/master.m3u8", FIXTURE_MASTER_PLAYLIST);
  await blobs.put("vod/v-pkg/720p/seg-1.m4s", new Uint8Array(4096).fill(7));
  app = createApp({
    config: t.deps.config,
    services: t.services,
    blobs,
    rateLimiter: new MemoryRateLimiter({ clock: t.clock }),
    clock: t.clock,
    ids: t.deps.ids,
    logger: t.logger,
    readiness: [{ name: "database", check: async () => {} }],
  });
});

/** A typed client that keeps the session cookie (and ignores the "known device" one). */
function client() {
  let cookie = "";
  return createRouteClient(routes, {
    validateResponses: true,
    headers: () => {
      const headers = new Headers();
      if (cookie) headers.set("Cookie", cookie);
      return headers;
    },
    fetch: async (url, init) => {
      const response = await app.request(url, init);
      for (const header of response.headers.getSetCookie()) {
        const pair = header.split(";")[0] ?? "";
        if (pair.startsWith("webflix_session=")) cookie = pair;
      }
      return response;
    },
  });
}

describe("API on D1 inside workerd", () => {
  it("serves a viewer's journey with a bounded number of D1 round trips", async () => {
    const api = client();
    await api.login({ body: { email: "demo@webflix.dev", password: "webflix-demo" } });
    await api.selectProfile({ body: { profileId: "pr-demo" } });

    // Warm the shared caches (catalog snapshot, popularity), then measure a browse request.
    await api.getBrowse();
    const before = database.stats.queries;
    const home = await api.getBrowse();
    const roundTrips = database.stats.queries - before;
    // Session lookup + one batch of the profile's library: independent of the number of rows.
    expect(roundTrips).toBeLessThanOrEqual(2);
    expect(home.rows.length).toBeGreaterThanOrEqual(6);
    expect(home.billboard).not.toBeNull();

    const detail = await api.getTitle({ params: { id: "t-kestrel" } });
    expect(detail.playTarget?.action).toBe("resume");

    const search = await api.search({ query: { q: "kest" } });
    expect(search.results[0]?.id).toBe("t-kestrel");

    const session = await api.createPlaybackSession({ body: { titleId: "t-orbit" } });
    const master = await app.request(session.manifestUrl);
    expect(master.status).toBe(200);
    expect(new TextDecoder().decode(await master.arrayBuffer())).toContain("1080p/index.m3u8");
    const segment = await app.request(
      session.manifestUrl.replace("master.m3u8", "720p/seg-1.m4s"),
      {
        headers: { Range: "bytes=0-99" },
      },
    );
    expect(segment.status).toBe(206);
    expect(segment.headers.get("Content-Range")).toBe("bytes 0-99/4096");
    await segment.arrayBuffer();

    await api.sendHeartbeat({
      params: { id: session.id },
      body: { positionSec: 30, durationSec: 5400, state: "playing" },
    });
    const continueWatching = await api.getContinueWatching();
    expect(continueWatching.items[0]?.title.id).toBe("t-orbit");
  });

  it("writes a heartbeat and a release with its final position in one batch each, credit bounded", async () => {
    const api = client();
    await api.login({ body: { email: "demo@webflix.dev", password: "webflix-demo" } });
    await api.selectProfile({ body: { profileId: "pr-demo" } });
    const session = await api.createPlaybackSession({ body: { titleId: "t-lowlands" } });
    let before = database.stats.queries;
    // Twelve reports at once, each claiming five more seconds.
    for (let beat = 1; beat <= 12; beat += 1) {
      await api.sendHeartbeat({
        params: { id: session.id },
        body: { positionSec: beat * 5, durationSec: 600, state: "playing" },
      });
    }
    // Per heartbeat: session lookup, the playback session, one write batch.
    expect((database.stats.queries - before) / 12).toBeLessThanOrEqual(3);
    before = database.stats.queries;
    await api.endPlaybackSession({
      params: { id: session.id },
      body: { positionSec: 65, durationSec: 600, state: "paused" },
    });
    expect(database.stats.queries - before).toBeLessThanOrEqual(3);
    const stored = await createRepositories(database).playback.get(session.id);
    expect(stored?.endedAt).not.toBeNull();
    expect(stored?.positionSec).toBe(65);
    // No clock moved: nothing was watched, whatever the reports claimed.
    expect(stored?.watchedSec).toBe(0);

    const showcase = await app.request("/api/v1/showcase");
    expect(showcase.headers.get("Cache-Control")).toMatch(/^public/);
    expect(((await showcase.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  it("filters a kids profile and signs up new members", async () => {
    const api = client();
    await api.login({ body: { email: "demo@webflix.dev", password: "webflix-demo" } });
    await api.selectProfile({ body: { profileId: "pr-kids" } });
    const home = await api.getBrowse({ query: { view: "home" } });
    const maturities = home.rows.flatMap((row) =>
      row.items.map((item) => ("title" in item ? item.title.maturity : item.maturity)),
    );
    expect(maturities.every((maturity) => maturity === "ALL" || maturity === "7+")).toBe(true);

    const fresh = client();
    const state = await fresh.signup({
      body: { email: "d1-member@example.com", password: "long-enough" },
    });
    expect(state.account.email).toBe("d1-member@example.com");
    // An account without a membership, on D1 as anywhere: no stand-in subscription or plan.
    expect(state).toMatchObject({ subscription: null, plan: null });
    const profile = await fresh.createProfile({ body: { name: "Me", avatarId: "av-fox" } });
    await fresh.selectProfile({ body: { profileId: profile.id } });
    expect((await fresh.getBrowse()).rows.length).toBeGreaterThan(3);
  });

  it("answers ops endpoints", async () => {
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/readyz")).status).toBe(200);
    const openapi = (await (await app.request("/api/openapi.json")).json()) as { openapi: string };
    expect(openapi.openapi).toBe("3.1.1");
    const docs = await app.request("/api/docs");
    expect(docs.status).toBe(200);
  });
});
