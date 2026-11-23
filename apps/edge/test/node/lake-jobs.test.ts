/**
 * The lake's jobs outside Workers (scripts/lib/lake-jobs.ts): a production deploy refuses a lake
 * nobody erases (privacy review M2), the jobs get the Worker's own retention periods, and the R2
 * lifecycle rules sit behind them.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";
import {
  lakeJobsIssues,
  lifecycleRules,
  localWorkerVars,
  runnerChecklist,
  workerRetention,
} from "../../scripts/lib/lake-jobs.ts";

const CONFIG = join(import.meta.dirname, "..", "..", "wrangler.jsonc");
const read = (env?: string) =>
  unstable_readConfig({ config: CONFIG, ...(env ? { env } : {}) }, { hideWarnings: true });
const production = read("production").vars as Record<string, string>;
const local = read().vars as Record<string, string>;
const declared = {
  ...production,
  WEBFLIX_LAKE_JOBS: "scheduled",
  WEBFLIX_STAFF_VERIFIER: "oidc",
  WEBFLIX_STAFF_ISSUER: "https://id.example.com/realms/webflix-staff",
};

describe("the deploy gate for the event lake", () => {
  it("refuses the shipped production config: a lake, no runner, a staff API that admits nobody", () => {
    expect(production.WEBFLIX_EVENT_SINK).toBe("lake");
    const issues = lakeJobsIssues(production);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain("WEBFLIX_LAKE_JOBS");
    expect(issues[1]).toContain("WEBFLIX_STAFF_ISSUER");
  });

  it("passes a declared runner with a staff issuer, and a memory sink with neither", () => {
    expect(lakeJobsIssues(declared)).toEqual([]);
    expect(lakeJobsIssues({ ...production, WEBFLIX_EVENT_SINK: "memory" })).toEqual([]);
  });

  it("refuses a runner it does not know, and an http staff issuer", () => {
    expect(lakeJobsIssues({ ...declared, WEBFLIX_LAKE_JOBS: "maybe" })[0]).toContain(
      "not a runner",
    );
    expect(
      lakeJobsIssues({ ...declared, WEBFLIX_STAFF_ISSUER: "http://id.example.com" }),
    ).toHaveLength(1);
  });

  it("lists what the runner needs and runs, retention values included", () => {
    const lines = runnerChecklist({
      vars: declared,
      bucket: "webflix-media",
      origin: "https://webflix.example.com",
    });
    expect(lines.join("\n")).toContain("WEBFLIX_EVENTS_RETENTION_DAYS=396");
    expect(lines.join("\n")).toContain(
      "WEBFLIX_ADMIN_API_URL=https://webflix.example.com/api/admin/v1",
    );
    for (const job of ["export-events", "compact", "erase", "retain", "train-and-score"]) {
      expect(
        lines.some((line) => line.includes(`webflix-recs ${job}`)),
        job,
      ).toBe(true);
    }
  });
});

describe("retention, as the Worker has it", () => {
  it("defaults to 396 and 1126 days, as the Worker does (config.test.ts compares the two)", () => {
    expect(workerRetention(production)).toEqual({ eventsDays: 396, aggregatesDays: 1126 });
  });

  it("follows an override and refuses what the Worker refuses", () => {
    expect(workerRetention({ ...local, WEBFLIX_EVENTS_RETENTION_DAYS: "30" }).eventsDays).toBe(30);
    expect(() => workerRetention({ ...local, WEBFLIX_EVENTS_RETENTION_DAYS: "0" })).toThrow(
      "WEBFLIX_EVENTS_RETENTION_DAYS",
    );
    expect(() => workerRetention({ ...local, WEBFLIX_AGGREGATES_RETENTION_DAYS: "soon" })).toThrow(
      "WEBFLIX_AGGREGATES_RETENTION_DAYS",
    );
  });

  it("puts R2 lifecycle rules a week behind the events period, on events/ and its quarantine", () => {
    expect(lifecycleRules({ eventsDays: 396, aggregatesDays: 1126 })).toEqual([
      { name: "webflix-events-retention", prefix: "events/", expireDays: 403 },
      {
        name: "webflix-events-quarantine-retention",
        prefix: "events-quarantine/",
        expireDays: 403,
      },
    ]);
  });
});

describe("the local Worker's variables, as wrangler dev composes them", () => {
  it("takes .dev.vars only for the secrets it lists, and the dev server's --var overrides last", async () => {
    const dir = await mkdtemp(join(tmpdir(), "webflix-lake-vars-"));
    try {
      const devVars = join(dir, ".dev.vars");
      await writeFile(
        devVars,
        "WEBFLIX_PSEUDONYM_KEY=from-dev-vars\nWEBFLIX_EVENTS_RETENTION_DAYS=10\n",
      );
      const plain = localWorkerVars({ configPath: CONFIG, devVarsPath: devVars });
      expect(plain.WEBFLIX_PSEUDONYM_KEY).toBe("from-dev-vars");
      // Not in secrets.required: wrangler ignores it in .dev.vars, and so do the jobs.
      expect(workerRetention(plain).eventsDays).toBe(396);
      const overridden = localWorkerVars({
        configPath: CONFIG,
        devVarsPath: devVars,
        overrides: { WEBFLIX_EVENTS_RETENTION_DAYS: "30" },
      });
      expect(workerRetention(overridden).eventsDays).toBe(30);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
