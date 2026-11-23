import type { RateLimiterObject, StreamGateObject } from "@webflix/adapters-cloudflare";
import {
  ConfigError,
  type CoreConfig,
  ENVIRONMENTS,
  loadCoreConfig,
  PBKDF2_DEFAULT_ITERATIONS,
  PBKDF2_MAX_ITERATIONS,
} from "@webflix/core";
import * as z from "zod";

/**
 * Bindings, vars and secrets of the Worker (wrangler.jsonc). Vars are strings; everything the
 * Worker reads is validated once per isolate by `loadEdgeConfig`.
 */
export interface Env {
  // Bindings
  DB: D1Database;
  CACHE: KVNamespace;
  MEDIA: R2Bucket;
  LIMITS: DurableObjectNamespace<RateLimiterObject>;
  STREAMS: DurableObjectNamespace<StreamGateObject>;
  JOBS: Queue;
  ASSETS: Fetcher;
  /** Per-profile recommendation lists (`WEBFLIX_RECOMMENDATION_STORE=kv`). */
  RECS?: KVNamespace;
  // Vars (portable ones are documented in docs/BACKEND.md §4)
  WEBFLIX_MODE: string;
  WEBFLIX_ENV?: string;
  WEBFLIX_PUBLIC_ORIGIN?: string;
  WEBFLIX_LOG_LEVEL?: string;
  WEBFLIX_PASSWORD_ITERATIONS?: string;
  WEBFLIX_EDGE_CACHE?: string;
  // Milestone 2 vars wrangler.jsonc sets (portable, parsed by `loadCoreConfig`)
  WEBFLIX_RELEASE?: string;
  WEBFLIX_EVENT_SINK?: string;
  WEBFLIX_EMAIL_SENDER?: string;
  WEBFLIX_EMAIL_FROM?: string;
  WEBFLIX_PAYMENT_PROVIDER?: string;
  WEBFLIX_STAFF_VERIFIER?: string;
  WEBFLIX_STAFF_ISSUER?: string;
  WEBFLIX_RECOMMENDATION_STORE?: string;
  // Secrets (`secrets.required`; empty locally = unset)
  WEBFLIX_MEDIA_TOKEN_KEYS?: string;
  WEBFLIX_PSEUDONYM_KEY?: string;
  WEBFLIX_EMAIL_HTTP_API_KEY?: string;
  WEBFLIX_EMAIL_WEBHOOK_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

/**
 * Queues redelivers a failed job `max_retries` times before dead-lettering it. Keep equal to
 * `max_retries + 1` of the consumer in wrangler.jsonc (a test checks).
 */
export const JOBS_MAX_ATTEMPTS = 5;

export interface EdgeConfig {
  core: CoreConfig;
  /**
   * PBKDF2-SHA256 iterations for new password hashes (and PINs). The dominant CPU cost of
   * sign-up, sign-in and PIN checks: about 40 ms at the 600 000 default (OWASP 2023), which
   * is why production needs Workers Paid. Lowering it is an explicit security trade-off; it
   * only affects new hashes, old ones keep verifying at their own cost and are upgraded on the
   * next sign-in when it is raised again.
   */
  passwordIterations: number;
  /** Read media and artwork through the Workers edge cache (`MediaOrigin`); `off` reads R2 directly. */
  edgeCache: boolean;
}

const EdgeVars = z.object({
  WEBFLIX_MODE: z.literal("cloudflare"),
  // Required here, never defaulted: `loadCoreConfig` reads an absent WEBFLIX_ENV as development,
  // which on a deployed Worker would mount the development issuer (staff tokens anyone can mint),
  // default to the fake payment provider and open the mailbox. wrangler.jsonc sets it in both
  // sections (development locally, production in env.production); a Worker without it answers
  // 503 config.invalid instead of running open.
  WEBFLIX_ENV: z.enum(ENVIRONMENTS, {
    error: () =>
      "required on Cloudflare (development or production): absent, the Worker would run as development",
  }),
  WEBFLIX_PASSWORD_ITERATIONS: z.coerce
    .number<string>()
    .int()
    .min(100_000, "below 100000 is not a password hash worth having")
    .max(PBKDF2_MAX_ITERATIONS)
    .default(PBKDF2_DEFAULT_ITERATIONS),
  WEBFLIX_EDGE_CACHE: z.enum(["on", "off"]).default("on"),
});

/** Validate everything once; a bad deploy fails on its first request with every problem listed. */
export function loadEdgeConfig(env: Env): EdgeConfig {
  const vars = Object.fromEntries(
    Object.entries(env).filter(([, value]) => typeof value === "string" && value !== ""),
  );
  const parsed = EdgeVars.safeParse(vars);
  const issues = parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  let core: CoreConfig | undefined;
  try {
    core = loadCoreConfig(env as unknown as Record<string, unknown>);
  } catch (error) {
    if (error instanceof ConfigError) issues.push(...error.issues);
    else throw error;
  }
  if (!parsed.success || !core || issues.length > 0) throw new ConfigError(issues);
  return {
    core,
    passwordIterations: parsed.data.WEBFLIX_PASSWORD_ITERATIONS,
    edgeCache: parsed.data.WEBFLIX_EDGE_CACHE === "on",
  };
}
