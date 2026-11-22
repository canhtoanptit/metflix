/**
 * Rate-limit measurement. Limits are configuration, not contract, so they are measured: a
 * fresh account's `profile-pin` bucket (keyed by account, so measuring it affects nobody else)
 * is hit with one concurrent burst of PIN attempts on a locked profile (only those count; see
 * `PUT /session/profile`) and the admitted count is compared with the documented values
 * (docs/BACKEND.md §3–4): strict defaults everywhere except dev, which relaxes most of them.
 */
import {
  API_BASE_PATH,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  type Profile,
  type RateLimitPolicyName,
} from "@webflix/contracts";
import type { Environment, TestAccount } from "./env.ts";
import { succeeds } from "./expect.ts";
import type { Agent, HttpResult } from "./http.ts";
import type { RateLimitSpec } from "./types.ts";

/** The PIN the suite locks its measuring profiles with. */
export const SMOKE_PIN = "4826";

export const DOCUMENTED_LIMITS: Record<
  "strict" | "relaxed",
  Record<RateLimitPolicyName, RateLimitSpec>
> = {
  strict: {
    auth: { limit: 10, windowSec: 60 },
    signup: { limit: 5, windowSec: 60 },
    "email-lookup": { limit: 20, windowSec: 60 },
    "profile-pin": { limit: 5, windowSec: 60 },
    payment: { limit: 10, windowSec: 600 },
    "auth-email": { limit: 10, windowSec: 900 },
    "playback-start": { limit: 60, windowSec: 60 },
    // Milestone 2's policies (docs/BACKEND.md §3); no check measures them yet.
    oidc: { limit: 30, windowSec: 60 },
    "email-send": { limit: 10, windowSec: 900 },
    "email-send-recipient": { limit: 5, windowSec: 900 },
    events: { limit: 120, windowSec: 60 },
    promotion: { limit: 10, windowSec: 600 },
  },
  // Dev relaxes what e2e suites sharing one address and the demo account would trip; budgets
  // per account or per email (cards, sign-ins to one account, playback starts) stay strict.
  relaxed: {
    auth: { limit: 60, windowSec: 60 },
    signup: { limit: 60, windowSec: 60 },
    "email-lookup": { limit: 300, windowSec: 60 },
    "profile-pin": { limit: 60, windowSec: 60 },
    payment: { limit: 10, windowSec: 600 },
    "auth-email": { limit: 10, windowSec: 900 },
    "playback-start": { limit: 60, windowSec: 60 },
    oidc: { limit: 300, windowSec: 60 },
    "email-send": { limit: 120, windowSec: 60 },
    "email-send-recipient": { limit: 5, windowSec: 900 },
    events: { limit: 600, windowSec: 60 },
    promotion: { limit: 10, windowSec: 600 },
  },
};

export interface BurstResult {
  sent: number;
  allowed: number;
  limited: number;
  /** Responses that were neither success nor 429 (status → count). */
  other: Map<number, number>;
  durationMs: number;
  results: HttpResult[];
}

/** Fire `count` requests at once and tally them. */
export async function burst(
  count: number,
  send: (index: number) => Promise<HttpResult>,
): Promise<BurstResult> {
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: count }, (_, index) => send(index)));
  const durationMs = Math.round(performance.now() - started);
  const other = new Map<number, number>();
  let allowed = 0;
  let limited = 0;
  for (const result of results) {
    if (result.status >= 200 && result.status < 300) allowed += 1;
    else if (result.status === 429) limited += 1;
    else other.set(result.status, (other.get(result.status) ?? 0) + 1);
  }
  return { sent: count, allowed, limited, other, durationMs, results };
}

/**
 * Admitted requests a correct limiter may allow in a burst lasting `durationMs`: the limit,
 * plus what refills meanwhile (GCRA and sliding windows refill continuously).
 */
export function admissible(spec: RateLimitSpec, durationMs: number): { min: number; max: number } {
  // GCRA/sliding windows admit one more request per elapsed interval (window / limit).
  const refill = Math.floor((durationMs / 1000) * (spec.limit / spec.windowSec));
  return { min: spec.limit, max: spec.limit + refill };
}

/** The limit a policy is expected to have under the run's `--rate-limits` setting. */
export function expectedSpec(
  env: Environment,
  policy: RateLimitPolicyName,
  classification: Classification,
): RateLimitSpec | null {
  const expectation = env.options.rateLimits;
  switch (expectation.mode) {
    case "strict":
      return DOCUMENTED_LIMITS.strict[policy];
    case "relaxed":
      return DOCUMENTED_LIMITS.relaxed[policy];
    case "custom":
      return expectation.limits[policy] ?? null;
    case "auto":
      return classification === "strict"
        ? DOCUMENTED_LIMITS.strict[policy]
        : classification === "relaxed"
          ? DOCUMENTED_LIMITS.relaxed[policy]
          : null;
  }
}

