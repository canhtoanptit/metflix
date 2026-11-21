#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
/**
 * webflix-api: the Node entrypoint for the dev and k8s modes.
 *
 *   node src/main.ts [serve]        HTTP API (+ in-process jobs when no Valkey is configured)
 *   node src/main.ts worker         job consumer + scheduler (k8s `worker` Deployment)
 *   node src/main.ts migrate        apply database migrations, then exit
 *   node src/main.ts seed [--force] [--manifest <file>|--no-manifest] [--no-demo]
 *   node src/main.ts wait [--skip-migrations] [--blobs] [--timeout <sec>]
 *                                   block until dependencies are usable (k8s init containers)
 *
 * Configuration is environment only (12-factor); see docs/BACKEND.md.
 */
import { type ServerType, serve } from "@hono/node-server";
import { ConfigError, serializeError } from "@webflix/core";
import { migrateToLatest } from "@webflix/db";
import type { Hono } from "hono";
import { type ApiConfig, BLOB_MANIFEST_PREFIX, describeConfig, loadApiConfig } from "./config.ts";
import { createHealth, createOpsApp, pendingMigrations } from "./ops.ts";
import { createHttpApp, createRuntime, loadSeedInput, type Runtime } from "./runtime.ts";

const USAGE = `Usage: webflix-api [serve|worker|migrate|seed|wait] [options]

  serve                 Start the HTTP API (default)
  worker                Consume jobs and run the scheduler
  migrate               Apply pending database migrations
  seed                  Load the catalog, search index, stats and demo account
      --force           Re-apply even if the same seed was already applied
      --manifest <file> Media manifest: a file, or blob:<key> in the blob store
                        (default: WEBFLIX_MEDIA_MANIFEST or .cache/media/*/manifest.json)
      --no-manifest     Seed without packaged media (external HLS fallback)
      --no-demo         Skip the demo account
  wait                  Block until the database is reachable and migrated, and Valkey (if
                        configured) answers; for init containers
      --skip-migrations Only wait for connectivity (before running migrate)
      --blobs           Also wait for the blob store (bucket reachable)
      --timeout <sec>   Give up after this long (default 300)
`;

async function migrate(runtime: Runtime): Promise<void> {
  const { applied, ahead } = await migrateToLatest(runtime.infra.database);
  if (ahead.length > 0) {
    // A rollback: a newer release migrated this database. Its changes are backward compatible
    // with this release by contract (docs/KUBERNETES.md), so this release runs on it as is.
    runtime.logger.warn("db.schema_ahead", {
      ahead,
      detail:
        "The database has migrations from a newer release; running this older release against it (rollback)",
    });
  }
  runtime.logger.info("db.migrated", { applied, dialect: runtime.infra.database.dialect });
}

async function seed(
  runtime: Runtime,
  options: { force?: boolean; manifestPath?: string | null; demo?: boolean } = {},
): Promise<void> {
  const input = await loadSeedInput(runtime.config, { ...options, blobs: runtime.infra.blobs });
  const result = await runtime.services.seeder.seed(input, { force: options.force ?? false });
  runtime.logger.info(result.skipped ? "seed.unchanged" : "seed.done", {
    ...result,
    manifest: input.manifestPath,
  });
}

const ATTEMPT_TIMEOUT_MS = 5000;

/**
 * Block until the dependencies this process needs are usable. Init containers run it so pods
 * start in order (database, then schema, then the app) without crash loops, and say what they
 * are waiting for in their logs.
 */
