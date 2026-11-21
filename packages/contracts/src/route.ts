import type { z } from "zod";
import type { ErrorCode } from "./error-codes.ts";
import { type HttpMethod, isSafeMethod } from "./http.ts";

export const ROUTE_TAGS = [
  "auth",
  "account",
  "profiles",
  "browse",
  "titles",
  "search",
  "library",
  "notifications",
  "playback",
] as const;
export type RouteTag = (typeof ROUTE_TAGS)[number];

/**
 * Who may call a route. The server enforces it from the route table (see FOUNDATION.md):
 * - `public`: no session required (a session may still be present).
 * - `account`: a signed-in session; otherwise `unauthenticated`.
 * - `profile`: a signed-in session with an active profile; otherwise `profile_required`.
 * - `account-holder`: account management. A signed-in session whose active profile has no
 *   parental controls (not a kids profile, the highest maturity ceiling); otherwise
 *   `profile_required` (no active profile) or `unrestricted_profile_required`.
 */
export type RouteAuth = "public" | "account" | "profile" | "account-holder";

/**
 * Named rate-limit policies; their limits live in server config (`@webflix/core`).
 * - `auth`, `signup`, `email-lookup`: per client address (an IPv6 /64 counts as one).
 * - `auth-email`: sign-in attempts per email address, on top of `auth`.
 * - `profile-pin`: per account, every check of a PIN or of the account password after
 *   sign-in, whichever route it comes through.
 * - `payment`: per account, card verifications.
 * - `playback-start`: per account, playback sessions started.
 */
export const RATE_LIMIT_POLICY_NAMES = [
  "auth",
  "signup",
  "email-lookup",
  "profile-pin",
  "payment",
  "auth-email",
  "playback-start",
] as const;
export type RateLimitPolicyName = (typeof RATE_LIMIT_POLICY_NAMES)[number];

/**
 * Which requests of a rate-limited route consume its policy:
 * - `request`: every request, before anything else (the server's guard enforces it).
 * - `handler`: only the requests the route's description names (a PIN attempt on a locked
 *   profile, a request that carries a card); the handler enforces it.
 */
export type RateLimitScope = "request" | "handler";

/** Path parameters arrive as strings; schemas may coerce (`z.coerce.number<number>()`). */
type PathParamSchema = z.ZodType<unknown, string | number>;
/**
 * Query parameters are scalar strings on the wire; repeated keys and nested objects are not
 * supported. Booleans are excluded on purpose (`z.coerce.boolean()` reads "false" as true):
 * use `z.enum(["true", "false"])` if one is ever needed.
 */
type QueryParamSchema = z.ZodType<unknown, string | number | undefined>;

/**
 * One HTTP endpoint. Paths are relative to `API_BASE_PATH` and use `:name` parameters
 * (Hono syntax). Declare routes with `defineRoute`, which type-checks that `params`
 * declares exactly the path's parameters.
 */
export interface RouteSpec {
  readonly method: HttpMethod;
  readonly path: `/${string}`;
  readonly tag: RouteTag;
  readonly summary: string;
  readonly description?: string;
  readonly auth: RouteAuth;
  readonly params?: z.ZodObject<Record<string, PathParamSchema>>;
  readonly query?: z.ZodObject<Record<string, QueryParamSchema>>;
  /** JSON request body. Not allowed on GET. */
  readonly body?: z.ZodType;
  /** JSON success body, or `null` for `204 No Content`. Response schemas must not transform. */
  readonly response: z.ZodType | null;
  /** Success status when `response` is not null. Defaults to 200. */
  readonly successStatus?: 200 | 201 | 202;
  /** Route-specific error codes. Codes implied by auth/validation are added by `routeErrorCodes`. */
  readonly errors?: readonly ErrorCode[];
  readonly rateLimit?: RateLimitPolicyName;
  /** Defaults to `request`. */
  readonly rateLimitScope?: RateLimitScope;
  /**
   * Example request and success bodies for the OpenAPI document (a test parses each with the
   * route's schemas, so they cannot drift).
   */
  readonly examples?: { readonly request?: unknown; readonly response?: unknown };
}

export type RouteTable = Readonly<Record<string, RouteSpec>>;

/** `"/titles/:id/seasons/:n"` → `"id" | "n"`. */
export type PathParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | PathParamNames<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;

type ShapeKeys<S> = S extends z.ZodObject<infer Shape> ? keyof Shape : never;

type CheckParams<R extends RouteSpec> = [PathParamNames<R["path"]>] extends [never]
  ? R extends { params: z.ZodType }
    ? { params: "Error: this path has no :parameters; remove `params`" }
    : unknown
  : R extends { params: infer S }
    ? [
        | Exclude<PathParamNames<R["path"]>, ShapeKeys<S>>
        | Exclude<ShapeKeys<S>, PathParamNames<R["path"]>>,
      ] extends [never]
      ? unknown
      : { params: `Error: params must declare exactly: ${PathParamNames<R["path"]>}` }
    : { params: `Error: declare a params schema for: ${PathParamNames<R["path"]>}` };

type CheckBody<R extends RouteSpec> = R["method"] extends "GET"
  ? R extends { body: z.ZodType }
    ? { body: "Error: GET routes cannot have a body" }
    : unknown
  : unknown;

