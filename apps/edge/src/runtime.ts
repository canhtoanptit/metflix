import { exports as loopback } from "cloudflare:workers";
import {
  createDurableObjectRateLimiter,
  createDurableObjectStreamGate,
  createEdgeCachedBlobStore,
  createKvCache,
  createQueueConsumer,
  createQueuesJobQueue,
  createR2BlobStore,
} from "@webflix/adapters-cloudflare";
import {
  createHmacTokenSigner,
  createJsonLogger,
  createMediaTokens,
  createPbkdf2PasswordHasher,
  createServices,
  createUuidV7Generator,
  type Logger,
  type Services,
  systemClock,
} from "@webflix/core";
import { createRepositories, createSqlSearchIndex } from "@webflix/db";
import { createD1Database } from "@webflix/db/d1";
import { createApp } from "@webflix/http";
import { createAreaPorts } from "./areas/index.ts";
import { type EdgeConfig, type Env, JOBS_MAX_ATTEMPTS, loadEdgeConfig } from "./env.ts";
import { mediaGeneration } from "./media-generation.ts";

/**
 * `/readyz` is public and unauthenticated: its database check is shared per isolate for a few
 * seconds (outcome included), so a flood of probes costs at most one D1 query per isolate per
 * window instead of one per request.
 */
const READINESS_MEMO_MS = 5_000;

function memoised(check: () => Promise<void>, ttlMs: number): () => Promise<void> {
  // Settled outcomes only: an in-flight promise shared with another request would tie that
  // request to the first one's lifetime (a cancelled request can leave waiters hanging).
  let last: { at: number; error: unknown | null } | undefined;
  return async () => {
    if (last && Date.now() - last.at < ttlMs) {
      if (last.error !== null) throw last.error;
      return;
    }
    try {
      await check();
      last = { at: Date.now(), error: null };
    } catch (error) {
      last = { at: Date.now(), error };
      throw error;
    }
  };
}

export interface Runtime {
  config: EdgeConfig;
  logger: Logger;
  services: Services;
  app: ReturnType<typeof createApp>;
  /** The `queue()` handler body. */
  consume: (batch: MessageBatch) => Promise<void>;
}

/**
 * Everything is composed once per isolate and reused by every request it serves: config is
 * validated once, the catalog snapshot and popularity stay memoised in memory (30-60 s, then
 * KV), the UUIDv7 generator stays monotonic. Construction does no I/O, so a cold start pays
 * only for module evaluation. Nothing request-scoped is captured here: bindings are
 * isolate-wide handles, and per-request state lives in Hono's context.
 */
const runtimes = new WeakMap<Env, Runtime>();

export function getRuntime(env: Env): Runtime {
  let runtime = runtimes.get(env);
  if (!runtime) {
    runtime = buildRuntime(env);
    runtimes.set(env, runtime);
  }
  return runtime;
}

function buildRuntime(env: Env): Runtime {
  const config = loadEdgeConfig(env);
  const clock = systemClock;
  const ids = createUuidV7Generator({ clock });
  const logger = createJsonLogger({
    level: config.core.logLevel,
    bindings: { service: "webflix-edge", mode: "cloudflare" },
  });
  const database = createD1Database(env.DB);
  const repos = createRepositories(database);
  const cache = createKvCache(env.CACHE);
  const media = createR2BlobStore(env.MEDIA);
  const blobs = config.edgeCache
    ? createEdgeCachedBlobStore({
        origin: loopback.MediaOrigin,
        store: media,
        generation: mediaGeneration(env.CACHE, logger),
        logger,
      })
    : media;

  const services = createServices({
    // Milestone 2's ports, composed per area (src/areas/).
    ...createAreaPorts({ env, config, clock, ids, logger, blobs, database, cache }),
    config: config.core,
    repos,
    search: createSqlSearchIndex(database),
    cache,
    streamGate: createDurableObjectStreamGate(env.STREAMS),
    jobs: createQueuesJobQueue(env.JOBS),
    passwords: createPbkdf2PasswordHasher({ iterations: config.passwordIterations }),
    mediaTokens: createMediaTokens(
      createHmacTokenSigner({ keys: config.core.media.tokenKeys, clock }),
      clock,
    ),
    clock,
    ids,
    logger,
  });

  const app = createApp({
    config: config.core,
    services,
    blobs,
    rateLimiter: createDurableObjectRateLimiter(env.LIMITS),
    clock,
    ids,
    logger: logger.child({ component: "http" }),
    readiness: [{ name: "database", check: memoised(() => repos.ping(), READINESS_MEMO_MS) }],
    // `clientIp` defaults to CF-Connecting-IP, which the edge sets and clients cannot forge.
    docs: {
      // Served by the static-asset layer before the Worker runs (run_worker_first excludes it);
      // this fallback only answers if a request reaches the Worker anyway.
      scriptUrl: "/api/docs/scalar.js",
      serveScript: async () => {
        const response = await env.ASSETS.fetch(
          new Request("https://assets.internal/api/docs/scalar.js"),
        );
        return response.ok ? response : null;
      },
    },
  });

  return {
    config,
    logger,
    services,
    app,
    consume: createQueueConsumer(services.processor, {
      logger: logger.child({ component: "jobs" }),
      maxAttempts: JOBS_MAX_ATTEMPTS,
    }),
  };
}