async function waitForDependencies(
  runtime: Runtime,
  options: { migrations: boolean; blobs: boolean; timeoutSec: number },
): Promise<void> {
  const deadline = Date.now() + options.timeoutSec * 1000;
  let reported = "";
  for (;;) {
    const waiting: string[] = [];
    // Each attempt has its own deadline (never past the overall one): a dependency that
    // accepts connections and never answers must not hold this loop.
    const attempt = async (name: string, check: () => Promise<string | null>) => {
      const budget = Math.max(500, Math.min(ATTEMPT_TIMEOUT_MS, deadline - Date.now()));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const problem = await Promise.race([
          check(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`no answer within ${budget} ms`)), budget);
          }),
        ]);
        if (problem) waiting.push(`${name}: ${problem}`);
      } catch (error) {
        waiting.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        clearTimeout(timer);
      }
    };
    await attempt("database", async () => {
      await runtime.infra.repos.ping();
      if (!options.migrations) return null;
      const pending = await pendingMigrations(runtime);
      return pending.length > 0 ? `migrations pending (${pending.join(", ")})` : null;
    });
    for (const check of runtime.infra.readiness) {
      if (check.name === "database") continue;
      await attempt(check.name, async () => {
        await check.check();
        return null;
      });
    }
    if (options.blobs) {
      await attempt("blobs", async () => {
        await runtime.infra.pingBlobs();
        return null;
      });
    }
    if (waiting.length === 0) {
      runtime.logger.info("wait.ready");
      return;
    }
    const summary = waiting.join("; ");
    if (Date.now() >= deadline) {
      throw new Error(`Dependencies not ready after ${options.timeoutSec}s: ${summary}`);
    }
    if (summary !== reported) runtime.logger.info("wait.waiting", { for: waiting });
    reported = summary;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/** One-shot commands (migrate, seed, wait): exit promptly on SIGTERM rather than linger. */
function exitOnSignal(runtime: Runtime): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      runtime.logger.warn("interrupted", { signal });
      process.exit(signal === "SIGTERM" ? 143 : 130);
    });
  }
}

/** Periodic scheduler ticks (stats rollups, baseline, cleanup). Returns a stop function. */
function startScheduler(runtime: Runtime): () => void {
  const tick = () => {
    runtime.services.scheduler.tick().catch((error: unknown) => {
      runtime.logger.error("scheduler.tick_failed", { error: serializeError(error) });
    });
  };
  tick();
  const timer = setInterval(tick, runtime.config.schedulerIntervalSec * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

function listen(
  app: { fetch: Hono["fetch"] },
  config: ApiConfig,
  runtime: Runtime,
  port: number = config.port,
  role = "public",
): Promise<ServerType> {
  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: app.fetch, port, ...(config.host ? { hostname: config.host } : {}) },
      (info) => {
        runtime.logger.info("server.listening", { role, port: info.port, address: info.address });
        resolve(server);
      },
    );
    // Node closes idle keep-alive connections after 5 s by default, while a gateway keeps its
    // upstream connections for a minute or more: it can then send a request on a connection
    // the server is closing at that instant (a 503 at the gateway). Outlive the proxy instead.
    if ("keepAliveTimeout" in server) {
      server.keepAliveTimeout = config.httpKeepAliveSec * 1000;
      server.headersTimeout = config.httpKeepAliveSec * 1000 + 1000;
    }
    server.once("error", reject);
  });
}

/**
 * Graceful shutdown: fail readiness first (so the k8s endpoint controller and gateway stop
 * routing here), wait `shutdownDelaySec`, stop accepting connections and let in-flight
 * requests finish, then stop background work and close pools. A hard deadline guards it.
 */
function onShutdown(runtime: Runtime, stop: () => Promise<void>): void {
  let stopping = false;
  const handler = (signal: string) => {
    if (stopping) return;
    stopping = true;
    runtime.draining.value = true;
    runtime.logger.info("shutdown.start", { signal, delaySec: runtime.config.shutdownDelaySec });
    const deadline = setTimeout(
      () => {
        runtime.logger.error("shutdown.timeout");
        process.exit(1);
      },
      (runtime.config.shutdownDelaySec + 25) * 1000,
    );
    deadline.unref();
    setTimeout(() => {
      stop()
        .then(() => {
          runtime.logger.info("shutdown.done");
          process.exit(0);
        })
        .catch((error: unknown) => {
          runtime.logger.error("shutdown.failed", { error: serializeError(error) });
          process.exit(1);
        });
    }, runtime.config.shutdownDelaySec * 1000);
  };
  process.once("SIGTERM", () => handler("SIGTERM"));
  process.once("SIGINT", () => handler("SIGINT"));
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // Idle keep-alive sockets would hold close() open until they time out.
    if ("closeIdleConnections" in server) server.closeIdleConnections();
  });
}

