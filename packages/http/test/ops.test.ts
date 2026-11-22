/** Ops endpoints, cross-cutting headers, metrics and the API reference. */
import { adminRoutes, routes } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { createMetricsRegistry } from "../src/index.ts";
import { createTestApp } from "./support.ts";

describe("health and readiness", () => {
  it("separates liveness from readiness", async () => {
    let draining = false;
    let databaseUp = true;
    const t = await createTestApp({
      container: {
        readiness: [
          {
            name: "database",
            check: async () => {
              if (!databaseUp) throw new Error("connection refused");
            },
          },
        ],
        isShuttingDown: () => draining,
      },
    });
    expect(await (await t.request("/healthz")).json()).toEqual({ status: "ok" });
    const ready = await t.request("/readyz");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ready", checks: { database: "ok" } });

    databaseUp = false;
    const failing = await t.request("/readyz");
    expect(failing.status).toBe(503);
    expect(await failing.json()).toEqual({
      status: "unavailable",
      checks: { database: "failing" },
    });
    expect((await t.request("/healthz")).status).toBe(200);

    databaseUp = true;
    draining = true;
    expect((await t.request("/readyz")).status).toBe(503);
  });
});

describe("cross-cutting headers", () => {
  it("echoes valid request ids and generates the rest", async () => {
    const t = await createTestApp();
    const echoed = await t.request("/api/v1/session", {
      headers: { "X-Request-Id": "req-123.abc" },
    });
    expect(echoed.headers.get("X-Request-Id")).toBe("req-123.abc");
    const generated = await t.request("/api/v1/session", {
      headers: { "X-Request-Id": "bad id!" },
    });
    expect(generated.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
    const problem = await t.request("/api/v1/nope", { headers: { "X-Request-Id": "req-404" } });
    expect(await problem.json()).toMatchObject({ code: "not_found", requestId: "req-404" });
  });

  it("sets security and caching headers on API responses", async () => {
    const t = await createTestApp();
    const response = await t.request("/api/v1/plans");
    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-frame-options": "DENY",
      "cross-origin-opener-policy": "same-origin",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "cache-control": "no-store",
    });
    expect(response.headers.get("Vary")).toContain("Cookie");
    expect(response.headers.get("Strict-Transport-Security")).toBeNull();
  });

  it("marks cookies Secure and sends HSTS behind https", async () => {
    const t = await createTestApp({ config: { WEBFLIX_PUBLIC_ORIGIN: "https://webflix.example" } });
    const device = t.device();
    await device.api.login({ body: { email: "demo@webflix.dev", password: "webflix-demo" } });
    expect(device.setCookies.at(-1)).toMatch(/^__Host-webflix_session=.*Secure/);
    const response = await t.request("/api/v1/plans");
    expect(response.headers.get("Strict-Transport-Security")).toMatch(/max-age=/);
  });
});

describe("metrics", () => {
  it("records requests by route pattern, never by raw path", async () => {
    const metrics = createMetricsRegistry();
    const t = await createTestApp({ container: { metrics } });
    await t.request("/api/v1/plans");
    await t.request("/api/v1/titles/t-orbit");
    await t.request("/media/secret-token-value/vod/v-pkg/master.m3u8");
    const response = await t.request("/metrics");
    expect(response.headers.get("Content-Type")).toContain("text/plain; version=0.0.4");
    const text = await response.text();
    expect(text).toContain("# TYPE webflix_http_requests_total counter");
    expect(text).toContain(
      'webflix_http_requests_total{method="GET",route="/api/v1/plans",status="200"} 1',
    );
    expect(text).toContain('route="/api/v1/titles/:id",status="401"');
    expect(text).toContain(
      'webflix_http_request_duration_seconds_bucket{method="GET",route="/api/v1/plans",le="+Inf"} 1',
    );
    expect(text).not.toContain("secret-token-value");
  });

  it("is absent without a registry", async () => {
    const t = await createTestApp();
    expect((await t.request("/metrics")).status).toBe(404);
  });

  it("renders gauges and escapes label values", () => {
    const registry = createMetricsRegistry();
    registry.gauge("process_up", "Up.", () => 1);
    registry.counter("things_total", "Things.", ["kind"]).inc({ kind: 'a"b\\c\nd' }, 2);
    expect(registry.render()).toContain('things_total{kind="a\\"b\\\\c\\nd"} 2');
    expect(registry.render()).toContain("process_up 1");
    expect(registry.counter("things_total", "Things.", ["kind"])).toBeDefined();
    expect(() => registry.gauge("things_total", "clash")).toThrow(/already a counter/);
  });
});

