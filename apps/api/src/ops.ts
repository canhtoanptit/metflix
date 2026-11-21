/**
 * Operational endpoints and health of the Node processes (serve, worker).
 *
 * Readiness answers one question: should this pod receive traffic, i.e. would replacing or
 * removing *this pod* help? It reflects process-local state only: started (database reached
 * with the schema current, and Valkey reached, at least once since boot), not draining, event
 * loop responsive. Shared dependencies (PostgreSQL, Valkey, the bucket) being down later does
 * not make it unready: every replica would fail together and the gateway would answer 503 for
 * everything, including what still works without them (signed segments, artwork, plans).
 * Requests that need a missing dependency fail fast on their own (503 with Retry-After).
 *
 * Dependencies are still watched, for operators: a background monitor probes each one and
 * exports `webflix_dependency_up{dependency}` and `/dependencies` (detail, 503 when degraded).
 *
 * In k8s these endpoints live on their own listener (`WEBFLIX_OPS_PORT`), which the gateway
 * cannot reach; the public listener refuses them, however the path is spelled.
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createProblem } from "@webflix/contracts";
import { serializeError } from "@webflix/core";
import { migrationProvider } from "@webflix/db";
import { type MetricsRegistry, problemResponse } from "@webflix/http";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import type { Runtime } from "./runtime.ts";

export const OPS_PATHS = ["/healthz", "/readyz", "/metrics", "/dependencies"] as const;
const CHECK_TIMEOUT_MS = 2000;
const MONITOR_INTERVAL_MS = 5000;
/** Event-loop delay (p99 over a monitor interval) beyond which the process is wedged. */
const MAX_EVENT_LOOP_LAG_MS = 5000;

