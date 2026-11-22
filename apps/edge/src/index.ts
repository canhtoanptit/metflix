/**
 * Webflix on Cloudflare: one Worker, four entry points.
 *
 * - `fetch` (default entrypoint, never cached): the HTTP app from `@webflix/http`, identical to
 *   the Node modes, for `/api`, `/media`, `/cdn` and the health endpoints (wrangler.jsonc
 *   `run_worker_first`). Files of the SPA are served by the asset layer; requests that match
 *   no file come here too and are answered by `spa.ts` (shell for client routes, 404 for
 *   missing files).
 * - `MediaOrigin` (named entrypoint, cache-enabled): token-free blob reads behind the Workers
 *   edge cache. Reachable only through `ctx.exports` from the gateway after it has authorised
 *   the request; it is not routable from the internet.
 * - `queue`: the Queues consumer driving the job processor (stats rollups, cleanup).
 * - `scheduled`: the Cron Trigger publishing periodic jobs.
 *
 * Durable Objects: `RateLimiterObject` (one per policy and client key) and `StreamGateObject`
 * (one per account).
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { createR2BlobStore, serveBlobOrigin } from "@webflix/adapters-cloudflare";
import { createProblem } from "@webflix/contracts";
import { ConfigError, serializeError } from "@webflix/core";
import { problemResponse } from "@webflix/http";
import { handleBillingRequest } from "./areas/billing.ts";
import { handleIdentityRequest } from "./areas/identity.ts";
import type { Env } from "./env.ts";
import { getRuntime, type Runtime } from "./runtime.ts";
import { routeRequest, serveShell } from "./spa.ts";

export { RateLimiterObject, StreamGateObject } from "@webflix/adapters-cloudflare";
export type { Env } from "./env.ts";

/**
 * Edge-cache lifetime of a media or artwork object at its generation-scoped internal URL.
 * Content there only changes together with the generation, so this is a safety net, not a
 * freshness bound.
 */
const MEDIA_EDGE_CACHE_CONTROL = "public, max-age=604800";

export class MediaOrigin extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    // Only R2 is needed here: no config, services or app are built for an origin request.
    return serveBlobOrigin(createR2BlobStore(this.env.MEDIA), request, {
      cacheControl: MEDIA_EDGE_CACHE_CONTROL,
      cacheTag: "webflix-media",
    });
  }
}

/**
 * The runtime, or the reason it cannot be composed. A `ConfigError` (invalid vars, or
 * `createApp` refusing a rate-limit table that lacks a policy the routes name) is logged as one
 * `config.invalid` line listing every problem, whichever handler hit it first.
 */
function compose(
  env: Env,
  handler: "fetch" | "queue" | "scheduled",
  build: (env: Env) => Runtime,
): Runtime | ConfigError {
  try {
    return build(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(
      JSON.stringify({
        level: "error",
        msg: "config.invalid",
        service: "webflix-edge",
        handler,
        detail: "the Worker cannot be composed; fix the vars or secrets listed in issues",
        issues: error.issues,
      }),
    );
    return error;
  }
}

/** A misconfigured deploy answers 503 with a pointer to the logs, which list every problem. */
function configFailure(): Response {
  return problemResponse(
    createProblem("service_unavailable", {
      detail: "The deployment's configuration is invalid; see the Worker logs (config.invalid).",
    }),
  );
}

/** The gateway, with the runtime factory injectable for tests (defaults to the isolate's). */
export async function handleFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  build: (env: Env) => Runtime = getRuntime,
): Promise<Response> {
  // Client-side routes the asset layer had no file for: the SPA shell, no app needed.
  if (routeRequest(request) === "shell") return serveShell(request, env.ASSETS);
  const runtime = compose(env, "fetch", build);
  if (runtime instanceof ConfigError) return configFailure();
  // Milestone 2: the development issuer (`/dev-idp/*`, never in production), ahead of the app
  // so its pages keep their own headers.
  const issuer = handleIdentityRequest(request, env, runtime.config.core);
  if (issuer !== null) return issuer;
  // Milestone 2: the fake payment provider's form (`/_pay/*`, never in production).
  const payment = await handleBillingRequest(request, env, runtime.config);
  if (payment) return payment;
  return serveApp(request, env, ctx, runtime);
}

async function serveApp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  runtime: Runtime,
): Promise<Response> {
  const response = await runtime.app.fetch(request, env, ctx);
  // Nothing the gateway answers may be stored by a shared cache unless it says so: the
  // session cookie is not part of any edge cache key.
  if (!response.headers.has("Cache-Control")) {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return response;
}

export default {
  fetch: (request, env, ctx) => handleFetch(request, env, ctx),

  async queue(batch, env) {
    const runtime = compose(env, "queue", getRuntime);
    // Thrown: Queues retries the batch (and dead-letters it) instead of losing the jobs.
    if (runtime instanceof ConfigError) throw runtime;
    await runtime.consume(batch);
  },

  async scheduled(controller, env, ctx) {
    const runtime = compose(env, "scheduled", getRuntime);
    if (runtime instanceof ConfigError) throw runtime;
    ctx.waitUntil(
      runtime.services.scheduler.tick().then(
        () => runtime.logger.info("scheduler.ticked", { cron: controller.cron }),
        (error: unknown) => {
          runtime.logger.error("scheduler.tick_failed", { error: serializeError(error) });
          throw error;
        },
      ),
    );
  },
} satisfies ExportedHandler<Env>;
