import {
  ADMIN_API_BASE_PATH,
  API_DOCS_PATH,
  adminRoutes,
  OPENAPI_PATH,
  REQUEST_ID_HEADER,
  type RouteSpec,
  routes,
  toOpenApiPath,
} from "@webflix/contracts";
import { check, equal, fail, header, problem, status } from "../expect.ts";
import type { HttpResult } from "../http.ts";
import { needs } from "../needs.ts";
import type { CheckContext, CheckDefinition } from "../types.ts";
import { API, CSRF, unique } from "./util.ts";

/** `/healthz` and `/readyz` are internal in k8s routing: absent there is not a failure. */
function notExposed(result: HttpResult): boolean {
  const type = result.headers.get("Content-Type") ?? "";
  return result.status === 404 || type.includes("text/html");
}

function securityHeaders(result: HttpResult, what: string, https: boolean): void {
  header(result, "X-Content-Type-Options", "nosniff", what);
  header(result, "X-Frame-Options", /^deny$/i, what);
  header(
    result,
    "Referrer-Policy",
    (value) => value !== null && value !== "" && value !== "unsafe-url",
    what,
  );
  header(result, "Cross-Origin-Opener-Policy", "same-origin", what);
  header(result, "Cross-Origin-Resource-Policy", "same-origin", what);
  header(result, "Content-Security-Policy", /frame-ancestors 'none'/, what);
  if (https) header(result, "Strict-Transport-Security", /max-age=(\d{8,}|[3-9]\d{7})/, what);
}

/** Navigation headers a browser sends for a typed URL or a link. */
const NAVIGATE = {
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
  Accept: "text/html,application/xhtml+xml",
};

