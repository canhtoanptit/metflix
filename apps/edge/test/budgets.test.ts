/**
 * Per-request binding budgets on the hot paths, measured through the real Worker: every
 * binding is wrapped in a counter, so the numbers are what the platform bills and limits
 * (D1 queries per invocation, subrequests, Durable Object requests, KV and R2 operations).
 * docs/CLOUDFLARE.md quotes this table; the assertions keep it true.
 */
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { sha256Hex, utf8Encode } from "@webflix/core";
import {
  FIXTURE_CATALOG,
  FIXTURE_DEMO_ACCOUNT,
  FIXTURE_MANIFEST,
  FIXTURE_MASTER_PLAYLIST,
} from "@webflix/core/testing";
import { createIdentityRepository } from "@webflix/db";
import { createD1Database } from "@webflix/db/d1";
import { beforeAll, describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index.ts";
import { MEDIA_GENERATION_KEY } from "../src/media-generation.ts";
import { getRuntime } from "../src/runtime.ts";

type Counts = Record<"d1" | "durableObject" | "kv" | "r2" | "queue", number>;
const counts: Counts = { d1: 0, durableObject: 0, kv: 0, r2: 0, queue: 0 };
const reset = () => {
  for (const key of Object.keys(counts) as (keyof Counts)[]) counts[key] = 0;
};

/** Count calls to the methods that cross the network; everything else passes through. */
function counted<T extends object>(target: T, kind: keyof Counts, methods: string[]): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== "function") return value;
      if (methods.includes(String(property))) {
        return (...args: unknown[]) => {
          counts[kind] += 1;
          return Reflect.apply(value, object, args);
        };
      }
      return value.bind(object);
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
        // `bind` returns a new statement: count queries on whichever statement executes.
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

