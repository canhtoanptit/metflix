/**
 * The suite's only way to reach a target: an `Agent` is one browser (one cookie jar, one
 * device). Every request is recorded as an `Exchange` so a failing check can show exactly what
 * was sent and what came back, and the typed client from `@webflix/contracts` runs on top with
 * response validation on, so contract drift fails the check that observed it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  ADMIN_API_BASE_PATH,
  type AdminApiClient,
  type ApiClient,
  ApiError,
  adminRoutes,
  createRouteClient,
  PROBLEM_CONTENT_TYPE,
  REQUEST_ID_HEADER,
  routes,
} from "@webflix/contracts";
import { CookieJar } from "./cookies.ts";

export interface Exchange {
  seq: number;
  agent: string;
  /** The `X-Request-Id` the suite sent (servers echo it, so it greps in their logs). */
  requestId: string;
  method: string;
  /** Path and query relative to the target, media tokens shortened. */
  url: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  /** 0 when the request never got a response. */
  status: number;
  responseHeaders: Record<string, string>;
  /** Text excerpt, or a size note for binary bodies. */
  responseBody?: string;
  durationMs: number;
  error?: string;
  startedAt: number;
}

/** A buffered response. */
export interface HttpResult {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  text(): string;
  json<T = unknown>(): T;
  exchange: Exchange;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** A string body is sent as is; an object is JSON-encoded. */
  body?: string | object;
  /** Overrides the agent's 429 handling for this request. */
  retryOn429?: boolean;
  /** Fail when a body is larger than this. Default 64 MiB. */
  maxBytes?: number;
  /** Do not send the jar's cookies. */
  omitCookies?: boolean;
  /**
   * Follow same-origin redirects of GET and HEAD like a browser (default). Off: the redirect
   * itself is the result (federated sign-in reads each `Location` on the way).
   */
  followRedirects?: boolean;
}

/** What a running check provides to the requests made inside it (see `runInCheckScope`). */
export interface RequestScope {
  collectors: Exchange[][];
  signal?: AbortSignal;
  note?: (message: string) => void;
}

const scopes = new AsyncLocalStorage<RequestScope>();
const MAX_RECORDED = 400;
const exchangeByError = new WeakMap<object, Exchange>();

export function runInScope<T>(scope: RequestScope, fn: () => Promise<T>): Promise<T> {
  return scopes.run(scope, fn);
}

/** Run `fn` outside any check (background timers of shared fixtures). */
export function runDetached<T>(fn: () => T): T {
  return scopes.exit(fn);
}

export function currentScope(): RequestScope | undefined {
  return scopes.getStore();
}

/** Collect the exchanges made by `fn` (in addition to the enclosing collectors). */
export async function capture<T>(
  fn: () => Promise<T>,
): Promise<
  | { ok: true; value: T; exchanges: Exchange[] }
  | { ok: false; error: unknown; exchanges: Exchange[] }
> {
  const parent = scopes.getStore();
  const exchanges: Exchange[] = [];
  const scope: RequestScope = { ...parent, collectors: [...(parent?.collectors ?? []), exchanges] };
  try {
    const value = await scopes.run(scope, fn);
    return { ok: true, value, exchanges };
  } catch (error) {
    return { ok: false, error, exchanges };
  }
}

/** The exchange that produced an error thrown by an agent's typed client, if known. */
export function exchangeOf(error: unknown): Exchange | undefined {
  return typeof error === "object" && error !== null ? exchangeByError.get(error) : undefined;
}

function record(exchange: Exchange): void {
  for (const collector of scopes.getStore()?.collectors ?? []) {
    collector.push(exchange);
    if (collector.length > MAX_RECORDED) collector.splice(0, collector.length - MAX_RECORDED);
  }
}

const TEXTUAL = /json|text|mpegurl|javascript|xml|vtt|html/i;

