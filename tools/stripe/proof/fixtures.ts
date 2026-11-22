import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths, REPO_ROOT } from "../src/paths.ts";
import { Scrubber, unscrubbedIds } from "../src/scrub.ts";
import { findSecrets } from "../src/secrets.ts";
import { type Attribution, inversions } from "./attribution.ts";
import type { ApiCall, ClockAdvance, Observation, RecordedResponse } from "./context.ts";
import type { Delivery } from "./receiver.ts";

/** What a fixture needs from a scenario: a live `Scenario`, or one rebuilt from a raw record. */
export interface FixtureScenario {
  name: string;
  title: string;
  error: string | null;
  timeMode: string;
  skipped: readonly string[];
  steps: ReadonlyArray<{ name: string; ms: number }>;
  observations: readonly Observation[];
  failedExpectations: readonly Observation[];
  advances: readonly ClockAdvance[];
  calls: readonly ApiCall[];
  responses: readonly RecordedResponse[];
  startedAtMs: number;
  finishedAtMs: number;
}

export interface FixtureInput {
  meta: Record<string, unknown>;
  scenarios: readonly FixtureScenario[];
  deliveries: readonly Delivery[];
  attribution: Attribution;
  unscopedCalls: readonly ApiCall[];
}

function histogram(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

export function apiCost(calls: readonly ApiCall[]) {
  return {
    total: calls.length,
    secret_key: calls.filter((c) => c.auth === "secret").length,
    publishable_key: calls.filter((c) => c.auth === "publishable").length,
    by_method: histogram(calls.map((c) => c.method)),
    by_status: histogram(calls.map((c) => String(c.status))),
    replayed: calls.filter((c) => c.replayed).length,
    rate_limited: calls.filter((c) => c.status === 429).length,
    rate_limited_reasons: histogram(
      calls.filter((c) => c.rateLimitedReason).map((c) => c.rateLimitedReason as string),
    ),
    total_ms: calls.reduce((sum, c) => sum + c.ms, 0),
  };
}

/**
 * Write `tools/stripe/fixtures/<scenario>/{scenario,events,responses}.json` and `index.json`
 * from one run, through one Scrubber (consistent id rewriting across all files). Refuses to
 * write if anything secret-shaped survives scrubbing.
 */
export function writeFixtures(input: FixtureInput): number {
  const scrubber = new Scrubber();
  const files: Array<{ path: string; data: unknown }> = [];
  const scenarioSummaries: unknown[] = [];

  const index = scrubber.scrub({
    generated_by: "make stripe-proof (tools/stripe/proof/run.ts)",
    ...input.meta,
  }) as Record<string, unknown>;

  for (const s of input.scenarios) {
    const seqs = input.attribution.byOwner.get(s.name) ?? [];
    const deliveries = seqs
      .map((seq) => input.deliveries[seq])
      .filter((d): d is Delivery => d !== undefined);
    const originals = deliveries.filter((d) => d.deliveryOfId === 1 && d.event);
    const inverted = inversions(
      originals.map((d) => ({
        seq: d.seq,
        // biome-ignore lint/style/noNonNullAssertion: filtered on d.event above.
        created: d.event!.created,
        // biome-ignore lint/style/noNonNullAssertion: filtered on d.event above.
        id: d.event!.id,
        // biome-ignore lint/style/noNonNullAssertion: filtered on d.event above.
        type: d.event!.type,
      })),
    );
    const ok = !s.error && s.failedExpectations.length === 0;
    const scenario = scrubber.scrub({
      name: s.name,
      title: s.title,
      ok,
      error: s.error,
      time_mode: s.timeMode,
      skipped: s.skipped,
      started_at: new Date(s.startedAtMs).toISOString(),
      duration_ms: s.finishedAtMs - s.startedAtMs,
      steps: s.steps,
      observations: s.observations,
      failed_expectations: s.failedExpectations,
      clock_advances: s.advances.map((a) => ({
        clock: a.clock,
        from: new Date(a.fromTime * 1000).toISOString(),
        to: new Date(a.toTime * 1000).toISOString(),
        span_hours: Math.round(((a.toTime - a.fromTime) / 3600) * 10) / 10,
        ms: a.ms,
        polls: a.polls,
      })),
      api: apiCost(s.calls),
      events: {
        deliveries: deliveries.length,
        distinct: new Set(deliveries.map((d) => d.event?.id)).size,
        types: histogram(originals.map((d) => d.event?.type ?? "?")),
        inversions_vs_created: inverted,
      },
      calls: s.calls.map((c) => ({
        step: c.step,
        method: c.method,
        path: c.path,
        status: c.status,
        ms: c.ms,
        auth: c.auth,
        idempotency_key: c.idempotencyKey,
        replayed: c.replayed,
        request_id: c.requestId,
      })),
    });
    const responses = scrubber.scrub(s.responses);
    const events = scrubber.scrub(
      deliveries.map((d, n) => ({
        n,
        run_seq: d.seq,
        received_offset_ms: d.receivedAtMs - s.startedAtMs,
        delivery_of_id: d.deliveryOfId,
        signature_verified: d.signatureVerified,
        responded_with: d.respondedWith,
        signed_minus_created_s:
          d.signedAt !== null && d.event ? d.signedAt - d.event.created : null,
        event: d.event,
      })),
    );
    files.push({ path: join(s.name, "scenario.json"), data: scenario });
    files.push({ path: join(s.name, "responses.json"), data: responses });
    files.push({ path: join(s.name, "events.json"), data: events });
    scenarioSummaries.push({
      name: s.name,
      title: s.title,
      ok,
      skipped: s.skipped.length,
      duration_ms: s.finishedAtMs - s.startedAtMs,
      api_calls: s.calls.length,
      deliveries: deliveries.length,
      clock_advances: s.advances.length,
      clock_advance_ms: s.advances.map((a) => a.ms),
    });
  }

  const unattributed = input.attribution.unattributed
    .map((seq) => input.deliveries[seq])
    .filter((d): d is Delivery => d !== undefined)
    .map((d) => ({
      run_seq: d.seq,
      type: d.event?.type ?? null,
      object: (d.event?.data.object as { object?: string } | undefined)?.object ?? null,
    }));

  files.push({
    path: "index.json",
    data: {
      ...index,
      scenarios: scenarioSummaries,
      setup_calls: apiCost(input.unscopedCalls),
      deliveries_total: input.deliveries.length,
      unattributed: scrubber.scrub(unattributed),
      ambiguous: input.attribution.ambiguous.length,
      scrubbed: scrubber.stats(),
    },
  });

  const rendered = files.map((f) => ({
    path: f.path,
    text: `${JSON.stringify(f.data, null, 2)}\n`,
  }));
  for (const f of rendered) {
    const leaks = findSecrets(f.text);
    if (leaks.length > 0) {
      throw new Error(
        `Refusing to write fixtures: ${f.path} still contains ${leaks.map((l) => l.kind).join(", ")}`,
      );
    }
    const missed = unscrubbedIds(f.text);
    if (missed.length > 0) {
      throw new Error(
        `Refusing to write fixtures: ${f.path} has ${missed.length} id(s) the scrubber missed (prefixes: ${[...new Set(missed)].join(", ")})`,
      );
    }
  }
  rmSync(paths.fixturesDir, { recursive: true, force: true });
  for (const f of rendered) {
    const target = join(paths.fixturesDir, f.path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, f.text);
  }
  formatWithBiome();
  return rendered.length;
}

/**
 * Format the fixtures with the workspace's Biome, so `pnpm lint` (which format-checks JSON)
 * passes. Biome's output is deterministic, so regeneration stays byte-identical.
 */
function formatWithBiome(): void {
  const biome = join(REPO_ROOT, "node_modules", ".bin", "biome");
  if (!existsSync(biome)) {
    process.stderr.write(
      "Biome not installed: fixtures left unformatted (pnpm lint will flag them).\n",
    );
    return;
  }
  execFileSync(biome, ["format", "--write", paths.fixturesDir], {
    cwd: REPO_ROOT,
    stdio: "ignore",
  });
}
