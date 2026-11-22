import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import {
  DEMO_ACCOUNT_EMAIL,
  DEMO_ACCOUNT_PASSWORD,
  RATE_LIMIT_POLICY_NAMES,
  type RateLimitPolicyName,
} from "@webflix/contracts";
import type { RateLimitExpectation, RateLimitSpec, SmokeOptions } from "./types.ts";

export const USAGE = `Usage: webflix-smoke --base-url <url> [options]

Black-box conformance checks of a Webflix deployment (dev, k8s or cloudflare).

Target
  -u, --base-url <url>        Origin to test (env SMOKE_BASE_URL), e.g. http://localhost:4000
      --demo-email <email>    Seeded demo account (default ${DEMO_ACCOUNT_EMAIL})
      --demo-password <pw>    (default: the documented demo password)
      --media-title <id>      Title to use for packaged-media checks (default: discovered)
      --promo-code <code>     A promo code the deployment honours for the Standard plan (billing.promo-code.applied)

Selection
      --only <ids>            Comma-separated ids, prefixes or globs: "identity", "media.*,plans.stream-limit"
      --skip <ids>            Exclude checks (same syntax)
      --tag <tags>            Only checks with a tag: consistency, exclusive, demo, ip-limit
      --list                  Print the check catalogue and exit
      --expect-fail <ids>     Known failures: reported as XFAIL and do not fail the run

Behaviour
      --rate-limits <spec>    auto (detect; default) | strict | relaxed | policy=N/W,... (e.g. profile-pin=10/60)
      --no-ip-exhaustion      Never exhaust IP-keyed limits (sign-in, sign-up, email lookup)
      --concurrency <n>       Checks run at once (default 4)
      --parallelism <n>       Concurrent requests per consistency fan-out (default 8)
      --repeat <n>            Rounds per consistency check (default 3)
      --burst <n>             Requests in a rate-limit measuring burst (default 80; must exceed the limit)

Timeouts (milliseconds)
      --timeout <ms>          Per check (default 120000)
      --request-timeout <ms>  Per request (default 20000)
      --eventual-timeout <ms> Polling budget for eventually-visible effects (default 30000)
      --poll-interval <ms>    Polling interval (default 500)
      --export-wait <ms>      Batch-mode data export: wait for a round of the deployment's export-events job (default 300000)
      --export-wait-max <ms>  ... and at most this long, the job's deferral (its grace) included (default 1200000)

Output
      --json <file>           Write the JSON summary ("-" for stdout)
      --fail-on-skip          Exit non-zero when any check is skipped
      --verbose               Print every request and all notes
      --no-color              Plain output (also NO_COLOR)
      --run-id <id>           Tag for emails and request ids (default: random)

Exit status: 0 all passed (skips allowed), 1 a check failed, 2 usage error or target unreachable.
`;

export class UsageError extends Error {
  override readonly name = "UsageError";
}

function list(values: string[] | undefined): string[] {
  return (values ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

function integer(value: string | undefined, fallback: number, name: string, min = 1): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min)
    throw new UsageError(`--${name} must be an integer ≥ ${min}`);
  return parsed;
}

export function parseRateLimits(value: string | undefined): RateLimitExpectation {
  if (value === undefined || value === "auto") return { mode: "auto" };
  if (value === "strict" || value === "relaxed") return { mode: value };
  const limits: Partial<Record<RateLimitPolicyName, RateLimitSpec>> = {};
  for (const part of value.split(",")) {
    const match = /^([a-z-]+)=(\d+)\/(\d+)$/.exec(part.trim());
    const policy = match?.[1] as RateLimitPolicyName | undefined;
    if (!match || !policy || !RATE_LIMIT_POLICY_NAMES.includes(policy)) {
      throw new UsageError(
        `--rate-limits: expected auto, strict, relaxed or policy=N/W (policies: ${RATE_LIMIT_POLICY_NAMES.join(", ")}), got "${part}"`,
      );
    }
    limits[policy] = { limit: Number(match[2]), windowSec: Number(match[3]) };
  }
  return { mode: "custom", limits };
}

