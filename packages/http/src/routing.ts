import {
  API_BASE_PATH,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  isBodyOptional,
  isSafeMethod,
  type RedirectResult,
  type RouteRequest,
  type RouteResult,
  type RouteSpec,
  type RouteTable,
  successStatus,
  type ValidationIssue,
} from "@webflix/contracts";
import { AppError } from "@webflix/core";
import type { Context, Env, Hono } from "hono";
import type { z } from "zod";

/**
 * Implements one route. Receives validated input (zod output types: coercions applied) and
 * the Hono context (cookies, headers, per-request container), and returns the success body,
 * typed by the route's response schema. Throw `AppError` for every expected failure.
 */
export type RouteHandler<R extends RouteSpec, E extends Env = Env> = (
  request: RouteRequest<R>,
  c: Context<E>,
) => RouteResult<R> | Promise<RouteResult<R>>;

/** A handler for every route of `T` (exhaustive at compile time). */
export type RouteHandlers<T extends RouteTable, E extends Env = Env> = {
  [K in keyof T]: RouteHandler<T[K], E>;
};

const NOT_IMPLEMENTED: unique symbol = Symbol.for("webflix.route.notImplemented");

/**
 * The handler of a route its area has not implemented yet. Bound routes answer every request
 * with `501 not_implemented` (`operationId`, `area`), before authentication, validation and
 * rate limits: the same answer for every caller, so a conformance suite recognises it from one
 * anonymous request. The served OpenAPI document marks the operation
 * `x-webflix-implementation: pending`.
 */
export function notImplemented<R extends RouteSpec, E extends Env = Env>(): RouteHandler<R, E> {
  const handler = (() => {
    throw new Error("A not-implemented route's handler is never called");
  }) as unknown as RouteHandler<R, E>;
  return Object.assign(handler, { [NOT_IMPLEMENTED]: true });
}

/** True for handlers made by `notImplemented()`. */
export function isNotImplemented(handler: unknown): boolean {
  return typeof handler === "function" && NOT_IMPLEMENTED in handler;
}

/** Operation ids of a handler set that are still `notImplemented()`. */
export function pendingOperations(handlers: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(handlers)
    .filter(([, handler]) => isNotImplemented(handler))
    .map(([name]) => name);
}

export interface BindOptions<E extends Env = Env> {
  /**
   * Runs before validation on every bound route, with the route's spec: enforce `auth`,
   * the CSRF header and `rateLimit` here from the route table, never per handler.
   */
  guard?: (route: RouteSpec, c: Context<E>) => void | Promise<void>;
  /** Parse every handler result with the response schema (dev/test). Default false. */
  validateResponses?: boolean;
  /** Largest accepted body when the route sets none (`RouteSpec.maxBodyBytes`). Default 1 MiB. */
  maxBodyBytes?: number;
  /** Prefix routes are mounted under. Default `API_BASE_PATH`. */
  basePath?: string;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function issuesOf(location: ValidationIssue["location"], error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    location,
    path: issue.path.map(String).join("."),
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Read the body as text, counting bytes as they stream in: `Content-Length` can be absent
 * (chunked) or wrong, so it is only a fast path, never the guard.
 */
async function readBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new AppError("payload_too_large");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new AppError("payload_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBodyText(request: Request, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBodyBytes(request, maxBytes));
}

/**
 * An `application/x-www-form-urlencoded` body (an issuer's `form_post`) as an object of strings.
 * A repeated field is refused, as issuers refuse repeated parameters.
 */
async function readFormBody(
  c: Context,
  maxBytes: number,
  issues: ValidationIssue[],
): Promise<Record<string, string>> {
  if (!/^application\/x-www-form-urlencoded\b/i.test(c.req.header("Content-Type") ?? "")) {
    throw new AppError("unsupported_media_type", {
      detail: "Send the body as application/x-www-form-urlencoded",
    });
  }
  const fields: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(await readBodyText(c.req.raw, maxBytes))) {
    if (Object.hasOwn(fields, name)) {
      issues.push({ location: "body", path: name, message: "Repeated field", code: "custom" });
    }
    fields[name] = value;
  }
  return fields;
}

/**
 * The JSON body. Where the body is optional, an empty or whitespace-only one is no body at all,
 * whatever `Content-Type` says (clients send the header on every request): `undefined`.
 */
async function readJsonBody(c: Context, maxBytes: number, optional: boolean): Promise<unknown> {
  const json = /^application\/(?:[\w.+-]+\+)?json\b/i.test(c.req.header("Content-Type") ?? "");
  const unsupported = () =>
    new AppError("unsupported_media_type", { detail: "Send the body as application/json" });
  if (!json && !optional) throw unsupported();
  const text = await readBodyText(c.req.raw, maxBytes);
  if (optional && text.trim() === "") return undefined;
  if (!json) throw unsupported();
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("bad_request", { detail: "Request body is not valid JSON" });
  }
}

