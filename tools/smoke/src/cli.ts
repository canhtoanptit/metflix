#!/usr/bin/env node
/**
 * webflix-smoke: run the conformance suite against a deployment.
 *
 *   node tools/smoke/src/cli.ts --base-url http://localhost:4000
 *   node tools/smoke/src/cli.ts -u http://localhost:8787 --only identity,consistency --json report.json
 */
import { writeFile } from "node:fs/promises";
import { OPENAPI_PATH } from "@webflix/contracts";
import { allChecks } from "./checks/index.ts";
import { type CliOptions, parseCli, USAGE, UsageError } from "./options.ts";
import { formatCatalogue, formatHeader, formatResult, formatSummary } from "./report.ts";
import { runChecks, selectChecks } from "./runner.ts";

/** Fail fast (exit 2) when nothing answers at the base URL, instead of 60 identical failures. */
async function reachable(baseUrl: string, timeoutMs: number): Promise<string | null> {
  try {
    const response = await fetch(new URL(OPENAPI_PATH, baseUrl), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return null;
  } catch (error) {
    const cause =
      error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
    return `${error instanceof Error ? error.message : String(error)}${cause}`;
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  let cli: CliOptions;
  try {
    cli = parseCli(argv);
  } catch (error) {
    if (error instanceof UsageError || (error instanceof Error && "code" in error)) {
      console.error(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
  if (cli.help) {
    console.log(USAGE);
    return 0;
  }
  if (cli.list) {
    console.log(formatCatalogue(selectChecks(allChecks, cli.options)));
    return 0;
  }
  const options = cli.options;
  const style = { color: cli.color };
  const out = cli.json === "-" ? console.error : console.log;
  const unreachable = await reachable(options.baseUrl, options.requestTimeoutMs);
  if (unreachable) {
    console.error(`Target unreachable: ${options.baseUrl}${OPENAPI_PATH}: ${unreachable}`);
    return 2;
  }
  out(formatHeader({ baseUrl: options.baseUrl, runId: options.runId }, new Date()));
  out("");
  options.log = (line) => out(`  · ${line}`);
  const report = await runChecks(allChecks, options, {
    onResult: (result) => out(formatResult(result, style, options.verbose)),
  });
  out(formatSummary(report, style));
  if (cli.json) {
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (cli.json === "-") process.stdout.write(json);
    else {
      await writeFile(cli.json, json);
      out(`JSON summary: ${cli.json}`);
    }
  }
  return report.ok ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error);
      process.exit(2);
    },
  );
}
