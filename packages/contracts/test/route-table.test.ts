import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  buildPath,
  ERROR_CATALOG,
  ERROR_CODES,
  type Problem,
  pathParamNames,
  type RouteInput,
  type RouteOutput,
  type RouteRequest,
  type RouteSpec,
  routeErrorCodes,
  routes,
  type TitleDetail,
  toOpenApiPath,
} from "../src/index.ts";

const entries: [string, RouteSpec][] = Object.entries(routes);

describe("route table", () => {
  it("has one route per method and path", () => {
    const keys = entries.map(([, route]) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
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

  it("covers exactly the surface of blueprint §6", () => {
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
    const actual = entries.map(([, route]) => `${route.method} ${route.path}`);
    expect(actual.sort()).toEqual(blueprint.sort());
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
