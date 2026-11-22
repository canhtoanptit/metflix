/**
 * End-to-end proof of the contract seam: Hono routes registered straight from the route
 * table, called through the typed client, with validation, CSRF, problem+json and OpenAPI.
 */
import {
  API_BASE_PATH,
  ApiError,
  adminRoutes,
  createApiClient,
  createRouteClient,
  type FetchLike,
  isClientRoute,
  OPENAPI_PATH,
  type RouteSpec,
  routes,
} from "@webflix/contracts";
import { makePlaybackSession, makeTitleDetail } from "@webflix/contracts/fixtures";
import { buildOpenApiDocument } from "@webflix/contracts/openapi";
import { AppError } from "@webflix/core";
import { Hono } from "hono";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  bindRoute,
  bindRoutes,
  problemErrorHandler,
  problemNotFoundHandler,
  requireClientHeader,
} from "../src/index.ts";

interface Recorded {
  rated: { titleId: string; value: string }[];
  seasonNumbers: unknown[];
}

function buildApp(recorded: Recorded) {
  const app = new Hono();
  app.onError(problemErrorHandler());
  app.notFound(problemNotFoundHandler());
  const options = { guard: requireClientHeader, validateResponses: true };

  const subset = {
    getTitle: routes.getTitle,
    listEpisodes: routes.listEpisodes,
    rateTitle: routes.rateTitle,
    createPlaybackSession: routes.createPlaybackSession,
    getGenreBrowse: routes.getGenreBrowse,
  };
  bindRoutes(
    app,
    subset,
    {
      getTitle: ({ params }) => {
        if (params.id === "t-missing") throw new AppError("not_found", { detail: "No such title" });
        if (params.id === "t-crash") throw new Error("database exploded: password=hunter2");
        return makeTitleDetail({ id: params.id });
      },
      listEpisodes: ({ params }) => {
        recorded.seasonNumbers.push(params.seasonNumber);
        return {
          titleId: params.id,
          season: {
            number: params.seasonNumber,
            name: "Season 2",
            episodeCount: 0,
            releaseYear: 2025,
          },
          items: [],
        };
      },
      rateTitle: ({ params, body }) => {
        recorded.rated.push({ titleId: params.titleId, value: body.value });
      },
      createPlaybackSession: ({ body }) => {
        if (body.titleId === "t-busy") {
          throw new AppError("stream_limit_reached", {
            limit: 1,
            activeStreams: [
              {
                playbackSessionId: "ps-other",
                deviceLabel: "Safari on iPhone",
                titleName: "Sintel",
                startedAt: "2026-01-01T00:00:00.000Z",
                lastSeenAt: "2026-01-01T00:05:00.000Z",
              },
            ],
          });
        }
        return makePlaybackSession({ titleId: body.titleId });
      },
      getGenreBrowse: ({ params, query }) => ({
        genre: { id: "g-1", slug: params.slug, name: "Drama", description: null },
        type: query.type ?? null,
        sort: query.sort ?? "suggested",
        items: [],
        nextCursor: null,
      }),
    },
    options,
  );
  app.get(OPENAPI_PATH, (c) => c.json(buildOpenApiDocument()));
  return app;
}

