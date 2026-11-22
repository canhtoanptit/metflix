#!/usr/bin/env node
/**
 * Regenerate tools/stripe/fixtures from a run's raw record without calling Stripe:
 * `node tools/stripe/proof/refixture.ts [.cache/stripe/runs/<id>/raw.json]` (default: the latest
 * run). Used after a scrubber change; `make stripe-proof` does the same at the end of a run.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/paths.ts";
import { type Attribution, attribute } from "./attribution.ts";
import type { ApiCall, ClockAdvance, Observation, RecordedResponse } from "./context.ts";
import { type FixtureScenario, writeFixtures } from "./fixtures.ts";
import type { Delivery } from "./receiver.ts";
import { SCENARIOS } from "./registry.ts";

interface RawScenario {
  name: string;
  title?: string;
  firstSeq?: number;
  error: string | null;
  calls: ApiCall[];
  responses: RecordedResponse[];
  observations: Observation[];
  advances: ClockAdvance[];
  steps: Array<{ name: string; ms: number }>;
  owned: string[];
  skipped?: string[];
  startedAtMs: number;
  finishedAtMs: number;
}

interface RawRun {
  meta: Record<string, unknown> & { timeMode?: string };
  deliveries: Delivery[];
  attribution: Record<string, number[]>;
  unattributed: number[];
  ambiguous?: number[];
  scenarios: RawScenario[];
  unscopedCalls: ApiCall[];
}

function latestRaw(): string {
  const runs = readdirSync(paths.runsDir)
    .map((name) => join(paths.runsDir, name, "raw.json"))
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  const latest = runs[0];
  if (!latest) throw new Error(`No raw run record under ${paths.runsDir}; run make stripe-proof.`);
  return latest;
}

const file = process.argv[2] ?? latestRaw();
const raw = JSON.parse(readFileSync(file, "utf8")) as RawRun;
const timeMode = raw.meta.timeMode ?? "unknown";

const scenarios: FixtureScenario[] = raw.scenarios.map((s) => ({
  name: s.name,
  title: s.title ?? SCENARIOS.find((d) => d.name === s.name)?.title ?? s.name,
  error: s.error,
  timeMode,
  skipped: s.skipped ?? [],
  steps: s.steps,
  observations: s.observations,
  failedExpectations: s.observations.filter((o) => o.ok === false),
  advances: s.advances,
  calls: s.calls,
  responses: s.responses,
  startedAtMs: s.startedAtMs,
  finishedAtMs: s.finishedAtMs,
}));

// Recompute when the record has what attribution needs; otherwise use the stored result.
const attribution: Attribution = raw.scenarios.every((s) => s.firstSeq !== undefined)
  ? attribute(
      raw.deliveries.map((d) => ({ seq: d.seq, object: d.event?.data.object ?? null })),
      raw.scenarios.map((s) => ({
        name: s.name,
        owned: new Set(s.owned),
        firstSeq: s.firstSeq ?? 0,
      })),
    )
  : {
      byOwner: new Map(Object.entries(raw.attribution)),
      unattributed: raw.unattributed,
      ambiguous: raw.ambiguous ?? [],
    };

const written = writeFixtures({
  meta: raw.meta,
  scenarios,
  deliveries: raw.deliveries,
  attribution,
  unscopedCalls: raw.unscopedCalls,
});
process.stdout.write(`Fixtures: ${written} files in ${paths.fixturesDir} (from ${file})\n`);
