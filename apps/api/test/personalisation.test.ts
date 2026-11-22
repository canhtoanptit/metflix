/**
 * Hybrid serving in the Node composition on SQLite, measured: database round trips of a cold
 * browse (a fresh process on the same database: every cache empty) and a warm one, with no
 * model, with a published model and learned lists, and with experiments running. The importer
 * publishes from pipeline-format artefacts (Parquet, manifest, pointer).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowsePage, createRouteClient, routes } from "@webflix/contracts";
import type { StaffAction } from "@webflix/core";
import { MemoryBlobStore } from "@webflix/core/memory";
import {
  experimentDefinition,
  FIXTURE_CATALOG,
  FIXTURE_DEMO_ACCOUNT,
  FIXTURE_MANIFEST,
  writeRecsVersion,
} from "@webflix/core/testing";
import { migrateToLatest } from "@webflix/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadApiConfig } from "../src/config.ts";
import { createHttpApp, createRuntime, type Runtime } from "../src/runtime.ts";
import { createCookieJar } from "./cookie-jar.ts";

const DAY = 86_400_000;
const RUN = "20261121-000000-feedf00d";
const staff: StaffAction = {
  actor: { type: "staff", id: "staff-1", name: "Ada" },
  reason: "Rule engine against learned candidates",
  requestId: null,
};

let directory: string;
let databaseUrl: string;
const runtimes: Runtime[] = [];

/** A process: its own runtime (empty caches) over the shared SQLite file. */
function spawn(extra: Record<string, string> = {}) {
  const runtime = createRuntime(
    loadApiConfig({
      WEBFLIX_DATABASE_URL: databaseUrl,
      WEBFLIX_BLOB_STORE: "memory",
      WEBFLIX_MEDIA_DIR: "none",
      WEBFLIX_LOG_LEVEL: "error",
      WEBFLIX_PAYMENT_PROVIDER: "memory",
      ...extra,
    }),
    "api",
  );
  runtimes.push(runtime);
  const app = createHttpApp(runtime);
  const jar = createCookieJar();
  const api = createRouteClient(routes, {
    validateResponses: true,
    headers: (): Record<string, string> => (jar.header() ? { Cookie: jar.header() } : {}),
    fetch: async (url: string, init: RequestInit) => {
      const response = await app.request(url, init);
      jar.store(response);
      return response;
    },
  });
  return { runtime, app, api, jar };
}

let cookie = "";

/** A process signed in as the demo profile (the session is in the database, shared). */
function signedIn(extra: Record<string, string> = {}) {
  const proc = spawn(extra);
  const api = createRouteClient(routes, {
    validateResponses: true,
    headers: (): Record<string, string> => ({ Cookie: cookie }),
    fetch: async (url: string, init: RequestInit) => proc.app.request(url, init),
  });
  return { ...proc, api };
}

async function measure(proc: ReturnType<typeof signedIn>, run: () => Promise<BrowsePage>) {
  const before = proc.runtime.infra.database.stats.queries;
  const page = await run();
  return { page, roundTrips: proc.runtime.infra.database.stats.queries - before };
}

async function coldAndWarm(extra: Record<string, string> = {}) {
  const proc = signedIn(extra);
  // A fresh process: every cache empty, and the first request's one-time schema check.
  await proc.runtime.infra.repos.ping();
  const fresh = await measure(proc, () => proc.api.getBrowse());
  // Cold as milestone 1 measures it: the same process with every shared cache dropped.
  const { services } = proc.runtime;
  await Promise.all([
    services.state.catalog.invalidate(),
    services.state.popularity.invalidate(),
    services.personalisation.serving.invalidate(),
    services.personalisation.serving.invalidateEditorial(),
    proc.runtime.services.experiments.invalidateDefinitions(),
  ]);
  const cold = await measure(proc, () => proc.api.getBrowse());
  const warm = await measure(proc, () => proc.api.getBrowse());
  const warmBatches: number[] = [];
  let cursor = warm.page.nextCursor;
  while (cursor) {
    const current = cursor;
    const next = await measure(proc, () => proc.api.getBrowse({ query: { cursor: current } }));
    warmBatches.push(next.roundTrips);
    cursor = next.page.nextCursor;
  }
  return { proc, fresh, cold, warm, warmBatches };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "webflix-recs-"));
  databaseUrl = `sqlite:${join(directory, "webflix.sqlite")}`;
  const { runtime, api, jar } = spawn();
  await migrateToLatest(runtime.infra.database);
  await runtime.services.seeder.seed({
    catalog: FIXTURE_CATALOG,
    demoAccount: FIXTURE_DEMO_ACCOUNT,
    manifest: FIXTURE_MANIFEST,
  });
  await api.login({ body: { email: "demo@webflix.dev", password: "webflix-demo" } });
  await api.selectProfile({ body: { profileId: "pr-demo" } });
  cookie = jar.header();
});

afterAll(async () => {
  for (const runtime of runtimes) await runtime.close();
  await rm(directory, { recursive: true, force: true });
});

