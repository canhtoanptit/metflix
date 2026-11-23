/**
 * The lake's jobs outside Workers (docs/CLOUDFLARE.md §10.4): the deploy gate that refuses a lake
 * nobody erases, the retention values those jobs must share with the Worker, the R2 lifecycle
 * rules behind them, and what a runner must have and schedule.
 *
 * With `WEBFLIX_EVENT_SINK=lake` the Worker writes behaviour events into R2, and only the
 * pipeline's jobs erase deleted members from them, finish batch exports and enforce retention.
 * A production deploy therefore requires a declared runner (`WEBFLIX_LAKE_JOBS=scheduled`) and a
 * staff issuer whose service account the runner uses to list and confirm work through the staff
 * API; otherwise it stops (privacy review M2). `WEBFLIX_EVENT_SINK=memory` stores nothing and
 * needs no runner.
 */
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { type Environment, loadEventsConfig } from "@webflix/core";
import { unstable_readConfig } from "wrangler";

export const LAKE_JOBS_VARIABLE = "WEBFLIX_LAKE_JOBS";
/** `scheduled`: an operator runs the lake jobs on the schedule below (the only runner kind). */
export const LAKE_JOBS_RUNNERS = ["scheduled"] as const;

const EVENTS_VARIABLE = "WEBFLIX_EVENTS_RETENTION_DAYS";
const AGGREGATES_VARIABLE = "WEBFLIX_AGGREGATES_RETENTION_DAYS";

/** Days after the events period when R2's lifecycle deletes what `retain` left behind. */
export const LIFECYCLE_MARGIN_DAYS = 7;

export interface RetentionPeriods {
  eventsDays: number;
  aggregatesDays: number;
}

type Vars = Readonly<Record<string, unknown>>;

function strings(vars: Vars): Record<string, string> {
  return Object.fromEntries(
    Object.entries(vars).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
    ),
  );
}

/**
 * The retention periods the Worker runs with, from its variables, by the Worker's own rule
 * (`loadEventsConfig`: same defaults, anything but a positive integer refused). The pipeline's
 * jobs get exactly these (`retain` reads the same two variables).
 */
export function workerRetention(vars: Vars): RetentionPeriods {
  const input = strings(vars);
  const environment = (input.WEBFLIX_ENV ?? "development") as Environment;
  const { config, issues } = loadEventsConfig({ vars: input, environment });
  const relevant = issues.filter(
    (issue) => issue.includes(EVENTS_VARIABLE) || issue.includes(AGGREGATES_VARIABLE),
  );
  if (relevant.length > 0) throw new Error(relevant.join("; "));
  return { eventsDays: config.rawRetentionDays, aggregatesDays: config.aggregateRetentionDays };
}

/**
 * The local Worker's variables as `wrangler dev` composes them: wrangler.jsonc's top level, then
 * the names `secrets.required` lists from `.dev.vars` (wrangler loads only those: an allowlist),
 * then the dev server's own `--var` overrides (recorded by scripts/dev.ts).
 */
export function localWorkerVars(options: {
  configPath: string;
  devVarsPath: string;
  overrides?: Readonly<Record<string, string>> | undefined;
}): Record<string, string> {
  const config = unstable_readConfig({ config: options.configPath }, { hideWarnings: true });
  const allowed = new Set(config.secrets?.required ?? []);
  let devVars: Record<string, string> = {};
  try {
    devVars = parseEnv(readFileSync(options.devVarsPath, "utf8")) as Record<string, string>;
  } catch {
    devVars = {};
  }
  return {
    ...strings(config.vars as Vars),
    ...strings(Object.fromEntries(Object.entries(devVars).filter(([name]) => allowed.has(name)))),
    ...(options.overrides ?? {}),
  };
}

/** The variables that hand the Worker's retention periods to a pipeline process. */
export function retentionEnvironment(periods: RetentionPeriods): Record<string, string> {
  return {
    [EVENTS_VARIABLE]: String(periods.eventsDays),
    [AGGREGATES_VARIABLE]: String(periods.aggregatesDays),
  };
}

/**
 * Why this configuration may not be deployed as it stands: a lake with no declared runner, or a
 * runner the staff API would not admit. Empty when it may.
 */
