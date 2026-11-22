import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  adminRoutes,
  buildPath,
  ERROR_CATALOG,
  ERROR_CODES,
  isClientRoute,
  type Problem,
  pathParamNames,
  ROUTE_AREAS,
  type RouteInput,
  type RouteOutput,
  type RouteRequest,
  type RouteSpec,
  routeErrorCodes,
  routes,
  type TitleDetail,
  toOpenApiPath,
} from "../src/index.ts";

const memberEntries: [string, RouteSpec][] = Object.entries(routes);
const adminEntries: [string, RouteSpec][] = Object.entries(adminRoutes);
const entries: [string, RouteSpec][] = [...memberEntries, ...adminEntries];

describe("route table", () => {
  it("has one route per method and path in each table, and unique operation ids", () => {
    for (const table of [memberEntries, adminEntries]) {
      const keys = table.map(([, route]) => `${route.method} ${route.path}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
    const names = entries.map(([name]) => name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(entries)("%s names a known area", (_name, route) => {
    expect(ROUTE_AREAS).toContain(route.area);
  });

  it.each(entries)(
    "%s is consistent about redirects, encodings, CSRF and staff roles",
    (_name, route) => {
      if (route.redirect !== undefined) expect(route.response).toBeNull();
      if (route.bodyEncoding === "raw") expect(route.body).toBeUndefined();
      if (route.bodyEncoding === "form") expect(route.body).toBeDefined();
      // Only callers that cannot send the client header are exempt from it.
      if (route.csrf === "none") {
        expect(route.bodyEncoding === "raw" || route.bodyEncoding === "form").toBe(true);
      }
      expect(route.staffRole !== undefined).toBe(route.auth === "staff");
    },
  );

  it("serves the staff API with staff auth only, and the member API never with it", () => {
    for (const [, route] of adminEntries) {
      expect(route.auth).toBe("staff");
      expect(route.area).toBe("admin");
      expect(isClientRoute(route)).toBe(true);
    }
    for (const [, route] of memberEntries) expect(route.auth).not.toBe("staff");
  });

  it.each(entries)("%s declares exactly its path parameters", (_name, route) => {
    const declared = route.params ? Object.keys(route.params.shape).sort() : [];
    expect(declared).toEqual(pathParamNames(route.path).sort());
  });

  it.each(entries)("%s has no body on GET", (_name, route) => {
    if (route.method === "GET") expect(route.body).toBeUndefined();
  });

  it.each(entries)("%s only lists known error codes", (_name, route) => {
    for (const code of routeErrorCodes(route)) expect(ERROR_CODES).toContain(code);
  });

  it.each(entries)("%s has a JSON-representable response without transforms", (_name, route) => {
    if (route.response === null) return;
    // Response bodies must survive JSON and mean the same on both sides: input == output.
    const output = z.toJSONSchema(route.response, { io: "output", unrepresentable: "throw" });
    const input = z.toJSONSchema(route.response, { io: "input", unrepresentable: "throw" });
    expect(input.$defs ?? {}).toBeDefined();
    expect(JSON.stringify(stripClosedObjects(input))).toBe(
      JSON.stringify(stripClosedObjects(output)),
    );
  });

  it.each(entries.filter(([, route]) => route.examples))(
    "%s has examples that match its schemas",
    (_name, route) => {
      if (route.examples?.request !== undefined) {
        expect(route.body?.safeParse(route.examples.request).success).toBe(true);
      }
      if (route.examples?.response !== undefined) {
        expect(route.response?.safeParse(route.examples.response).success).toBe(true);
      }
    },
  );

  it("covers exactly the surface of blueprint §6 (milestone 1) and milestone 2", () => {
    const blueprint = [
      "GET /auth/email-status",
      "POST /auth/signup",
      "POST /auth/login",
      "POST /auth/logout",
      "POST /auth/logout-all",
      "GET /session",
      "PUT /session/profile",
      "DELETE /session/profile",
      "GET /account",
      "PATCH /account",
      "GET /plans",
      "PUT /account/subscription",
      "DELETE /account/subscription",
      "POST /account/subscription/resume",
      "GET /account/sessions",
      "DELETE /account/sessions/:id",
      "GET /profiles",
      "POST /profiles",
      "PATCH /profiles/:id",
      "DELETE /profiles/:id",
      "GET /avatars",
      "GET /browse",
      "GET /browse/rows/:rowId",
      "GET /genres",
      "GET /browse/genre/:slug",
      "GET /titles/:id",
      "GET /titles/:id/seasons/:seasonNumber/episodes",
      "GET /titles/:id/similar",
      "GET /titles/:id/popularity",
      "GET /showcase",
      "PUT /account/payment-method",
      "GET /search",
      "GET /my-list",
      "PUT /my-list/:titleId",
      "DELETE /my-list/:titleId",
      "PUT /ratings/:titleId",
      "DELETE /ratings/:titleId",
      "GET /continue-watching",
      "DELETE /continue-watching/:titleId",
      "GET /history",
      "DELETE /history/:id",
      "GET /notifications",
      "POST /notifications/read",
      "POST /playback/sessions",
      "POST /playback/sessions/:id/heartbeat",
      "DELETE /playback/sessions/:id",
    ];
    // Milestone 2 (docs/BLUEPRINT-M2.md §4-§6, §8; docs/CONTRACT_CHANGES.md).
    const milestone2 = [
      "GET /auth/providers",
      "GET /auth/oidc/:provider/start",
      "GET /auth/oidc/:provider/callback",
      "POST /auth/oidc/:provider/callback",
      "GET /account/identities",
      "DELETE /account/identities/:provider",
      "GET /session/elevation",
      "POST /session/elevation",
      "POST /auth/email-verification",
      "POST /auth/email-verification/confirm",
      "POST /auth/password-reset",
      "POST /auth/password-reset/confirm",
      "POST /webhooks/email/:provider",
      "GET /diagnostics/mailbox",
      "GET /billing/config",
      "POST /billing/checkout",
      "GET /billing/checkout/:id",
      "POST /billing/checkout/:id/confirm",
      "POST /billing/subscription/preview",
      "POST /billing/payment-method/setup",
      "GET /billing/payment-method/setup/:id",
      "GET /billing/invoices",
      "POST /billing/promotions/validate",
      "POST /webhooks/payments/:provider",
      "POST /diagnostics/billing/clock",
      "POST /events",
      "GET /privacy/consent",
      "PUT /privacy/consent",
      "POST /privacy/export",
      "GET /privacy/exports/:id",
      "GET /privacy/requests",
      "POST /account/deletion",
      "DELETE /account/deletion",
      "GET /diagnostics/events",
    ];
    const actual = memberEntries.map(([, route]) => `${route.method} ${route.path}`);
    expect(actual.sort()).toEqual([...blueprint, ...milestone2].sort());
  });

  it("covers the staff API of milestone 2 §8.3", () => {
    const staff = [
      "GET /me",
      "GET /members",
      "GET /members/:accountId",
      "POST /members/:accountId/sign-out",
      "POST /members/:accountId/password-reset",
      "DELETE /members/:accountId/profiles/:profileId/pin",
      "POST /members/:accountId/refunds",
      "POST /members/:accountId/subscription/cancel",
      "POST /members/:accountId/subscription/extend-trial",
      "POST /members/:accountId/subscription/complimentary",
      "GET /plans",
      "PUT /plans/:planId/prices/:currency",
      "POST /plans/sync",
      "GET /editorial/billboards/:view",
      "PUT /editorial/billboards/:view",
      "GET /editorial/collections",
      "POST /editorial/collections",
      "PUT /editorial/collections/:id",
      "DELETE /editorial/collections/:id",
      "PUT /titles/:titleId/availability",
      "GET /experiments",
      "POST /experiments",
      "GET /experiments/:key",
      "PATCH /experiments/:key",
      "PUT /experiments/:key/status",
      "GET /experiments/:key/results",
      "GET /system/health",
      "GET /system/dead-letters",
      "POST /system/dead-letters/:id/replay",
      "GET /system/recommendations",
      "POST /system/recommendations/import",
      "GET /audit",
      // Added by the admin area (docs/CONTRACT_CHANGES.md): support's privacy actions, the
      // operator's erasure confirmations and the recommendation rollback.
      "GET /members/:accountId/privacy",
      "PUT /members/:accountId/privacy/consent",
      "DELETE /members/:accountId/deletion",
      "POST /system/recommendations/rollback",
      "GET /system/privacy/erasures",
      "POST /system/privacy/erasures/confirm",
    ];
    const actual = adminEntries.map(([, route]) => `${route.method} ${route.path}`);
    expect(actual.sort()).toEqual(staff.sort());
  });

  it("takes an idempotency key on every staff billing action (a retry must not act twice)", () => {
    for (const [name, route] of adminEntries) {
      if (route.method === "GET" || !route.path.startsWith("/members/:accountId/")) continue;
      const shape = (route.body as { shape?: Record<string, unknown> } | undefined)?.shape;
      const billing = route.path.endsWith("/refunds") || route.path.includes("/subscription/");
      expect(shape?.idempotencyKey !== undefined, name).toBe(billing);
    }
  });

  it("takes a reason on every mutating staff route (the audit log needs one)", () => {
    for (const [name, route] of adminEntries) {
      if (route.method === "GET") continue;
      const shape = (route.body as { shape?: Record<string, unknown> } | undefined)?.shape;
      expect(shape?.reason, name).toBeDefined();
    }
  });

  it("maps every error code to a 4xx/5xx status", () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_CATALOG[code].status).toBeGreaterThanOrEqual(400);
      expect(ERROR_CATALOG[code].status).toBeLessThan(600);
    }
  });
});

/** zod marks output objects closed (additionalProperties: false); input objects are open. */
function stripClosedObjects(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripClosedObjects);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "additionalProperties")
      .map(([key, child]) => [key, stripClosedObjects(child)]),
  );
}

describe("path helpers", () => {
  it("builds paths with encoded parameters", () => {
    expect(
      buildPath("/titles/:id/seasons/:seasonNumber/episodes", { id: "a b", seasonNumber: 2 }),
    ).toBe("/titles/a%20b/seasons/2/episodes");
  });

  it("rejects missing parameters", () => {
    expect(() => buildPath("/titles/:id", {})).toThrow(/Missing path parameter "id"/);
  });

  it("converts to OpenAPI templates", () => {
    expect(toOpenApiPath("/browse/rows/:rowId")).toBe("/browse/rows/{rowId}");
  });
});

describe("derived types", () => {
  it("types client input, server request and output", () => {
    expectTypeOf<RouteInput<typeof routes.getTitle>>().toEqualTypeOf<{
      params: { id: string };
      query?: undefined;
      body?: undefined;
    }>();
    expectTypeOf<RouteInput<typeof routes.listEpisodes>["params"]>().toEqualTypeOf<{
      id: string;
      seasonNumber: number;
    }>();
    expectTypeOf<RouteRequest<typeof routes.listEpisodes>["params"]["seasonNumber"]>().toBeNumber();
    expectTypeOf<RouteOutput<typeof routes.getTitle>>().toEqualTypeOf<TitleDetail>();
    expectTypeOf<RouteOutput<typeof routes.logout>>().toBeUndefined();
    // A body schema that accepts undefined makes the body optional (the final heartbeat).
    expectTypeOf<RouteInput<typeof routes.endPlaybackSession>>().toEqualTypeOf<{
      params: { id: string };
      query?: undefined;
      body?:
        | {
            positionSec: number;
            durationSec: number;
            state: "playing" | "paused" | "buffering" | "ended";
          }
        | undefined;
    }>();
    // Optional query: the whole input may be omitted.
    expectTypeOf<RouteInput<typeof routes.getBrowse>>().toEqualTypeOf<{
      params?: undefined;
      query?: {
        view?: "home" | "series" | "movies" | "new-popular" | undefined;
        cursor?: string | undefined;
      };
      body?: undefined;
    }>();
  });

  it("narrows problems by code", () => {
    expectTypeOf<
      Problem<"stream_limit_reached">["activeStreams"][number]["deviceLabel"]
    >().toBeString();
    expectTypeOf<Problem<"rate_limited">["retryAfterSec"]>().toBeNumber();
    expectTypeOf<Problem<"not_found">>().not.toHaveProperty("retryAfterSec");
  });
});
