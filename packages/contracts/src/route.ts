import type { z } from "zod";
import type { StaffRole } from "./constants.ts";
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
  "billing",
  "events",
  "privacy",
  "webhooks",
  "diagnostics",
  "admin",
] as const;
export type RouteTag = (typeof ROUTE_TAGS)[number];

/**
 * Who implements a route (docs/FOUNDATION.md §8, the hand-off). Each area's handlers live in
 * `packages/http/src/handlers/<area>.ts`, typed so that it must implement exactly the routes of
 * its area. `streaming` is milestone 1's catalogue, library and playback surface, which no
 * milestone 2 area owns.
 */
export const ROUTE_AREAS = [
  "identity",
  "billing",
  "events",
  "personalisation",
  "experiments",
  "admin",
  "streaming",
] as const;
export type RouteArea = (typeof ROUTE_AREAS)[number];

/**
 * Who may call a route. The server enforces it from the route table (see FOUNDATION.md):
 * - `public`: no session required (a session may still be present).
 * - `account`: a signed-in session; otherwise `unauthenticated`.
 * - `profile`: a signed-in session with an active profile; otherwise `profile_required`.
 * - `account-holder`: account management. A signed-in session whose active profile has no
 *   parental controls (not a kids profile, the highest maturity ceiling); otherwise
 *   `profile_required` (no active profile) or `unrestricted_profile_required`.
 * - `staff`: the admin API. A staff bearer token (`Authorization: Bearer`) the `StaffVerifier`
 *   accepts, carrying the route's `staffRole` (or `admin`); otherwise `unauthenticated` or
 *   `staff_role_required`. Staff identity never becomes a member session.
 */
export type RouteAuth = "public" | "account" | "profile" | "account-holder" | "staff";

/**
 * How a request body is encoded:
 * - `json` (default): `application/json`, parsed and validated against `body`.
 * - `form`: `application/x-www-form-urlencoded` (an issuer's `form_post` callback), parsed into
 *   an object of strings and validated against `body`.
 * - `raw`: the bytes are handed to the handler unparsed (`Uint8Array`), because something is
 *   verified over them first (a webhook signature). Such routes declare no `body` schema.
 */
export type BodyEncoding = "json" | "form" | "raw";

/** What a staff route requires (see `RouteSpec.staffRole`). */
export type StaffRouteRole = StaffRole | "any";

/**
 * Named rate-limit policies; their limits live in server config (`@webflix/core`).
 * - `auth`, `signup`, `email-lookup`: per client address (an IPv6 /64 counts as one).
 * - `auth-email`: sign-in attempts per email address, on top of `auth`.
 * - `profile-pin`: per account, every check of a PIN or of the account password after
 *   sign-in, whichever route it comes through.
 * - `payment`: per account, card verifications.
 * - `playback-start`: per account, playback sessions started.
 * - `oidc`: per client address, federated sign-ins started or completed.
 * - `email-send`: per client address, requests that send a verification or password-reset
 *   email (milestone 2 §4.3).
 * - `email-send-recipient`: per recipient address, the same requests (charged by the handler
 *   once it knows the address, like `auth-email`).
 * - `events`: per account (signed out: per client address), behaviour event batches.
 * - `promotion`: per account, promo-code lookups (codes must not be guessable by enumeration),
 *   whichever route makes them (validation, or a checkout started with a code).
 * - `billing`: per account, member requests that create something at the payment provider
 *   (a checkout start, a card setup, a plan-change preview): one account cannot spend the
 *   provider's account-wide budget for every member.
 * - `billing-refresh`: per account, how often a poll (`GET /billing/checkout/:id`, a card
 *   change's status) reads the provider; a poll inside it answers from stored state, never 429.
 */
