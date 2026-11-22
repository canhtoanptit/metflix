/**
 * The typed API client. Zod-free at runtime: `createApiClient` routes with the generated
 * `ROUTE_INDEX` and recognises problem documents structurally, so the web app's initial bundle
 * does not ship zod. Response validation is opt-in through `createRouteClient(routes, ...)`.
 */
import type { z } from "zod";
import type { AdminRoutes } from "./admin-routes.ts";
import { type ErrorCode, isErrorCode } from "./error-codes.ts";
import type { Problem } from "./errors.ts";
import {
  ADMIN_API_BASE_PATH,
  API_BASE_PATH,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  type HttpMethod,
  isSafeMethod,
  JSON_CONTENT_TYPE,
  PROBLEM_CONTENT_TYPE,
} from "./http.ts";
import {
  buildPath,
  type ClientRoutes,
  type NavigationRoutes,
  type RouteInput,
  type RouteInputOptional,
  type RouteOutput,
  type RouteSpec,
  type RouteTable,
} from "./route.ts";
import { ADMIN_ROUTE_INDEX, NAVIGATION_ROUTE_INDEX, ROUTE_INDEX } from "./route-index.gen.ts";
import type { Routes } from "./routes.ts";

/** Errors produced by the client itself rather than returned by the server. */
export const CLIENT_ERROR_CODES = ["network_error", "unexpected_response"] as const;
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];
export type ApiErrorCode = ErrorCode | ClientErrorCode;

/** Problem-shaped description of a client-side failure (`status` 0 for network errors). */
export interface ClientProblem {
  type: string;
  title: string;
  status: number;
  code: ClientErrorCode;
  detail?: string;
}

export type ProblemFor<C extends ApiErrorCode> = C extends ErrorCode
  ? Problem<C>
  : ClientProblem & { code: C };

/**
 * The only error type the client throws (aborts excepted: an aborted request rejects with the
 * signal's own reason so query libraries recognise cancellation). Narrow with `is`:
 *
 * ```ts
 * if (ApiError.is(error, "stream_limit_reached")) error.problem.activeStreams
 * ```
 */
export class ApiError<C extends ApiErrorCode = ApiErrorCode> extends Error {
  override readonly name = "ApiError";
  readonly code: C;
  readonly status: number;
  readonly problem: ProblemFor<C>;

  constructor(problem: ProblemFor<C>, options?: { cause?: unknown }) {
    // ProblemFor<C> is a member of this union for every C; TS cannot see through the
    // unresolved conditional type, so widen explicitly.
    const base = problem as unknown as Problem | ClientProblem;
    super(base.detail ?? base.title, options);
    this.problem = problem;
    this.code = base.code as C;
    this.status = base.status;
  }

  is<K extends ApiErrorCode>(code: K): this is ApiError<K> {
    return (this.code as ApiErrorCode) === code;
  }

  /** Type guard for `catch (error: unknown)`, optionally for one code. */
  static is<K extends ApiErrorCode = ApiErrorCode>(value: unknown, code?: K): value is ApiError<K> {
    return value instanceof ApiError && (code === undefined || value.code === code);
  }
}

function clientProblem<C extends ClientErrorCode>(
  code: C,
  status: number,
  detail: string,
): ClientProblem & { code: C } {
  const title = code === "network_error" ? "Network error" : "Unexpected response from server";
  return { type: `urn:webflix:problem:${code}`, title, status, code, detail };
}

/**
 * Structural check for a problem document. Deliberately shallow (no schema library): the
 * server is the same codebase, and the code alone is enough to branch on.
 */
export function isProblem(value: unknown): value is Problem {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isErrorCode(candidate.code) &&
    typeof candidate.status === "number" &&
    typeof candidate.title === "string" &&
    typeof candidate.type === "string"
  );
}

// Spelled without DOM-only global types (HeadersInit, RequestCredentials) so the client
// typechecks under Node, Workers and DOM type environments alike.
export type HeadersLike = ConstructorParameters<typeof Headers>[0];
export type FetchCredentials = "include" | "same-origin" | "omit";
/** `RequestInit` plus members some runtimes' type definitions omit. */
export type ClientRequestInit = RequestInit & {
  credentials?: FetchCredentials;
  keepalive?: boolean;
};

/** The subset of `fetch` the client needs; pass `app.request` from Hono in tests. */
export type FetchLike = (input: string, init: ClientRequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /**
   * Prefix every route path is relative to. Defaults to `API_BASE_PATH` (`ADMIN_API_BASE_PATH`
   * for `createAdminApiClient`).
   */
  basePath?: string;
  /**
   * Origin (and optional prefix) to call, e.g. `http://localhost:4000`. Defaults to "" so the
   * browser calls its own origin. Required outside the browser unless `fetch` handles
   * relative URLs (as Hono's `app.request` does).
   */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Extra headers on every request (e.g. a `Cookie` header from Node or a Worker). */
  headers?: HeadersLike | (() => HeadersLike | Promise<HeadersLike>);
  /**
   * Fetch credentials mode. Defaults to `"include"` so the session cookie is always sent;
   * omitted where the runtime's `Request` does not expose the member (workerd).
   */
  credentials?: FetchCredentials;
}

