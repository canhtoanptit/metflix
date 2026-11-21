import { RATE_LIMIT_POLICY_NAMES, type RateLimitPolicyName } from "@webflix/contracts";
import * as z from "zod";
import { LOG_LEVELS, type LogLevel } from "./ports/logger.ts";
import { assertRateLimitPolicy, type RateLimitPolicy } from "./ports/rate-limiter.ts";
import { MIN_SIGNING_SECRET_LENGTH, type SigningKey } from "./ports/token-signer.ts";

export const DEPLOYMENT_MODES = ["dev", "k8s", "cloudflare"] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

export const ENVIRONMENTS = ["development", "test", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/**
 * DEVELOPMENT ONLY. Used when `WEBFLIX_MEDIA_TOKEN_KEYS` is unset outside production;
 * `loadCoreConfig` refuses it when `WEBFLIX_ENV=production`.
 */
export const DEV_ONLY_MEDIA_TOKEN_KEY: SigningKey = {
  id: "dev",
  secret: "dev-only-insecure-media-token-secret-do-not-deploy",
};

export const DEFAULT_RATE_LIMITS: Readonly<Record<RateLimitPolicyName, RateLimitPolicy>> = {
  auth: { name: "auth", limit: 10, windowSec: 60 },
  signup: { name: "signup", limit: 5, windowSec: 60 },
  "email-lookup": { name: "email-lookup", limit: 20, windowSec: 60 },
  "profile-pin": { name: "profile-pin", limit: 5, windowSec: 60 },
  // Card verifications per account: a member fixing a typo or a declined card stays well
  // inside it; testing stolen cards through an account does not.
  payment: { name: "payment", limit: 10, windowSec: 600 },
  // Sign-ins per email address, whatever the client address: slows a distributed guess at one
  // account. A browser that signed in to the account before is exempt, so a flood of wrong
  // guesses cannot lock its owner out (docs/DECISIONS.md D28).
  "auth-email": { name: "auth-email", limit: 10, windowSec: 900 },
  // Playback sessions started per account: zapping between titles stays far below it.
  "playback-start": { name: "playback-start", limit: 60, windowSec: 60 },
};

/** What is wrong with a rate-limit table: a policy the contract names but the table lacks. */
function rateLimitTableIssues(
  table: Readonly<Record<string, RateLimitPolicy | undefined>>,
): string[] {
  return RATE_LIMIT_POLICY_NAMES.flatMap((name) => {
    const policy = table[name];
    if (!policy) return [`rate limit "${name}": no policy configured`];
    try {
      assertRateLimitPolicy(policy);
      if (policy.name !== name) throw new TypeError(`named "${policy.name}"`);
      return [];
    } catch (error) {
      return [`rate limit "${name}": ${error instanceof Error ? error.message : String(error)}`];
    }
  });
}

/**
 * Every policy a route or handler may charge (`RATE_LIMIT_POLICY_NAMES`) is configured and
 * valid. The app calls it when it is composed, so a runtime built with an incomplete table
 * fails at startup with a `ConfigError` rather than with a 500 on the first limited request.
 */
export function assertRateLimitTable(
  table: Readonly<Record<string, RateLimitPolicy | undefined>>,
): void {
  const issues = rateLimitTableIssues(table);
  if (issues.length > 0) throw new ConfigError(issues);
}

/**
 * Settings shared by every deployment mode. Mode-specific settings (database URL, Valkey,
 * S3, bindings) are parsed by the app that owns them (`apps/api`, `apps/edge`).
 */
export interface CoreConfig {
  mode: DeploymentMode;
  environment: Environment;
  /** Origin users load the app from, without trailing slash, e.g. `http://localhost:5173`. */
  publicOrigin: string;
  logLevel: LogLevel;
  cookies: {
    /** True when `publicOrigin` is https (blueprint §2.3: Secure outside plain-http dev). */
    secure: boolean;
    /** `__Host-` prefixed when secure. */
    sessionCookieName: string;
    /** The "known device" cookie (exempts a browser's sign-ins from the per-email limit). */
    knownDeviceCookieName: string;
  };
  session: { ttlSec: number };
  media: { tokenKeys: SigningKey[]; tokenTtlSec: number };
  playback: { heartbeatIntervalSec: number; leaseTtlSec: number };
  rateLimits: Record<RateLimitPolicyName, RateLimitPolicy>;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join("\n  - ")}`);
    this.issues = issues;
  }
}

const positiveInt = (fallback: number) =>
  z.coerce.number<string>().int().positive().default(fallback);

const SigningKeys = z.string().transform((value, ctx): SigningKey[] => {
  const keys = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(":");
      return { id: entry.slice(0, separator), secret: entry.slice(separator + 1) };
    });
  for (const key of keys) {
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(key.id) || key.secret.length < MIN_SIGNING_SECRET_LENGTH) {
      ctx.addIssue({
        code: "custom",
        message: `expected "id:secret" pairs; ids [A-Za-z0-9_-]{1,16}, secrets >= ${MIN_SIGNING_SECRET_LENGTH} chars`,
      });
      return z.NEVER;
    }
  }
  if (keys.length === 0) {
    ctx.addIssue({ code: "custom", message: "at least one key is required" });
    return z.NEVER;
  }
  return keys;
});

const RateLimitOverride = z
  .string()
  .regex(/^\d+\/\d+$/, 'expected "<limit>/<windowSec>", e.g. "10/60"')
  .transform((value) => {
    const [limit, windowSec] = value.split("/").map(Number);
    return { limit: limit ?? 0, windowSec: windowSec ?? 0 };
  });

const EnvSchema = z.object({
  WEBFLIX_MODE: z.enum(DEPLOYMENT_MODES),
  WEBFLIX_ENV: z.enum(ENVIRONMENTS).default("development"),
  WEBFLIX_PUBLIC_ORIGIN: z.url({ protocol: /^https?$/ }).default("http://localhost:5173"),
  WEBFLIX_LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  /** `id:secret[,id:secret...]`; the first key signs. Required in production. */
  WEBFLIX_MEDIA_TOKEN_KEYS: SigningKeys.optional(),
  WEBFLIX_MEDIA_TOKEN_TTL_SEC: positiveInt(6 * 60 * 60),
  WEBFLIX_SESSION_TTL_DAYS: positiveInt(30),
  WEBFLIX_HEARTBEAT_INTERVAL_SEC: positiveInt(30),
  ...Object.fromEntries(
    RATE_LIMIT_POLICY_NAMES.map((name) => [rateLimitEnvName(name), RateLimitOverride.optional()]),
  ),
});

function rateLimitEnvName(name: RateLimitPolicyName): string {
  return `WEBFLIX_RATE_LIMIT_${name.toUpperCase().replaceAll("-", "_")}`;
}

/**
 * Parse and validate the portable settings from environment variables (`process.env` on Node,
 * the Worker `env` object on Cloudflare: non-string bindings are ignored). Throws
 * `ConfigError` listing every problem, so a bad deploy fails at startup.
 *
 * Variables: WEBFLIX_MODE (required), WEBFLIX_ENV, WEBFLIX_PUBLIC_ORIGIN, WEBFLIX_LOG_LEVEL,
 * WEBFLIX_MEDIA_TOKEN_KEYS, WEBFLIX_MEDIA_TOKEN_TTL_SEC, WEBFLIX_SESSION_TTL_DAYS,
 * WEBFLIX_HEARTBEAT_INTERVAL_SEC, WEBFLIX_RATE_LIMIT_<POLICY> ("limit/windowSec").
 */
export function loadCoreConfig(env: Readonly<Record<string, unknown>>): CoreConfig {
  const strings = Object.fromEntries(
    Object.entries(env).filter(([, value]) => typeof value === "string" && value !== ""),
  );
  const parsed = EnvSchema.safeParse(strings);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`),
    );
  }
  const vars = parsed.data;
  const issues: string[] = [];
  const production = vars.WEBFLIX_ENV === "production";

  const tokenKeys = vars.WEBFLIX_MEDIA_TOKEN_KEYS ?? (production ? [] : [DEV_ONLY_MEDIA_TOKEN_KEY]);
  if (production && tokenKeys.length === 0) {
    issues.push("WEBFLIX_MEDIA_TOKEN_KEYS: required when WEBFLIX_ENV=production");
  }
  if (production && tokenKeys.some((key) => key.secret === DEV_ONLY_MEDIA_TOKEN_KEY.secret)) {
    issues.push("WEBFLIX_MEDIA_TOKEN_KEYS: the development key cannot be used in production");
  }

  const rateLimits = { ...DEFAULT_RATE_LIMITS };
  for (const name of RATE_LIMIT_POLICY_NAMES) {
    const override = (vars as Record<string, unknown>)[rateLimitEnvName(name)] as
      | { limit: number; windowSec: number }
      | undefined;
    if (!override) continue;
    if (override.limit < 1 || override.windowSec < 1) {
      issues.push(`${rateLimitEnvName(name)}: limit and windowSec must be positive`);
    }
    rateLimits[name] = { name, ...override };
  }

  issues.push(...rateLimitTableIssues(rateLimits));
  if (issues.length > 0) throw new ConfigError(issues);

  const publicOrigin = new URL(vars.WEBFLIX_PUBLIC_ORIGIN).origin;
  const secure = publicOrigin.startsWith("https:");
  const heartbeat = vars.WEBFLIX_HEARTBEAT_INTERVAL_SEC;
  return {
    mode: vars.WEBFLIX_MODE,
    environment: vars.WEBFLIX_ENV,
    publicOrigin,
    logLevel: vars.WEBFLIX_LOG_LEVEL,
    cookies: {
      secure,
      sessionCookieName: secure ? "__Host-webflix_session" : "webflix_session",
      knownDeviceCookieName: secure ? "__Host-webflix_device" : "webflix_device",
    },
    session: { ttlSec: vars.WEBFLIX_SESSION_TTL_DAYS * 24 * 60 * 60 },
    media: { tokenKeys, tokenTtlSec: vars.WEBFLIX_MEDIA_TOKEN_TTL_SEC },
    // Two missed heartbeats plus grace before a stream slot frees up.
    playback: { heartbeatIntervalSec: heartbeat, leaseTtlSec: heartbeat * 2 + 15 },
    rateLimits,
  };
}
