/**
 * In-browser mock of the Webflix API: a `fetch` for the typed client that routes requests with
 * the contract's route index and answers from `handlers.ts`, including problem documents,
 * latency, abort and configurable failures. Used by mock mode, component tests and e2e.
 */
import {
  API_BASE_PATH,
  ERROR_CATALOG,
  type FetchLike,
  PROBLEM_CONTENT_TYPE,
  problemType,
  ROUTE_INDEX,
} from "@webflix/contracts";
import { handlers, MockProblem } from "./handlers.ts";
import { loadSettings, loadState, type MockSettings, type MockState } from "./state.ts";

interface CompiledRoute {
  name: keyof typeof ROUTE_INDEX;
  method: string;
  pattern: RegExp;
  params: string[];
}

const NUMERIC_PARAMS = new Set(["seasonNumber"]);
const NUMERIC_QUERY = new Set(["limit"]);

const compiled: CompiledRoute[] = Object.entries(ROUTE_INDEX).map(([name, route]) => {
  const params: string[] = [];
  const source = route.path.replace(/:([A-Za-z]+)/g, (_match, param: string) => {
    params.push(param);
    return "([^/]+)";
  });
  return {
    name: name as keyof typeof ROUTE_INDEX,
    method: route.method,
    pattern: new RegExp(`^${API_BASE_PATH}${source}$`),
    params,
  };
});

function problemResponse(
  code: keyof typeof ERROR_CATALOG,
  extensions: Record<string, unknown> = {},
): Response {
  const spec = ERROR_CATALOG[code];
  return new Response(
    JSON.stringify({
      type: problemType(code),
      title: spec.title,
      status: spec.status,
      code,
      requestId: `mock-${Math.random().toString(36).slice(2, 10)}`,
      ...extensions,
    }),
    { status: spec.status, headers: { "Content-Type": PROBLEM_CONTENT_TYPE } },
  );
}

function delay(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export interface MockServer {
  fetch: FetchLike;
  state: MockState;
  settings: MockSettings;
}

export interface MockServerOptions {
  state?: MockState;
  settings?: Partial<MockSettings>;
}

export function createMockServer(options: MockServerOptions = {}): MockServer {
  const state = options.state ?? loadState();
  const settings: MockSettings = { ...loadSettings(), ...options.settings };

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input, "http://mock.local");
    const method = (init.method ?? "GET").toUpperCase();
    await delay(settings.latencyMs, init.signal);

    const match = compiled
      .filter((route) => route.method === method)
      .map((route) => ({ route, result: route.pattern.exec(url.pathname) }))
      .find((candidate) => candidate.result !== null);
    if (!match?.result) return problemResponse("not_found");
    const { route, result } = match;

    if (settings.failing.includes(route.name)) return problemResponse("internal_error");

    const params: Record<string, unknown> = {};
    route.params.forEach((name, index) => {
      const raw = decodeURIComponent(result[index + 1] ?? "");
      params[name] = NUMERIC_PARAMS.has(name) ? Number(raw) : raw;
    });
    const query: Record<string, unknown> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = NUMERIC_QUERY.has(key) ? Number(value) : value;
    });
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;

    const handler = handlers[route.name] as
      | ((input: unknown, state: MockState) => unknown)
      | undefined;
    if (!handler) return problemResponse("service_unavailable");
    try {
      const output = await handler({ params, query, body }, state);
      if (output === undefined || output === null) return new Response(null, { status: 204 });
      const status =
        route.name === "signup" ||
        route.name === "createProfile" ||
        route.name === "createPlaybackSession"
          ? 201
          : 200;
      return new Response(JSON.stringify(output), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      if (error instanceof MockProblem) return problemResponse(error.code, error.extensions);
      console.error("[mock api]", route.name, error);
      return problemResponse("internal_error");
    }
  };

  return { fetch, state, settings };
}
