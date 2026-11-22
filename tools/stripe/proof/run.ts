#!/usr/bin/env node
/**
 * The Stripe proof run (`make stripe-proof`): drives the sandbox through every behaviour the
 * billing design depends on, records each webhook delivery in arrival order and the key API
 * responses, and regenerates the scrubbed fixtures in tools/stripe/fixtures.
 *
 * Run with `node --conditions=worker`, so `import Stripe from "stripe"` loads the library's
 * Workers build: fetch for HTTP, Web Crypto for signatures, and Node's transports unavailable.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  captureWebhookSecret,
  importedKey,
  readRecord,
  startListener,
  stopListener,
} from "../src/listen.ts";
import { paths } from "../src/paths.ts";
import { redact } from "../src/secrets.ts";
import { ensurePrivateDir, writePrivateFile } from "../src/secure-fs.ts";
import { requireState } from "../src/state.ts";
import { runCli } from "../src/stripe-cli.ts";
import { attribute } from "./attribution.ts";
import { API_VERSION, createStripe, unscopedCalls } from "./client.ts";
import { deleteClock } from "./clock.ts";
import { activeScope, Scenario } from "./context.ts";
import { writeFixtures } from "./fixtures.ts";
import { startReceiver } from "./receiver.ts";
import { SCENARIOS, type ScenarioDefinition } from "./registry.ts";
import type { DeliveryControls } from "./scenarios/delivery.ts";
import { detectTimeMode } from "./timeline.ts";

const LISTENER = "proof";

function log(line: string): void {
  process.stdout.write(`${redact(line)}\n`);
}

async function runScenario(
  def: ScenarioDefinition,
  s: Scenario,
  controls: DeliveryControls,
): Promise<void> {
  s.firstSeq = s.receiver.deliveries.length;
  s.startedAtMs = Date.now();
  log(`▶ ${def.name}: ${def.title}`);
  try {
    await activeScope.run({ scenario: s }, () => def.run(s, controls));
  } catch (error) {
    s.error = error instanceof Error ? error.message : String(error);
  } finally {
    s.finishedAtMs = Date.now();
  }
  const failed = s.failedExpectations.length;
  const verdict = s.error
    ? `FAILED: ${s.error}`
    : failed
      ? `${failed} expectation(s) not met`
      : "ok";
  log(
    `■ ${def.name}: ${verdict} (${Math.round((s.finishedAtMs - s.startedAtMs) / 1000)} s, ${s.calls.length} API calls)`,
  );
}

/** Cancel subscriptions the run left running (real time has no clock whose deletion removes them). */
async function cancelLeftovers(
  stripe: ReturnType<typeof createStripe>,
  scenarios: readonly Scenario[],
): Promise<number> {
  let canceled = 0;
  for (const s of scenarios) {
    for (const id of s.owned) {
      if (!id.startsWith("sub_")) continue;
      try {
        const sub = await stripe.subscriptions.retrieve(id);
        if (
          ["active", "trialing", "past_due", "incomplete", "unpaid", "paused"].includes(sub.status)
        ) {
          await stripe.subscriptions.cancel(id);
          canceled++;
        }
      } catch {
        // Deleted with its test clock, or already gone.
      }
    }
  }
  return canceled;
}

async function inPool<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  });
  await Promise.all(workers);
}