export interface RouteClientOptions extends ApiClientOptions {
  /** Parse success bodies with the route's response schema (tests, dev). Default false. */
  validateResponses?: boolean;
}

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: HeadersLike;
  /** Lets the request outlive the page (final heartbeat on unload). */
  keepalive?: boolean;
}

/** One client method: argument optional when the route needs no input. */
export type RouteMethod<R extends RouteSpec> =
  RouteInputOptional<R> extends true
    ? (input?: RouteInput<R>, options?: RequestOptions) => Promise<RouteOutput<R>>
    : (input: RouteInput<R>, options?: RequestOptions) => Promise<RouteOutput<R>>;

/**
 * A client for a route table: one method per client route (redirect, form and raw-body routes
 * are served and documented but are not `fetch` calls; see `IsClientRoute`).
 */
export type ApiClientFor<T extends RouteTable> = {
  readonly [K in keyof ClientRoutes<T>]: ClientRoutes<T>[K] extends RouteSpec
    ? RouteMethod<ClientRoutes<T>[K]>
    : never;
};

/** Typed client for the whole Webflix member API. Method names are the route table keys. */
export type ApiClient = ApiClientFor<Routes>;

/** Typed client for the staff API (`adminRoutes`). */
export type AdminApiClient = ApiClientFor<AdminRoutes>;

/** What the transport needs per route; `response` only when validating. */
interface RuntimeRoute {
  method: HttpMethod;
  path: string;
  response?: z.ZodType | null;
}

interface ResolvedOptions {
  baseUrl: string;
  basePath: string;
  fetch: FetchLike;
  headers: ApiClientOptions["headers"];
  credentials: FetchCredentials | undefined;
  validateResponses: boolean;
}

const runtimeSupportsCredentials =
  typeof Request !== "undefined" && "credentials" in Request.prototype;

function resolveOptions(options: RouteClientOptions): ResolvedOptions {
  return {
    baseUrl: (options.baseUrl ?? "").replace(/\/+$/, ""),
    basePath: options.basePath ?? API_BASE_PATH,
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    headers: options.headers,
    credentials: runtimeSupportsCredentials ? (options.credentials ?? "include") : undefined,
    validateResponses: options.validateResponses ?? false,
  };
}

function buildClient(
  table: Readonly<Record<string, RuntimeRoute>>,
  resolved: ResolvedOptions,
): Record<string, unknown> {
  const client: Record<string, unknown> = {};
  for (const [name, route] of Object.entries(table)) {
    client[name] = (input?: AnyRouteInput, requestOptions?: RequestOptions) =>
      performRequest(route, input ?? {}, requestOptions ?? {}, resolved);
  }
  return client;
}

/**
 * Create the typed Webflix API client. Works in browsers, Node and Workers, and carries no
 * schema library: use it in the app bundle.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  return buildClient(ROUTE_INDEX, resolveOptions(options)) as ApiClient;
}

export interface AdminApiClientOptions extends Omit<ApiClientOptions, "basePath"> {
  /**
   * The staff access token for `Authorization: Bearer`, read before every request (so a
   * refreshed token is picked up). Staff identity never becomes a member session.
   */
  accessToken: () => string | Promise<string>;
}

/** Typed client for the staff API, zod-free like `createApiClient`. */
export function createAdminApiClient(options: AdminApiClientOptions): AdminApiClient {
  const { accessToken, headers, ...rest } = options;
  return buildClient(
    ADMIN_ROUTE_INDEX,
    resolveOptions({
      ...rest,
      basePath: ADMIN_API_BASE_PATH,
      headers: async () => {
        const merged = new Headers(typeof headers === "function" ? await headers() : headers);
        merged.set("Authorization", `Bearer ${await accessToken()}`);
        return merged;
      },
    }),
  ) as AdminApiClient;
}

/**
 * The URL of a browser navigation (a redirect route such as `startOidc`): assign it to
 * `window.location`, never `fetch` it (the issuer's page is cross-origin).
 */
export function navigationUrl<K extends keyof NavigationRoutes<Routes>>(
  name: K,
  input: NavigationRoutes<Routes>[K] extends RouteSpec
    ? RouteInput<NavigationRoutes<Routes>[K]>
    : never,
  options: { baseUrl?: string } = {},
): string {
  const route = NAVIGATION_ROUTE_INDEX[name as keyof typeof NAVIGATION_ROUTE_INDEX];
  return buildUrl(
    route,
    input as AnyRouteInput,
    (options.baseUrl ?? "").replace(/\/+$/, ""),
    API_BASE_PATH,
  );
}

/**
 * Build a client from a full route table (with schemas). Pass `routes` and
 * `validateResponses: true` in tests and dev to check every response against the contract.
 */
