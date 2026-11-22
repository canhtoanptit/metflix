#!/usr/bin/env node
import { parseArgs } from "node:util";
/**
 * webflix-recs-import: the recommendation importer's command-line entry for the Node modes, so
 * that scheduling it (a CronJob on k8s, a timer in dev) is wiring. Same configuration as the API
 * (environment only); the store is `WEBFLIX_RECOMMENDATION_STORE` on `WEBFLIX_DATABASE_URL`.
 *
 *   node src/recs.ts import [--run <run>] [--from <dir>]   publish the pipeline's run
 *   node src/recs.ts rollback                             serve the previous run again
 *   node src/recs.ts status                               the served model and the last import
 *   node src/recs.ts experiments-import [--from <dir>]    the pipeline's experiment results
 *
 * Artefacts are read from the mode's blob store (the pipeline publishes `recs/current.json` and
 * `experiments/results/current.json` into the same bucket), or from `--from <dir>`, a pipeline
 * store in the filesystem layout (`.cache/recs/<preset>/store`). One JSON line per result on
 * stdout; exit 1 on failure (for `experiments-import`, also when a result was refused).
 */
import { createFsBlobStore } from "@webflix/adapters-node";
import { serializeError } from "@webflix/core";
import { migrateToLatest } from "@webflix/db";
import { loadApiConfig } from "./config.ts";
import { createRuntime } from "./runtime.ts";

const USAGE = `Usage: node src/recs.ts <import|rollback|status|experiments-import> [options]

  import                Import the published run (recs/current.json) and serve it
      --run <run>       Import this version instead (recs/v=<run>/manifest.json)
      --from <dir>      Read artefacts from a pipeline store directory, not the mode's blob store
  rollback              Serve the previously served run again (one write)
  status                Print the served model and the last import
  experiments-import    Import the experiment results the pipeline published
                        (experiments/results/current.json); --from <dir> as above
`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      run: { type: "string" },
      from: { type: "string" },
      help: { type: "boolean" },
    },
  });
  const command = positionals[0];
  const commands = ["import", "rollback", "status", "experiments-import"];
  if (values.help || !command || !commands.includes(command)) {
    process.stderr.write(USAGE);
    return values.help ? 0 : 2;
  }
  const config = loadApiConfig(process.env);
  const runtime = createRuntime(config, "worker");
  try {
    if (config.migrateOnStart) await migrateToLatest(runtime.infra.database);
    const personalisation = runtime.services.personalisation;
    let result: unknown;
    if (command === "import") {
      result = await personalisation.importRecommendations({
        ...(values.run ? { run: values.run } : {}),
        ...(values.from ? { artefacts: createFsBlobStore({ root: values.from }) } : {}),
      });
    } else if (command === "experiments-import") {
      const imported = await runtime.services.experiments.importResults(
        values.from ? { artefacts: createFsBlobStore({ root: values.from }) } : {},
      );
      process.stdout.write(`${JSON.stringify(imported)}\n`);
      // Unknown experiments are expected (the pipeline analyses what it was given); a result
      // that failed verification is not.
      return imported.skipped.some((entry) => entry.reason !== "unknown experiment") ? 1 : 0;
    } else if (command === "rollback") {
      result = await personalisation.rollbackRecommendations();
    } else {
      result = await personalisation.recommendationStatus();
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    runtime.logger.error("recs.command_failed", { command, error: serializeError(error) });
    return 1;
  } finally {
    await runtime.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