export const opsChecks: CheckDefinition[] = [
  {
    id: "ops.health",
    area: "ops",
    title: "Liveness and readiness probes answer (when exposed)",
    async run(ctx: CheckContext) {
      const agent = ctx.agent("ops");
      const live = await agent.fetch("/healthz");
      if (notExposed(live)) {
        ctx.skip(
          `/healthz is not exposed at this URL (${live.status} ${live.headers.get("Content-Type") ?? ""}); k8s routing keeps probes internal`,
        );
      }
      status(live, 200, "GET /healthz");
      equal(live.json<{ status?: unknown }>().status, "ok", "/healthz status", live.exchange);
      const ready = await agent.fetch("/readyz");
      if (notExposed(ready)) {
        ctx.note("/readyz is not exposed at this URL");
        return;
      }
      status(ready, 200, "GET /readyz");
      equal(ready.json<{ status?: unknown }>().status, "ready", "/readyz status", ready.exchange);
    },
  },
  {
    id: "ops.openapi",
    area: "ops",
    title: "OpenAPI 3.1 document lists every route of the contract",
    async run(ctx: CheckContext) {
      const result = await ctx.agent("ops").fetch(OPENAPI_PATH);
      status(result, 200, `GET ${OPENAPI_PATH}`);
      header(result, "Content-Type", /application\/json/, OPENAPI_PATH);
      const document = result.json<{
        openapi?: string;
        paths?: Record<string, Record<string, unknown>>;
      }>();
      check(
        typeof document.openapi === "string" && document.openapi.startsWith("3.1"),
        "not an OpenAPI 3.1 document",
        {
          expected: "openapi: 3.1.x",
          observed: String(document.openapi),
          exchange: result.exchange,
        },
      );
      const missing: string[] = [];
      const tables = [
        [routes, API],
        [adminRoutes, ADMIN_API_BASE_PATH],
      ] as const;
      for (const [table, base] of tables) {
        for (const [name, route] of Object.entries(table) as [string, RouteSpec][]) {
          const path = `${base}${toOpenApiPath(route.path)}`;
          if (!document.paths?.[path]?.[route.method.toLowerCase()])
            missing.push(`${route.method} ${path} (${name})`);
        }
      }
      check(
        missing.length === 0,
        "the deployed OpenAPI document lacks routes of this suite's contract",
        {
          expected: `${Object.keys(routes).length + Object.keys(adminRoutes).length} operations`,
          observed: `${missing.length} missing`,
          details: missing,
          exchange: result.exchange,
        },
      );
    },
  },
  {
    id: "ops.pending-routes",
    area: "ops",
    title:
      "Routes the contract has but the deployment has not implemented answer 501 not_implemented, uniformly",
    async run(ctx: CheckContext) {
      // Milestone 2 lands area by area: the deployed OpenAPI document marks what is registered
      // but not implemented (`x-webflix-implementation: pending`). Each must answer the one
      // uniform problem to an anonymous request without the client header, naming itself; the
      // rest of the suite covers what is implemented. Pending routes are listed as notes.
      const agent = ctx.agent("ops");
      const result = await agent.fetch(OPENAPI_PATH);
      status(result, 200, `GET ${OPENAPI_PATH}`);
      const document = result.json<{
        paths?: Record<
          string,
          Record<
            string,
            { operationId?: string; "x-webflix-area"?: string; "x-webflix-implementation"?: string }
          >
        >;
      }>();
      const pending = Object.entries(document.paths ?? {}).flatMap(([path, methods]) =>
        Object.entries(methods)
          .filter(([, operation]) => operation["x-webflix-implementation"] === "pending")
          .map(([method, operation]) => ({
            method: method.toUpperCase(),
            // Any value fills a parameter: the answer comes before validation.
            path: path.replaceAll(/\{[^}]+\}/g, "smoke-param"),
            operationId: operation.operationId ?? "?",
            area: operation["x-webflix-area"] ?? "?",
          })),
      );
      if (pending.length === 0) {
        ctx.note("every route of the contract is implemented");
        return;
      }
      const byArea = new Map<string, string[]>();
      for (const route of pending) {
        const answer = problem(
          await agent.fetch(route.path, { method: route.method, retryOn429: false }),
          "not_implemented",
          `${route.method} ${route.path} (${route.operationId})`,
        );
        equal(answer.operationId, route.operationId, `${route.operationId}: operationId`);
        equal(answer.area, route.area, `${route.operationId}: area`);
        byArea.set(route.area, [...(byArea.get(route.area) ?? []), route.operationId]);
      }
      const areas = [...byArea].sort(([a], [b]) => a.localeCompare(b));
      ctx.note(
        `${pending.length} operations pending: ${areas.map(([area, names]) => `${area} ${names.length}`).join(", ")}`,
      );
      for (const [area, names] of areas) {
        ctx.note(`pending in ${area} (${names.length}): ${names.join(", ")}`);
      }
    },
  },
  {
    id: "ops.docs-page",
    area: "ops",
    title: "API docs page loads only same-origin scripts and styles",
    async run(ctx: CheckContext) {
      const agent = ctx.agent("ops");
      const page = await agent.fetch(API_DOCS_PATH, { headers: { Accept: "text/html" } });
      status(page, 200, `GET ${API_DOCS_PATH}`);
      header(page, "Content-Type", /text\/html/, API_DOCS_PATH);
      const html = page.text();
      const origin = agent.origin;
      const references = [
        ...html.matchAll(
          /<(script|link|img|iframe)\b[^>]*?\s(?:src|href)\s*=\s*["']([^"']+)["']/gi,
        ),
      ].map((match) => ({ tag: (match[1] ?? "").toLowerCase(), url: match[2] ?? "" }));
      const thirdParty = references.filter(({ url }) => {
        if (url.startsWith("data:")) return false;
        try {
          return new URL(url, origin).origin !== origin;
        } catch {
          return true;
        }
      });
      check(thirdParty.length === 0, "the docs page references third-party origins", {
        expected: "only same-origin script/link/img URLs",
        observed: thirdParty.map(({ tag, url }) => `<${tag}> ${url}`).join(", "),
        exchange: page.exchange,
      });
      const csp = header(page, "Content-Security-Policy", /script-src/, API_DOCS_PATH) ?? "";
      const scriptSrc = /script-src([^;]*)/.exec(csp)?.[1] ?? "";
      const foreign = scriptSrc.split(/\s+/).filter((source) => /^(https?:|\*|\/\/)/.test(source));
      check(foreign.length === 0, "the docs CSP allows third-party script origins", {
        expected: "script-src limited to 'self' and nonces",
        observed: `script-src${scriptSrc}`,
        exchange: page.exchange,
      });
      const scripts = references.filter(({ tag }) => tag === "script");
      check(scripts.length > 0, "the docs page has no script (the reference UI cannot render)", {
        exchange: page.exchange,
      });
      for (const { url } of scripts) {
        const script = await agent.fetch(url);
        status(script, 200, `docs script ${url}`);
        header(script, "Content-Type", /javascript/, `docs script ${url}`);
      }
      ctx.note(`${references.length} same-origin references, ${scripts.length} script(s)`);
    },
  },
  {
    id: "ops.security-headers",
    area: "ops",
    title: "Security headers on JSON, problems, docs and blobs; no-store on the API",
    async run(ctx: CheckContext) {
      const agent = ctx.agent("ops");
      const https = agent.origin.startsWith("https:");
      const plans = await agent.fetch(`${API}/plans`);
      status(plans, 200, "GET /plans");
      securityHeaders(plans, "GET /plans", https);
      header(plans, "Cache-Control", /no-store/, "GET /plans");
      header(plans, "Vary", /cookie/i, "GET /plans");
      const unauthenticated = await agent.fetch(`${API}/account`);
      problem(unauthenticated, "unauthenticated", "GET /account without a session");
      securityHeaders(unauthenticated, "401 problem", https);
      header(unauthenticated, "Cache-Control", /no-store/, "401 problem");
      const openapi = await agent.fetch(OPENAPI_PATH);
      securityHeaders(openapi, OPENAPI_PATH, https);
      const docs = await agent.fetch(API_DOCS_PATH);
      securityHeaders(docs, API_DOCS_PATH, https);
      const blob = await agent.fetch(`/cdn/${unique("smoke-missing")}.webp`);
      securityHeaders(blob, "/cdn miss", https);
      ctx.note(https ? "https target: HSTS required" : "plain-http target: HSTS not required");
    },
  },
  {
    id: "ops.request-id",
    area: "ops",
    title: "X-Request-Id is echoed when valid, generated otherwise, and matches problems",
    async run(ctx: CheckContext) {
      const agent = ctx.agent("ops");
      const mine = unique("smoke-req");
      const echoed = await agent.fetch(`${API}/plans`, { headers: { [REQUEST_ID_HEADER]: mine } });
      header(echoed, REQUEST_ID_HEADER, mine, "a valid incoming id is reused");
      const invalid = "not a valid id; with spaces";
      const replaced = await agent.fetch(`${API}/plans`, {
        headers: { [REQUEST_ID_HEADER]: invalid },
      });
      header(
        replaced,
        REQUEST_ID_HEADER,
        (value) => value !== null && value !== invalid && /^[A-Za-z0-9._-]{1,64}$/.test(value),
        "an invalid incoming id is replaced",
      );
      const tooLong = "x".repeat(65);
      const long = await agent.fetch(`${API}/plans`, { headers: { [REQUEST_ID_HEADER]: tooLong } });
      header(
        long,
        REQUEST_ID_HEADER,
        (value) => value !== null && value !== tooLong,
        "a 65-char id is replaced",
      );
      const id = unique("smoke-problem");
      const failing = await agent.fetch(`${API}/account`, { headers: { [REQUEST_ID_HEADER]: id } });
      const body = problem(failing, "unauthenticated", "GET /account without a session");
      equal(body.requestId, id, "problem.requestId", failing.exchange);
      const media = await agent.fetch(`/cdn/${unique("smoke")}.webp`);
      header(
        media,
        REQUEST_ID_HEADER,
        (value) => value !== null && value !== "",
        "blob responses carry a request id",
      );
    },
  },
  {
    id: "ops.problem.unknown-route",
    area: "ops",
    title: "Unknown API routes answer a not_found problem+json",
    async run(ctx: CheckContext) {
      const agent = ctx.agent("ops");
      const path = `${API}/${unique("smoke-no-such-route")}`;
      problem(await agent.fetch(path), "not_found", `GET ${path}`);
      problem(
        await agent.fetch(path, { method: "POST", headers: CSRF, body: {} }),
        "not_found",
        `POST ${path}`,
      );
    },
  },
  {
    id: "ops.problem.missing-resources",
    area: "ops",
    title: "Missing titles, genres, rows and blobs answer not_found problems",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.browseViewer();
      const agent = viewer.agent;
      problem(
        await agent.fetch(`${API}/titles/${unique("t-smoke-missing")}`),
        "not_found",
        "unknown title",
      );
      problem(
        await agent.fetch(`${API}/browse/genre/${unique("smoke-genre")}`),
        "not_found",
        "unknown genre",
      );
      problem(
        await agent.fetch(`${API}/browse/rows/${unique("home:smoke")}`),
        "not_found",
        "unknown row",
      );
      problem(
        await agent.fetch(`/cdn/${unique("smoke-missing")}.webp`),
        "not_found",
        "missing /cdn object",
      );
      problem(
        await agent.fetch(`/media/${unique("garbage-token")}/vod/v-smoke/master.m3u8`),
        "media_token_invalid",
        "garbage media token",
      );
    },
  },
  {
    id: "ops.problem.validation",
    area: "ops",
    title: "Validation (every issue at once), malformed JSON and wrong content type are problems",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.browseViewer();
      const agent = viewer.agent;
      const badId = await agent.fetch(`${API}/titles/${encodeURIComponent("bad id!")}`);
      const invalid = problem(badId, "validation_failed", "GET /titles/<invalid id>");
      check(
        invalid.issues.some((issue) => issue.location === "params" && issue.path === "id"),
        "validation issue does not point at params.id",
        { observed: JSON.stringify(invalid.issues), exchange: badId.exchange },
      );
      const emptySearch = await agent.fetch(`${API}/search?q=`);
      problem(emptySearch, "validation_failed", "GET /search?q= (empty)");
      const view = await agent.fetch(`${API}/browse?view=smoke-bogus`);
      problem(view, "validation_failed", "GET /browse?view=<unknown>");
      // Every issue is reported at once (name and avatarId are both missing).
      const both = await agent.fetch(`${API}/profiles`, {
        method: "POST",
        headers: CSRF,
        body: {},
      });
      const collected = problem(both, "validation_failed", "POST /profiles {}");
      const paths = collected.issues.map((issue) => issue.path);
      check(
        paths.includes("name") && paths.includes("avatarId"),
        "not every validation issue is reported",
        {
          expected: "issues for body.name and body.avatarId",
          observed: JSON.stringify(collected.issues),
          exchange: both.exchange,
        },
      );
      const target = `${API}/profiles/${viewer.profile.id}`;
      problem(
        await agent.fetch(target, {
          method: "PATCH",
          headers: { ...CSRF, "Content-Type": "application/json" },
          body: "{not json",
        }),
        "bad_request",
        "malformed JSON",
      );
      problem(
        await agent.fetch(target, {
          method: "PATCH",
          headers: { ...CSRF, "Content-Type": "text/plain" },
          body: JSON.stringify({ name: "x" }),
        }),
        "unsupported_media_type",
        "text/plain body",
      );
    },
  },
  {
    id: "ops.problem.payload-too-large",
    area: "ops",
    title: "A JSON body over 1 MiB is refused with payload_too_large",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.browseViewer();
      const large = JSON.stringify({ name: "x", padding: "a".repeat(1024 * 1024 + 16) });
      problem(
        await viewer.agent.fetch(`${API}/profiles/${viewer.profile.id}`, {
          method: "PATCH",
          headers: { ...CSRF, "Content-Type": "application/json" },
          body: large,
        }),
        "payload_too_large",
        "1 MiB+ body",
      );
    },
  },
  {
    id: "ops.asset-miss",
    area: "ops",
    title: "Build assets are immutable; a missing one is a 404 no cache keeps, never the SPA shell",
    needs: [needs.webBuild],
    async run(ctx: CheckContext) {
      const index = await ctx.env.webBuild();
      if (/\/@vite\/client/.test(index.html)) {
        ctx.skip(
          "the target serves the web app from the Vite dev server (source modules, no build output), so build asset caching does not apply",
        );
      }
      const agent = ctx.agent("ops-assets");
      const entry = [...index.html.matchAll(/<script\b[^>]*>/gi)]
        .map((match) => match[0])
        .filter((tag) => /\btype=["']module["']/i.test(tag))
        .map((tag) => /\bsrc=["'](\/assets\/[^"']+)["']/i.exec(tag)?.[1])
        .find((src): src is string => src !== undefined);
      check(entry, "the index document loads no module script from /assets/", {
        observed: index.evidence,
      });
      const asset = await agent.fetch(entry);
      status(asset, 200, `GET ${entry}`);
      header(asset, "Content-Type", /javascript/, `GET ${entry}`);
      header(asset, "Cache-Control", /immutable/, `GET ${entry}`);

      const token = unique("smoke");
      const misses: Array<[string, string]> = [
        [`/assets/${token}.js`, "script"],
        [`/assets/${token}.css`, "style"],
        [`/${token}.png`, "image"],
      ];
      for (const [path, destination] of misses) {
        const what = `a missing ${destination} (${path})`;
        const miss = await agent.fetch(path, {
          headers: { "Sec-Fetch-Dest": destination, "Sec-Fetch-Mode": "no-cors" },
        });
        status(miss, 404, what);
        header(miss, "Content-Type", (value) => !(value ?? "").includes("text/html"), what);
        header(
          miss,
          "Cache-Control",
          (value) =>
            value !== null &&
            /no-store/.test(value) &&
            !/immutable/.test(value) &&
            !/max-age=0*[1-9]/.test(value),
          what,
        );
      }
      const navigated = await agent.fetch(`/assets/${token}.js`, { headers: NAVIGATE });
      status(navigated, 404, "navigating to a missing build file (build output is never a route)");
      const route = await agent.fetch(`/browse/genre/${token}`, { headers: NAVIGATE });
      status(route, 200, "navigating to a client route");
      header(route, "Content-Type", /text\/html/, "navigating to a client route");
      header(
        route,
        "Cache-Control",
        (value) => !/immutable/.test(value ?? ""),
        "navigating to a client route",
      );
    },
  },
  {
    id: "ops.spa-fallback",
    area: "ops",
    title: "Unknown non-API paths serve the SPA; API, media and blob misses never do",
    needs: [needs.webBuild],
    async run(ctx: CheckContext) {
      const agent = ctx.agent("ops");
      const index = await ctx.env.webBuild();
      const deep = await agent.fetch(`/browse/${unique("smoke-deep-link")}?jbv=t-smoke`, {
        headers: { Accept: "text/html,application/xhtml+xml" },
      });
      status(deep, 200, "deep link into the SPA");
      header(deep, "Content-Type", /text\/html/, "deep link into the SPA");
      const scripts = (html: string) =>
        [...html.matchAll(/<script\b[^>]*\ssrc=["']([^"']+)["']/gi)]
          .map((match) => match[1])
          .sort();
      equal(
        scripts(deep.text()).join(" "),
        scripts(index.html).join(" "),
        "SPA fallback document (script set)",
        deep.exchange,
      );
      for (const path of [
        `${API}/${unique("smoke-missing")}`,
        `/cdn/${unique("smoke-missing")}.webp`,
        `/media/${unique("tok")}/vod/v-smoke/master.m3u8`,
      ]) {
        const result = await agent.fetch(path, {
          headers: { Accept: "text/html,application/xhtml+xml" },
        });
        if (
          (result.headers.get("Content-Type") ?? "").includes("text/html") ||
          result.status === 200
        ) {
          fail(`${path} is answered by the SPA instead of the API`, {
            expected: "a 4xx problem from the API",
            observed: `${result.status} ${result.headers.get("Content-Type") ?? ""}`,
            exchange: result.exchange,
          });
        }
      }
    },
  },
];