describe("API description", () => {
  it("serves the OpenAPI document for the whole route table", async () => {
    const t = await createTestApp();
    const document = await (await t.request("/api/openapi.json")).json();
    expect(document.openapi).toBe("3.1.1");
    const operations = Object.values(document.paths as Record<string, object>).flatMap((path) =>
      Object.keys(path),
    );
    // The member API and the staff API.
    expect(operations).toHaveLength(Object.keys(routes).length + Object.keys(adminRoutes).length);
    expect(document.components.securitySchemes.sessionCookie.name).toBe("webflix_session");
    // Only a route registered but not implemented yet is marked pending (none is left since the
    // admin area's wave: milestone2.test.ts checks the mark on a probe route).
    expect(document.paths["/api/admin/v1/plans"].get).not.toHaveProperty(
      "x-webflix-implementation",
    );
    expect(document.paths["/api/v1/billing/config"].get).not.toHaveProperty(
      "x-webflix-implementation",
    );
    expect(document.paths["/api/v1/account"].get).not.toHaveProperty("x-webflix-implementation");
  });

  it("renders the docs UI from same-origin resources only, under a strict CSP", async () => {
    const t = await createTestApp({
      container: {
        docs: {
          scriptUrl: "/api/docs/scalar.js",
          serveScript: async () =>
            new Response("window.Scalar = {};", { headers: { "Content-Type": "text/javascript" } }),
        },
      },
    });
    const response = await t.request("/api/docs");
    expect(response.status).toBe(200);
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1] ?? "";
    expect(nonce).not.toBe("");
    expect(csp).toContain("connect-src 'self'");
    const html = await response.text();
    expect(html).toContain('src="/api/docs/scalar.js"');
    expect(html).toContain(`nonce="${nonce}"`);
    expect(html).toContain("/api/openapi.json");
    expect(html).not.toMatch(/https?:\/\//);
    const script = await t.request("/api/docs/scalar.js");
    expect(await script.text()).toBe("window.Scalar = {};");
  });

  it("serves a docs page whose every source its own policy allows, without eval", async () => {
    const t = await createTestApp({
      container: {
        docs: {
          scriptUrl: "/api/docs/scalar.js",
          serveScript: async () =>
            new Response("window.Scalar = {};", { headers: { "Content-Type": "text/javascript" } }),
        },
      },
    });
    const response = await t.request("/api/docs");
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    const directives = new Map(
      csp.split(";").map((directive) => {
        const [name = "", ...sources] = directive.trim().split(/\s+/);
        return [name, sources] as const;
      }),
    );
    const scriptSources = directives.get("script-src") ?? [];
    const nonce = scriptSources.find((source) => source.startsWith("'nonce-"))?.slice(7, -1);
    expect(nonce).toBeTruthy();
    // Nothing may be evaluated; no wildcard or third-party origin anywhere.
    expect(csp).not.toMatch(/'unsafe-eval'|'wasm-unsafe-eval'|\*|https?:/);
    expect(scriptSources).not.toContain("'unsafe-inline'");
    const html = await response.text();
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((match) => match[1] ?? "");
    expect(scripts.length).toBeGreaterThanOrEqual(3);
    for (const attributes of scripts) {
      // Every script, inline or not, carries the nonce; external ones are same-origin paths.
      expect(attributes).toContain(`nonce="${nonce}"`);
      const src = /\bsrc="([^"]*)"/.exec(attributes)?.[1];
      if (src !== undefined) expect(src).toMatch(/^\/(?!\/)/);
    }
    // zod in the bundle is told not to probe for eval before the bundle runs.
    const config = html.indexOf("__zod_globalConfig = { jitless: true }");
    expect(config).toBeGreaterThan(-1);
    expect(config).toBeLessThan(html.indexOf('src="/api/docs/scalar.js"'));
    // No inline event handlers or javascript: URLs (a nonce does not cover them).
    expect(html).not.toMatch(/\son[a-z]+\s*=|javascript:/i);
    for (const [, href] of html.matchAll(/<link\b[^>]*\bhref="([^"]*)"/g)) {
      expect(href).toMatch(/^\/(?!\/)/);
    }
    // Every other response keeps the strict API policy.
    const api = await t.request("/api/openapi.json");
    expect(api.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
  });

  it("explains a missing docs bundle", async () => {
    const t = await createTestApp();
    const script = await t.request("/api/docs/scalar.js");
    expect(script.status).toBe(404);
    expect((await script.json()).detail).toContain("@scalar/api-reference");
  });
});
