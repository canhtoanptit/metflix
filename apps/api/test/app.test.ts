/**
 * The Node composition end to end: real config, SQLite (node:sqlite), scrypt, the Kysely
 * repositories and FTS5 search, the full Hono app. Asserts the query budget of the hot read
 * paths (the N+1 guard): a warm browse page costs two round trips whatever its row count.
 */
import { createRouteClient, routes } from "@webflix/contracts";
import {
  FIXTURE_CATALOG,
  FIXTURE_DEMO_ACCOUNT,
  FIXTURE_MANIFEST,
  FIXTURE_MASTER_PLAYLIST,
} from "@webflix/core/testing";
import { migrateToLatest } from "@webflix/db";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadApiConfig } from "../src/config.ts";
import { createHttpApp, createRuntime, loadSeedInput, type Runtime } from "../src/runtime.ts";
import { createCookieJar } from "./cookie-jar.ts";

let runtime: Runtime;
let app: Hono;

beforeAll(async () => {
  const config = loadApiConfig({
    WEBFLIX_DATABASE_URL: "sqlite::memory:",
    WEBFLIX_BLOB_STORE: "memory",
    WEBFLIX_MEDIA_DIR: "none",
    WEBFLIX_LOG_LEVEL: "error",
  });
  runtime = createRuntime(config, "api");
  await migrateToLatest(runtime.infra.database);
  await runtime.services.seeder.seed({
    catalog: FIXTURE_CATALOG,
    demoAccount: FIXTURE_DEMO_ACCOUNT,
    manifest: FIXTURE_MANIFEST,
  });
  await runtime.infra.blobs.put("vod/v-pkg/master.m3u8", FIXTURE_MASTER_PLAYLIST);
  app = createHttpApp(runtime);
});

afterAll(async () => {
  await runtime.close();
});

function client() {
  const jar = createCookieJar();
  const fetch = async (url: string, init: RequestInit) => {
    const response = await app.request(url, init);
    jar.store(response);
    return response;
  };
  return {
    api: createRouteClient(routes, {
      validateResponses: true,
      headers: (): Record<string, string> => (jar.header() ? { Cookie: jar.header() } : {}),
      fetch,
    }),
    get: (path: string) =>
      app.request(path, { headers: jar.header() ? { Cookie: jar.header() } : {} }),
  };
}

async function roundTrips(run: () => Promise<unknown>): Promise<number> {
  const before = runtime.infra.database.stats.queries;
  await run();
  return runtime.infra.database.stats.queries - before;
}

