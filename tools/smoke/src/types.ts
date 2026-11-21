import type { RateLimitPolicyName } from "@webflix/contracts";
import type { Agent } from "./http.ts";

export const AREAS = [
  "ops",
  "identity",
  "profiles",
  "browse",
  "library",
  "playback",
  "media",
  "plans",
  "consistency",
  "ratelimit",
  "pipeline",
] as const;
export type Area = (typeof AREAS)[number];

/**
 * - `consistency`: depends on state shared across replicas/isolates; runs with fan-out.
 * - `exclusive`: runs alone after everything else (it exhausts a shared, IP-keyed budget).
 * - `slow`: takes tens of seconds by design (started first).
 * - `demo`: reads the seeded demo account.
 */
export type CheckTag = "consistency" | "exclusive" | "slow" | "demo" | "ip-limit";

export interface RateLimitSpec {
  limit: number;
  windowSec: number;
}

/** What the target's rate limits are expected to be (`--rate-limits`). */
export type RateLimitExpectation =
  | { mode: "auto" }
  | { mode: "strict" }
  | { mode: "relaxed" }
  | { mode: "custom"; limits: Partial<Record<RateLimitPolicyName, RateLimitSpec>> };

export interface SmokeOptions {
  baseUrl: string;
  /** Checks running at once. */
  concurrency: number;
  checkTimeoutMs: number;
  requestTimeoutMs: number;
  /** Upper bound for anything the backend documents as eventually visible. */
  eventualTimeoutMs: number;
  pollIntervalMs: number;
  /** Fan-out of concurrent requests in consistency checks. */
  parallelism: number;
  /** Rounds of each consistency check. */
  repeat: number;
  /** Largest burst sent to measure a rate limit (must exceed the limit to measure it). */
  burst: number;
  rateLimits: RateLimitExpectation;
  /** Checks that exhaust IP-keyed limits (sign-in, sign-up, email lookup) may run. */
  allowIpExhaustion: boolean;
  demo: { email: string; password: string };
  /** Pin the title used for packaged-media checks. */
  mediaTitleId: string | null;
  only: string[];
  skip: string[];
  tags: string[];
  /** Known failures: reported as XFAIL instead of FAIL. */
  expectFail: string[];
  failOnSkip: boolean;
  runId: string;
  verbose: boolean;
  /** Progress output (one line per finished check); none when undefined. */
  log?: (line: string) => void;
}

export interface CheckContext {
  readonly options: SmokeOptions;
  readonly signal: AbortSignal;
  readonly env: import("./env.ts").Environment;
  /** A fresh browser (cookie jar, device). Set `retryOn429: false` to see 429s yourself. */
  agent(label: string, options?: { retryOn429?: boolean }): Agent;
  /** Shown in the report under the check (measurements, latencies, throttling). */
  note(message: string): void;
  /** The target cannot support this check; reported as SKIP with the reason. */
  skip(reason: string): never;
  sleep(ms: number): Promise<void>;
  /**
   * Poll until `probe` reports done or the eventual timeout passes. Fails with the last
   * observation, never sleeps a fixed time.
   */
  eventually<T>(
    what: string,
    probe: () => Promise<{ done: true; value: T } | { done: false; observed: string }>,
    options?: { timeoutMs?: number; intervalMs?: number },
  ): Promise<{ value: T; elapsedMs: number; attempts: number }>;
}

export interface Requirement {
  id: string;
  /** Null when met; otherwise the reason the check is skipped. */
  evaluate(env: import("./env.ts").Environment): Promise<string | null>;
}

export interface CheckDefinition {
  id: string;
  area: Area;
  title: string;
  needs?: Requirement[];
  tags?: CheckTag[];
  timeoutMs?: number;
  run(ctx: CheckContext): Promise<void>;
}

export type Outcome = "pass" | "fail" | "skip" | "xfail" | "xpass";

export interface RequestSummary {
  agent: string;
  method: string;
  url: string;
  status: number;
  requestId: string;
  serverRequestId: string | null;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  responseHeaders: Record<string, string>;
  responseBody?: string;
  error?: string;
  durationMs: number;
}

export interface CheckResult {
  id: string;
  area: Area;
  title: string;
  tags: CheckTag[];
  outcome: Outcome;
  durationMs: number;
  /** Why the check was skipped. */
  reason?: string;
  failure?: {
    message: string;
    expected?: string;
    observed?: string;
    details: string[];
    request?: RequestSummary;
  };
  notes: string[];
  requests: number;
}

export interface RunReport {
  tool: "webflix-smoke";
  runId: string;
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  target: Record<string, string>;
  options: Record<string, unknown>;
  counts: Record<Outcome, number> & { total: number };
  ok: boolean;
  results: CheckResult[];
}