function packageVersion(name: string): string {
  const manifest = JSON.parse(
    readFileSync(join(paths.fixturesDir, "..", "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return manifest.dependencies?.[name] ?? manifest.devDependencies?.[name] ?? "unknown";
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      only: { type: "string" },
      concurrency: { type: "string", default: "4" },
      port: { type: "string", default: "5510" },
      "keep-clocks": { type: "boolean", default: false },
      "no-fixtures": { type: "boolean", default: false },
      /** auto: test clocks if the key may create them, else real time. */
      time: { type: "string", default: "auto" },
    },
  });
  const port = Number(values.port);
  if (!(port >= 5500 && port <= 5549)) throw new Error("--port must be within 5500–5549");
  const only = values.only ? new Set(values.only.split(",").map((n) => n.trim())) : null;
  const selected = SCENARIOS.filter((d) => !only || only.has(d.name) || d.name === "catalogue");
  const writeFixtureFiles = !values["no-fixtures"] && !only;

  const state = requireState();
  const stripe = createStripe(state.secretKey);
  const runId = `r${Date.now().toString(36)}`;
  const startedAt = new Date();
  log(
    `Stripe proof run ${runId} against ${state.accountId}, API ${API_VERSION}, ${selected.length} scenario(s)`,
  );

  const clockProbe = await detectTimeMode(stripe, values.time ?? "auto");
  const timeMode = clockProbe.mode;
  log(`Time: ${timeMode} (${clockProbe.reason})`);

  const { secret } = await captureWebhookSecret();
  const receiver = await startReceiver({ port, secret, stripe });
  const listen = () =>
    startListener({ name: LISTENER, forwardTo: receiver.url, events: [], latest: false, log }).then(
      () => undefined,
    );
  await listen();
  const controls: DeliveryControls = {
    stopListener: () => stopListener(LISTENER, log).then(() => undefined),
    startListener: listen,
    resend: async (eventId) => {
      const result = await runCli(["events", "resend", eventId], {
        timeoutMs: 60_000,
        ...importedKey(state),
      });
      if (result.code !== 0)
        throw new Error(`stripe events resend failed: ${redact(result.stderr).trim()}`);
      return { code: result.code };
    },
  };

  const scenarios = new Map<string, Scenario>();
  const make = (def: ScenarioDefinition) => {
    const s = new Scenario({
      name: def.name,
      title: def.title,
      stripe,
      receiver,
      runId,
      publishableKey: state.publishableKey,
      timeMode,
    });
    scenarios.set(def.name, s);
    return s;
  };

  let exitCode = 0;
  try {
    for (const def of selected.filter((d) => d.phase === "first"))
      await runScenario(def, make(def), controls);
    await inPool(
      selected.filter((d) => d.phase === "main"),
      Number(values.concurrency),
      (def) => runScenario(def, make(def), controls),
    );
    for (const def of selected.filter((d) => d.phase === "last"))
      await runScenario(def, make(def), controls);
    // Late deliveries (events created by the last steps) still belong in the record.
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  } finally {
    const listener = readRecord(LISTENER);
    await stopListener(LISTENER, log);
    await receiver.close();

    const ordered = selected
      .map((d) => scenarios.get(d.name))
      .filter((s): s is Scenario => s !== undefined);
    const attribution = attribute(
      receiver.deliveries.map((d) => ({ seq: d.seq, object: d.event?.data.object ?? null })),
      ordered.map((s) => ({ name: s.name, owned: s.owned, firstSeq: s.firstSeq })),
    );

    const finishedAt = new Date();
    const meta = {
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      accountId: state.accountId,
      apiVersion: API_VERSION,
      eventApiVersion: listener?.eventApiVersion ?? null,
      stripeNode: packageVersion("stripe"),
      stripeCli: packageVersion("@stripe/cli"),
      concurrency: Number(values.concurrency),
      timeMode,
      timeModeReason: clockProbe.reason,
    };

    // Raw, unscrubbed record for debugging: git-ignored and owner-only (it holds client secrets).
    const runDir = join(paths.runsDir, runId);
    ensurePrivateDir(runDir);
    writePrivateFile(
      join(runDir, "raw.json"),
      JSON.stringify(
        {
          meta,
          deliveries: receiver.deliveries,
          attribution: Object.fromEntries(attribution.byOwner),
          unattributed: attribution.unattributed,
          ambiguous: attribution.ambiguous,
          scenarios: ordered.map((s) => ({
            name: s.name,
            title: s.title,
            firstSeq: s.firstSeq,
            error: s.error,
            calls: s.calls,
            responses: s.responses,
            observations: s.observations,
            advances: s.advances,
            steps: s.steps,
            owned: [...s.owned],
            skipped: s.skipped,
            startedAtMs: s.startedAtMs,
            finishedAtMs: s.finishedAtMs,
          })),
          unscopedCalls,
        },
        null,
        2,
      ),
    );
    log(`Raw record: ${join(runDir, "raw.json")}`);

    if (!values["keep-clocks"]) {
      for (const s of ordered) for (const clock of s.clocks) await deleteClock(stripe, clock);
      if (ordered.some((s) => s.clocks.length > 0))
        log("Test clocks deleted (their customers and subscriptions go with them).");
    }
    const canceled = await cancelLeftovers(stripe, ordered);
    if (canceled > 0)
      log(
        `Canceled ${canceled} subscription(s) the run left running, so they stop generating events.`,
      );

    if (writeFixtureFiles) {
      const written = writeFixtures({
        meta,
        scenarios: ordered,
        deliveries: receiver.deliveries,
        attribution,
        unscopedCalls,
      });
      log(`Fixtures: ${written} files in ${paths.fixturesDir}`);
    } else {
      log("Fixtures not written (partial run or --no-fixtures).");
    }

    log("");
    log(
      `${"scenario".padEnd(20)} ${"result".padEnd(8)} ${"time".padStart(6)} ${"calls".padStart(6)} ${"events".padStart(7)} ${"clock".padStart(12)}`,
    );
    for (const s of ordered) {
      const events = attribution.byOwner.get(s.name)?.length ?? 0;
      const advanceMs = s.advances.reduce((sum, a) => sum + a.ms, 0);
      const ok = !s.error && s.failedExpectations.length === 0;
      if (!ok) exitCode = 1;
      log(
        `${s.name.padEnd(20)} ${(ok ? "ok" : "FAILED").padEnd(8)} ${`${Math.round((s.finishedAtMs - s.startedAtMs) / 1000)}s`.padStart(6)} ` +
          `${String(s.calls.length).padStart(6)} ${String(events).padStart(7)} ${`${s.advances.length}× ${Math.round(advanceMs / 1000)}s`.padStart(12)}`,
      );
      for (const check of s.skipped) log(`    skipped (needs a test clock): ${check}`);
      for (const o of s.failedExpectations)
        log(`    expected ${o.key}: ${JSON.stringify(o.expected)}, got ${JSON.stringify(o.value)}`);
    }
    log(
      `Unattributed deliveries: ${attribution.unattributed.length}; total deliveries: ${receiver.deliveries.length}`,
    );
    log(`Wall time: ${Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000)} s`);
  }
  return exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `${redact(error instanceof Error ? (error.stack ?? error.message) : String(error))}\n`,
    );
    process.exitCode = 1;
  },
);