export const RATE_LIMIT_POLICY_NAMES = [
  "auth",
  "signup",
  "email-lookup",
  "profile-pin",
  "payment",
  "auth-email",
  "playback-start",
  "oidc",
  "email-send",
  "email-send-recipient",
  "events",
  "promotion",
  "billing",
  "billing-refresh",
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
  /** The area whose handler module implements the route (see `ROUTE_AREAS`). */
  readonly area: RouteArea;
  readonly summary: string;
  readonly description?: string;
  readonly auth: RouteAuth;
  /**
   * For `auth: "staff"` only, and required there: the role the token must carry (`admin` passes
   * every role check), or `any` for a route every staff token may call (its own identity).
   */
  readonly staffRole?: StaffRouteRole;
  readonly params?: z.ZodObject<Record<string, PathParamSchema>>;
  readonly query?: z.ZodObject<Record<string, QueryParamSchema>>;
  /** Request body (JSON unless `bodyEncoding` says otherwise). Not allowed on GET. */
  readonly body?: z.ZodType;
  /** Default `json`. `raw` routes declare no `body`; the handler receives the bytes. */
  readonly bodyEncoding?: BodyEncoding;
  /** Largest accepted body in bytes. Default 1 MiB. */
  readonly maxBodyBytes?: number;
  /**
   * CSRF defence for non-safe methods. `header` (default): the custom client header is
   * required. `none`: exempt, because the caller cannot send it and the request is
   * authenticated another way (an issuer's callback: state and PKCE bound to a cookie; a
   * webhook: its signature). Say how in `description`.
   */
  readonly csrf?: "header" | "none";
  /** JSON success body, or `null` for `204 No Content`. Response schemas must not transform. */
  readonly response: z.ZodType | null;
  /**
   * A browser navigation answered with a redirect: the handler returns `{ location }` and the
   * server answers this status with `Location`. Requires `response: null`. Such routes are not
   * methods of the typed client; build their URL with `navigationUrl`.
   */
  readonly redirect?: 302 | 303;
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
  : R extends { bodyEncoding: "raw" }
    ? R extends { body: z.ZodType }
      ? { body: "Error: raw-body routes declare no body schema" }
      : unknown
    : unknown;

type CheckStaff<R extends RouteSpec> = R["auth"] extends "staff"
  ? R extends { staffRole: StaffRouteRole }
    ? unknown
    : { staffRole: "Error: staff routes must name the role they need" }
  : R extends { staffRole: StaffRouteRole }
    ? { staffRole: "Error: only staff routes take a staffRole" }
    : unknown;

type CheckRedirect<R extends RouteSpec> = R extends { redirect: number }
  ? R["response"] extends null
    ? unknown
    : { response: "Error: redirect routes answer no JSON body (response: null)" }
  : unknown;

/**
 * Declare a route. Identity at runtime; at compile time it preserves the literal type and
 * rejects mismatches between the path's `:params` and the `params` schema, bodies on GET,
 * staff routes without a role and redirect routes with a JSON body.
 */
export function defineRoute<const R extends RouteSpec>(
  route: R & CheckParams<R> & CheckBody<R> & CheckStaff<R> & CheckRedirect<R>,
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
  /** A `raw` route's bytes, exactly as received (verify signatures over these). */
  body: R extends { bodyEncoding: "raw" }
    ? Uint8Array
    : R extends { body: infer S extends z.ZodType }
      ? z.output<S>
      : undefined;
}

/** Where a redirect route sends the browser (an absolute URL or a same-origin path). */
export interface RedirectResult {
  location: string;
}

/** What a handler returns for a successful response (nothing for 204 routes). */
export type RouteResult<R extends RouteSpec> = R extends { redirect: number }
  ? RedirectResult
  : R["response"] extends z.ZodType
    ? z.input<R["response"]>
    : // biome-ignore lint/suspicious/noConfusingVoidType: a 204 handler may simply not return.
      void;

/** What the client resolves with. `undefined` for 204 routes. */
export type RouteOutput<R extends RouteSpec> = R["response"] extends z.ZodType
  ? z.output<R["response"]>
  : undefined;

/**
 * Routes the typed client calls with `fetch`: JSON in, JSON (or nothing) out. Redirect routes
 * (browser navigations), form callbacks and raw webhooks are served and documented like any
 * other route but are not client methods.
 */
export type IsClientRoute<R> = R extends { redirect: number }
  ? false
  : R extends { bodyEncoding: "form" | "raw" }
    ? false
    : true;

/** The subset of a table the typed client exposes. */
export type ClientRoutes<T extends RouteTable> = {
  [K in keyof T as IsClientRoute<T[K]> extends true ? K : never]: T[K];
};

/** Redirect routes the browser navigates to with a GET (e.g. starting a federated sign-in). */
export type NavigationRoutes<T extends RouteTable> = {
  [K in keyof T as T[K] extends { redirect: number; method: "GET" } ? K : never]: T[K];
};

/** Routes of one area of a table. */
export type AreaRoutes<T extends RouteTable, A extends RouteArea> = {
  [K in keyof T as T[K]["area"] extends A ? K : never]: T[K];
};

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

/** True for routes the typed client calls (see `IsClientRoute`). */
export function isClientRoute(route: RouteSpec): boolean {
  return (
    route.redirect === undefined && route.bodyEncoding !== "form" && route.bodyEncoding !== "raw"
  );
}

/** True for redirect routes the browser reaches with a GET navigation. */
export function isNavigationRoute(route: RouteSpec): boolean {
  return route.redirect !== undefined && route.method === "GET";
}

// --- Runtime helpers --------------------------------------------------------------------------

export function successStatus(route: RouteSpec): 200 | 201 | 202 | 204 | 302 | 303 {
  if (route.redirect !== undefined) return route.redirect;
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
  if (route.bodyEncoding === "raw") codes.add("payload_too_large");
  if (!isSafeMethod(route.method) && route.csrf !== "none") codes.add("csrf_check_failed");
  if (route.auth !== "public") codes.add("unauthenticated");
  if (route.auth === "profile" || route.auth === "account-holder") codes.add("profile_required");
  if (route.auth === "account-holder") codes.add("unrestricted_profile_required");
  if (route.auth === "staff") codes.add("staff_role_required");
  if (route.rateLimit) codes.add("rate_limited");
  for (const code of route.errors ?? []) codes.add(code);
  codes.add("internal_error");
  return [...codes];
}
