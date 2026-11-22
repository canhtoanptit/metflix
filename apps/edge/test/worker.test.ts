/**
 * The real Worker inside workerd, with the bindings of wrangler.jsonc (D1 migrated with the
 * generated SQL files, KV, R2, both Durable Objects, Queues, static assets): every request
 * goes through `SELF`, i.e. the asset router, the gateway, the cached media origin and the
 * Durable Objects exactly as `wrangler dev` runs them.
 */
import {
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { createRouteClient, routes } from "@webflix/contracts";
import { ConfigError } from "@webflix/core";
import {
  FIXTURE_CATALOG,
  FIXTURE_DEMO_ACCOUNT,
  FIXTURE_MANIFEST,
  FIXTURE_MASTER_PLAYLIST,
} from "@webflix/core/testing";
import { beforeAll, describe, expect, it } from "vitest";
import worker, { handleFetch } from "../src/index.ts";
import { MEDIA_GENERATION_KEY } from "../src/media-generation.ts";
import { getRuntime } from "../src/runtime.ts";

const BASE = "http://localhost:8787";
const CLIENT = { "X-Webflix-Client": "web" };
const SEGMENT = new Uint8Array(4096).map((_, index) => index % 251);

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const media = env.MEDIA;
  await media.put("vod/v-pkg/master.m3u8", FIXTURE_MASTER_PLAYLIST);
  await media.put("vod/v-pkg/720p/index.m3u8", "#EXTM3U\n#EXTINF:4,\nseg-1.m4s\n");
  await media.put("vod/v-pkg/720p/seg-1.m4s", SEGMENT);
  await media.put("public/img/avatars/a-test.webp", new Uint8Array([1, 2, 3, 4]), {
    httpMetadata: { contentType: "image/webp" },
  });
  await env.CACHE.put(MEDIA_GENERATION_KEY, "test-gen");
  await getRuntime(env).services.seeder.seed({
    catalog: FIXTURE_CATALOG,
    demoAccount: FIXTURE_DEMO_ACCOUNT,
    manifest: FIXTURE_MANIFEST,
  });
});

