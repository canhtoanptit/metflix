/**
 * Readiness is process-local (a shared dependency going down never empties the endpoint set),
 * dependencies are reported separately, and with an ops listener the public one refuses the
 * ops endpoints however their path is spelled.
 */

import { migrateToLatest } from "@webflix/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadApiConfig } from "../src/config.ts";
import { canonicalPath, createHealth, createOpsApp, retryAfterOn503 } from "../src/ops.ts";
import { createHttpApp, createRuntime, type Runtime } from "../src/runtime.ts";

function runtimeWith(env: Record<string, string> = {}): Runtime {
  return createRuntime(
    loadApiConfig({
      WEBFLIX_DATABASE_URL: "sqlite::memory:",
      WEBFLIX_BLOB_STORE: "memory",
      WEBFLIX_MEDIA_DIR: "none",
      WEBFLIX_LOG_LEVEL: "error",
      ...env,
    }),
    "api",
  );
}

describe("canonical paths", () => {
  it("decodes and resolves dot segments the way a lenient router would", () => {
    expect(canonicalPath("/api/%2e%2e/metrics")).toBe("/metrics");
    expect(canonicalPath("/api/%2E%2E/%2e%2e/readyz/")).toBe("/readyz");
    expect(canonicalPath("/x/..%2fmetrics")).toBe("/metrics");
    expect(canonicalPath("/%256Detrics")).toBe("/metrics");
    expect(canonicalPath("/a\\..\\healthz")).toBe("/healthz");
    expect(canonicalPath("/METRICS")).toBe("/metrics");
    expect(canonicalPath("/api/v1/plans")).toBe("/api/v1/plans");
  });
});

describe("public listener with a separate ops listener", () => {
  let runtime: Runtime;
  let app: Hono;
  beforeAll(async () => {
    runtime = runtimeWith({ WEBFLIX_OPS_PORT: "4001" });
    await migrateToLatest(runtime.infra.database);
    app = createHttpApp(runtime);
  });
  afterAll(() => runtime.close());

  it.each([
    "/healthz",
    "/readyz",
    "/metrics",
    "/dependencies",
    "/api/%2e%2e/metrics",
    "/api/../metrics",
    "/api/%2E%2E/readyz",
    "/media/..%2f..%2fmetrics",
    "/METRICS/",
  ])("refuses %s", async (path) => {
    const response = await app.request(`http://localhost${path}`);
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("application/problem+json");
    expect(await response.text()).not.toContain("webflix_http_requests_total");
  });

  it("still serves the API", async () => {
    expect((await app.request("/api/v1/plans")).status).toBe(200);
  });

  it("serves the ops endpoints on the ops app", async () => {
    const health = runtime.health;
    if (!health) throw new Error("no health");
    await health.refresh();
    const ops = createOpsApp(runtime, health);
    expect((await ops.request("/healthz")).status).toBe(200);
    expect((await ops.request("/readyz")).status).toBe(200);
    expect(await (await ops.request("/metrics")).text()).toContain("webflix_ready 1");
  });
});

describe("readiness is process-local", () => {
  it("waits for every required dependency once, then ignores their outages", async () => {
    const runtime = runtimeWith();
    await migrateToLatest(runtime.infra.database);
    let valkeyUp = false;
    runtime.infra.readiness.push({
      name: "valkey",
      check: async () => {
        if (!valkeyUp) throw new Error("connection refused");
      },
    });
    const health = createHealth(runtime);
    const ops = createOpsApp(runtime, health);
    try {
      // Never reached Valkey: not ready (a pod that cannot work yet takes no traffic).
      await health.refresh();
      const starting = await ops.request("/readyz");
      expect(starting.status).toBe(503);
      expect(await starting.json()).toMatchObject({
        status: "starting",
        waiting: "waiting for valkey",
      });

      valkeyUp = true;
      await health.refresh();
      expect((await ops.request("/readyz")).status).toBe(200);

      // Valkey goes down for everyone: this pod stays ready, the outage is reported.
      valkeyUp = false;
      await health.refresh();
      expect((await ops.request("/readyz")).status).toBe(200);
      const dependencies = await ops.request("/dependencies");
      expect(dependencies.status).toBe(503);
      expect(await dependencies.json()).toMatchObject({
        status: "degraded",
        dependencies: { valkey: { status: "down", error: "connection refused" } },
      });
      expect(await (await ops.request("/metrics")).text()).toContain(
        'webflix_dependency_up{dependency="valkey"} 0',
      );

      // Draining always wins.
      runtime.draining.value = true;
      expect(await (await ops.request("/readyz")).json()).toMatchObject({ status: "draining" });
    } finally {
      health.stop();
      await runtime.close();
    }
  });
});

describe("503 responses", () => {
  it("carry Retry-After", async () => {
    const app = new Hono();
    app.use("*", retryAfterOn503());
    app.get("/down", (c) => c.json({ code: "service_unavailable" }, 503));
    app.get("/limited", (c) => c.json({}, 503, { "Retry-After": "30" }));
    expect((await app.request("/down")).headers.get("Retry-After")).toBe("5");
    expect((await app.request("/limited")).headers.get("Retry-After")).toBe("30");
  });
});
