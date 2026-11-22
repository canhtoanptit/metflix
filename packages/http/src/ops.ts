import { Scalar } from "@scalar/hono-api-reference";
import { API_DOCS_PATH, OPENAPI_PATH } from "@webflix/contracts";
import { buildOpenApiDocument } from "@webflix/contracts/openapi";
import { AppError, base64Encode, randomBytes, serializeError } from "@webflix/core";
import type { Context, Hono } from "hono";
import type { AppContainer, AppEnv } from "./container.ts";
import { METRICS_CONTENT_TYPE } from "./metrics.ts";

const READINESS_TIMEOUT_MS = 2000;
export const DEFAULT_DOCS_SCRIPT_URL = `${API_DOCS_PATH}/scalar.js`;

/**
 * Runs before the reference bundle: its copy of zod would otherwise probe `Function("")` to
 * decide whether it may compile validators, which this page's CSP (no `'unsafe-eval'`) refuses
 * and the browser reports as a violation. With `jitless` zod never tries, and the policy stays
 * without `'unsafe-eval'`. zod reads this global (`__zod_globalConfig`) when it loads.
 */
const DOCS_ZOD_CONFIG = "globalThis.__zod_globalConfig = { jitless: true };";

/**
 * The docs page loads only same-origin resources; the CSP enforces it in the browser. Scripts
 * need the page's nonce (the bundle and the two inline scripts carry it); styles may be inline
 * (the reference injects its theme at runtime); nothing may be evaluated.
 */
export function docsContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

async function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    // Workers' clearTimeout does not accept undefined.
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function registerOpsRoutes(
  app: Hono<AppEnv>,
  container: AppContainer,
  options: { pending?: ReadonlySet<string> } = {},
): void {
  // Liveness: the process answers. Never depends on downstream services, or an outage there
  // would make the orchestrator restart healthy pods.
  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // Readiness: should this instance receive traffic? False while draining or when a
  // dependency it cannot work without is unreachable.
  app.get("/readyz", async (c) => {
    if (container.isShuttingDown?.()) {
      return c.json({ status: "draining", checks: {} }, 503);
    }
    const results = await Promise.all(
      (container.readiness ?? []).map(async (probe) => {
        try {
          await withTimeout(probe.check(), READINESS_TIMEOUT_MS, probe.name);
          return [probe.name, "ok"] as const;
        } catch (error) {
          container.logger.warn("readiness.check_failed", {
            check: probe.name,
            error: serializeError(error),
          });
          return [probe.name, "failing"] as const;
        }
      }),
    );
    const checks = Object.fromEntries(results);
    const ready = results.every(([, status]) => status === "ok");
    return c.json({ status: ready ? "ready" : "unavailable", checks }, ready ? 200 : 503);
  });

  if (container.metrics) {
    const registry = container.metrics;
    app.get("/metrics", (c) =>
      c.body(registry.render(), 200, { "Content-Type": METRICS_CONTENT_TYPE }),
    );
  }

  let openApi: ReturnType<typeof buildOpenApiDocument> | undefined;
  app.get(OPENAPI_PATH, (c) => {
    // Every API this deployment serves: the member API and the staff API (`/api/admin/v1`).
    openApi ??= buildOpenApiDocument(undefined, {
      sessionCookieName: container.config.cookies.sessionCookieName,
      description:
        "The Webflix HTTP API. Member sessions are cookies and mutations need `X-Webflix-Client: web`; the staff API takes a staff bearer token. Operations marked `x-webflix-implementation: pending` are part of the contract but answer `501 not_implemented` in this deployment.",
      ...(options.pending ? { pending: options.pending } : {}),
    });
    return c.json(openApi);
  });

  const scriptUrl = container.docs?.scriptUrl ?? DEFAULT_DOCS_SCRIPT_URL;
  if (scriptUrl === DEFAULT_DOCS_SCRIPT_URL) {
    app.get(DEFAULT_DOCS_SCRIPT_URL, async () => {
      const response = await container.docs?.serveScript?.();
      // Re-wrapped: a Response from fetch() (e.g. a Workers ASSETS binding) has immutable
      // headers, and the middleware adds security headers to every response.
      if (response) return new Response(response.body, response);
      throw new AppError("not_found", {
        detail:
          "The API reference bundle is not available in this deployment. Serve @scalar/api-reference's standalone bundle and pass it as `docs` to createApp.",
      });
    });
  }

  app.get(API_DOCS_PATH, async (c, next) => {
    const nonce = base64Encode(randomBytes(16));
    c.header("Content-Security-Policy", docsContentSecurityPolicy(nonce));
    const render = Scalar({
      url: OPENAPI_PATH,
      cdn: scriptUrl,
      nonce,
      pageTitle: "Webflix API",
      // Nothing may reach a third-party origin: no hosted fonts, telemetry, request proxy or
      // hosted AI agent.
      withDefaultFonts: false,
      telemetry: false,
      hideClientButton: true,
      showDeveloperTools: "never",
      agent: { disabled: true },
    });
    // Scalar's middleware is typed for the default Hono env; it only renders HTML from `c`.
    const rendered = await render(c as unknown as Context, next);
    if (!rendered) throw new Error("The API reference middleware rendered nothing");
    const html = await rendered.text();
    const bundle = `<script src="${scriptUrl}"`;
    if (!html.includes(bundle)) {
      throw new Error("The API reference page no longer loads its bundle where expected");
    }
    return new Response(
      html.replace(bundle, `<script nonce="${nonce}">${DOCS_ZOD_CONFIG}</script>\n    ${bundle}`),
      rendered,
    );
  });
}
