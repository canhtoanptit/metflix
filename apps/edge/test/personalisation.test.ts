/**
 * Hybrid serving and the importer inside the real Worker (workerd, bindings of wrangler.jsonc):
 * the importer reads pipeline-format artefacts from R2 and publishes them into D1 (models,
 * neighbours) and Workers KV (per-profile lists); browse is measured in D1 round trips and KV
 * reads, cold (every cache dropped) and warm, before and after a model and an experiment.
 */
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createR2BlobStore } from "@webflix/adapters-cloudflare";
import type { BrowsePage } from "@webflix/contracts";
import type { StaffAction } from "@webflix/core";
import {
  experimentDefinition,
  FIXTURE_CATALOG,
  FIXTURE_DEMO_ACCOUNT,
  FIXTURE_MANIFEST,
  writeRecsVersion,
} from "@webflix/core/testing";
import { beforeAll, describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index.ts";
import { getRuntime } from "../src/runtime.ts";

const DAY = 86_400_000;
const RUN = "20261121-000000-feedf00d";
const PREVIOUS = "20261120-000000-0dd0dd00";
const counts = { d1: 0, kv: 0 };

function countedKv(namespace: KVNamespace): KVNamespace {
  return new Proxy(namespace, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (["get", "put", "delete", "list", "getWithMetadata"].includes(String(property))) {
          counts.kv += 1;
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
}

function countedD1(db: D1Database): D1Database {
  return new Proxy(db, {
    get(object, property) {
      const value = Reflect.get(object, property);
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          counts.d1 += 1;
          return object.batch(statements);
        };
      }
      if (property === "prepare") {
        const statement = (prepared: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(prepared, {
            get(target, member) {
              if (member === "bind") {
                return (...values: unknown[]) => statement(target.bind(...values));
              }
              const fn = Reflect.get(target, member);
              if (typeof fn !== "function") return fn;
              if (["all", "first", "run", "raw"].includes(String(member))) counts.d1 += 1;
              return fn.bind(target);
            },
          });
        return (sql: string) => statement(object.prepare(sql));
      }
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}

if (!env.RECS) throw new Error("wrangler.jsonc must bind RECS");
const measured: Env = {
  ...env,
  DB: countedD1(env.DB),
  CACHE: countedKv(env.CACHE),
  RECS: countedKv(env.RECS),
  WEBFLIX_EDGE_CACHE: "off",
};
/** Milestone 1's composition: no recommendation store or experiments table to read. */
const baseline: Env = {
  ...measured,
  WEBFLIX_RECOMMENDATION_STORE: "memory",
  WEBFLIX_EXPERIMENTS: "memory",
} as Env;
let current: Env = measured;
const runtime = () => getRuntime(current);

const jar = new Map<string, string>();
async function call(path: string, init: { method?: string; body?: string } = {}) {
  const headers = new Headers({ "X-Webflix-Client": "web", "CF-Connecting-IP": "192.0.2.20" });
  if (jar.size > 0) headers.set("Cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await worker.fetch(
    new Request(new URL(path, "http://localhost:8787"), {
      ...(init.method ? { method: init.method } : {}),
      ...(init.body ? { body: init.body } : {}),
      headers,
    }) as Request<unknown, IncomingRequestCfProperties>,
    current,
    createExecutionContext(),
  );
  for (const line of response.headers.getSetCookie()) {
    const [pair = ""] = line.split(";");
    const separator = pair.indexOf("=");
    jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
  return response;
}

async function browse(): Promise<{ page: BrowsePage; d1: number; kv: number }> {
  counts.d1 = 0;
  counts.kv = 0;
  const response = await call("/api/v1/browse");
  if (response.status !== 200)
    throw new Error(`browse: ${response.status} ${await response.text()}`);
  const page = (await response.json()) as BrowsePage;
  return { page, d1: counts.d1, kv: counts.kv };
}

/** Cold (every cache dropped: isolate memory and Workers KV) then warm. */
async function coldAndWarm() {
  const { services } = runtime();
  await Promise.all([
    services.state.catalog.invalidate(),
    services.state.popularity.invalidate(),
    services.personalisation.serving.invalidate(),
    services.personalisation.serving.invalidateEditorial(),
    services.experiments.invalidateDefinitions(),
  ]);
  const cold = await browse();
  const warm = await browse();
  return { cold, warm };
}

const table: Record<
  string,
  { cold: { d1: number; kv: number }; warm: { d1: number; kv: number } }
> = {};
const staff: StaffAction = {
  actor: { type: "staff", id: "staff-1", name: "Ada" },
  reason: "Rule engine against learned candidates",
  requestId: null,
};

async function publish(run: string, lists: boolean) {
  const now = Date.now();
  const profileKey = await runtime().services.personalisation.serving.profileKey("pr-demo");
  await writeRecsVersion(createR2BlobStore(env.MEDIA), {
    run,
    asOf: now - DAY,
    expiresAt: now + 2 * DAY,
    neighbours: ["t-pebble", "t-thaw", "t-owl", "t-grin"].map((neighbourId, index) => ({
      titleId: "t-orbit",
      rank: index + 1,
      neighbourId,
      score: 0.9 - index / 10,
      support: 10,
    })),
    profiles: lists
      ? [
          {
            profileKey,
            run,
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
        ]
      : [],
  });
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await runtime().services.seeder.seed({
    catalog: FIXTURE_CATALOG,
    demoAccount: FIXTURE_DEMO_ACCOUNT,
    manifest: FIXTURE_MANIFEST,
  });
  const login = await call("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: FIXTURE_DEMO_ACCOUNT.email, password: "webflix-demo" }),
  });
  if (login.status !== 200) throw new Error(`login: ${login.status}`);
  await call("/api/v1/session/profile", {
    method: "PUT",
    body: JSON.stringify({ profileId: "pr-demo" }),
  });
  await browse();
});

describe("hybrid serving in the Worker (D1 + KV)", () => {
  it("measures milestone 1's browse (the baseline)", async () => {
    current = baseline;
    await browse();
    const { cold, warm } = await coldAndWarm();
    current = measured;
    table.baseline = { cold, warm };
    expect(warm.d1).toBeLessThanOrEqual(2);
  });

  it("measures browse with no model published", async () => {
    const { cold, warm } = await coldAndWarm();
    table["no model"] = { cold, warm };
    expect(warm.d1).toBeLessThanOrEqual(2);
    expect(cold.page.policy?.id).toBe("rules");
  });

  it("imports from R2 into D1 and KV, then serves learned candidates within the budget", async () => {
    await publish(PREVIOUS, false);
    await runtime().services.personalisation.importRecommendations();
    await publish(RUN, true);
    counts.d1 = 0;
    counts.kv = 0;
    const result = await runtime().services.personalisation.importRecommendations();
    expect(result).toMatchObject({ status: "imported", run: RUN, previous: PREVIOUS, profiles: 1 });
    console.log(`import: D1 ${counts.d1}, KV ${counts.kv} (1 list, 4 neighbour rows)`);
    const key = await runtime().services.personalisation.serving.profileKey("pr-demo");
    expect(await env.RECS?.get(`recs:v1:${RUN}:${key}`)).toContain('"top-picks"');

    const { cold, warm } = await coldAndWarm();
    table.learned = { cold, warm };
    expect(cold.page.policy).toEqual({ id: `learned:${RUN}`, explore: false });
    expect(warm.page.rows.some((row) => row.kind === "top-picks")).toBe(true);
    expect(warm.d1).toBeLessThanOrEqual(2);
  });

  it("stays within the budget with an experiment running", async () => {
    const {
      status: _s,
      salt: _salt,
      registeredAt: _r,
      createdAt: _c,
      updatedAt: _u,
      ...design
    } = experimentDefinition({ startsAt: null });
    await runtime().services.experiments.createExperiment(design, staff);
    await runtime().services.experiments.setExperimentStatus(
      "recs.learned-vs-rules",
      "running",
      staff,
    );
    const { cold, warm } = await coldAndWarm();
    table.experiment = { cold, warm };
    expect(warm.d1).toBeLessThanOrEqual(2);
  });

  it("erases a deleted account's lists from KV in every run", async () => {
    const key = await runtime().services.personalisation.serving.profileKey("pr-demo");
    expect(await env.RECS?.get(`recs:v1:${RUN}:${key}`)).not.toBeNull();
    await runtime().services.personalisation.eraseAccountData("demo-account");
    expect(await env.RECS?.get(`recs:v1:${RUN}:${key}`)).toBeNull();
    // The same profile's page no longer has its learned lists (caches were forgotten too).
    const { cold } = await coldAndWarm();
    expect(cold.page.rows.some((row) => row.kind === "top-picks")).toBe(false);
  });

  it("rolls back across D1 and KV in one D1 write", async () => {
    await runtime().services.experiments.setExperimentStatus(
      "recs.learned-vs-rules",
      "paused",
      staff,
    );
    counts.d1 = 0;
    const status = await runtime().services.personalisation.rollbackRecommendations();
    expect(status.activeModel?.run).toBe(PREVIOUS);
    const { cold } = await coldAndWarm();
    expect(cold.page.policy?.id).toBe(`learned:${PREVIOUS}`);
    expect(cold.page.rows.some((row) => row.kind === "top-picks")).toBe(false);
    for (const [name, row] of Object.entries(table)) {
      console.log(
        `browse ${name.padEnd(10)} cold D1 ${row.cold.d1} KV ${row.cold.kv} | warm D1 ${row.warm.d1} KV ${row.warm.kv}`,
      );
    }
  });
});