export type Classification = "strict" | "relaxed" | "other" | "none";

export interface ProfilePinMeasurement {
  account: TestAccount;
  agent: Agent;
  profile: Profile;
  burst: BurstResult;
  /** Units of the budget the account spent: the burst's admitted attempts and the setup's. */
  allowed: number;
  classification: Classification;
  /** The limit the run expects for profile-pin (null when unknown). */
  expected: RateLimitSpec | null;
  matchesExpected: boolean;
  verdict: string;
  maxRetryAfterSec: number;
}

/** PUT /session/profile as a raw request (statuses are tallied, not thrown). */
export function selectProfileRaw(
  agent: Agent,
  profileId: string,
  pin?: string,
): Promise<HttpResult> {
  return agent.fetch(`${API_BASE_PATH}/session/profile`, {
    method: "PUT",
    headers: { [CLIENT_HEADER]: CLIENT_HEADER_VALUE },
    body: pin === undefined ? { profileId } : { profileId, pin },
    retryOn429: false,
  });
}

/** A new profile locked with `SMOKE_PIN` (setting a PIN needs the account password). */
export async function lockedProfile(
  env: Environment,
  account: TestAccount,
  name: string,
): Promise<Profile> {
  const profile = await env.createProfile(account.agent, { name });
  return succeeds(
    () =>
      account.agent.api.updateProfile({
        params: { id: profile.id },
        body: { pin: SMOKE_PIN, currentPassword: account.password },
      }),
    `lock profile ${name} with a PIN`,
  );
}

export function measureProfilePinLimit(env: Environment): Promise<ProfilePinMeasurement> {
  return env.once("limits:profile-pin", async () => {
    // A fresh account whose bucket nothing else has touched: no PIN submitted yet.
    // An account only: PINs and passwords need no membership.
    const account = await env.bareSignup("ratelimit");
    const agent = env.agent("ratelimit-burst", { retryOn429: false });
    for (const [name, value] of account.agent.jar.snapshot()) agent.jar.set(name, value);
    const profile = await lockedProfile(env, account, "Burst");
    // Locking the profile checked the account password: one unit of the same per-account
    // budget (every PIN and password check after sign-in shares it).
    const spentBeforeBurst = 1;
    // The right PIN, so every admitted attempt answers 200 and nothing else is tallied.
    const attempt = () => selectProfileRaw(agent, profile.id, SMOKE_PIN);
    // Keep bursting until something is limited: per-instance limiters behind k replicas admit
    // about k × the limit, which a single burst smaller than that would read as "no limit".
    let result = await burst(env.options.burst, attempt);
    while (result.limited === 0 && result.other.size === 0 && result.sent < env.options.burst * 5) {
      const more = await burst(env.options.burst, attempt);
      result = {
        sent: result.sent + more.sent,
        allowed: result.allowed + more.allowed,
        limited: more.limited,
        other: more.other,
        durationMs: result.durationMs + more.durationMs,
        results: [...result.results, ...more.results],
      };
    }
    const counted = result.allowed + spentBeforeBurst;
    const fits = (spec: RateLimitSpec) => {
      const range = admissible(spec, result.durationMs);
      return counted >= range.min && counted <= range.max;
    };
    let classification: Classification;
    if (result.limited === 0) classification = "none";
    else if (fits(DOCUMENTED_LIMITS.strict["profile-pin"])) classification = "strict";
    else if (fits(DOCUMENTED_LIMITS.relaxed["profile-pin"])) classification = "relaxed";
    else classification = "other";
    const expected = expectedSpec(env, "profile-pin", classification);
    const matchesExpected = expected !== null && result.limited > 0 && fits(expected);
    const retryAfters = result.results
      .filter((item) => item.status === 429)
      .map((item) => Number(item.headers.get("Retry-After")))
      .filter((value) => Number.isFinite(value));
    const verdict =
      classification === "none"
        ? `no request of ${result.sent} was rate limited`
        : `${result.allowed} of ${result.sent} admitted in ${result.durationMs} ms after ${spentBeforeBurst} password check (${classification === "other" ? "matches neither documented limit: strict 5/min, dev 60/min" : `${classification} limits`})`;
    env.note(
      "rate limits",
      classification === "none"
        ? `no limiting observed (profile-pin burst of ${result.sent})`
        : `${classification} (profile-pin burst admitted ${result.allowed}/${result.sent} after ${spentBeforeBurst} password check)`,
    );
    return {
      account,
      agent,
      profile,
      burst: result,
      allowed: counted,
      classification,
      expected,
      matchesExpected,
      verdict,
      maxRetryAfterSec: Math.max(0, ...retryAfters),
    };
  });
}
