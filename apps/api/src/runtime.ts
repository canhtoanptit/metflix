import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { getConnInfo } from "@hono/node-server/conninfo";
import { catalog, demoAccount } from "@webflix/catalog";
import { MediaManifest } from "@webflix/contracts";
import {
  type BlobStore,
  createHmacTokenSigner,
  createJsonLogger,
  createMediaTokens,
  createServices,
  createUuidV7Generator,
  type Logger,
  type SeedInput,
  type Services,
  systemClock,
} from "@webflix/core";
import {
  type AppEnv,
  createApp,
  createMetricsRegistry,
  type MetricsRegistry,
  problemNotFoundHandler,
} from "@webflix/http";
import { type Context, Hono, type NotFoundHandler } from "hono";
import { compress } from "hono/compress";
import { createInfrastructure, type Infrastructure, type RuntimeComponent } from "./adapters.ts";
import { mountBillingRoutes } from "./areas/billing.ts";
import { mountIdentityRoutes } from "./areas/identity.ts";
import { createAreaPorts } from "./areas/index.ts";
import { type ApiConfig, BLOB_MANIFEST_PREFIX } from "./config.ts";
import {
  createHealth,
  type Health,
  refuseOpsPaths,
  registerOpsRoutes,
  retryAfterOn503,
} from "./ops.ts";

export interface Runtime {
  config: ApiConfig;
  logger: Logger;
  infra: Infrastructure;
  services: Services;
  metrics: MetricsRegistry | undefined;
  /** Set by graceful shutdown: /readyz answers 503 so load balancers stop routing here. */
  draining: { value: boolean };
  /** Health monitor of a long-running process (serve, worker); stopped on close. */
  health: Health | undefined;
  close(): Promise<void>;
}

export function createLogger(config: ApiConfig, component: string): Logger {
  return createJsonLogger({
    level: config.core.logLevel,
    bindings: { service: "webflix-api", component, mode: config.core.mode },
  });
}

/** Wire ports into services. No I/O happens until something is called. */
export function createRuntime(config: ApiConfig, component: RuntimeComponent): Runtime {
  const logger = createLogger(config, component);
  const clock = systemClock;
  const ids = createUuidV7Generator({ clock });
  const infra = createInfrastructure(config, { clock, ids, logger, component });
  const services = createServices({
    // Milestone 2's ports, composed per area (src/areas/).
    ...createAreaPorts({
      config,
      clock,
      ids,
      logger,
      blobs: infra.blobs,
      database: infra.database,
      cache: infra.cache,
    }),
    config: config.core,
    repos: infra.repos,
    search: infra.search,
    cache: infra.cache,
    streamGate: infra.streamGate,
    jobs: infra.jobs.queue,
    passwords: infra.passwords,
    mediaTokens: createMediaTokens(
      createHmacTokenSigner({ keys: config.core.media.tokenKeys, clock }),
      clock,
    ),
    clock,
    ids,
    logger,
  });
  const metrics = config.metricsEnabled ? createMetricsRegistry() : undefined;
  if (metrics) registerProcessMetrics(metrics, infra);
  const runtime: Runtime = {
    config,
    logger,
    infra,
    services,
    metrics,
    draining: { value: false },
    health: undefined,
    async close() {
      runtime.health?.stop();
      await infra.close();
    },
  };
  return runtime;
}

/** Node process and database gauges for Prometheus. */
function registerProcessMetrics(metrics: MetricsRegistry, infra: Infrastructure): void {
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  metrics.gauge(
    "process_resident_memory_bytes",
    "Resident memory size in bytes.",
    () => process.memoryUsage().rss,
  );
  metrics.gauge(
    "nodejs_heap_used_bytes",
    "V8 heap used in bytes.",
    () => process.memoryUsage().heapUsed,
  );
  metrics.gauge("process_uptime_seconds", "Process uptime in seconds.", () => process.uptime());
  metrics.gauge("nodejs_eventloop_lag_p99_seconds", "Event loop delay, 99th percentile.", () => {
    const p99 = loop.percentile(99) / 1e9;
    loop.reset();
    return Number.isFinite(p99) ? p99 : 0;
  });
  metrics.gauge(
    "webflix_db_round_trips",
    "Database round trips since start (a batch counts once, like D1 bills).",
    () => infra.database.stats.queries,
  );
  const stats = infra.jobs.stats;
  if (stats) {
    // Scrapes are synchronous: serve the last sample, refreshed in the background.
    let depth: Awaited<ReturnType<typeof stats>> | undefined;
    const refresh = () => {
      stats()
        .then((sample) => {
          depth = sample;
        })
        .catch(() => {
          depth = undefined;
        });
    };
    refresh();
    setInterval(refresh, 15_000).unref();
    metrics.gauge("webflix_jobs", "Jobs by state (shared queue in Valkey).", () =>
      depth
        ? (["stream", "delayed", "pending", "dead"] as const).map((state) => ({
            labels: { state },
            value: depth?.[state] ?? 0,
          }))
        : [],
    );
  }
}

