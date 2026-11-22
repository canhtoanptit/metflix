#!/usr/bin/env node
/**
 * Print the event sequence of every scenario in tools/stripe/fixtures as Markdown tables (the
 * tables in docs/STRIPE.md come from here): `node tools/stripe/proof/report.ts [scenario…]`.
 * Reads only the scrubbed fixtures.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/paths.ts";

interface FixtureEvent {
  n: number;
  received_offset_ms: number;
  delivery_of_id: number;
  responded_with: number;
  event: {
    id: string;
    type: string;
    created: number;
    data: { object: Record<string, unknown> };
  } | null;
}

function describe(object: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of [
    "status",
    "billing_reason",
    "attempt_count",
    "cancel_at_period_end",
    "amount_refunded",
    "refunded",
  ]) {
    const value = object[key];
    if (value !== undefined && value !== null && value !== false)
      parts.push(`${key}=${String(value)}`);
  }
  return parts.join(" ");
}

const index = JSON.parse(readFileSync(join(paths.fixturesDir, "index.json"), "utf8")) as {
  scenarios: Array<{ name: string; title: string }>;
};
const wanted = new Set(process.argv.slice(2));
for (const scenario of index.scenarios) {
  if (wanted.size > 0 && !wanted.has(scenario.name)) continue;
  const file = join(paths.fixturesDir, scenario.name, "events.json");
  if (!existsSync(file)) continue;
  const events = JSON.parse(readFileSync(file, "utf8")) as FixtureEvent[];
  const start = events[0]?.event?.created ?? 0;
  process.stdout.write(`\n#### ${scenario.name}: ${scenario.title}\n\n`);
  process.stdout.write(
    "| # | arrived (s) | created (s) | event | object | state |\n| ---: | ---: | ---: | --- | --- | --- |\n",
  );
  for (const e of events) {
    if (!e.event) continue;
    const object = e.event.data.object;
    const notes = [
      describe(object),
      e.delivery_of_id > 1 ? `delivery #${e.delivery_of_id}` : "",
      e.responded_with !== 200 ? `answered ${e.responded_with}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    process.stdout.write(
      `| ${e.n + 1} | ${(e.received_offset_ms / 1000).toFixed(1)} | ${e.event.created - start} | \`${e.event.type}\` | ${String(object.object ?? "")} | ${notes} |\n`,
    );
  }
}