function countedNamespace<T extends DurableObjectNamespace<undefined>>(namespace: T): T {
  return new Proxy(namespace, {
    get(object, property) {
      const value = Reflect.get(object, property);
      if (property === "getByName" || property === "get") {
        return (...args: unknown[]) => {
          const stub = Reflect.apply(value as (...a: unknown[]) => object, object, args) as object;
          return new Proxy(stub, {
            get(target, method) {
              const member = Reflect.get(target, method);
              if (typeof member !== "function") return member;
              // RPC stubs answer any property, `apply` included: call without property access.
              return (...callArgs: unknown[]) => {
                counts.durableObject += 1;
                return Reflect.apply(member as (...a: unknown[]) => unknown, target, callArgs);
              };
            },
          });
        };
      }
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}

const KV_METHODS = ["get", "put", "delete", "list", "getWithMetadata"];
if (!env.RECS) throw new Error("wrangler.jsonc must bind RECS");
const measured: Env = {
  ...env,
  DB: countedD1(env.DB),
  CACHE: counted(env.CACHE, "kv", KV_METHODS),
  // Per-profile recommendation lists: a KV read on browse once a model is served.
  RECS: counted(env.RECS, "kv", KV_METHODS),
  MEDIA: counted(env.MEDIA, "r2", ["get", "head", "put", "delete", "list"]),
  JOBS: counted(env.JOBS, "queue", ["send", "sendBatch"]),
  LIMITS: countedNamespace(env.LIMITS as never),
  STREAMS: countedNamespace(env.STREAMS as never),
  // Media reads go through the loopback origin (R2 counted inside it would be the origin's
  // invocation, i.e. the edge cache's miss path): measure the gateway with direct R2 reads.
  WEBFLIX_EDGE_CACHE: "off",
};

const demoJar = new Map<string, string>();
async function call(
  path: string,
  init: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    /** Whose cookies (default: the demo account's session). */
    jar?: Map<string, string>;
  } = {},
): Promise<Response> {
  const jar = init.jar ?? demoJar;
  const headers = new Headers(init.headers);
  headers.set("X-Webflix-Client", "web");
  headers.set("CF-Connecting-IP", "192.0.2.10");
  if (jar.size > 0) {
    headers.set("Cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
  }
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await worker.fetch(
    new Request(new URL(path, "http://localhost:8787"), {
      ...(init.method ? { method: init.method } : {}),
      ...(init.body ? { body: init.body } : {}),
      headers,
    }) as Request<unknown, IncomingRequestCfProperties>,
    measured,
    createExecutionContext(),
  );
  for (const line of response.headers.getSetCookie()) {
    const [pair = ""] = line.split(";");
    const separator = pair.indexOf("=");
    jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
  return response;
}

async function measure(path: string, init: Parameters<typeof call>[1] = {}) {
  reset();
  const response = await call(path, init);
  await response.arrayBuffer();
  return { status: response.status, ...counts };
}

const table: Record<string, Counts & { status: number }> = {};

/** A client event as the web SDK sends it (contracts' event schema). */
function clientEvent(sequence: number) {
  return {
    eventId: `0193a1d2-7c4e-7a10-8f00-${sequence.toString(16).padStart(12, "0")}`,
    type: "title.open",
    version: 1,
    occurredAt: new Date().toISOString(),
    deviceId: "budget-device",
    sessionSeq: sequence,
    app: { platform: "web", version: "budget" },
    context: {
      surface: "home",
      rowId: null,
      rowRank: 1,
      rank: sequence,
      experiments: {},
      policy: null,
    },
    payload: { titleId: "t-kestrel" },
  };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.MEDIA.put("vod/v-pkg/master.m3u8", FIXTURE_MASTER_PLAYLIST);
  await env.MEDIA.put("vod/v-pkg/720p/seg-1.m4s", new Uint8Array(4096));
  await env.CACHE.put(MEDIA_GENERATION_KEY, "budget");
  await getRuntime(env).services.seeder.seed({
    catalog: FIXTURE_CATALOG,
    demoAccount: FIXTURE_DEMO_ACCOUNT,
    manifest: FIXTURE_MANIFEST,
  });
  const body = (value: unknown) => ({ method: "POST", body: JSON.stringify(value) });
  const login = await call(
    "/api/v1/auth/login",
    body({ email: FIXTURE_DEMO_ACCOUNT.email, password: "webflix-demo" }),
  );
  if (login.status !== 200) throw new Error(`login: ${login.status} ${await login.text()}`);
  await call("/api/v1/session/profile", {
    method: "PUT",
    body: JSON.stringify({ profileId: "pr-demo" }),
  });
  await (await call("/api/v1/browse")).arrayBuffer(); // warm the isolate's catalog and popularity

  table["GET /api/v1/browse (warm)"] = await measure("/api/v1/browse");
  table["GET /api/v1/titles/:id"] = await measure("/api/v1/titles/t-kestrel");
  table["GET /api/v1/search"] = await measure("/api/v1/search?q=kest");
  reset();
  const start = await call("/api/v1/playback/sessions", body({ titleId: "t-orbit" }));
  const session = (await start.json()) as { id: string; manifestUrl: string };
  if (!session.manifestUrl)
    throw new Error(`playback start: ${start.status} ${JSON.stringify(session)}`);
  table["POST /api/v1/playback/sessions"] = { status: start.status, ...counts };
  table["GET master.m3u8"] = await measure(session.manifestUrl);
  // The first segment of an asset in an isolate also reads the master playlist once (the
  // HTTP layer's rendition→height map for the plan cap, memoised per isolate); after that a
  // segment is one R2 read. On Cloudflare both go through the edge cache.
  table["GET segment (Range), cold isolate"] = await measure(
    session.manifestUrl.replace("master.m3u8", "720p/seg-1.m4s"),
    { headers: { Range: "bytes=0-99" } },
  );
  table["GET segment (Range)"] = await measure(
    session.manifestUrl.replace("master.m3u8", "720p/seg-1.m4s"),
    { headers: { Range: "bytes=100-199" } },
  );
  table["POST heartbeat"] = await measure(
    `/api/v1/playback/sessions/${session.id}/heartbeat`,
    body({ positionSec: 60, durationSec: 5400, state: "playing" }),
  );
  table["POST /api/v1/auth/login"] = await measure(
    "/api/v1/auth/login",
    body({ email: FIXTURE_DEMO_ACCOUNT.email, password: "webflix-demo" }),
  );
  // Milestone 2's hot requests: the session (experiment assignments ride on it) and a batch of
  // behaviour events (every few seconds from an active client; collected only with consent).
  await call("/api/v1/session/profile", {
    method: "PUT",
    body: JSON.stringify({ profileId: "pr-demo" }),
  });
  table["GET /api/v1/session"] = await measure("/api/v1/session?deviceId=budget-device");
  await call("/api/v1/privacy/consent", {
    method: "PUT",
    body: JSON.stringify({ purpose: "analytics", granted: true, source: "banner" }),
  });
  table["POST /api/v1/events"] = await measure(
    "/api/v1/events",
    body({ events: [clientEvent(1), clientEvent(2)] }),
  );

  // The member pages and staff reads the web app and the console added: an account with an open
  // checkout, then a member (the fake provider's trial) with its next invoice and privacy terms.
  const member = new Map<string, string>();
  const as = (init: Parameters<typeof call>[1] = {}) => ({ ...init, jar: member });
  const signup = await call(
    "/api/v1/auth/signup",
    as(body({ email: "budget-member@example.test", password: "a long and correct horse battery" })),
  );
  if (signup.status !== 201) throw new Error(`signup: ${signup.status} ${await signup.text()}`);
  reset();
  const checkout = await call("/api/v1/billing/checkout", as(body({ planId: "standard" })));
  const started = (await checkout.json()) as { id: string; clientSecret: string };
  // The isolate's first checkout also syncs the plan catalogue with the provider (here the fake,
  // whose state is in D1); a second member's checkout shows the steady cost.
  table["POST /api/v1/billing/checkout (first)"] = { status: checkout.status, ...counts };
  const second = new Map<string, string>();
  const secondSignup = await call("/api/v1/auth/signup", {
    ...body({ email: "budget-second@example.test", password: "a long and correct horse battery" }),
    jar: second,
  });
  if (secondSignup.status !== 201) throw new Error(`signup: ${secondSignup.status}`);
  table["POST /api/v1/billing/checkout"] = await measure("/api/v1/billing/checkout", {
    ...body({ planId: "standard" }),
    jar: second,
  });
  table["GET /api/v1/billing/checkout (open)"] = await measure("/api/v1/billing/checkout", as());
  table["GET /api/v1/billing/checkout/:id"] = await measure(
    `/api/v1/billing/checkout/${started.id}`,
    as(),
  );
  await (
    await call("/_pay/api/confirm", as(body({ clientSecret: started.clientSecret, card: "visa" })))
  ).arrayBuffer();
  await (
    await call(`/api/v1/billing/checkout/${started.id}/confirm`, as({ method: "POST" }))
  ).arrayBuffer();
  const avatars = (await (await call("/api/v1/avatars", as())).json()) as {
    groups: { avatars: { id: string }[] }[];
  };
  const profile = (await (
    await call(
      "/api/v1/profiles",
      as(body({ name: "Budget", avatarId: avatars.groups[0]?.avatars[0]?.id })),
    )
  ).json()) as { id: string };
  await (
    await call(
      "/api/v1/session/profile",
      as({ method: "PUT", body: JSON.stringify({ profileId: profile.id }) }),
    )
  ).arrayBuffer();
  table["GET /api/v1/account (next invoice)"] = await measure("/api/v1/account", as());
  table["GET /api/v1/privacy/requests (terms)"] = await measure("/api/v1/privacy/requests", as());
  // The console's reads, with a staff token from the development issuer's jobs client.
  const issued = await call("/dev-idp/staff/token", {
    method: "POST",
    body: "grant_type=client_credentials",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa("webflix-jobs:dev-only-jobs-client-secret")}`,
    },
    jar: new Map(),
  });
  const { access_token: token } = (await issued.json()) as { access_token: string };
  const staffCall = {
    headers: { Authorization: `Bearer ${token}` },
    jar: new Map<string, string>(),
  };
  table["GET /api/admin/v1/members?q="] = await measure(
    "/api/admin/v1/members?q=budget-member",
    staffCall,
  );
  const found = (await (await call("/api/admin/v1/members?q=budget-member", staffCall)).json()) as {
    items: { accountId: string }[];
  };
  table["GET /api/admin/v1/members/:id"] = await measure(
    `/api/admin/v1/members/${found.items[0]?.accountId}`,
    staffCall,
  );
  // A password reset through the emailed link (identity): every device signed out, this one
  // signed in, as sign-in answers. The link's token is minted here as the reset email would.
  const resetEmail = "budget-reset@example.test";
  const resetSignup = await call("/api/v1/auth/signup", {
    ...body({ email: resetEmail, password: "a long and correct horse battery" }),
    jar: new Map(),
  });
  if (resetSignup.status !== 201) throw new Error(`signup: ${resetSignup.status}`);
  const identityRepository = createIdentityRepository(createD1Database(env.DB));
  const resetAccount = await identityRepository.findAccountByEmail(resetEmail);
  const resetLink = "r".repeat(43);
  await identityRepository.createToken({
    tokenHash: await sha256Hex(utf8Encode(resetLink)),
    accountId: resetAccount?.id ?? "",
    purpose: "reset_password",
    email: resetEmail,
    expiresAt: Date.now() + 30 * 60 * 1000,
    usedAt: null,
    createdAt: Date.now(),
  });
  table["POST /api/v1/auth/password-reset/confirm"] = await measure(
    "/api/v1/auth/password-reset/confirm",
    { ...body({ token: resetLink, newPassword: "the owner's new passphrase" }), jar: new Map() },
  );
  for (const [path, row] of Object.entries(table)) {
    console.log(
      `budget ${path.padEnd(32)} status ${row.status}  D1 ${row.d1}  DO ${row.durableObject}  KV ${row.kv}  R2 ${row.r2}  Queues ${row.queue}`,
    );
  }
});

describe("public probes", () => {
  it("/readyz checks the database at most once per isolate every few seconds", async () => {
    reset();
    for (let index = 0; index < 5; index += 1) {
      const response = await call("/readyz");
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    // Public and unauthenticated: a flood of probes must not become a flood of D1 queries.
    expect(counts.d1).toBeLessThanOrEqual(1);
  });
});

describe("hot-path binding budgets (per request)", () => {
  it("browse: one session lookup and one library batch, nothing else", () => {
    expect(table["GET /api/v1/browse (warm)"]).toMatchObject({
      status: 200,
      d1: 2,
      durableObject: 0,
      r2: 0,
    });
  });

  it("segments never touch D1 or a Durable Object (stateless token)", () => {
    expect(table["GET segment (Range), cold isolate"]).toMatchObject({
      status: 206,
      d1: 0,
      durableObject: 0,
    });
    expect(table["GET segment (Range), cold isolate"]?.r2).toBeLessThanOrEqual(2);
    expect(table["GET segment (Range)"]).toMatchObject({
      status: 206,
      d1: 0,
      durableObject: 0,
      r2: 1,
    });
  });

  it("playlists check the stream slot: one D1 read and one Durable Object call", () => {
    expect(table["GET master.m3u8"]).toMatchObject({ status: 200, d1: 1, durableObject: 1, r2: 1 });
  });

  it("starting playback and heartbeats stay a handful of calls", () => {
    const start = table["POST /api/v1/playback/sessions"];
    expect(start?.status).toBe(201);
    expect(
      (start?.d1 ?? 99) + (start?.durableObject ?? 99) + (start?.queue ?? 99),
    ).toBeLessThanOrEqual(8);
    const heartbeat = table["POST heartbeat"];
    expect(heartbeat).toMatchObject({ status: 200, durableObject: 1 });
    expect(heartbeat?.d1).toBeLessThanOrEqual(3);
  });

  it("the session stays a few D1 reads (experiment assignments are memoised)", () => {
    expect(table["GET /api/v1/session"]).toMatchObject({
      status: 200,
      durableObject: 0,
      r2: 0,
      queue: 0,
    });
    expect(table["GET /api/v1/session"]?.d1).toBeLessThanOrEqual(3);
  });

  it("an event batch is two rate limits and one queue message; the lake is the consumer's", () => {
    const events = table["POST /api/v1/events"];
    expect(events).toMatchObject({ status: 202, durableObject: 2, queue: 1, r2: 0 });
    expect(events?.d1).toBeLessThanOrEqual(4);
  });

  it("the member pages and the console's reads stay a few D1 queries, nothing else", () => {
    const pinned: [string, number][] = [
      ["GET /api/v1/billing/checkout (open)", 2],
      ["GET /api/v1/account (next invoice)", 3],
      ["GET /api/v1/privacy/requests (terms)", 2],
      ["GET /api/admin/v1/members?q=", 4],
      // The audit entry is written before the data is read and settled after (docs/BACKEND.md),
      // and a member's record reads every area's part: not a hot path, a staff click.
      ["GET /api/admin/v1/members/:id", 8],
    ];
    for (const [route, d1] of pinned) {
      expect(table[route], route).toMatchObject({ status: 200, durableObject: 0, r2: 0, queue: 0 });
      expect(table[route]?.d1, route).toBeLessThanOrEqual(d1);
    }
  });

  it("checkout: polling one is one rate-limit call, starting one at most two Durable Object calls", () => {
    expect(table["GET /api/v1/billing/checkout/:id"]).toMatchObject({
      status: 200,
      durableObject: 1,
      r2: 0,
      queue: 0,
    });
    expect(table["GET /api/v1/billing/checkout/:id"]?.d1).toBeLessThanOrEqual(2);
    for (const route of [
      "POST /api/v1/billing/checkout (first)",
      "POST /api/v1/billing/checkout",
    ]) {
      expect(table[route], route).toMatchObject({ status: 201, r2: 0 });
      expect(table[route]?.durableObject, route).toBeLessThanOrEqual(2);
      expect(table[route]?.queue, route).toBeLessThanOrEqual(1);
      // Most of these are the fake provider's own state in D1 (customer, setup, the first
      // invoice's estimate; with Stripe they are subrequests instead); the first of an isolate
      // also syncs the catalogue. Bounded so a regression shows; Workers Paid allows 1,000.
      expect(table[route]?.d1, route).toBeLessThanOrEqual(64);
    }
  });

  it("sign-in is one rate-limit call plus a few D1 queries", () => {
    expect(table["POST /api/v1/auth/login"]).toMatchObject({ status: 200, durableObject: 1 });
    expect(table["POST /api/v1/auth/login"]?.d1).toBeLessThanOrEqual(4);
  });

  it("a password reset that signs this device in costs what sign-in does", () => {
    // The live token, the reset with its new session in one batch, the session bootstrap, the
    // membership; one Durable Object call frees the account's streams, one message alerts.
    expect(table["POST /api/v1/auth/password-reset/confirm"]).toMatchObject({
      status: 200,
      durableObject: 1,
      queue: 1,
    });
    expect(table["POST /api/v1/auth/password-reset/confirm"]?.d1).toBeLessThanOrEqual(4);
  });
});