/** Validate params, query and body against the route's schemas; collect every issue. */
async function parseRequest<R extends RouteSpec>(
  route: R,
  c: Context,
  maxBodyBytes: number,
): Promise<RouteRequest<R>> {
  const issues: ValidationIssue[] = [];
  const parse = (location: ValidationIssue["location"], schema: z.ZodType, value: unknown) => {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    issues.push(...issuesOf(location, result.error));
    return undefined;
  };

  const params = route.params ? parse("params", route.params, c.req.param()) : {};
  const query = route.query ? parse("query", route.query, c.req.query()) : {};
  // A route whose body is optional accepts a request without one; anything sent is checked.
  let body: unknown;
  if (route.bodyEncoding === "raw") {
    body = await readBodyBytes(c.req.raw, maxBodyBytes);
  } else if (route.body && route.bodyEncoding === "form") {
    body = parse("body", route.body, await readFormBody(c, maxBodyBytes, issues));
  } else if (route.body) {
    const optional = isBodyOptional(route);
    const sent = await readJsonBody(c, maxBodyBytes, optional);
    body = optional && sent === undefined ? undefined : parse("body", route.body, sent);
  }
  if (issues.length > 0) throw new AppError("validation_failed", { issues });
  return { params, query, body } as RouteRequest<R>;
}

/**
 * Register one route of the table on a Hono app. The method, path, validation and success
 * status all come from the route spec; the handler only implements behaviour.
 */
export function bindRoute<R extends RouteSpec, E extends Env = Env>(
  app: Hono<E>,
  route: R,
  handler: RouteHandler<R, E>,
  options: BindOptions<E> & { operationId?: string } = {},
): void {
  const basePath = options.basePath ?? API_BASE_PATH;
  const maxBodyBytes = route.maxBodyBytes ?? options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (isNotImplemented(handler)) {
    const operationId = options.operationId ?? `${route.method} ${route.path}`;
    app.on(route.method, `${basePath}${route.path}`, () => {
      throw new AppError("not_implemented", {
        operationId,
        area: route.area,
        detail: `${route.method} ${basePath}${route.path} (${operationId}) is part of the contract, but the ${route.area} area has not implemented it yet.`,
      });
    });
    return;
  }
  app.on(route.method, `${basePath}${route.path}`, async (c) => {
    await options.guard?.(route, c);
    const request = await parseRequest(route, c, maxBodyBytes);
    const result = await handler(request, c);
    if (route.redirect !== undefined) {
      return c.redirect((result as RedirectResult).location, route.redirect);
    }
    const status = successStatus(route);
    if (route.response === null) return c.body(null, 204);
    const body = options.validateResponses ? route.response.parse(result) : result;
    return c.json(body as object, status as 200 | 201 | 202);
  });
}

/** Register every route of `table` with its handler. */
export function bindRoutes<T extends RouteTable, E extends Env = Env>(
  app: Hono<E>,
  table: T,
  handlers: RouteHandlers<T, E>,
  options: BindOptions<E> = {},
): void {
  for (const name of Object.keys(table) as (keyof T & string)[]) {
    const route = table[name];
    if (route) bindRoute(app, route, handlers[name], { ...options, operationId: name });
  }
}

/**
 * Guard enforcing the CSRF header of blueprint §2.3 on every non-safe method.
 * Compose it into `BindOptions.guard`.
 */
export function requireClientHeader(route: RouteSpec, c: Context): void {
  // `csrf: "none"`: a caller that cannot send the header, authenticated otherwise (a signed
  // webhook, an issuer's form post bound to the transaction cookie).
  if (isSafeMethod(route.method) || route.csrf === "none") return;
  if (c.req.header(CLIENT_HEADER) !== CLIENT_HEADER_VALUE) {
    throw new AppError("csrf_check_failed", {
      detail: `Send the ${CLIENT_HEADER}: ${CLIENT_HEADER_VALUE} header on state-changing requests`,
    });
  }
}
