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
 *   node src/recs.ts demo [--replace] [--to <dir>]       publish and import a demo run
 *
 * Artefacts are read from the mode's blob store (the pipeline publishes `recs/current.json` and
 * `experiments/results/current.json` into the same bucket), or from `--from <dir>`, a pipeline
 * store in the filesystem layout (`.cache/recs/<preset>/store`). One JSON line per result on
 * stdout; exit 1 on failure (for `experiments-import`, also when a result was refused); exit 3
 * when a run was imported but the shared cache could not be told (retried; every process serves
 * it within the model's 30 s age bound).
 *
 * `demo` (docs/RECOMMENDATIONS.md, "A demo run"): a run for the demo account's profiles, for a
 * demo where no pipeline run is fresh. Not a trained model: the rule engine's scores for each
 * demo profile's seeded library, content-similarity neighbours; its run id ends in `-de00de00`
 * and its manifest says `code.demo: true`. It is published into the mode's artefact store
 * (version, then pointer) and imported by the importer like any run, checksums included.
 * Refused while a fresh pipeline run is served, unless `--replace`. `--to <dir>` only writes it
 * into a filesystem store (the pipeline store layout), published there, and imports nothing.
 */
import { createFsBlobStore } from "@webflix/adapters-node";
import {
  DemoRunRefusedError,
  publishDemoRecommendations,
  serializeError,
  writeDemoRecommendations,
} from "@webflix/core";
import { migrateToLatest } from "@webflix/db";
import { loadApiConfig } from "./config.ts";
import { createRuntime, loadSeedInput } from "./runtime.ts";

const USAGE = `Usage: node src/recs.ts <import|rollback|status|experiments-import|demo> [options]

  import                Import the published run (recs/current.json) and serve it
      --run <run>       Import this version instead (recs/v=<run>/manifest.json)
      --from <dir>      Read artefacts from a pipeline store directory, not the mode's blob store
  rollback              Serve the previously served run again (one write)
  status                Print the served model and the last import
  experiments-import    Import the experiment results the pipeline published
                        (experiments/results/current.json); --from <dir> as above
  demo                  Publish a demo run for the demo account's profiles into the artefact
                        store and import it (labelled: run id *-de00de00, manifest code.demo)
      --replace         Even while a fresh pipeline run is served (it replaces it for everyone)
      --to <dir>        Only write it, published, into this filesystem store; import nothing
`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      run: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      replace: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const command = positionals[0];
  const commands = ["import", "rollback", "status", "experiments-import", "demo"];
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
    } else if (command === "demo") {
      const seed = await loadSeedInput(config, { blobs: runtime.infra.blobs });
      if (!seed.demoAccount) throw new Error("No demo account in the seed");
      const input = {
        catalog: seed.catalog,
        demoAccount: seed.demoAccount,
        manifest: seed.manifest,
        // The serving runtime's own key: the lists are filed under the keys it looks up.
        pseudonymKey: config.core.events.pseudonymKey,
        now: Date.now(),
      };
      try {
        result = values.to
          ? await writeDemoRecommendations({
              ...input,
              blobs: createFsBlobStore({ root: values.to }),
              publish: true,
            })
          : await publishDemoRecommendations({
              ...input,
              personalisation,
              blobs: runtime.infra.blobs,
              replace: values.replace === true,
            });
      } catch (error) {
        if (!(error instanceof DemoRunRefusedError)) throw error;
        process.stderr.write(`${error.message}\n`);
        return 1;
      }
    } else if (command === "rollback") {
      result = await personalisation.rollbackRecommendations();
    } else {
      result = await personalisation.recommendationStatus();
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    // Imported, but the shared cache was never told (retried): said, with its own exit code.
    const imported = (result as { imported?: unknown })?.imported ?? result;
    if ((imported as { cacheInvalidated?: boolean } | null)?.cacheInvalidated === false) {
      process.stderr.write(
        "imported, but the shared cache could not be told after retries: every process serves the new model within 30 s\n",
      );
      return 3;
    }
    return 0;
  } catch (error) {
    runtime.logger.error("recs.command_failed", { command, error: serializeError(error) });
    return 1;
  } finally {
    await runtime.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
