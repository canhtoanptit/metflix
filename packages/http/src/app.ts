import { API_BASE_PATH, REQUEST_ID_HEADER, routes } from "@webflix/contracts";
import { assertRateLimitTable } from "@webflix/core";
import { type Context, Hono } from "hono";
import { etag } from "hono/etag";
import { routePath } from "hono/route";
import type { AppContainer, AppEnv } from "./container.ts";
import { createHandlers } from "./handlers.ts";
import { registerMediaRoutes } from "./media.ts";
import { registerOpsRoutes } from "./ops.ts";
import { problemErrorHandler, problemNotFoundHandler } from "./problem.ts";
import { redactPath } from "./redact.ts";
import { bindRoutes } from "./routing.ts";
import { createGuard } from "./session.ts";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const QUIET_PATHS = new Set(["/healthz", "/readyz", "/metrics"]);
/** For JSON and media responses: nothing here is a document that may load anything. */
const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/**
 * The Webflix HTTP application: every route of the contract, media delivery, ops endpoints and
 * the cross-cutting policies (request ids, access logs, metrics, security headers). Web-standard
 * only: the same app is served by `@hono/node-server` (dev, k8s) and by the Worker's `fetch`
 * (cloudflare).
 */
export function createApp(container: AppContainer): Hono<AppEnv> {
  const { logger, config } = container;
  assertRateLimitTable(config.rateLimits);
  const app = new Hono<AppEnv>();
  // The id is set by the first middleware; errors before it (none today) would have none.
  const requestId = (c: Context): string | undefined => c.get("requestId");

  const requests = container.metrics?.counter(
    "webflix_http_requests_total",
    "HTTP requests by method, route pattern and status.",
    ["method", "route", "status"],
  );
  const durations = container.metrics?.histogram(
    "webflix_http_request_duration_seconds",
    "HTTP request latency by method and route pattern.",
    ["method", "route"],
  );

  app.use("*", async (c, next) => {
    const started = performance.now();
    const incoming = c.req.header(REQUEST_ID_HEADER);
    const id = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : container.ids.next();
    c.set("requestId", id);
    await next();

    const path = c.req.path;
    const headers = c.res.headers;
    headers.set(REQUEST_ID_HEADER, id);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
    if (!headers.has("Content-Security-Policy")) headers.set("Content-Security-Policy", API_CSP);
    if (config.cookies.secure) {
      headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    if (path.startsWith(`${API_BASE_PATH}/`)) {
      // API responses depend on the session cookie and must never be stored, except the few
      // that are public by design (the showcase), which say so and do not vary by cookie.
      if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
      if (!headers.get("Cache-Control")?.startsWith("public")) headers.append("Vary", "Cookie");
    }

    const route = routePath(c, -1) || "unmatched";
    const label = route === "/*" || route === "*" ? "unmatched" : redactPath(route);
    const durationSec = (performance.now() - started) / 1000;
    requests?.inc({ method: c.req.method, route: label, status: String(c.res.status) });
    durations?.observe({ method: c.req.method, route: label }, durationSec);
    const fields = {
      method: c.req.method,
      path: redactPath(path),
      route: label,
      status: c.res.status,
      durationMs: Math.round(durationSec * 10_000) / 10,
      requestId: id,
    };
    if (QUIET_PATHS.has(path)) logger.debug("http.request", fields);
    else logger.info("http.request", fields);
  });

  app.onError(problemErrorHandler({ logger, requestId }));
  app.notFound(problemNotFoundHandler({ requestId }));

  // Conditional requests for the public showcase (its handler sets the ETag): 304 when unchanged.
  app.use(`${API_BASE_PATH}${routes.getShowcase.path}`, etag());
  bindRoutes(app, routes, createHandlers(container), {
    guard: createGuard(container),
    validateResponses: config.environment !== "production",
  });
  registerMediaRoutes(app, container);
  registerOpsRoutes(app, container);
  return app;
}