describe("Node API on SQLite", () => {
  it("keeps browse endpoints within a fixed query budget (no N+1)", async () => {
    const { api } = client();
    await api.login({ body: { email: "demo@webflix.dev", password: "webflix-demo" } });
    await api.selectProfile({ body: { profileId: "pr-demo" } });

    // Cold: session + library batch + catalog snapshot batch + popularity.
    await runtime.services.state.catalog.invalidate();
    await runtime.services.state.popularity.invalidate();
    expect(await roundTrips(() => api.getBrowse())).toBeLessThanOrEqual(4);

    // Warm: session + library batch, for every view and every batch of rows.
    for (const view of ["home", "series", "movies", "new-popular"] as const) {
      let cursor: string | undefined;
      let batches = 0;
      do {
        let page: Awaited<ReturnType<typeof api.getBrowse>> | undefined;
        const cost = await roundTrips(async () => {
          page = await api.getBrowse({ query: { view, ...(cursor ? { cursor } : {}) } });
        });
        expect(cost, `${view} batch ${batches}`).toBeLessThanOrEqual(2);
        cursor = page?.nextCursor ?? undefined;
        batches += 1;
      } while (cursor);
    }

    const home = await api.getBrowse();
    const row = home.rows.find((candidate) => candidate.nextCursor !== null) ?? home.rows[0];
    if (!row) throw new Error("no rows");
    const budgets: [string, () => Promise<unknown>, number][] = [
      ["row page", () => api.getBrowseRow({ params: { rowId: row.id }, query: { limit: 5 } }), 2],
      [
        "genre page",
        () => api.getGenreBrowse({ params: { slug: "drama" }, query: { sort: "newest" } }),
        2,
      ],
      ["genres", () => api.listGenres(), 2],
      ["title detail", () => api.getTitle({ params: { id: "t-kestrel" } }), 2],
      ["similar", () => api.listSimilar({ params: { id: "t-kestrel" } }), 2],
      ["episodes", () => api.listEpisodes({ params: { id: "t-kestrel", seasonNumber: 1 } }), 3],
      ["search", () => api.search({ query: { q: "night" } }), 4],
      ["my list", () => api.getMyList(), 2],
      ["continue watching", () => api.getContinueWatching(), 2],
      ["history", () => api.getHistory(), 2],
      ["notifications", () => api.listNotifications(), 2],
    ];
    for (const [name, run, budget] of budgets) {
      expect(await roundTrips(run), name).toBeLessThanOrEqual(budget);
    }
  });

  it("plays packaged media with the plan's rendition cap, through scrypt-hashed sign-in", async () => {
    const { api, get } = client();
    await api.login({ body: { email: "demo@webflix.dev", password: "webflix-demo" } });
    await api.selectProfile({ body: { profileId: "pr-demo" } });
    const session = await api.createPlaybackSession({ body: { titleId: "t-orbit" } });
    const master = await get(session.manifestUrl);
    expect(master.status).toBe(200);
    expect(master.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(await master.text()).toContain("RESOLUTION=1920x1080");
    await api.sendHeartbeat({
      params: { id: session.id },
      body: { positionSec: 42, durationSec: 5400, state: "paused" },
    });
    await api.endPlaybackSession({ params: { id: session.id } });
    const cw = await api.getContinueWatching();
    expect(cw.items[0]).toMatchObject({ title: { id: "t-orbit" }, progress: { positionSec: 42 } });
  });

  it("serves the self-hosted docs bundle and ops endpoints", async () => {
    const script = await app.request("/api/docs/scalar.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("Content-Type")).toContain("javascript");
    expect((await script.text()).length).toBeGreaterThan(100_000);
    await runtime.health?.refresh();
    const ready = await app.request("/readyz");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: "ready", started: true, draining: false });
    const dependencies = await app.request("/dependencies");
    expect(await dependencies.json()).toMatchObject({
      status: "ok",
      dependencies: { database: { status: "up" } },
    });
    const metrics = await (await app.request("/metrics")).text();
    expect(metrics).toContain("webflix_http_requests_total");
    expect(metrics).toContain("process_resident_memory_bytes");
    expect(metrics).toContain("webflix_db_round_trips");
    expect(metrics).toContain('webflix_dependency_up{dependency="database"} 1');
  });

  it("answers unknown paths with a not_found problem carrying the request id", async () => {
    for (const path of ["/api/v1/no-such-route", "/api/nope", "/elsewhere"]) {
      const response = await app.request(path, {
        headers: { "X-Request-Id": "0b4c5e1a-1111-4222-8333-944455556666" },
      });
      expect(response.status, path).toBe(404);
      expect(response.headers.get("Content-Type"), path).toContain("application/problem+json");
      expect(await response.json(), path).toMatchObject({
        code: "not_found",
        requestId: "0b4c5e1a-1111-4222-8333-944455556666",
      });
    }
  });

  it("reports readiness failures while draining", async () => {
    runtime.draining.value = true;
    try {
      expect((await app.request("/readyz")).status).toBe(503);
      expect((await app.request("/healthz")).status).toBe(200);
    } finally {
      runtime.draining.value = false;
    }
  });
});

describe("live catalog (@webflix/catalog)", () => {
  it("seeds whatever the content package currently holds, idempotently", async () => {
    const config = loadApiConfig({
      WEBFLIX_DATABASE_URL: "sqlite::memory:",
      WEBFLIX_BLOB_STORE: "memory",
      WEBFLIX_MEDIA_DIR: "none",
      WEBFLIX_LOG_LEVEL: "error",
      WEBFLIX_PASSWORD_HASHER: "pbkdf2",
    });
    const live = createRuntime(config, "api");
    try {
      await migrateToLatest(live.infra.database);
      const input = await loadSeedInput(config);
      const first = await live.services.seeder.seed(input);
      expect(first.skipped).toBe(false);
      expect(first.titles).toBe(input.catalog.titles.length);
      expect((await live.services.seeder.seed(input)).skipped).toBe(true);
      const issued = await live.services.auth.login(
        { email: input.demoAccount?.email ?? "", password: input.demoAccount?.password ?? "" },
        { userAgent: null },
        { chargeEmail: async () => {} },
      );
      expect(issued.state.profiles.length).toBe(input.demoAccount?.profiles.length);
    } finally {
      await live.close();
    }
  });
});