function excerpt(bytes: Uint8Array, contentType: string | null, limit = 1500): string {
  if (bytes.byteLength === 0) return "";
  if (!contentType || !TEXTUAL.test(contentType)) return `<${bytes.byteLength} bytes>`;
  const text = new TextDecoder().decode(bytes.subarray(0, limit * 4));
  return text.length > limit ? `${text.slice(0, limit)}… (${bytes.byteLength} bytes)` : text;
}

/** `/media/<long token>/vod/...` → `/media/<abcdefgh…wxyz>/vod/...` for readable reports. */
export function displayPath(path: string): string {
  return path.replace(/^\/media\/([^/]+)\//, (_whole, token: string) =>
    token.length > 20 ? `/media/${token.slice(0, 10)}…${token.slice(-6)}/` : `/media/${token}/`,
  );
}

function headerRecord(headers: Headers, redact: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = redact.includes(key) ? "<redacted>" : value;
  });
  return out;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface AgentOptions {
  baseUrl: string;
  label: string;
  runId: string;
  requestTimeoutMs: number;
  /** Wait out `rate_limited` answers (they never have side effects) and retry. Default true. */
  retryOn429?: boolean;
  /** Longest single Retry-After the agent waits before giving up. Default 90 s. */
  maxRetryAfterSec?: number;
  userAgent?: string;
  verbose?: (line: string) => void;
}

let sequence = 0;

/** Chrome-on-macOS user agent: device labels read "Chrome on macOS" like a real browser's. */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 webflix-smoke/1";

export class Agent {
  readonly label: string;
  readonly jar = new CookieJar();
  readonly origin: string;
  readonly api: ApiClient;
  private readonly options: AgentOptions;
  private readonly aliases = new Set<string>();

  constructor(options: AgentOptions) {
    this.options = options;
    this.label = options.label;
    this.origin = new URL(options.baseUrl).origin;
    const client = createRouteClient(routes, {
      baseUrl: this.origin,
      validateResponses: true,
      fetch: (input, init) => this.transport(input, init),
    });
    this.api = withExchanges(client);
  }

  /**
   * The staff API (`/api/admin/v1`) with a bearer token, through this agent (its cookies are
   * sent too, as a browser would: the staff API must ignore them). Responses are validated.
   */
  staffApi(accessToken: string): AdminApiClient {
    return withExchanges(
      createRouteClient(adminRoutes, {
        baseUrl: this.origin,
        basePath: ADMIN_API_BASE_PATH,
        validateResponses: true,
        headers: { Authorization: `Bearer ${accessToken}` },
        fetch: (input, init) => this.transport(input, init),
      }),
    );
  }