export function lakeJobsIssues(vars: Vars): string[] {
  const input = strings(vars);
  const sink = input.WEBFLIX_EVENT_SINK ?? "memory";
  const runner = input[LAKE_JOBS_VARIABLE];
  const issues: string[] = [];
  if (runner !== undefined && !(LAKE_JOBS_RUNNERS as readonly string[]).includes(runner)) {
    issues.push(
      `${LAKE_JOBS_VARIABLE}=${runner} is not a runner this deploy knows (${LAKE_JOBS_RUNNERS.join(", ")})`,
    );
  }
  if (sink !== "lake") return issues;
  if (runner === undefined) {
    issues.push(
      `WEBFLIX_EVENT_SINK is lake but no runner of the lake jobs is declared (${LAKE_JOBS_VARIABLE}): deleted members would stay in the lake, batch exports would never finish and nothing would enforce retention. Set up the runner (docs/CLOUDFLARE.md §10.4) and set ${LAKE_JOBS_VARIABLE} to scheduled, or set WEBFLIX_EVENT_SINK to memory (nothing stored)`,
    );
  }
  const issuer = input.WEBFLIX_STAFF_ISSUER ?? "";
  if (input.WEBFLIX_STAFF_VERIFIER !== "oidc" || !issuer.startsWith("https://")) {
    issues.push(
      "WEBFLIX_EVENT_SINK is lake but the staff API admits nobody (WEBFLIX_STAFF_VERIFIER oidc and an https WEBFLIX_STAFF_ISSUER): the lake jobs list and confirm their work through it with a service account of that issuer",
    );
  }
  return issues;
}

export interface LifecycleRule {
  name: string;
  prefix: string;
  expireDays: number;
}

/**
 * R2 lifecycle rules on what the events period covers, a second line of defence behind the
 * daily `retain` (which deletes by receipt hour, holds the lake lease and keeps a plan). R2 ages
 * an object from its last write, so an hour rewritten by an erasure or a compaction is kept
 * longer by these rules than by `retain`: they catch a runner that stopped, they do not replace
 * it. Nothing under these prefixes is a total (aggregates live in D1, `recs-work/`, `recs/` and
 * `experiments/`), so nothing there needs to outlive the events period.
 */
export function lifecycleRules(periods: RetentionPeriods): LifecycleRule[] {
  const expireDays = periods.eventsDays + LIFECYCLE_MARGIN_DAYS;
  return [
    { name: "webflix-events-retention", prefix: "events/", expireDays },
    { name: "webflix-events-quarantine-retention", prefix: "events-quarantine/", expireDays },
  ];
}

/** What a declared runner needs and runs, for the deploy plan (docs/CLOUDFLARE.md §10.4). */
export function runnerChecklist(input: { vars: Vars; bucket: string; origin: string }): string[] {
  const periods = workerRetention(input.vars);
  const vars = strings(input.vars);
  const issuer = vars.WEBFLIX_STAFF_ISSUER ?? "<WEBFLIX_STAFF_ISSUER>";
  const env = retentionEnvironment(periods);
  return [
    `store: --store s3://${input.bucket} with WEBFLIX_S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com, WEBFLIX_S3_REGION=auto and an R2 API token's WEBFLIX_S3_ACCESS_KEY_ID / WEBFLIX_S3_SECRET_ACCESS_KEY (Object Read & Write on ${input.bucket} only)`,
    `staff API: WEBFLIX_ADMIN_API_URL=${input.origin}/api/admin/v1 and a service account of ${issuer} (client credentials: WEBFLIX_STAFF_TOKEN_URL, WEBFLIX_STAFF_CLIENT_ID, WEBFLIX_STAFF_CLIENT_SECRET) with the roles admin and experiments`,
    `retention, the Worker's own values: ${Object.entries(env)
      .map(([name, value]) => `${name}=${value}`)
      .join(" ")}`,
    "every 5 min: webflix-recs export-events --requests api --grace-minutes 15",
    "hourly at :20: webflix-recs compact --grace-minutes 15",
    "daily 03:40: webflix-recs erase --keys api",
    "daily 03:50: webflix-recs retain",
    "daily 04:00: webflix-recs train-and-score (--erasures api, the default with WEBFLIX_ADMIN_API_URL; exit 6 = run erase first), publish (exit 3 = the gate refused: nothing changes), then make cf-recs-import ENV=production",
    "daily 04:30: webflix-recs analyse-experiments (experiment results; the Worker imports them on its next tick)",
  ];
}