describe("hybrid serving on SQLite (Node)", () => {
  const results: Record<
    string,
    { freshProcess: number; cold: number; warm: number; batches: number[] }
  > = {};

  afterAll(() => {
    // The numbers docs/RECOMMENDATIONS.md quotes; printed for the record.
    console.info(`browse round trips: ${JSON.stringify(results)}`);
  });

  it("costs what milestone 1 cost with in-memory adapters (the baseline)", async () => {
    const { fresh, cold, warm, warmBatches } = await coldAndWarm({
      WEBFLIX_RECOMMENDATION_STORE: "memory",
      WEBFLIX_EXPERIMENTS: "memory",
    });
    results.baseline = {
      freshProcess: fresh.roundTrips,
      cold: cold.roundTrips,
      warm: warm.roundTrips,
      batches: warmBatches,
    };
    expect(warm.roundTrips).toBeLessThanOrEqual(2);
    expect(cold.page.policy).toEqual({ id: "rules", explore: false });
  });

  it("adds one cold round trip per store and none warm while no model is published", async () => {
    const { fresh, cold, warm, warmBatches } = await coldAndWarm();
    results.noModel = {
      freshProcess: fresh.roundTrips,
      cold: cold.roundTrips,
      warm: warm.roundTrips,
      batches: warmBatches,
    };
    expect(warm.roundTrips).toBeLessThanOrEqual(2);
    for (const batch of warmBatches) expect(batch).toBeLessThanOrEqual(2);
    expect(cold.page.policy?.id).toBe("rules");
  });

  it("imports a published run and serves learned candidates within the warm budget", async () => {
    const { runtime } = spawn();
    const blobs = new MemoryBlobStore();
    const now = Date.now();
    const profileKey = await runtime.services.personalisation.serving.profileKey("pr-demo");
    await writeRecsVersion(blobs, {
      run: RUN,
      asOf: now - DAY,
      expiresAt: now + 2 * DAY,
      neighbours: ["t-pebble", "t-thaw", "t-owl", "t-grin"].map((neighbourId, index) => ({
        titleId: "t-orbit",
        rank: index + 1,
        neighbourId,
        score: 0.9 - index / 10,
        support: 10,
      })),
      profiles: [
        {
          profileKey,
          run: RUN,
          generatedAt: now - DAY,
          expiresAt: now + 2 * DAY,
          rows: [
            {
              type: "personal",
              param: null,
              items: [
                ["t-hours", 0.4],
                ["t-tides", 0.3],
              ],
            },
            {
              type: "top-picks",
              param: null,
              items: [
                ["t-tides", 0.3],
                ["t-hours", 0.4],
                ["t-thaw", 0.2],
                ["t-hollow", 0.1],
              ],
            },
          ],
        },
      ],
    });
    const imported = await runtime.services.personalisation.importRecommendations({
      artefacts: blobs,
    });
    expect(imported).toMatchObject({ status: "imported", run: RUN, profiles: 1, neighbourRows: 4 });
    expect((await runtime.services.personalisation.recommendationStatus()).activeModel?.run).toBe(
      RUN,
    );

    const { fresh, cold, warm, warmBatches } = await coldAndWarm();
    results.learned = {
      freshProcess: fresh.roundTrips,
      cold: cold.roundTrips,
      warm: warm.roundTrips,
      batches: warmBatches,
    };
    expect(cold.page.policy).toEqual({ id: `learned:${RUN}`, explore: false });
    expect(cold.page.rows.some((row) => row.kind === "top-picks")).toBe(true);
    expect(warm.roundTrips).toBeLessThanOrEqual(2);
    for (const batch of warmBatches) expect(batch).toBeLessThanOrEqual(2);
  });

  it("stays within the warm budget with an experiment running, plan-targeted included", async () => {
    const { runtime } = spawn();
    const {
      status: _s,
      salt: _salt,
      registeredAt: _r,
      createdAt: _c,
      updatedAt: _u,
      ...design
    } = experimentDefinition({
      startsAt: null,
      targeting: { percentage: 100, plans: ["premium"], countries: [], audience: "all" },
    });
    await runtime.services.experiments.createExperiment(design, staff);
    await runtime.services.experiments.setExperimentStatus(
      "recs.learned-vs-rules",
      "running",
      staff,
    );
    const { fresh, cold, warm, warmBatches } = await coldAndWarm();
    results.experiment = {
      freshProcess: fresh.roundTrips,
      cold: cold.roundTrips,
      warm: warm.roundTrips,
      batches: warmBatches,
    };
    expect(warm.roundTrips).toBeLessThanOrEqual(2);
    for (const batch of warmBatches) expect(batch).toBeLessThanOrEqual(2);
    expect(["rules", `learned:${RUN}`]).toContain(cold.page.policy?.id);
  });

  it("rolls back in one operation and serves the previous run from the next page", async () => {
    const { runtime } = spawn();
    // A second run, then back to the first.
    const blobs = new MemoryBlobStore();
    const now = Date.now();
    await writeRecsVersion(blobs, {
      run: "20261122-000000-0badc0de",
      asOf: now - DAY,
      expiresAt: now + 2 * DAY,
      neighbours: [{ titleId: "t-orbit", rank: 1, neighbourId: "t-owl", score: 0.5, support: 1 }],
      profiles: [],
    });
    await runtime.services.personalisation.importRecommendations({ artefacts: blobs });
    const status = await runtime.services.personalisation.rollbackRecommendations();
    expect(status.activeModel?.run).toBe(RUN);
    const proc = signedIn({ WEBFLIX_RECS_EXPERIMENT: "none.running" });
    expect((await proc.api.getBrowse()).policy?.id).toBe(`learned:${RUN}`);
  });
});