/**
 * Declare a route. Identity at runtime; at compile time it preserves the literal type and
 * rejects mismatches between the path's `:params` and the `params` schema.
 */
export function defineRoute<const R extends RouteSpec>(
  route: R & CheckParams<R> & CheckBody<R>,
): R {
  return route;
}

// --- Derived types ----------------------------------------------------------------------------

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type EmptyObject = Record<never, never>;

type ParamsInput<R> = R extends { params: infer S extends z.ZodType }
  ? { params: z.input<S> }
  : { params?: undefined };
type QueryInput<R> = R extends { query: infer S extends z.ZodType }
  ? EmptyObject extends z.input<S>
    ? { query?: z.input<S> }
    : { query: z.input<S> }
  : { query?: undefined };
// A route with a body schema takes a body (send `{}` for all-optional objects), so the zod-free
// client never has to know which routes expect one. The exception is a body schema that accepts
// `undefined` (`Schema.optional()`): the request may then carry no body at all.
type BodyInput<R> = R extends { body: infer S extends z.ZodType }
  ? undefined extends z.input<S>
    ? { body?: z.input<S> }
    : { body: z.input<S> }
  : { body?: undefined };

/** What a caller passes: `{ params, query, body }`, each present only if the route has it. */
export type RouteInput<R extends RouteSpec> = Simplify<
  ParamsInput<R> & QueryInput<R> & BodyInput<R>
>;

/** True when every part of the input is optional (the client argument may be omitted). */
export type RouteInputOptional<R extends RouteSpec> =
  EmptyObject extends RouteInput<R> ? true : false;

/** What the server sees after validation (zod output types, coercions applied). */
export interface RouteRequest<R extends RouteSpec> {
  params: R extends { params: infer S extends z.ZodType } ? z.output<S> : EmptyObject;
  query: R extends { query: infer S extends z.ZodType } ? z.output<S> : EmptyObject;
  body: R extends { body: infer S extends z.ZodType } ? z.output<S> : undefined;
}

/** What a handler returns for a successful response (nothing for 204 routes). */
export type RouteResult<R extends RouteSpec> = R["response"] extends z.ZodType
  ? z.input<R["response"]>
  : // biome-ignore lint/suspicious/noConfusingVoidType: a 204 handler may simply not return.
    void;

/** What the client resolves with. `undefined` for 204 routes. */
export type RouteOutput<R extends RouteSpec> = R["response"] extends z.ZodType
  ? z.output<R["response"]>
  : undefined;

// --- Runtime index (what the zod-free client needs) ---------------------------------------------

/** Method and path of one route: all the browser client needs at runtime. */
export interface RouteIndexEntry {
  readonly method: HttpMethod;
  readonly path: `/${string}`;
}

/** Derive the runtime index of a route table (used by the generator and its sync test). */
export function routeIndexOf<T extends RouteTable>(table: T): { [K in keyof T]: RouteIndexEntry } {
  return Object.fromEntries(
    Object.entries(table).map(([name, route]) => [
      name,
      { method: route.method, path: route.path },
    ]),
  ) as { [K in keyof T]: RouteIndexEntry };
}

// --- Runtime helpers --------------------------------------------------------------------------

export function successStatus(route: RouteSpec): 200 | 201 | 202 | 204 {
  return route.response === null ? 204 : (route.successStatus ?? 200);
}

/** True when the route's body schema accepts no body at all (`Schema.optional()`). */
export function isBodyOptional(route: RouteSpec): boolean {
  return route.body?.safeParse(undefined).success === true;
}

export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1] ?? "");
}

/** Substitute `:name` segments with URL-encoded values. Throws when a value is missing. */
export function buildPath(path: string, params: Readonly<Record<string, unknown>> = {}): string {
  return path.replaceAll(/:([A-Za-z0-9_]+)/g, (_segment, name: string) => {
    const value = params[name];
    if (value === undefined || value === null || value === "") {
      throw new TypeError(`Missing path parameter "${name}" for ${path}`);
    }
    return encodeURIComponent(String(value));
  });
}

/** `/titles/:id` → `/titles/{id}` (OpenAPI path template). */
export function toOpenApiPath(path: string): string {
  return path.replaceAll(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/**
 * Every error code a route can produce: its own `errors` plus those implied by its auth
 * level, method, inputs and rate limit. Used for documentation and OpenAPI.
 */
export function routeErrorCodes(route: RouteSpec): ErrorCode[] {
  const codes = new Set<ErrorCode>();
  if (route.params || route.query || route.body) codes.add("validation_failed");
  if (route.body) {
    codes.add("bad_request");
    codes.add("payload_too_large");
    codes.add("unsupported_media_type");
  }
  if (!isSafeMethod(route.method)) codes.add("csrf_check_failed");
  if (route.auth !== "public") codes.add("unauthenticated");
  if (route.auth === "profile" || route.auth === "account-holder") codes.add("profile_required");
  if (route.auth === "account-holder") codes.add("unrestricted_profile_required");
  if (route.rateLimit) codes.add("rate_limited");
  for (const code of route.errors ?? []) codes.add(code);
  codes.add("internal_error");
  return [...codes];
}
