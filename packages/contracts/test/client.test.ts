import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import { makeProfile, makeTitleDetail } from "../src/fixtures/index.ts";
import {
  ApiError,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  createApiClient,
  createProblem,
  createRouteClient,
  defineRoute,
  type FetchLike,
  PROBLEM_CONTENT_TYPE,
  routes,
  type TitleDetail,
} from "../src/index.ts";

interface Recorded {
  url: string;
  init: RequestInit;
  headers: Headers;
}

function recordingFetch(respond: (call: Recorded) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, init, headers: new Headers(init.headers) };
    calls.push(call);
    return respond(call);
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const problem = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": PROBLEM_CONTENT_TYPE },
  });

describe("createApiClient", () => {
  it("builds the URL from base, prefix, encoded params and query", async () => {
    const { fetch, calls } = recordingFetch(() => json({ items: [], nextCursor: null }));
    const api = createApiClient({ baseUrl: "http://localhost:4000/", fetch });
    await api.getGenreBrowse({
      params: { slug: "sci-fi" },
      query: { sort: "a-z", limit: 24, cursor: undefined },
    });
    expect(calls[0]?.url).toBe(
      "http://localhost:4000/api/v1/browse/genre/sci-fi?sort=a-z&limit=24",
    );
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("uses same-origin relative URLs by default", async () => {
    const { fetch, calls } = recordingFetch(() => json({ authenticated: false }));
    const api = createApiClient({ fetch });
    await expect(api.getSession()).resolves.toEqual({ authenticated: false });
    expect(calls[0]?.url).toBe("/api/v1/session");
  });

  it("sends credentials, Accept, and the CSRF header only on mutations", async () => {
    const { fetch, calls } = recordingFetch((call) =>
      call.init.method === "GET"
        ? json({ authenticated: false })
        : new Response(null, { status: 204 }),
    );
    const api = createApiClient({ fetch });
    await api.getSession();
    await api.addToMyList({ params: { titleId: "t-sintel" } });

    const [get, put] = calls;
    expect(get?.init.credentials).toBe("include");
    expect(get?.headers.get("Accept")).toContain("application/problem+json");
    expect(get?.headers.has(CLIENT_HEADER)).toBe(false);
    expect(put?.init.method).toBe("PUT");
    expect(put?.headers.get(CLIENT_HEADER)).toBe(CLIENT_HEADER_VALUE);
    expect(put?.init.body).toBeUndefined();
  });

  it("serialises JSON bodies and returns undefined for 204", async () => {
    const { fetch, calls } = recordingFetch(() => new Response(null, { status: 204 }));
    const api = createApiClient({ fetch });
    const result = await api.rateTitle({ params: { titleId: "t-1" }, body: { value: "love" } });
    expect(result).toBeUndefined();
    expect(calls[0]?.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ value: "love" });
  });

  it("sends exactly the body given, also for all-optional bodies", async () => {
    const { fetch, calls } = recordingFetch(() => new Response(null, { status: 204 }));
    await createApiClient({ fetch }).markNotificationsRead({ body: {} });
    expect(calls[0]?.init.body).toBe("{}");
  });

  it("merges default headers (function form) and per-request headers", async () => {
    const { fetch, calls } = recordingFetch(() => json({ authenticated: false }));
    const api = createApiClient({
      fetch,
      headers: async () => ({ Cookie: "webflix_session=abc" }),
    });
    await api.getSession(undefined, { headers: { "X-Request-Id": "req-1" } });
    expect(calls[0]?.headers.get("Cookie")).toBe("webflix_session=abc");
    expect(calls[0]?.headers.get("X-Request-Id")).toBe("req-1");
  });

  it("turns problem+json into a typed ApiError", async () => {
    const body = createProblem("stream_limit_reached", {
      limit: 2,
      activeStreams: [
        {
          playbackSessionId: "ps-1",
          deviceLabel: "Chrome on macOS",
          titleName: "Sintel",
          startedAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-01T00:10:00.000Z",
        },
      ],
      requestId: "req-9",
    });
    const { fetch } = recordingFetch(() => problem(body, 409));
    const api = createApiClient({ fetch });

    const error = await api
      .createPlaybackSession({ body: { titleId: "t-1" } })
      .catch((caught: unknown) => caught);

    expect(ApiError.is(error, "stream_limit_reached")).toBe(true);
    if (!(error instanceof ApiError) || !error.is("stream_limit_reached")) throw error;
    expectTypeOf(error.problem.activeStreams).toBeArray();
    expect(error.status).toBe(409);
    expect(error.problem.limit).toBe(2);
    expect(error.problem.activeStreams[0]?.deviceLabel).toBe("Chrome on macOS");
    expect(error.problem.requestId).toBe("req-9");
    expect(error.message).toBe("Too many people are using this account");
  });

  it("reports error responses without a valid problem as unexpected_response", async () => {
    const { fetch } = recordingFetch(
      () => new Response("<html>Bad gateway</html>", { status: 502 }),
    );
    const error = await createApiClient({ fetch })
      .getSession()
      .catch((caught: unknown) => caught);
    expect(ApiError.is(error, "unexpected_response")).toBe(true);
    expect((error as ApiError).status).toBe(502);
  });

  it("wraps transport failures as network_error with the cause", async () => {
    const cause = new TypeError("fetch failed");
    const fetch: FetchLike = () => Promise.reject(cause);
    const error = await createApiClient({ fetch })
      .getSession()
      .catch((caught: unknown) => caught);
    expect(ApiError.is(error, "network_error")).toBe(true);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).cause).toBe(cause);
  });

  it("rejects aborted requests with the abort reason, not an ApiError", async () => {
    const controller = new AbortController();
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const pending = createApiClient({ fetch }).getSession(undefined, { signal: controller.signal });
    controller.abort();
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });

  it("reports an abort during the body read as an abort", async () => {
    const controller = new AbortController();
    const fetch: FetchLike = async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"authenticated":'));
          init.signal?.addEventListener("abort", () => stream.error(init.signal?.reason));
        },
      });
      return new Response(body, { headers: { "Content-Type": "application/json" } });
    };
    const pending = createApiClient({ fetch }).getSession(undefined, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const error = await pending.catch((caught: unknown) => caught);
    expect(ApiError.is(error)).toBe(false);
    expect((error as DOMException).name).toBe("AbortError");
  });

  it("keeps the server's explanation for a problem with an unknown code", async () => {
    const { fetch } = recordingFetch(() =>
      problem({ type: "urn:x", title: "Shiny new failure", status: 409, code: "brand_new" }, 409),
    );
    const error = await createApiClient({ fetch })
      .getSession()
      .catch((caught: unknown) => caught);
    expect(ApiError.is(error, "unexpected_response")).toBe(true);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).message).toBe("Shiny new failure");
  });

  it("validates success bodies against the contract when asked", async () => {
    const detail = makeTitleDetail();
    const { fetch } = recordingFetch(() => json({ ...detail, matchScore: 250 }));
    const lenient = createApiClient({ fetch });
    const strict = createRouteClient(routes, { fetch, validateResponses: true });

    await expect(lenient.getTitle({ params: { id: detail.id } })).resolves.toMatchObject({
      matchScore: 250,
    });
    const error = await strict
      .getTitle({ params: { id: detail.id } })
      .catch((caught: unknown) => caught);
    expect(ApiError.is(error, "unexpected_response")).toBe(true);
  });

  it("returns typed data", async () => {
    const detail = makeTitleDetail();
    const { fetch } = recordingFetch(() => json(detail));
    const result = await createRouteClient(routes, { fetch, validateResponses: true }).getTitle({
      params: { id: detail.id },
    });
    expectTypeOf(result).toEqualTypeOf<TitleDetail>();
    expect(result).toEqual(detail);
  });

  it("calls the global fetch unbound (browsers throw on detached fetch)", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => json({ items: [makeProfile()], maxProfiles: 5 }));
    try {
      const result = await createApiClient({ baseUrl: "http://example.test" }).listProfiles();
      expect(result.maxProfiles).toBe(5);
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("createRouteClient", () => {
  it("derives a client from any route table", async () => {
    const table = {
      echo: defineRoute({
        method: "POST",
        path: "/echo/:id",
        tag: "titles",
        area: "streaming",
        auth: "public",
        summary: "echo",
        params: z.object({ id: z.string() }),
        body: z.object({ text: z.string() }),
        response: z.object({ id: z.string(), text: z.string() }),
      }),
    };
    const { fetch } = recordingFetch(async (call) => {
      const body = JSON.parse(String(call.init.body)) as { text: string };
      return json({ id: call.url.split("/").pop(), text: body.text });
    });
    const client = createRouteClient(table, { fetch });
    await expect(client.echo({ params: { id: "x" }, body: { text: "hi" } })).resolves.toEqual({
      id: "x",
      text: "hi",
    });
  });
});