  /** Raw request against the target (path or same-origin absolute URL). */
  async fetch(pathOrUrl: string, options: RequestOptions = {}): Promise<HttpResult> {
    const headers: Record<string, string> = { ...options.headers };
    let body: string | undefined;
    if (typeof options.body === "string") body = options.body;
    else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers["Content-Type"] ??= "application/json";
    }
    return this.send(pathOrUrl, {
      method: options.method ?? "GET",
      headers,
      ...(body === undefined ? {} : { body }),
      retryOn429: options.retryOn429 ?? this.options.retryOn429 ?? true,
      maxBytes: options.maxBytes ?? 64 * 1024 * 1024,
      omitCookies: options.omitCookies ?? false,
      followRedirects: options.followRedirects ?? true,
    });
  }

  /**
   * Treat `origin` as this target's own (the deployment's public origin when the suite reaches
   * it through another one, e.g. the API port behind the SPA's dev server): URLs the deployment
   * builds from its public origin, such as the development issuer's endpoints and the callbacks
   * it redirects to, are then requested from the base URL instead. Same host only: a browser
   * shares cookies across ports, so nothing a browser would not do is assumed.
   */
  alias(origin: string): void {
    const target = new URL(origin);
    if (target.hostname !== new URL(this.origin).hostname) {
      throw new Error(`Refusing to alias another host: ${target.origin}`);
    }
    if (target.origin !== this.origin) this.aliases.add(target.origin);
  }

  /** `pathOrUrl` as a path on this target when it is this target's (or an alias's), else null. */
  ownPath(pathOrUrl: string): string | null {
    const url = new URL(pathOrUrl, this.origin);
    if (url.origin !== this.origin && !this.aliases.has(url.origin)) return null;
    return `${url.pathname}${url.search}`;
  }

  /** The `fetch` the typed client uses. */
  private async transport(input: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const result = await this.send(input, {
      method: init.method ?? "GET",
      headers,
      ...(typeof init.body === "string" ? { body: init.body } : {}),
      retryOn429: this.options.retryOn429 ?? true,
      maxBytes: 64 * 1024 * 1024,
      omitCookies: false,
      followRedirects: true,
    });
    const nullBody = [101, 204, 205, 304].includes(result.status) || init.method === "HEAD";
    return new Response(nullBody ? null : (result.bytes as Uint8Array<ArrayBuffer>), {
      status: result.status,
      headers: result.headers,
    });
  }

  private resolve(pathOrUrl: string): URL {
    const own = this.ownPath(pathOrUrl);
    const url = new URL(own ?? pathOrUrl, this.origin);
    if (url.origin !== this.origin) {
      // External HLS fallbacks and anything else off-origin: the suite never calls them.
      throw new Error(`Refusing to fetch a third-party origin: ${url.origin}`);
    }
    return url;
  }

  private async send(
    pathOrUrl: string,
    request: {
      method: string;
      headers: Record<string, string>;
      body?: string;
      retryOn429: boolean;
      maxBytes: number;
      omitCookies: boolean;
      followRedirects: boolean;
    },
  ): Promise<HttpResult> {
    let url = this.resolve(pathOrUrl);
    const scope = scopes.getStore();
    let throttledSec = 0;
    let redirects = 0;
    for (;;) {
      const result = await this.sendOnce(url, request, scope?.signal);
      const location = result.headers.get("Location");
      // Follow same-origin redirects like a browser; never follow one off-origin.
      if (
        request.followRedirects &&
        result.status >= 300 &&
        result.status < 400 &&
        result.status !== 304 &&
        location &&
        (request.method === "GET" || request.method === "HEAD") &&
        redirects < 5
      ) {
        const own = this.ownPath(new URL(location, url).href);
        if (own === null) return result;
        url = new URL(own, this.origin);
        redirects += 1;
        continue;
      }
      if (result.status !== 429 || !request.retryOn429) return result;
      const retryAfter = retryAfterSeconds(result);
      if (retryAfter === null || retryAfter > (this.options.maxRetryAfterSec ?? 90)) return result;
      throttledSec += retryAfter;
      scope?.note?.(
        `throttled by rate_limited on ${request.method} ${result.exchange.url}: waited ${retryAfter}s (Retry-After)`,
      );
      if (throttledSec > 600) return result;
      // A little jitter so parallel checks waiting on one bucket do not stampede it.
      await sleep(retryAfter * 1000 + Math.floor(Math.random() * 300), scope?.signal);
    }
  }

  private async sendOnce(
    url: URL,
    request: {
      method: string;
      headers: Record<string, string>;
      body?: string;
      maxBytes: number;
      omitCookies: boolean;
    },
    signal: AbortSignal | undefined,
  ): Promise<HttpResult> {
    sequence += 1;
    const seq = sequence;
    const requestId = `smk-${this.options.runId}-${seq}`;
    const headers = new Headers(request.headers);
    if (!headers.has(REQUEST_ID_HEADER)) headers.set(REQUEST_ID_HEADER, requestId);
    if (!headers.has("User-Agent")) {
      headers.set("User-Agent", this.options.userAgent ?? BROWSER_USER_AGENT);
    }
    const cookie = request.omitCookies ? null : this.jar.header();
    if (cookie && !headers.has("Cookie")) headers.set("Cookie", cookie);

    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const started = performance.now();
    const exchange: Exchange = {
      seq,
      agent: this.label,
      requestId: headers.get(REQUEST_ID_HEADER) ?? requestId,
      method: request.method,
      url: displayPath(url.pathname) + url.search,
      requestHeaders: headerRecord(headers, ["cookie", "authorization"]),
      ...(request.body === undefined ? {} : { requestBody: request.body.slice(0, 1500) }),
      status: 0,
      responseHeaders: {},
      durationMs: 0,
      startedAt: Date.now(),
    };
    let response: Response;
    try {
      response = await fetch(url, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: combined,
        redirect: "manual",
      });
    } catch (error) {
      exchange.durationMs = Math.round(performance.now() - started);
      exchange.error =
        timeout.aborted && !signal?.aborted
          ? `request timed out after ${this.options.requestTimeoutMs} ms`
          : error instanceof Error
            ? `${error.message}${error.cause instanceof Error ? ` (${error.cause.message})` : ""}`
            : String(error);
      record(exchange);
      this.options.verbose?.(
        `${this.label} ${request.method} ${exchange.url} -> ${exchange.error}`,
      );
      if (signal?.aborted) throw signal.reason;
      throw new NetworkError(exchange);
    }
    this.jar.store(response.headers.getSetCookie());
    const contentLength = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(contentLength) && contentLength > request.maxBytes) {
      await response.body?.cancel();
      throw new Error(`Response too large: ${contentLength} bytes`);
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      exchange.status = response.status;
      exchange.error = `body read failed: ${error instanceof Error ? error.message : String(error)}`;
      record(exchange);
      if (signal?.aborted) throw signal.reason;
      throw new NetworkError(exchange);
    }
    exchange.status = response.status;
    exchange.responseHeaders = headerRecord(response.headers, ["set-cookie"]);
    exchange.responseBody = excerpt(bytes, response.headers.get("Content-Type"));
    exchange.durationMs = Math.round(performance.now() - started);
    record(exchange);
    this.options.verbose?.(
      `${this.label} ${request.method} ${exchange.url} -> ${response.status} (${exchange.durationMs} ms)`,
    );
    const decoded = () => new TextDecoder().decode(bytes);
    return {
      status: response.status,
      headers: response.headers,
      bytes,
      text: decoded,
      json: <T>() => JSON.parse(decoded()) as T,
      exchange,
    };
  }
}

