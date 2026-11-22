/**
 * The k8s composition with two API "replicas" in one process: separate runtimes (separate
 * Valkey connections, caches and HTTP apps) sharing one database, one Valkey and one S3
 * bucket, exactly like two pods. What one replica decides, the other must see at once: stream
 * limits, revocations, rate limits.
 *
 * Needs WEBFLIX_TEST_VALKEY_URL and WEBFLIX_TEST_S3_*:
 *   pnpm --filter @webflix/api test:services
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, createRouteClient, MOCK_CARDS, routes } from "@webflix/contracts";
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

const env = {
  valkey: process.env.WEBFLIX_TEST_VALKEY_URL,
  s3: process.env.WEBFLIX_TEST_S3_ENDPOINT,
};

function replicaConfig(databaseUrl: string, prefix: string) {
  return loadApiConfig({
    WEBFLIX_MODE: "k8s",
    WEBFLIX_DATABASE_URL: databaseUrl,
    WEBFLIX_VALKEY_URL: env.valkey,
    WEBFLIX_VALKEY_KEY_PREFIX: prefix,
    WEBFLIX_BLOB_STORE: "s3",
    WEBFLIX_S3_ENDPOINT: env.s3,
    WEBFLIX_S3_REGION: process.env.WEBFLIX_TEST_S3_REGION,
    WEBFLIX_S3_BUCKET: process.env.WEBFLIX_TEST_S3_BUCKET,
    WEBFLIX_S3_ACCESS_KEY_ID: process.env.WEBFLIX_TEST_S3_ACCESS_KEY_ID,
    WEBFLIX_S3_SECRET_ACCESS_KEY: process.env.WEBFLIX_TEST_S3_SECRET_ACCESS_KEY,
    WEBFLIX_RATE_LIMIT_AUTH: "4/60",
    WEBFLIX_PASSWORD_HASHER: "pbkdf2",
    WEBFLIX_LOG_LEVEL: "error",
    WEBFLIX_PUBLIC_ORIGIN: "http://localhost:8080",
  });
}

/** A browser: its own cookie jar, talking to whichever replica it is given per request. */
function device(ip: string) {
  const jar = createCookieJar();
  let target: Hono | undefined;
  const fetch = async (url: string, init: RequestInit) => {
    if (!target) throw new Error("no replica selected");
    const headers = new Headers(init.headers);
    if (jar.header()) headers.set("Cookie", jar.header());
    headers.set("X-Forwarded-For", `198.51.100.99, ${ip}`);
    const response = await target.request(url, { ...init, headers });
    jar.store(response);
    return response;
  };
  const api = createRouteClient(routes, { validateResponses: true, fetch });
  return {
    on(app: Hono) {
      target = app;
      return api;
    },
  };
}

const configured = Boolean(env.valkey && env.s3);