/**
 * Same-origin docs UI: the Scalar bundle is served from our origin, never a CDN. The container
 * image ships it next to the bundled entrypoint; from source it comes from node_modules.
 */
function scalarBundlePath(): string {
  const shipped = fileURLToPath(new URL("./scalar.js", import.meta.url));
  if (existsSync(shipped)) return shipped;
  return fileURLToPath(
    new URL("./browser/standalone.js", import.meta.resolve("@scalar/api-reference")),
  );
}
let scalarBundle: Promise<string> | undefined;

/**
 * The public HTTP app. Ops endpoints are served here only when there is no separate ops
 * listener (dev); otherwise this listener refuses them (see ops.ts).
 */
export function createHttpApp(runtime: Runtime, options: { health?: Health } = {}): Hono {
  const { config } = runtime;
  runtime.health ??= options.health ?? createHealth(runtime);
  const health = runtime.health;
  const app = createApp({
    config: config.core,
    services: runtime.services,
    blobs: runtime.infra.blobs,
    rateLimiter: runtime.infra.rateLimiter,
    clock: systemClock,
    ids: createUuidV7Generator(),
    logger: runtime.logger,
    // Readiness is process-local and served by ops.ts; the app's own /readyz is never reached.
    readiness: [],
    ...(runtime.metrics ? { metrics: runtime.metrics } : {}),
    clientIp: (c: Context) => clientIp(c, config.trustProxy ? config.trustedProxyHops : 0),
    docs: {
      scriptUrl: "/api/docs/scalar.js",
      async serveScript() {
        scalarBundle ??= readFile(scalarBundlePath(), "utf8");
        return new Response(await scalarBundle, {
          headers: {
            "Content-Type": "text/javascript; charset=utf-8",
            "Cache-Control": "public, max-age=86400",
          },
        });
      },
    },
    isShuttingDown: () => runtime.draining.value,
  });
  // Node has no edge in front of it in dev (Workers and most gateways compress for us), so
  // compress JSON here. Media is left alone: byte ranges and already-compressed video.
  const root = new Hono();
  root.use("*", retryAfterOn503());
  if (config.opsPort === null) registerOpsRoutes(root, runtime, health);
  else root.use("*", refuseOpsPaths());
  // Milestone 2: routes an area serves outside the API (the development issuer).
  mountIdentityRoutes(root, config, runtime.logger);
  // Milestone 2: the fake payment provider's form (`/_pay/*`, never in production).
  mountBillingRoutes(root, config, runtime.infra.database);
  root.use("/api/*", compress());
  root.route("/", app as unknown as Hono);
  // Unmatched paths reach the root app, not the mounted one: answer with the same problem
  // document (and request id) instead of Hono's plain-text default.
  root.notFound(
    problemNotFoundHandler({
      requestId: (c) => (c as unknown as Context<AppEnv>).get("requestId"),
    }) as unknown as NotFoundHandler,
  );
  return root;
}

/**
 * Behind the k8s gateway the socket peer is the proxy. Each trusted proxy appends the address
 * it received the request from to `X-Forwarded-For`, so the client is `hops` entries from the
 * right; anything further left was sent by the client and is never trusted (taking the first
 * entry would let anyone pick their own rate-limit bucket).
 */
export function clientIp(c: Context, trustedProxyHops: number): string {
  if (trustedProxyHops > 0) {
    const chain = (c.req.header("X-Forwarded-For") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const client = chain[chain.length - trustedProxyHops] ?? chain[0];
    if (client) return client;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    // app.request() in tests has no socket.
    return "unknown";
  }
}

/**
 * The seed: `@webflix/catalog` plus the media manifest when one was packaged. A manifest path
 * `blob:<key>` is read from the blob store (k8s: uploaded there with the media); when it is
 * not there yet, the catalog is seeded with the external HLS fallback and a later seed (after
 * the upload) picks the media up.
 */
export async function loadSeedInput(
  config: ApiConfig,
  options: { manifestPath?: string | null; demo?: boolean; blobs?: BlobStore } = {},
): Promise<SeedInput & { manifestPath: string | null }> {
  let manifestPath =
    options.manifestPath === undefined ? config.manifestPath : options.manifestPath;
  let manifest: MediaManifest | null = null;
  let text: string | null = null;
  if (manifestPath?.startsWith(BLOB_MANIFEST_PREFIX)) {
    if (!options.blobs) throw new Error(`${manifestPath} needs a blob store`);
    const object = await options.blobs.get(manifestPath.slice(BLOB_MANIFEST_PREFIX.length));
    if (object) text = await new Response(object.body).text();
    else manifestPath = null;
  } else if (manifestPath) {
    text = await readFile(manifestPath, "utf8");
  }
  if (manifestPath && text !== null) {
    const parsed = MediaManifest.safeParse(JSON.parse(text));
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 10)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`);
      throw new Error(`Invalid media manifest ${manifestPath}:\n  - ${issues.join("\n  - ")}`);
    }
    manifest = parsed.data;
  }
  return {
    catalog,
    demoAccount: options.demo === false ? null : demoAccount,
    manifest,
    manifestPath,
  };
}