describe("route table → Hono → typed client", () => {
  let recorded: Recorded;
  let app: Hono;
  let fetch: FetchLike;

  beforeEach(() => {
    recorded = { rated: [], seasonNumbers: [] };
    app = buildApp(recorded);
    fetch = async (url, init) => app.request(url, init);
  });

  it("serves typed, contract-valid responses", async () => {
    const api = createRouteClient(routes, { fetch, validateResponses: true });
    const title = await api.getTitle({ params: { id: "t-sintel" } });
    expectTypeOf(title.viewer.progress).toEqualTypeOf<{
      positionSec: number;
      durationSec: number;
      completed: boolean;
      updatedAt: string;
    } | null>();
    expect(title.id).toBe("t-sintel");
  });

  it("coerces path parameters before the handler sees them", async () => {
    const api = createApiClient({ fetch });
    const page = await api.listEpisodes({ params: { id: "t-tides", seasonNumber: 2 } });
    expect(page.season.number).toBe(2);
    expect(recorded.seasonNumbers).toEqual([2]);
  });

  it("passes query parameters through validation", async () => {
    const api = createApiClient({ fetch });
    const page = await api.getGenreBrowse({
      params: { slug: "drama" },
      query: { sort: "a-z", type: "movie" },
    });
    expect(page).toMatchObject({ sort: "a-z", type: "movie", genre: { slug: "drama" } });
  });

  it("sends mutations with the CSRF header and answers 204", async () => {
    const api = createApiClient({ fetch });
    await expect(
      api.rateTitle({ params: { titleId: "t-1" }, body: { value: "love" } }),
    ).resolves.toBeUndefined();
    expect(recorded.rated).toEqual([{ titleId: "t-1", value: "love" }]);
  });

  it("rejects mutations without the CSRF header", async () => {
    const response = await app.request(`${API_BASE_PATH}/ratings/t-1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "love" }),
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("Content-Type")).toBe("application/problem+json");
    expect(await response.json()).toMatchObject({ code: "csrf_check_failed" });
    expect(recorded.rated).toEqual([]);
  });

  it("reports every validation issue with its location", async () => {
    const response = await app.request(`${API_BASE_PATH}/browse/genre/NOT_A_SLUG?sort=random`, {});
    expect(response.status).toBe(400);
    const problem = (await response.json()) as {
      code: string;
      issues: { location: string; path: string }[];
    };
    expect(problem.code).toBe("validation_failed");
    expect(problem.issues.map((issue) => `${issue.location}:${issue.path}`).sort()).toEqual([
      "params:slug",
      "query:sort",
    ]);
  });

  it("maps body problems to bad_request, unsupported_media_type and validation_failed", async () => {
    const post = (body: string, contentType = "application/json") =>
      app.request(`${API_BASE_PATH}/playback/sessions`, {
        method: "POST",
        headers: { "Content-Type": contentType, "X-Webflix-Client": "web" },
        body,
      });
    expect(await (await post("{not json")).json()).toMatchObject({
      code: "bad_request",
      status: 400,
    });
    expect(await (await post("{}", "text/plain")).json()).toMatchObject({
      code: "unsupported_media_type",
      status: 415,
    });
    expect(await (await post(JSON.stringify({ titleId: "" }))).json()).toMatchObject({
      code: "validation_failed",
      issues: [{ location: "body", path: "titleId" }],
    });
  });

  it("enforces the body limit while streaming, whatever Content-Length says", async () => {
    const chunk = new TextEncoder().encode(`{"titleId":"${"x".repeat(64 * 1024)}`);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // About 2 MiB, past the 1 MiB default, with no Content-Length header.
        if (sent > 2 * 1024 * 1024) return controller.close();
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const response = await app.request(`${API_BASE_PATH}/playback/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webflix-Client": "web" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "payload_too_large" });
    expect(sent).toBeLessThan(2 * 1024 * 1024);
  });

  it("keeps headers set before an error (e.g. clearing a cookie)", async () => {
    const guarded = new Hono();
    guarded.onError(problemErrorHandler());
    bindRoute(guarded, routes.getSession, () => ({ authenticated: false }) as const, {
      guard: (_route, c) => {
        c.header("Set-Cookie", "webflix_session=; Max-Age=0; Path=/");
        throw new AppError("unauthenticated");
      },
    });
    const response = await guarded.request(`${API_BASE_PATH}/session`);
    expect(response.status).toBe(401);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(response.headers.get("Content-Type")).toBe("application/problem+json");
  });

  it("turns AppError into a typed ApiError on the client", async () => {
    const api = createApiClient({ fetch });
    const error = await api
      .createPlaybackSession({ body: { titleId: "t-busy" } })
      .catch((caught: unknown) => caught);
    expect(ApiError.is(error, "stream_limit_reached")).toBe(true);
    if (!ApiError.is(error, "stream_limit_reached")) return;
    expect(error.status).toBe(409);
    expect(error.problem.activeStreams[0]?.deviceLabel).toBe("Safari on iPhone");

    const missing = await api
      .getTitle({ params: { id: "t-missing" } })
      .catch((caught: unknown) => caught);
    expect(ApiError.is(missing, "not_found")).toBe(true);
    expect((missing as ApiError).message).toBe("No such title");
  });

  it("hides unexpected errors behind internal_error", async () => {
    const api = createApiClient({ fetch });
    const error = await api
      .getTitle({ params: { id: "t-crash" } })
      .catch((caught: unknown) => caught);
    expect(ApiError.is(error, "internal_error")).toBe(true);
    expect(JSON.stringify((error as ApiError).problem)).not.toContain("hunter2");
  });

  it("answers unknown routes with a not_found problem", async () => {
    const response = await app.request(`${API_BASE_PATH}/nope`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  });

  it("serves the OpenAPI document generated from the same table", async () => {
    const response = await app.request(OPENAPI_PATH);
    const document = (await response.json()) as { paths: Record<string, Record<string, unknown>> };
    const operations = Object.values(document.paths).flatMap((methods) => Object.keys(methods));
    expect(operations).toHaveLength(Object.keys(routes).length + Object.keys(adminRoutes).length);
  });
});

describe("the whole route table binds and is reachable through the client", () => {
  it("registers every route where the client calls it", async () => {
    const app = new Hono();
    app.onError(problemErrorHandler());
    app.notFound(problemNotFoundHandler());
    const names = new Map<RouteSpec, string>(
      Object.entries(routes).map(([name, route]) => [route as RouteSpec, name]),
    );
    // The guard identifies the matched route before validation, proving method + path routing.
    for (const route of Object.values(routes) as RouteSpec[]) {
      bindRoute(app, route, () => undefined as never, {
        guard: (matched) => {
          throw new AppError("service_unavailable", { detail: names.get(matched) ?? "?" });
        },
      });
    }

    const api = createApiClient({ fetch: async (url, init) => app.request(url, init) });
    const input = {
      params: {
        id: "x1",
        rowId: "r1",
        slug: "drama",
        titleId: "t1",
        seasonNumber: 1,
        provider: "google",
      },
    };
    // Redirect, form and raw-body routes are served but are not client methods.
    const clientRoutes = (Object.entries(routes) as [string, RouteSpec][]).filter(([, route]) =>
      isClientRoute(route),
    );
    expect(Object.keys(api).sort()).toEqual(clientRoutes.map(([name]) => name).sort());
    for (const [name, route] of clientRoutes) {
      const call = api[name as keyof typeof api] as (input: unknown) => Promise<unknown>;
      const error = await call(route.params ? input : {}).catch((caught: unknown) => caught);
      expect(ApiError.is(error, "service_unavailable"), name).toBe(true);
      expect((error as ApiError).message, name).toBe(name);
    }
  });
});