/** Each typed call runs in its own collector so a rejection can carry its exchange. */
function withExchanges<T extends object>(client: T): T {
  return new Proxy(client, {
    get: (target, property, receiver) => {
      const method = Reflect.get(target, property, receiver) as unknown;
      if (typeof method !== "function") return method;
      return async (...args: unknown[]) => {
        const result = await capture(() =>
          (method as (...a: unknown[]) => Promise<unknown>)(...args),
        );
        if (result.ok) return result.value;
        const last = result.exchanges[result.exchanges.length - 1];
        if (last && typeof result.error === "object" && result.error !== null) {
          exchangeByError.set(result.error, last);
        }
        throw result.error;
      };
    },
  });
}

export class NetworkError extends Error {
  override readonly name = "NetworkError";
  readonly exchange: Exchange;
  constructor(exchange: Exchange) {
    super(`${exchange.method} ${exchange.url} failed: ${exchange.error ?? "no response"}`);
    this.exchange = exchange;
  }
}

function retryAfterSeconds(result: HttpResult): number | null {
  const header = Number(result.headers.get("Retry-After"));
  if (Number.isFinite(header) && header > 0) return header;
  if (result.headers.get("Content-Type")?.includes(PROBLEM_CONTENT_TYPE)) {
    try {
      const body = result.json<{ retryAfterSec?: unknown }>();
      if (typeof body.retryAfterSec === "number" && body.retryAfterSec > 0)
        return body.retryAfterSec;
    } catch {
      return null;
    }
  }
  return null;
}

/** True for an `ApiError` with the given code (narrowing helper for checks). */
export function isApiError(error: unknown, code?: string): error is ApiError {
  return ApiError.is(error) && (code === undefined || error.code === code);
}