async function runServe(config: ApiConfig): Promise<void> {
  const runtime = createRuntime(config, "api");
  runtime.logger.info("config", describeConfig(config));
  if (config.migrateOnStart) await migrate(runtime);
  if (config.seedOnStart) await seed(runtime);
  // Without a shared queue (no Valkey) this process is the only one that can consume what
  // it publishes, so it runs the consumer and the scheduler itself.
  const inProcessJobs = config.valkeyUrl === null;
  let stopScheduler = () => {};
  if (inProcessJobs) {
    runtime.infra.jobs.startConsumer(runtime.services.processor);
    stopScheduler = startScheduler(runtime);
  }
  const health = createHealth(runtime, { blobs: true });
  const server = await listen(createHttpApp(runtime, { health }), config, runtime);
  const opsServer =
    config.opsPort === null
      ? null
      : await listen(createOpsApp(runtime, health), config, runtime, config.opsPort, "ops");
  onShutdown(runtime, async () => {
    await closeServer(server);
    stopScheduler();
    await runtime.infra.jobs.stop();
    if (opsServer) await closeServer(opsServer);
    await runtime.close();
  });
}

async function runWorker(config: ApiConfig): Promise<void> {
  const runtime = createRuntime(config, "worker");
  runtime.logger.info("config", describeConfig(config));
  runtime.infra.jobs.startConsumer(runtime.services.processor);
  const stopScheduler = startScheduler(runtime);
  // Probes and metrics only: the worker has no public listener.
  runtime.health = createHealth(runtime);
  const app = createOpsApp(runtime, runtime.health);
  const server = await listen(app, config, runtime, config.opsPort ?? config.port, "ops");
  onShutdown(runtime, async () => {
    stopScheduler();
    await runtime.infra.jobs.stop();
    await closeServer(server);
    await runtime.close();
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    // `pnpm <script> -- --flag` forwards the `--` literally; it is not an end-of-options marker here.
    args: argv.filter((arg) => arg !== "--"),
    allowPositionals: true,
    options: {
      force: { type: "boolean", default: false },
      manifest: { type: "string" },
      "no-manifest": { type: "boolean", default: false },
      "no-demo": { type: "boolean", default: false },
      "skip-migrations": { type: "boolean", default: false },
      blobs: { type: "boolean", default: false },
      timeout: { type: "string", default: "300" },
      help: { type: "boolean", default: false },
    },
  });
  const command = positionals[0] ?? "serve";
  if (values.help || command === "help") {
    console.log(USAGE);
    return 0;
  }
  const config = loadApiConfig();
  switch (command) {
    case "serve":
      await runServe(config);
      return -1; // keeps running
    case "worker":
      await runWorker(config);
      return -1;
    case "wait": {
      const runtime = createRuntime(config, "wait");
      exitOnSignal(runtime);
      try {
        await waitForDependencies(runtime, {
          migrations: !values["skip-migrations"],
          blobs: values.blobs,
          timeoutSec: Number(values.timeout),
        });
      } finally {
        await runtime.close();
      }
      return 0;
    }
    case "migrate": {
      const runtime = createRuntime(config, "migrate");
      exitOnSignal(runtime);
      try {
        await migrate(runtime);
      } finally {
        await runtime.close();
      }
      return 0;
    }
    case "seed": {
      const runtime = createRuntime(config, "seed");
      exitOnSignal(runtime);
      try {
        if (config.migrateOnStart) await migrate(runtime);
        await seed(runtime, {
          force: values.force,
          manifestPath: values["no-manifest"]
            ? null
            : values.manifest
              ? values.manifest.startsWith(BLOB_MANIFEST_PREFIX)
                ? values.manifest
                : resolve(values.manifest)
              : undefined,
          demo: !values["no-demo"],
        });
      } finally {
        await runtime.close();
      }
      return 0;
    }
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code >= 0) process.exit(code);
    })
    .catch((error: unknown) => {
      if (error instanceof ConfigError) console.error(error.message);
      else
        console.error(
          JSON.stringify({ level: "error", msg: "fatal", error: serializeError(error) }),
        );
      process.exit(1);
    });
}
