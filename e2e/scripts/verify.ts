#!/usr/bin/env node
/**
 * `make verify`: the browser suite, then the conformance suite, against one running mode, with
 * one combined summary and a non-zero exit on any failure (e2e/README.md "Verify").
 *
 * Order matters. The conformance suite (tools/smoke) finishes by deliberately exhausting the
 * sign-in, sign-up and email-lookup budgets of the address it runs from, so the browser suite
 * runs first. Then the script waits one rate-limit window (VERIFY_COOLDOWN_SEC, default 65) so
 * the conformance suite starts with the full budgets it would have on its own: its rate-limit
 * checks measure the deployment, not what the browser suite just spent. The two never run at
 * the same time.
 *
 * Environment: BASE_URL (the origin people load), SMOKE_BASE_URL (default BASE_URL; dev mode's
 * API origin differs from its web origin), VERIFY_COOLDOWN_SEC, E2E_BROWSERS, SMOKE_ARGS.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const e2eDir = join(import.meta.dirname, "..");
const root = join(e2eDir, "..");
const baseUrl = process.env.BASE_URL;
if (!baseUrl) {
  console.error("verify: BASE_URL is required (make verify TARGET=dev|k8s|cf, or BASE_URL=...)");
  process.exit(2);
}
const smokeUrl = process.env.SMOKE_BASE_URL || baseUrl;
if (process.env.VERIFY_DRY_RUN) {
  // `make verify VERIFY_DRY_RUN=1`: what would run where (scripts/check-verify-urls.ts asserts it).
  console.log(`browser suite: ${baseUrl}`);
  console.log(`conformance: ${smokeUrl}`);
  process.exit(0);
}
const cooldownSec = Number(process.env.VERIFY_COOLDOWN_SEC ?? 65);
// Playwright empties test-results when it starts, so the summaries are written after that.
const outDir = join(e2eDir, "test-results", "verify");
const e2eReport = join(outDir, "e2e.json");
const smokeReport = join(outDir, "conformance.json");

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const started = Date.now();
  return new Promise<{ code: number; seconds: number }>((resolve) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
    child.on("close", (code) =>
      resolve({ code: code ?? 1, seconds: Math.round((Date.now() - started) / 100) / 10 }),
    );
  });
}

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/api/v1/session", url), {
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

const say = (text: string) => console.log(`\x1b[36m[verify]\x1b[0m ${text}`);

for (const url of new Set([baseUrl, smokeUrl])) {
  if (!(await reachable(url))) {
    console.error(`verify: nothing answers ${url}/api/v1/session; start the mode first`);
    process.exit(2);
  }
}

say(`browser suite against ${baseUrl}`);
const e2e = await run("pnpm", ["exec", "playwright", "test"], e2eDir, {
  BASE_URL: baseUrl,
  E2E_JSON_REPORT: e2eReport,
});

if (cooldownSec > 0) {
  say(
    `waiting ${cooldownSec} s for this address's rate-limit budgets to refill before the conformance suite`,
  );
  await new Promise((resolve) => setTimeout(resolve, cooldownSec * 1000));
}

say(`conformance suite against ${smokeUrl}`);
mkdirSync(outDir, { recursive: true });
const smokeArgs = (process.env.SMOKE_ARGS ?? "").split(/\s+/).filter(Boolean);
const smoke = await run(
  "node",
  ["tools/smoke/src/cli.ts", "--base-url", smokeUrl, "--json", smokeReport, ...smokeArgs],
  root,
);

interface PlaywrightStats {
  expected: number;
  unexpected: number;
  flaky: number;
  skipped: number;
}
const stats = readJson<{ stats: PlaywrightStats }>(e2eReport)?.stats ?? null;
const counts = readJson<{ counts: Record<string, number> }>(smokeReport)?.counts ?? null;

const e2eOk = e2e.code === 0 && stats !== null && stats.unexpected === 0 && stats.flaky === 0;
const smokeOk = smoke.code === 0 && counts !== null && (counts.fail ?? 0) === 0;

const e2eLine = stats
  ? `${stats.expected} passed · ${stats.unexpected} failed · ${stats.flaky} flaky · ${stats.skipped} skipped`
  : "no report (did not run)";
const smokeLine = counts
  ? `${counts.pass ?? 0} passed · ${counts.fail ?? 0} failed · ${counts.skip ?? 0} skipped` +
    (counts.xfail ? ` · ${counts.xfail} expected failures` : "")
  : "no report (did not run)";

console.log("");
console.log(`verify  ${baseUrl}${smokeUrl === baseUrl ? "" : ` (conformance: ${smokeUrl})`}`);
console.log(
  `  browser suite   ${e2eOk ? "PASS" : "FAIL"}  ${e2eLine}  (${e2e.seconds} s, exit ${e2e.code})`,
);
console.log(
  `  conformance     ${smokeOk ? "PASS" : "FAIL"}  ${smokeLine}  (${smoke.seconds} s, exit ${smoke.code})`,
);
console.log(`  result          ${e2eOk && smokeOk ? "PASS" : "FAIL"}`);
console.log(`  reports         ${e2eReport}, ${smokeReport}`);
process.exit(e2eOk && smokeOk ? 0 : 1);