export interface CliOptions {
  options: SmokeOptions;
  list: boolean;
  help: boolean;
  json: string | null;
  color: boolean;
}

export function parseCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CliOptions {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== "--"),
    allowPositionals: false,
    options: {
      "base-url": { type: "string", short: "u" },
      only: { type: "string", multiple: true },
      skip: { type: "string", multiple: true },
      tag: { type: "string", multiple: true },
      list: { type: "boolean", default: false },
      json: { type: "string" },
      concurrency: { type: "string" },
      parallelism: { type: "string" },
      repeat: { type: "string" },
      burst: { type: "string" },
      timeout: { type: "string" },
      "request-timeout": { type: "string" },
      "eventual-timeout": { type: "string" },
      "poll-interval": { type: "string" },
      "export-wait": { type: "string" },
      "export-wait-max": { type: "string" },
      "rate-limits": { type: "string" },
      "no-ip-exhaustion": { type: "boolean", default: false },
      "expect-fail": { type: "string", multiple: true },
      "fail-on-skip": { type: "boolean", default: false },
      "demo-email": { type: "string" },
      "demo-password": { type: "string" },
      "media-title": { type: "string" },
      "promo-code": { type: "string" },
      verbose: { type: "boolean", default: false },
      "no-color": { type: "boolean", default: false },
      "run-id": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const baseUrl = (values["base-url"] ?? env.SMOKE_BASE_URL ?? "").replace(/\/+$/, "");
  if (!values.help && !values.list) {
    if (!baseUrl) throw new UsageError("--base-url is required (or set SMOKE_BASE_URL)");
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new UsageError(`--base-url is not a URL: ${baseUrl}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new UsageError("--base-url must be http(s)");
  }
  const runId = values["run-id"] ?? randomBytes(3).toString("hex");
  if (!/^[a-z0-9-]{1,16}$/.test(runId)) throw new UsageError("--run-id must be 1-16 of [a-z0-9-]");
  return {
    list: values.list,
    help: values.help,
    json: values.json ?? null,
    color: !values["no-color"] && !env.NO_COLOR && process.stdout.isTTY === true,
    options: {
      baseUrl,
      concurrency: integer(values.concurrency, 4, "concurrency"),
      checkTimeoutMs: integer(values.timeout, 120_000, "timeout", 1000),
      requestTimeoutMs: integer(values["request-timeout"], 20_000, "request-timeout", 100),
      eventualTimeoutMs: integer(values["eventual-timeout"], 30_000, "eventual-timeout", 100),
      pollIntervalMs: integer(values["poll-interval"], 500, "poll-interval", 10),
      exportWaitMs: integer(values["export-wait"], 300_000, "export-wait", 0),
      exportWaitMaxMs: integer(values["export-wait-max"], 1_200_000, "export-wait-max", 0),
      parallelism: integer(values.parallelism, 8, "parallelism", 2),
      repeat: integer(values.repeat, 3, "repeat"),
      burst: integer(values.burst, 80, "burst", 2),
      rateLimits: parseRateLimits(values["rate-limits"]),
      allowIpExhaustion: !values["no-ip-exhaustion"],
      demo: {
        email: values["demo-email"] ?? DEMO_ACCOUNT_EMAIL,
        password: values["demo-password"] ?? DEMO_ACCOUNT_PASSWORD,
      },
      mediaTitleId: values["media-title"] ?? null,
      promoCode: values["promo-code"] ?? null,
      only: list(values.only),
      skip: list(values.skip),
      tags: list(values.tag),
      expectFail: list(values["expect-fail"]),
      failOnSkip: values["fail-on-skip"],
      runId,
      verbose: values.verbose,
    },
  };
}