describe.skipIf(!configured)("two API replicas sharing Valkey, S3 and the database", () => {
  let dir: string;
  let a: Runtime;
  let b: Runtime;
  let appA: Hono;
  let appB: Hono;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "webflix-replicas-"));
    const url = `sqlite:${join(dir, "webflix.sqlite")}`;
    const prefix = `test:${crypto.randomUUID()}:`;
    a = createRuntime(replicaConfig(url, prefix), "api");
    b = createRuntime(replicaConfig(url, prefix), "api");
    await migrateToLatest(a.infra.database);
    await a.services.seeder.seed({
      catalog: FIXTURE_CATALOG,
      demoAccount: FIXTURE_DEMO_ACCOUNT,
      manifest: FIXTURE_MANIFEST,
    });
    await a.infra.blobs.put("vod/v-pkg/master.m3u8", FIXTURE_MASTER_PLAYLIST);
    appA = createHttpApp(a);
    appB = createHttpApp(b);
  });

  afterAll(async () => {
    await a?.infra.blobs.delete("vod/v-pkg/master.m3u8");
    await a?.close();
    await b?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("is ready once it reached the database and Valkey, and reports both as dependencies", async () => {
    for (const [runtime, app] of [
      [a, appA],
      [b, appB],
    ] as const) {
      await runtime.health?.refresh();
      expect(await (await app.request("/readyz")).json()).toMatchObject({
        status: "ready",
        started: true,
      });
      expect(await (await app.request("/dependencies")).json()).toMatchObject({
        status: "ok",
        dependencies: { database: { status: "up" }, valkey: { status: "up" } },
      });
    }
  });

  it("enforces the stream limit, revocation and sign-out everywhere across replicas", async () => {
    const laptop = device("203.0.113.10");
    const phone = device("203.0.113.11");
    const email = `basic-${crypto.randomUUID()}@example.com`;
    const password = "correct-horse-battery";
    await laptop.on(appA).signup({
      body: {
        email,
        password,
        planId: "basic",
        payment: {
          method: "card",
          cardNumber: MOCK_CARDS.approved,
          expMonth: 12,
          expYear: 2035,
          cvc: "123",
          nameOnCard: "Replica Test",
        },
      },
    });
    const avatarId = (await laptop.on(appA).listAvatars()).groups[0]?.avatars[0]?.id ?? "";
    const { id: profileId } = await laptop
      .on(appA)
      .createProfile({ body: { name: "Replica", avatarId } });
    await laptop.on(appA).selectProfile({ body: { profileId } });
    await phone.on(appB).login({ body: { email, password } });
    await phone.on(appB).selectProfile({ body: { profileId } });

    // Basic = one screen. The laptop plays through replica A ...
    const playing = await laptop.on(appA).createPlaybackSession({ body: { titleId: "t-orbit" } });
    // ... so the phone is refused by replica B, which sees A's lease.
    const refused = await phone
      .on(appB)
      .createPlaybackSession({ body: { titleId: "t-orbit" } })
      .catch((error: unknown) => error);
    expect(ApiError.is(refused, "stream_limit_reached")).toBe(true);
    if (ApiError.is(refused, "stream_limit_reached")) {
      expect(refused.problem.activeStreams).toHaveLength(1);
    }

    // Heartbeats renew the lease whichever replica they land on.
    await laptop.on(appB).sendHeartbeat({
      params: { id: playing.id },
      body: { positionSec: 30, durationSec: 5400, state: "playing" },
    });

    // Sign out of all devices on replica B: replica A ends the laptop's stream at once.
    await phone.on(appB).logoutAll();
    const ended = await laptop
      .on(appA)
      .sendHeartbeat({
        params: { id: playing.id },
        body: { positionSec: 60, durationSec: 5400, state: "playing" },
      })
      .catch((error: unknown) => error);
    expect(
      ApiError.is(ended, "unauthenticated") || ApiError.is(ended, "playback_session_ended"),
    ).toBe(true);
    expect(await a.services.state.catalog.get()).toBeDefined();
  });

  it("counts sign-in attempts per client IP across replicas, from the trusted hop only", async () => {
    const attacker = device("203.0.113.66");
    const statuses: string[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const app = attempt % 2 === 0 ? appA : appB;
      const outcome = await attacker
        .on(app)
        .login({ body: { email: "nobody@example.com", password: "wrong-password" } })
        .catch((error: unknown) => error);
      statuses.push(ApiError.is(outcome) ? outcome.code : "ok");
    }
    // Limit 4/60 (WEBFLIX_RATE_LIMIT_AUTH): four wrong passwords, then 429 on either replica,
    // although each request also carried a client-chosen (spoofed) first X-Forwarded-For hop.
    expect(statuses).toEqual([
      "invalid_credentials",
      "invalid_credentials",
      "invalid_credentials",
      "invalid_credentials",
      "rate_limited",
      "rate_limited",
    ]);
  });

  it("seeds from a manifest stored in the bucket, and without one when it is absent", async () => {
    const key = `manifests/test-${crypto.randomUUID()}.json`;
    await a.infra.blobs.put(key, JSON.stringify(FIXTURE_MANIFEST));
    try {
      const present = await loadSeedInput(a.config, {
        manifestPath: `blob:${key}`,
        blobs: a.infra.blobs,
      });
      expect(present.manifestPath).toBe(`blob:${key}`);
      expect(present.manifest?.videoAssets.length).toBe(FIXTURE_MANIFEST.videoAssets.length);
      const absent = await loadSeedInput(a.config, {
        manifestPath: "blob:manifests/missing.json",
        blobs: a.infra.blobs,
      });
      expect(absent).toMatchObject({ manifest: null, manifestPath: null });
    } finally {
      await a.infra.blobs.delete(key);
    }
  });
});