export function createRouteClient<T extends RouteTable>(
  table: T,
  options: RouteClientOptions = {},
): ApiClientFor<T> {
  return buildClient(table, resolveOptions(options)) as ApiClientFor<T>;
}

/** Call a single route (from a full table) without building a client. */
export function callRoute<R extends RouteSpec>(
  route: R,
  input: RouteInput<R>,
  options: RouteClientOptions & RequestOptions = {},
): Promise<RouteOutput<R>> {
  const { signal, headers, keepalive, ...clientOptions } = options;
  const requestOptions: RequestOptions = { headers };
  if (signal) requestOptions.signal = signal;
  if (keepalive !== undefined) requestOptions.keepalive = keepalive;
  return performRequest(
    route,
    input as AnyRouteInput,
    requestOptions,
    resolveOptions(clientOptions),
  ) as Promise<RouteOutput<R>>;
}

interface AnyRouteInput {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
}

function buildUrl(
  route: Pick<RuntimeRoute, "path">,
  input: AnyRouteInput,
  baseUrl: string,
  basePath: string,
): string {
  let url = `${baseUrl}${basePath}${buildPath(route.path, input.params)}`;
  if (input.query) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(input.query)) {
      if (value === undefined || value === null) continue;
      search.set(key, String(value));
    }
    const encoded = search.toString();
    if (encoded) url += `?${encoded}`;
  }
  return url;
}

async function buildHeaders(
  route: RuntimeRoute,
  hasBody: boolean,
  options: ResolvedOptions,
  requestOptions: RequestOptions,
): Promise<Headers> {
  const defaults =
    typeof options.headers === "function" ? await options.headers() : options.headers;
  const headers = new Headers(defaults);
  headers.set("Accept", `${JSON_CONTENT_TYPE}, ${PROBLEM_CONTENT_TYPE}`);
  if (hasBody) headers.set("Content-Type", JSON_CONTENT_TYPE);
  if (!isSafeMethod(route.method)) headers.set(CLIENT_HEADER, CLIENT_HEADER_VALUE);
  if (requestOptions.headers) {
    new Headers(requestOptions.headers).forEach((value, key) => {
      headers.set(key, value);
    });
  }
  return headers;
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true ||
    (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")
  );
}

async function performRequest(
  route: RuntimeRoute,
  input: AnyRouteInput,
  requestOptions: RequestOptions,
  options: ResolvedOptions,
): Promise<unknown> {
  const url = buildUrl(route, input, options.baseUrl, options.basePath);
  const hasBody = input.body !== undefined;
  const init: ClientRequestInit = {
    method: route.method,
    headers: await buildHeaders(route, hasBody, options, requestOptions),
  };
  if (hasBody) init.body = JSON.stringify(input.body);
  if (options.credentials) init.credentials = options.credentials;
  if (requestOptions.signal) init.signal = requestOptions.signal;
  if (requestOptions.keepalive) init.keepalive = true;

  let response: Response;
  try {
    // Header resolution is async; honour an abort that happened meanwhile.
    requestOptions.signal?.throwIfAborted();
    response = await options.fetch(url, init);
  } catch (error) {
    if (isAbort(error, requestOptions.signal)) throw requestOptions.signal?.reason ?? error;
    throw new ApiError(clientProblem("network_error", 0, `${route.method} ${url} failed`), {
      cause: error,
    });
  }

  if (!response.ok) throw await toApiError(response, requestOptions.signal);
  if (response.status === 204 || route.response === null) {
    await response.body?.cancel();
    return undefined;
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    // An abort can land while the body streams in; report it as an abort, like fetch would.
    if (isAbort(error, requestOptions.signal)) throw requestOptions.signal?.reason ?? error;
    throw new ApiError(
      clientProblem("unexpected_response", response.status, "Response body is not valid JSON"),
      { cause: error },
    );
  }
  if (!options.validateResponses || !route.response) return data;
  const parsed = route.response.safeParse(data);
  if (!parsed.success) {
    throw new ApiError(
      clientProblem(
        "unexpected_response",
        response.status,
        `Response does not match the contract for ${route.method} ${route.path}`,
      ),
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

async function toApiError(response: Response, signal: AbortSignal | undefined): Promise<ApiError> {
  const contentType = response.headers.get("Content-Type") ?? "";
  let body: unknown;
  if (contentType.includes("json")) {
    body = await response.json().catch((error: unknown) => {
      if (isAbort(error, signal)) throw signal?.reason ?? error;
      return undefined;
    });
  } else {
    await response.body?.cancel();
  }
  if (isProblem(body)) return new ApiError(body);
  // A problem with a code this build does not know (a newer server behind a cached SPA):
  // keep the server's human-readable explanation.
  const known = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const explanation = [known.detail, known.title].find((value) => typeof value === "string");
  return new ApiError(
    clientProblem(
      "unexpected_response",
      response.status,
      typeof explanation === "string"
        ? explanation
        : `Unexpected ${response.status} response without a valid problem document`,
    ),
    { cause: body },
  );
}