/** A typed API client with its own cookie jar and client address, through the whole Worker. */
/** Cookies by name, as a browser keeps them (the API sets more than one). */
function cookieJar() {
  const jar = new Map<string, string>();
  return {
    header: () => [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
    store(response: Response) {
      for (const line of response.headers.getSetCookie()) {
        const [pair = ""] = line.split(";");
        const separator = pair.indexOf("=");
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        if (/max-age=0|expires=thu, 01 jan 1970/i.test(line) || value === "") jar.delete(name);
        else jar.set(name, value);
      }
    },
  };
}

function device(ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`) {
  const jar = cookieJar();
  const cookie = () => jar.header();
  const api = createRouteClient(routes, {
    baseUrl: BASE,
    validateResponses: true,
    headers: () => {
      const headers = new Headers({ "CF-Connecting-IP": ip });
      if (cookie()) headers.set("Cookie", cookie());
      return headers;
    },
    fetch: async (url, init) => {
      const response = await SELF.fetch(url, init);
      jar.store(response);
      return response;
    },
  });
  return { api, cookie, ip };
}

const SIGNUP = (email: string) => ({ email, password: "correct horse battery" });

/**
 * A member the one way there is (§5.1): a checkout, the card confirmed at the fake provider in
 * the Worker (a card of its own: it gets the trial, nothing is left to pay).
 */
async function becomeMember(
  api: ReturnType<typeof device>["api"],
  planId: "basic" | "standard" | "premium",
): Promise<void> {
  const started = await api.startCheckout({ body: { planId } });
  const confirmed = await SELF.fetch(new URL("/_pay/api/confirm", BASE), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientSecret: started.clientSecret,
      card: `visa:edge-${crypto.randomUUID().slice(0, 8)}`,
    }),
  });
  expect(confirmed.status).toBe(200);
  expect((await api.confirmCheckout({ params: { id: started.id } })).status).toBe("complete");
}

describe("the Worker on Cloudflare bindings", () => {
  it("serves a viewer's journey: browse, search, playback from R2 with ranges, heartbeats", async () => {
    const { api, cookie } = device();
    await api.login({ body: { email: FIXTURE_DEMO_ACCOUNT.email, password: "webflix-demo" } });
    await api.selectProfile({ body: { profileId: "pr-demo" } });
    const home = await api.getBrowse();
    expect(home.rows.length).toBeGreaterThanOrEqual(6);
    expect((await api.search({ query: { q: "kest" } })).results[0]?.id).toBe("t-kestrel");

    const session = await api.createPlaybackSession({ body: { titleId: "t-orbit" } });
    const master = await SELF.fetch(new URL(session.manifestUrl, BASE), {
      headers: { Cookie: cookie() },
    });
    expect(master.status).toBe(200);
    expect(master.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(await master.text()).toContain("720p/index.m3u8");

    const segmentUrl = new URL(session.manifestUrl.replace("master.m3u8", "720p/seg-1.m4s"), BASE);
    const ranged = await SELF.fetch(segmentUrl, { headers: { Range: "bytes=100-199" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("Content-Range")).toBe("bytes 100-199/4096");
    expect(ranged.headers.get("Cache-Control")).toMatch(/^private, max-age=\d+$/);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(SEGMENT.slice(100, 200));
    const etag = ranged.headers.get("ETag") ?? "";
    const conditional = await SELF.fetch(segmentUrl, { headers: { "If-None-Match": etag } });
    expect(conditional.status).toBe(304);

    await api.sendHeartbeat({
      params: { id: session.id },
      body: { positionSec: 30, durationSec: 5400, state: "playing" },
    });
    expect((await api.getContinueWatching()).items[0]?.title.id).toBe("t-orbit");
    await api.endPlaybackSession({ params: { id: session.id } });
  });

  it("enforces the plan's stream limit across devices and signs out everywhere at once", async () => {
    const email = `edge-${crypto.randomUUID()}@example.com`;
    const phone = device();
    await phone.api.signup({ body: SIGNUP(email) });
    await becomeMember(phone.api, "basic");
    const profile = await phone.api.createProfile({ body: { name: "Me", avatarId: "av-fox" } });
    await phone.api.selectProfile({ body: { profileId: profile.id } });
    const tv = device();
    await tv.api.login({ body: { email, password: "correct horse battery" } });
    await tv.api.selectProfile({ body: { profileId: profile.id } });

    const playing = await phone.api.createPlaybackSession({ body: { titleId: "t-orbit" } });
    const refused = await tv.api
      .createPlaybackSession({ body: { titleId: "t-orbit" } })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ problem: { code: "stream_limit_reached", limit: 1 } });

    await tv.api.logoutAll();
    // Effective immediately on every device: sessions live in D1, slots in the Durable Object.
    expect((await phone.api.getSession()).authenticated).toBe(false);
    const heartbeat = await SELF.fetch(
      new URL(`/api/v1/playback/sessions/${playing.id}/heartbeat`, BASE),
      {
        method: "POST",
        headers: { ...CLIENT, "Content-Type": "application/json", Cookie: phone.cookie() },
        body: JSON.stringify({ positionSec: 1, durationSec: 100, state: "playing" }),
      },
    );
    expect(heartbeat.status).toBe(401);
    // …and the stream slot is free again for any device that signs back in.
    const back = device();
    await back.api.login({ body: { email, password: "correct horse battery" } });
    await back.api.selectProfile({ body: { profileId: profile.id } });
    expect((await back.api.createPlaybackSession({ body: { titleId: "t-orbit" } })).id).toEqual(
      expect.any(String),
    );
  });

  it("rate limits sign-in per client address through the Durable Object", async () => {
    const { api } = device(`203.0.113.${Math.floor(Math.random() * 250) + 1}`);
    const attempts: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      const outcome = await api
        .login({ body: { email: "nobody@example.com", password: "wrong password" } })
        .then(() => "ok")
        .catch((error: { problem?: { code?: string } }) => error.problem?.code ?? "error");
      attempts.push(outcome);
    }
    expect(attempts.slice(0, 10).every((code) => code === "invalid_credentials")).toBe(true);
    expect(attempts[10]).toBe("rate_limited");
  });

  it("serves artwork from R2 with immutable caching for the browser", async () => {
    const response = await SELF.fetch(new URL("/cdn/img/avatars/a-test.webp?v=1", BASE));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("answers token-free, edge-cacheable reads only from the internal media origin", async () => {
    const whole = await exports.MediaOrigin.fetch(
      new Request("https://media-origin.internal/test-gen/vod/v-pkg/720p/seg-1.m4s"),
    );
    expect(whole.status).toBe(200);
    expect(whole.headers.get("Cache-Control")).toBe("public, max-age=604800");
    expect(whole.headers.get("Cache-Tag")).toBe("webflix-media");
    await whole.body?.cancel();
    // The public media path needs a valid token: nothing reaches R2 without one.
    const forged = await SELF.fetch(new URL("/media/forged/vod/v-pkg/720p/seg-1.m4s", BASE));
    expect(forged.status).toBe(403);
  });

  it("answers server-owned paths with problem documents, never the SPA shell", async () => {
    // `SELF` enters at the Worker; the asset router in front of it (run_worker_first) is
    // checked against wrangler.jsonc in test/node and end to end with wrangler dev.
    const navigate = { headers: { "Sec-Fetch-Mode": "navigate", Accept: "text/html" } };
    for (const path of ["/api/v1/nope", "/media/x/vod/y/z.m4s", "/cdn/img/missing.webp"]) {
      const response = await SELF.fetch(new URL(path, BASE), navigate);
      expect(response.headers.get("Content-Type"), path).toBe("application/problem+json");
    }
    const health = await SELF.fetch(new URL("/healthz", BASE), navigate);
    expect(await health.json()).toEqual({ status: "ok" });
  });

  it("answers missing build files with a 404 that nothing caches, never the SPA shell", async () => {
    // What reaches the Worker when the asset layer has no such file (not_found_handling: none).
    const misses: [string, Record<string, string>][] = [
      ["/assets/index-0000dead.js", { "Sec-Fetch-Dest": "script", "Sec-Fetch-Mode": "no-cors" }],
      ["/assets/index-0000dead.js", { "Sec-Fetch-Mode": "navigate" }],
      ["/assets/chunk-0000dead.css", {}],
      ["/favicon-missing.png", { "Sec-Fetch-Dest": "image" }],
      ["/robots.txt", {}],
    ];
    for (const [path, headers] of misses) {
      const response = await worker.fetch(
        new Request(new URL(path, BASE), { headers }),
        env,
        createExecutionContext(),
      );
      expect(response.status, path).toBe(404);
      expect(response.headers.get("Cache-Control"), path).toBe("no-store");
      expect(response.headers.get("Content-Type"), path).toBe("application/problem+json");
      await response.body?.cancel();
    }
  });

  it("answers client-side routes the asset layer has no file for with the SPA shell", async () => {
    for (const [path, headers] of [
      ["/browse/genre/drama", { "Sec-Fetch-Mode": "navigate" }],
      ["/title/t-orbit", {}],
      ["/watch/t-orbit.v2", { "Sec-Fetch-Mode": "navigate" }],
    ] as [string, Record<string, string>][]) {
      const response = await worker.fetch(
        new Request(new URL(path, BASE), { headers }),
        env,
        createExecutionContext(),
      );
      expect(response.status, path).toBe(200);
      expect(response.headers.get("Content-Type"), path).toContain("text/html");
      expect(response.headers.get("Cache-Control") ?? "", path).not.toContain("immutable");
      expect(await response.text(), path).toContain('<div id="root"');
    }
  });

  it("never lets a shared cache store a gateway response without explicit caching headers", async () => {
    const response = await SELF.fetch(new URL("/readyz", BASE));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("queue and cron handlers", () => {
  it("acknowledges processed jobs and retries malformed messages into the dead-letter queue", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const batch = createMessageBatch("webflix-jobs", [
      {
        id: "job-1",
        timestamp: new Date(),
        attempts: 1,
        body: { v: 1, type: "stats.rollup-day", payload: { day } },
      },
      { id: "job-2", timestamp: new Date(), attempts: 1, body: { not: "a job" } },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["job-1"]);
    expect(result.retryMessages.map((message) => message.msgId)).toEqual(["job-2"]);
  });

  it("passes the processor's backoff to Queues as the retry delay", async () => {
    const batch = createMessageBatch("webflix-jobs", [
      {
        id: "job-3",
        timestamp: new Date(),
        attempts: 2,
        body: { v: 1, type: "no.such-job", payload: null },
      },
    ]);
    // Record what the consumer asks Queues for (the test harness keeps only the message id).
    const retries: unknown[] = [];
    for (const message of batch.messages) {
      const retry = message.retry.bind(message);
      message.retry = (options) => {
        retries.push(options);
        retry(options);
      };
    }
    const ctx = createExecutionContext();
    await worker.queue(batch, env);
    const result = await getQueueResult(batch, ctx);
    expect(result.retryMessages.map((message) => message.msgId)).toEqual(["job-3"]);
    // Unknown job types back off exponentially (5 s × 2^(attempt-1)) rather than spin.
    expect(retries).toEqual([{ delaySeconds: 10 }]);
  });

  it("publishes the periodic jobs on the Cron Trigger", async () => {
    const sent: unknown[] = [];
    const spy = {
      ...env,
      JOBS: {
        send: async (body: unknown) => {
          sent.push(body);
        },
        sendBatch: async (messages: { body: unknown }[]) => {
          sent.push(...messages.map((message) => message.body));
        },
      } as unknown as Queue,
    };
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "*/5 * * * *" }), spy, ctx);
    await waitOnExecutionContext(ctx);
    // Every periodic job leaves as a well-formed envelope through the Queues producer.
    const types = sent.map((body) => (body as { v: number; type: string }).type);
    expect(types).toEqual(
      expect.arrayContaining([
        "playback.cleanup",
        "stats.baseline-day",
        "stats.rollup-day",
        "stats.rollup-day",
      ]),
    );
    expect(sent.every((body) => (body as { v?: number }).v === 1)).toBe(true);
  });

  it("hardens the known-device cookie exactly like the session cookie over https", async () => {
    // Cookie flags follow the public origin (https in production), not the request scheme.
    const https = { ...env, WEBFLIX_PUBLIC_ORIGIN: "https://webflix.test" };
    const response = await worker.fetch(
      new Request(new URL("/api/v1/auth/signup", BASE), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webflix-Client": "web",
          "CF-Connecting-IP": `192.0.2.${Math.floor(Math.random() * 250) + 1}`,
        },
        body: JSON.stringify(SIGNUP(`cookie-${crypto.randomUUID()}@example.com`)),
      }),
      https,
      createExecutionContext(),
    );
    expect(response.status).toBe(201);
    const cookies = new Map(
      response.headers.getSetCookie().map((line) => {
        const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
        const name = pair.slice(0, pair.indexOf("="));
        const flags = attributes
          .filter((attribute) => !/^(max-age|expires)=/i.test(attribute))
          .map((attribute) => attribute.toLowerCase())
          .sort();
        return [name, flags] as const;
      }),
    );
    const session = cookies.get("__Host-webflix_session");
    const device = cookies.get("__Host-webflix_device");
    expect(session).toEqual(["httponly", "path=/", "samesite=lax", "secure"]);
    // Same hardening: __Host- prefix (so no Domain), Secure, HttpOnly, SameSite=Lax, Path=/.
    expect(device).toEqual(session);
  });

  it("answers 503 and logs config.invalid when createApp refuses the composition", async () => {
    // What `createApp` throws when a route names a rate-limit policy the config lacks.
    const refusal = new ConfigError([
      'rate limit policy "playback-start" is referenced by POST /playback/sessions but not configured',
    ]);
    const logged: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => {
      logged.push(String(line));
    };
    try {
      const response = await handleFetch(
        new Request(new URL("/api/v1/session", BASE)),
        env,
        createExecutionContext(),
        () => {
          throw refusal;
        },
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("Content-Type")).toBe("application/problem+json");
      expect(((await response.json()) as { code: string }).code).toBe("service_unavailable");
    } finally {
      console.error = original;
    }
    const line = JSON.parse(logged.find((entry) => entry.includes("config.invalid")) ?? "{}");
    expect(line).toMatchObject({ level: "error", msg: "config.invalid", handler: "fetch" });
    expect(line.issues).toEqual(refusal.issues);
  });

  it("answers 503 with a problem document when the deployment is misconfigured", async () => {
    const broken = { ...env, WEBFLIX_MODE: "k8s", WEBFLIX_PASSWORD_ITERATIONS: "10" };
    const response = await worker.fetch(
      new Request(new URL("/api/v1/session", BASE)),
      broken,
      createExecutionContext(),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Content-Type")).toBe("application/problem+json");
  });
});
