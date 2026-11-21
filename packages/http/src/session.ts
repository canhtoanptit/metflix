import type { RateLimitPolicyName, RouteSpec } from "@webflix/contracts";
import {
  AppError,
  type AuthContext,
  requireAccountHolder as assertAccountHolder,
  type ChargeCredentialCheck,
  type Viewer,
} from "@webflix/core";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { clientAddressKey } from "./client-address.ts";
import type { AppContainer, AppEnv } from "./container.ts";
import { requireClientHeader } from "./routing.ts";

type AppContext = Context<AppEnv>;

/**
 * Session cookie: opaque token, HttpOnly, SameSite=Lax, Path=/, Secure (and `__Host-`
 * prefixed by config) outside plain-http dev (blueprint §2.3). `maxAgeSec: null` makes a
 * browser-session cookie ("remember me" off).
 */
export function setSessionCookie(
  container: AppContainer,
  c: AppContext,
  token: string,
  maxAgeSec: number | null,
): void {
  setCookie(c, container.config.cookies.sessionCookieName, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: container.config.cookies.secure,
    ...(maxAgeSec === null ? {} : { maxAge: maxAgeSec }),
  });
}

/** The "known device" cookie: HttpOnly, a year, sent with every request like the session's. */
export function setKnownDeviceCookie(
  container: AppContainer,
  c: AppContext,
  device: { token: string; maxAgeSec: number },
): void {
  setCookie(c, container.config.cookies.knownDeviceCookieName, device.token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: container.config.cookies.secure,
    maxAge: device.maxAgeSec,
  });
}

export function knownDeviceCookie(container: AppContainer, c: AppContext): string | undefined {
  return getCookie(c, container.config.cookies.knownDeviceCookieName);
}

export function clearSessionCookie(container: AppContainer, c: AppContext): void {
  deleteCookie(c, container.config.cookies.sessionCookieName, {
    path: "/",
    secure: container.config.cookies.secure,
    httpOnly: true,
    sameSite: "Lax",
  });
}

/**
 * The request's session, resolved at most once per request (one query). A cookie that no
 * longer maps to a live session is cleared so the browser stops sending it.
 */
export function resolveAuth(container: AppContainer, c: AppContext): Promise<AuthContext | null> {
  const memo = c.get("auth");
  if (memo) return memo;
  const token = getCookie(c, container.config.cookies.sessionCookieName);
  const promise = (async () => {
    if (token === undefined) return null;
    const auth = await container.services.auth.authenticate(token);
    if (!auth) clearSessionCookie(container, c);
    return auth;
  })();
  c.set("auth", promise);
  return promise;
}

/** For `auth: "account"` routes, after the guard ran. */
export async function requireAccount(container: AppContainer, c: AppContext): Promise<AuthContext> {
  const auth = await resolveAuth(container, c);
  if (!auth) throw new AppError("unauthenticated");
  return auth;
}

/**
 * For `auth: "account-holder"` routes (account management): a profile without parental
 * controls must be active (`privileges.ts` decides).
 */
export async function requireAccountHolder(
  container: AppContainer,
  c: AppContext,
): Promise<AuthContext> {
  const auth = await requireAccount(container, c);
  assertAccountHolder(auth);
  return auth;
}

/** For `auth: "profile"` routes, after the guard ran. */
export async function requireViewer(container: AppContainer, c: AppContext): Promise<Viewer> {
  const auth = await requireAccount(container, c);
  if (!auth.profile) throw new AppError("profile_required");
  return { session: auth.session, profile: auth.profile };
}

export function defaultClientIp(c: Context): string {
  return c.req.header("CF-Connecting-IP") ?? "unknown";
}

/**
 * Policies that protect an account (credential guessing, card testing, playback starts) rather
 * than a form: keyed by the signed-in account, wherever its requests come from.
 */
const ACCOUNT_KEYED_POLICIES: ReadonlySet<RateLimitPolicyName> = new Set([
  "profile-pin",
  "payment",
  "playback-start",
]);

/**
 * Rate-limit key per policy: by account for account-keyed policies, else by client address,
 * an IPv6 address by its /64 (one subscriber's allocation: rotating within it gains nothing).
 */
async function rateLimitKey(
  container: AppContainer,
  c: AppContext,
  policy: RateLimitPolicyName,
): Promise<string> {
  if (ACCOUNT_KEYED_POLICIES.has(policy)) {
    const auth = await resolveAuth(container, c);
    if (auth) return `account:${auth.session.accountId}`;
  }
  return `ip:${clientAddressKey((container.clientIp ?? defaultClientIp)(c))}`;
}

/**
 * Consume one unit of `policy` for this request's client (account or address), or for `key`
 * when the handler names what is limited (an email address); `rate_limited` once exhausted.
 * The guard calls it for `request`-scoped routes; handlers of `handler`-scoped routes call it
 * for exactly the requests the route says count.
 */
export async function enforceRateLimit(
  container: AppContainer,
  c: AppContext,
  policy: RateLimitPolicyName,
  key?: string,
): Promise<void> {
  const decision = await container.rateLimiter.consume(
    container.config.rateLimits[policy],
    key ?? (await rateLimitKey(container, c, policy)),
  );
  if (!decision.allowed) {
    throw new AppError("rate_limited", { retryAfterSec: decision.retryAfterSec });
  }
}

/**
 * The charge for one password or PIN check after sign-in: every such check, whatever the route,
 * spends the account's `profile-pin` budget before any hashing (docs/DECISIONS.md D25).
 */
export function credentialCharge(container: AppContainer, c: AppContext): ChargeCredentialCheck {
  return () => enforceRateLimit(container, c, "profile-pin");
}

/**
 * Cross-cutting policy, driven by the route table: CSRF header, authentication and rate
 * limits. Handlers never repeat these checks.
 */
export function createGuard(container: AppContainer) {
  return async (route: RouteSpec, c: AppContext): Promise<void> => {
    requireClientHeader(route, c);
    if (route.auth === "account") await requireAccount(container, c);
    if (route.auth === "profile") await requireViewer(container, c);
    if (route.auth === "account-holder") await requireAccountHolder(container, c);
    if (route.rateLimit && route.rateLimitScope !== "handler") {
      await enforceRateLimit(container, c, route.rateLimit);
    }
  };
}