export interface DependencyState {
  status: "up" | "down" | "unknown";
  /** Epoch ms of the last status change. */
  since: number;
  checkedAt: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface Health {
  /** Process-local readiness and why not. */
  readiness(): { ready: boolean; status: string; detail: Record<string, unknown> };
  dependencies(): Record<string, DependencyState>;
  /** Probe everything now (also run every few seconds in the background). */
  refresh(): Promise<void>;
  stop(): void;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Migrations this code knows that the database has not applied (read-only, no lock). */
export async function pendingMigrations(runtime: Runtime): Promise<string[]> {
  const { database } = runtime.infra;
  if (database.dialect === "d1") return [];
  const schema =
    database.dialect === "postgres"
      ? (await sql<{ schema: string }>`SELECT current_schema() AS schema`.execute(database.db))
          .rows[0]?.schema
      : undefined;
  const migrator = new Migrator({
    db: database.db,
    provider: migrationProvider(database.dialect),
    ...(schema ? { migrationTableSchema: schema } : {}),
  });
  const migrations = await migrator.getMigrations();
  return migrations.filter((migration) => !migration.executedAt).map((migration) => migration.name);
}

export function createHealth(runtime: Runtime, options: { blobs?: boolean } = {}): Health {
  const checks: { name: string; required: boolean; run: () => Promise<void> }[] = [
    {
      name: "database",
      required: true,
      run: async () => {
        await runtime.infra.repos.ping();
      },
    },
    ...runtime.infra.readiness
      .filter((check) => check.name !== "database")
      .map((check) => ({ name: check.name, required: true, run: () => check.check() })),
    ...(options.blobs ? [{ name: "blobs", required: false, run: runtime.infra.pingBlobs }] : []),
  ];
  const state: Record<string, DependencyState> = Object.fromEntries(
    checks.map((check) => [
      check.name,
      { status: "unknown", since: Date.now(), checkedAt: null, latencyMs: null, error: null },
    ]),
  );
  let started = false;
  let startupProblem: string | null = "dependencies not checked yet";
  let lagP99Ms = 0;
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();

  async function probe(check: (typeof checks)[number]): Promise<void> {
    const began = performance.now();
    let error: string | null = null;
    try {
      await withTimeout(check.run(), CHECK_TIMEOUT_MS, check.name);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const previous = state[check.name];
    const status = error ? "down" : "up";
    if (previous && previous.status !== status && previous.status !== "unknown") {
      if (status === "up") runtime.logger.info("dependency.up", { dependency: check.name });
      else runtime.logger.warn("dependency.down", { dependency: check.name, error });
    }
    state[check.name] = {
      status,
      since: previous?.status === status ? previous.since : Date.now(),
      checkedAt: Date.now(),
      latencyMs: Math.round(performance.now() - began),
      error,
    };
  }

  async function refresh(): Promise<void> {
    await Promise.all(checks.map(probe));
    const p99 = loop.percentile(99) / 1e6;
    lagP99Ms = Number.isFinite(p99) ? Math.round(p99) : 0;
    loop.reset();
    if (started) return;
    // Startup gate: never take traffic before this process has reached its database with the
    // schema it expects, and Valkey when configured. Latched: later outages do not undo it.
    const down = checks.filter((check) => check.required && state[check.name]?.status !== "up");
    if (down.length > 0) {
      startupProblem = `waiting for ${down.map((check) => check.name).join(", ")}`;
      return;
    }
    try {
      const pending = await withTimeout(pendingMigrations(runtime), CHECK_TIMEOUT_MS, "schema");
      if (pending.length > 0) {
        startupProblem = `migrations pending: ${pending.join(", ")}`;
        return;
      }
    } catch (error) {
      startupProblem = `schema check failed: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    started = true;
    startupProblem = null;
    runtime.logger.info("health.started", { dependencies: Object.keys(state) });
  }

  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    refresh()
      .catch((error: unknown) =>
        runtime.logger.error("health.refresh_failed", { error: serializeError(error) }),
      )
      .finally(() => {
        busy = false;
      });
  }, MONITOR_INTERVAL_MS);
  timer.unref();
  void refresh().catch(() => {});

  if (runtime.metrics) registerHealthMetrics(runtime.metrics, state, () => readiness().ready);

  function readiness() {
    const detail = {
      started,
      draining: runtime.draining.value,
      eventLoopLagP99Ms: lagP99Ms,
      ...(startupProblem ? { waiting: startupProblem } : {}),
    };
    if (runtime.draining.value) return { ready: false, status: "draining", detail };
    if (!started) return { ready: false, status: "starting", detail };
    if (lagP99Ms > MAX_EVENT_LOOP_LAG_MS) return { ready: false, status: "unresponsive", detail };
    return { ready: true, status: "ready", detail };
  }

  return {
    readiness,
    dependencies: () => structuredClone(state),
    refresh,
    stop() {
      clearInterval(timer);
      loop.disable();
    },
  };
}

function registerHealthMetrics(
  metrics: MetricsRegistry,
  state: Record<string, DependencyState>,
  ready: () => boolean,
): void {
  metrics.gauge(
    "webflix_dependency_up",
    "Whether a shared dependency answered its last health probe (1) or not (0).",
    () =>
      Object.entries(state).map(([dependency, entry]) => ({
        labels: { dependency },
        value: entry.status === "up" ? 1 : 0,
      })),
  );
  metrics.gauge(
    "webflix_dependency_probe_seconds",
    "Duration of the last health probe of a shared dependency.",
    () =>
      Object.entries(state).map(([dependency, entry]) => ({
        labels: { dependency },
        value: (entry.latencyMs ?? 0) / 1000,
      })),
  );
  metrics.gauge("webflix_ready", "Process-local readiness (1 ready, 0 not).", () =>
    ready() ? 1 : 0,
  );
}

/** /healthz, /readyz, /dependencies and /metrics. */
export function registerOpsRoutes(app: Hono, runtime: Runtime, health: Health): void {
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", (c) => {
    const { ready, status, detail } = health.readiness();
    return c.json({ status, ...detail }, ready ? 200 : 503);
  });
  app.get("/dependencies", (c) => {
    const dependencies = health.dependencies();
    const degraded = Object.values(dependencies).some((entry) => entry.status !== "up");
    return c.json({ status: degraded ? "degraded" : "ok", dependencies }, degraded ? 503 : 200);
  });
  const metrics = runtime.metrics;
  if (metrics) {
    app.get("/metrics", (c) =>
      c.body(metrics.render(), 200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      }),
    );
  }
}

export function createOpsApp(runtime: Runtime, health: Health): Hono {
  const app = new Hono();
  registerOpsRoutes(app, runtime, health);
  return app;
}

/**
 * The path as a server that decodes and resolves dot segments would route it:
 * `/api/%2e%2e/metrics`, `/x/../readyz/`, `/%6detrics` all become the ops path they reach.
 */
export function canonicalPath(path: string): string {
  let decoded = path;
  for (let round = 0; round < 3; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      break;
    }
    if (next === decoded) break;
    decoded = next;
  }
  const segments: string[] = [];
  for (const segment of decoded.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`.toLowerCase();
}

/** Public listener: ops endpoints do not exist here, whatever the spelling. */
export function refuseOpsPaths(): MiddlewareHandler {
  const ops = new Set<string>(OPS_PATHS);
  return async (c: Context, next) => {
    const raw = new URL(c.req.url).pathname;
    if (ops.has(canonicalPath(raw)) || ops.has(canonicalPath(c.req.path))) {
      return problemResponse(
        createProblem("not_found", {
          detail: "Operational endpoints are not served on this listener",
        }),
      );
    }
    return next();
  };
}

/** A 503 tells clients and gateways when to come back. */
export function retryAfterOn503(seconds = 5): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.res.status === 503 && !c.res.headers.has("Retry-After")) {
      try {
        c.res.headers.set("Retry-After", String(seconds));
      } catch {
        const response = new Response(c.res.body, c.res);
        response.headers.set("Retry-After", String(seconds));
        c.res = response;
      }
    }
  };
}
