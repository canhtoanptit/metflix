#!/usr/bin/env node
/**
 * webflix-edge ops: the data-plane operations of the Cloudflare mode, run from Node against
 * the Worker's bindings (local miniflare state, or the real account).
 *
 *   node scripts/ops.ts assets   [--target local|production]   stage SPA + docs bundle + _headers
 *   node scripts/ops.ts media    [--target …] [--profile fast|full] [--prune]
 *   node scripts/ops.ts seed     [--target …] [--force] [--no-demo]
 *   node scripts/ops.ts prepare  [--target …] [--profile …]     media (if packaged) then seed
 *   node scripts/ops.ts status   [--target …]
 *   node scripts/ops.ts dev-vars                               complete .dev.vars (local secrets)
 *   node scripts/ops.ts lake pull   --store <dir>              event lake (R2) → pipeline store
 *   node scripts/ops.ts recs push   --store <dir> [--run <r>]  pipeline artefacts → R2
 *   node scripts/ops.ts recs import [--run <r>] [--from <dir>] import a run from outside the Worker
 *   node scripts/ops.ts recs import --demo [--replace]       publish and import a demo run (local)
 *   node scripts/ops.ts recs status | recs rollback
 *   node scripts/ops.ts jobs export|erase|compact|retain|run   the pipeline's lake jobs against
 *                                                       the running local Worker (lib/pipeline-jobs.ts)
 *
 * Every command is idempotent. See docs/CLOUDFLARE.md for how they fit together.
 */
import { readFileSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { unstable_readConfig } from "wrangler";
import { GENERATION_PROPAGATION_MS, MEDIA_GENERATION_KEY } from "../src/media-generation.ts";
import { stageAssets } from "./lib/assets.ts";
import { publishMedia } from "./lib/generation.ts";
import { localWorkerVars, workerRetention } from "./lib/lake-jobs.ts";
import { mediaStore, mediaUpToDate, pickProfile, uploadMedia } from "./lib/media.ts";
import {
  compactRoundTrip,
  DEFAULT_RECS_BIN,
  dueRoundTrips,
  eraseRoundTrip,
  exportEventsRoundTrip,
  retainRoundTrip,
} from "./lib/pipeline-jobs.ts";
import {
  DEFAULT_INSTANCE,
  EDGE_DIR,
  type LocalInstance,
  openPlatform,
  type Platform,
  parseTarget,
  REPO_ROOT,
  type Target,
  WRANGLER_CONFIG,
} from "./lib/platform.ts";
import type { DevServerRecord } from "./lib/processes.ts";
import {
  importDemoRun,
  importRun,
  personalisationService,
  pullLake,
  pushRecs,
} from "./lib/recs.ts";
import { completeDevVars, isGenerated } from "./lib/secrets.ts";
import { MANIFEST_KEY, readManifestText, seed, seedsDemo } from "./lib/seed.ts";

const USAGE = `Usage: node scripts/ops.ts <assets|media|seed|prepare|status|dev-vars|lake|recs> [options]

  lake pull                   copy the event lake (R2 events/) into --store, incrementally
  recs push                   copy a scored run from --store into R2 (pointer last; --run: no pointer)
  recs import                 import the run R2's recs/current.json names (or --run, or --from a
                              pipeline store) into D1 and KV, from outside the Worker
  recs status | recs rollback the served model / serve the previous run again
  jobs export                 pending data exports: webflix-recs export-events, results posted
  jobs erase                  pending erasures: webflix-recs erase, written back to R2, confirmed
  jobs compact                compact the local lake's closed hours, written back to R2
  jobs retain                 delete what the Worker's retention periods no longer cover, in the
                              store and in R2 (--dry-run: the plan only; --now: as if then)
  jobs run                    what is due: erase, then export (both no-ops when nothing is pending),
                              then retain once a day
                              (jobs run beside the dev server, through its Local Explorer API)

  --target local|production   bindings to use (default local: the wrangler dev state)
  --state <dir>               local: the instance's state directory (default .wrangler/state)
  --port <n>                  local: the port its dev server uses (default 8787)
  --out <dir>                 assets: where to stage (default dist/public or dist/production-assets)
  --payment-provider <name>   assets: stage the headers for this provider instead of the
                              environment's (stripe adds Stripe.js's origins to the CSP; for a
                              local Stripe lane run with --var WEBFLIX_PAYMENT_PROVIDER:stripe)
  --profile fast|full         media profile to upload (default: the first one packaged)
  --prune                     media: delete stored objects the profile no longer has (after
                              the new media was uploaded and seeded)
  --drain-seconds <n>         media: wait before rewriting objects (default 120 in production:
                              readers must stop caching under the old generation first)
  --force                     media: re-check every object; seed: re-apply even if unchanged
                              (resets the demo account)
  --demo | --no-demo          seed: the demo account (default: locally yes, in production no);
                              recs import --demo: publish and import a demo run for the demo
                              account's profiles (local; run id *-de00de00, manifest code.demo)
  --replace                   recs import --demo: even while a fresh pipeline run is served
  --store <dir>               lake, recs push: a pipeline store directory (filesystem BlobStore
                              layout, e.g. .cache/recs/<preset>/store)
  --run <run>                 recs: a version (recs/v=<run>/) instead of the published pointer
  --from <dir>                recs import: read artefacts from a pipeline store, not R2
  --grace-minutes <n>         jobs export / compact: the pipeline's grace (default 15)
  --now <iso>                 jobs compact / retain: as if it were then
  --dry-run                   jobs retain: report what would go, delete nothing
  --delete-sources            jobs compact: delete raw objects a manifest covers
  --recs-bin <path>           jobs: the pipeline's CLI (default services/recs/.venv/bin/webflix-recs)
  --no-media                  seed: ignore packaged media (every title plays the external
                              HLS fallback); seed again without it to switch back
`;

const say = (message: string) => console.log(`[cf] ${message}`);

async function withPlatform<T>(
  target: Target,
  instance: LocalInstance,
  run: (platform: Platform) => Promise<T>,
): Promise<T> {
  const started = Date.now();
  const platform = await openPlatform(target, instance);
  say(`${target} bindings ready (${Date.now() - started} ms)`);
  try {
    return await run(platform);
  } finally {
    await platform.dispose();
  }
}

async function media(
  platform: Platform,
  options: { profile: string | undefined; prune: boolean; force: boolean; drainSec?: number },
) {
  const profile = pickProfile(options.profile);
  if (!profile) {
    say("no packaged media (.cache/media/*/manifest.json): titles play the external HLS fallback");
    say("  run `make content` to package media, then run this again to upload it");
    return;
  }
  const { store, transport } = await mediaStore(platform.env, platform.bucket);
  if (options.prune) {
    // Deleting objects the profile no longer has is safe only once the catalog stopped using
    // them: after the new manifest was uploaded and seeded (a previous run).
    if (!(await mediaUpToDate(store, profile))) {
      throw new Error(
        "--prune runs after the new media is live: upload (`media`), seed, then `media --prune`",
      );
    }
    const report = await uploadMedia(store, platform.target, profile, { prune: true });
    say(`media: ${report.deleted} objects the profile no longer has deleted`);
    return;
  }
  // Readers exist only in production (local tooling refuses to run beside the dev server).
  const drainMs =
    (options.drainSec ??
      (platform.target === "production" ? GENERATION_PROPAGATION_MS / 1000 : 0)) * 1000;
  const { report, generation } = await publishMedia({
    kv: platform.env.CACHE,
    upToDate: async () => !options.force && (await mediaUpToDate(store, profile)),
    upload: async () => {
      say(`uploading media profile "${profile}" to R2 (${platform.target}, ${transport})…`);
      return uploadMedia(store, platform.target, profile).catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `media upload failed: ${detail}\n     The edge cache stays bypassed until an upload completes (run this again; uploads resume). If the media pipeline is still writing .cache/media/${profile}, wait for \`make content\` to finish.`,
        );
      });
    },
    readManifest: () => readManifestText(platform.env),
    drainMs,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: say,
  });
  if (!report) {
    say(
      `media "${profile}" already in R2 (${platform.target}), manifest unchanged; cache generation ${generation}`,
    );
    return;
  }
  say(
    `media: ${report.uploaded} uploaded (${(report.bytes / 1e6).toFixed(1)} MB), ${report.skipped} unchanged; cache generation ${generation}`,
  );
}

async function seedCommand(
  platform: Platform,
  options: { force: boolean; demo: boolean; media: boolean },
) {
  say(`seeding D1 (${platform.target})…`);
  const { result, manifest, generation } = await seed(platform.env, options);
  const assets = `${result.packagedAssets} packaged, ${result.externalAssets} external, ${result.unavailableAssets} unavailable`;
  say(
    result.skipped
      ? `seed unchanged (${result.titles} titles; ${assets})`
      : `seeded ${result.titles} titles, ${result.episodes} episodes (${assets})${result.demoAccount ? ", demo account reset" : ", no demo account"}`,
  );
  say(
    manifest
      ? `media manifest ${manifest.key}`
      : options.media
        ? "no media manifest in the bucket: external HLS fallback"
        : "packaged media ignored (--no-media): external HLS fallback",
  );
  say(
    generation.uploading
      ? `media upload in progress or interrupted (${generation.generation}): edge cache bypassed until \`media\` completes`
      : `cache generation ${generation.generation}${generation.changed ? " (new)" : ""}`,
  );
}

/**
 * `.dev.vars` with every secret wrangler.jsonc requires (lib/secrets.ts): written once per clone
 * and completed when the list grows; existing values are never changed.
 */
async function devVars(): Promise<void> {
  const path = join(EDGE_DIR, ".dev.vars");
  const required = unstable_readConfig({ config: WRANGLER_CONFIG }, { hideWarnings: true }).secrets
    ?.required;
  if (!required) throw new Error("wrangler.jsonc declares no secrets.required");
  const existing = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const { text, added } = completeDevVars(existing, required);
  if (added.length === 0) return;
  await writeFile(path, text, { mode: 0o600 });
  await chmod(path, 0o600);
  say(
    `wrote ${added.join(", ")} to ${relative(process.cwd(), path)} (${added.filter(isGenerated).length} generated, the rest empty = unset)`,
  );
}

async function status(platform: Platform) {
  const { env } = platform;
  const hash = await env.DB.prepare("SELECT value FROM meta WHERE key = 'seed.hash'")
    .first<{ value: string }>()
    .catch(() => null);
  const titles = await env.DB.prepare("SELECT count(*) AS n FROM titles")
    .first<{ n: number }>()
    .catch(() => null);
  const manifest = await env.MEDIA.head(MANIFEST_KEY);
  const generation = await env.CACHE.get(MEDIA_GENERATION_KEY);
  say(
    `D1: ${titles ? `${titles.n} titles` : "not migrated"}, seed ${hash?.value.slice(0, 12) ?? "none"}`,
  );
  say(
    `R2: manifest ${manifest ? `${manifest.size} bytes, uploaded ${manifest.uploaded.toISOString()}` : "absent"}`,
  );
  say(`KV: media cache generation ${generation ?? "unset"}`);
}

/** The pipeline's privacy jobs against the running local Worker (lib/pipeline-jobs.ts). */
async function jobsCommand(
  sub: string | undefined,
  instance: LocalInstance,
  values: {
    store?: string | undefined;
    force: boolean;
    "grace-minutes"?: string | undefined;
    now?: string | undefined;
    "delete-sources": boolean;
    "dry-run": boolean;
    "recs-bin"?: string | undefined;
  },
): Promise<number> {
  const bucket =
    unstable_readConfig({ config: WRANGLER_CONFIG }, { hideWarnings: true }).r2_buckets[0]
      ?.bucket_name ?? "webflix-media";
  const context = {
    origin: `http://localhost:${instance.port}`,
    bucket,
    storeDir: resolve(values.store ?? join(REPO_ROOT, ".cache", "recs", "cf", "store")),
    recsBin: values["recs-bin"] ? resolve(values["recs-bin"]) : DEFAULT_RECS_BIN,
    log: say,
  };
  const graceMinutes = values["grace-minutes"] === undefined ? 15 : Number(values["grace-minutes"]);
  const print = (label: string, result: unknown) => say(`${label}: ${JSON.stringify(result)}`);
  // The retention periods the running Worker has: its vars, .dev.vars, and the dev server's own
  // --var overrides (recorded in the state directory by scripts/dev.ts).
  const periods = () => {
    let record: DevServerRecord | null = null;
    try {
      record = JSON.parse(
        readFileSync(join(instance.state, "dev-server.json"), "utf8"),
      ) as DevServerRecord;
    } catch {
      record = null;
    }
    return workerRetention(
      localWorkerVars({
        configPath: WRANGLER_CONFIG,
        devVarsPath: join(EDGE_DIR, ".dev.vars"),
        overrides: record?.vars,
      }),
    );
  };
  switch (sub) {
    case "export":
      print("jobs export", await exportEventsRoundTrip(context, { graceMinutes }));
      return 0;
    case "erase":
      print("jobs erase", await eraseRoundTrip(context, { force: values.force }));
      return 0;
    case "compact":
      print(
        "jobs compact",
        await compactRoundTrip(context, {
          graceMinutes,
          ...(values.now ? { now: values.now } : {}),
          deleteSources: values["delete-sources"],
        }),
      );
      return 0;
    case "retain":
      print(
        "jobs retain",
        await retainRoundTrip(context, {
          periods: periods(),
          dryRun: values["dry-run"],
          ...(values.now ? { now: values.now } : {}),
        }),
      );
      return 0;
    case "run": {
      const result = await dueRoundTrips(context, { graceMinutes, periods: periods() });
      // Quiet when there was nothing to do: the dev server's loop calls this every few seconds.
      if (result.erase.pending > 0 || result.exports.pending > 0 || result.retain) {
        print("jobs run", result);
      }
      return 0;
    }
    default:
      return usage("jobs <export|erase|compact|retain|run>");
  }
}

function usage(detail: string): number {
  console.error(`Usage: node scripts/ops.ts ${detail}\n\n${USAGE}`);
  return 1;
}

async function recsCommand(
  sub: string | undefined,
  target: Target,
  instance: LocalInstance,
  values: {
    store?: string | undefined;
    run?: string | undefined;
    from?: string | undefined;
    demo?: boolean | undefined;
    replace?: boolean | undefined;
  },
): Promise<number> {
  switch (sub) {
    case "push": {
      if (!values.store) return usage("recs push --store <dir> [--run <run>]");
      const store = resolve(values.store);
      await withPlatform(target, instance, async (platform) => {
        const report = await pushRecs(platform, store, values.run);
        say(
          `recs ${report.run} → R2 (${platform.target}): ${report.copied} files copied (${(report.bytes / 1e6).toFixed(2)} MB), ${report.skipped} already there${report.pointer ? ", pointer recs/current.json written last" : ", no pointer (import with --run)"}`,
        );
      });
      return 0;
    }
    case "import": {
      // Imported, but the shared cache (KV) was never told after retries: exit 3, as the Node
      // importer does (every isolate serves the new model within its 30 s age bound).
      let told = true;
      if (values.demo) {
        await withPlatform(target, instance, async (platform) => {
          const { demo, imported } = await importDemoRun(platform, {
            replace: values.replace === true,
          });
          told = imported.cacheInvalidated !== false;
          say(
            `recs demo run ${demo.run} (lists for ${demo.profiles.map((p) => p.profileId).join(", ")}; none for ${demo.skipped.join(", ") || "-"}): ${JSON.stringify(imported)}`,
          );
        });
        return told ? 0 : 3;
      }
      await withPlatform(target, instance, async (platform) => {
        const started = Date.now();
        const result = await importRun(platform, {
          ...(values.run ? { run: values.run } : {}),
          ...(values.from ? { from: resolve(values.from) } : {}),
        });
        told = result.cacheInvalidated !== false;
        say(
          `recs import (${platform.target}, ${Date.now() - started} ms): ${JSON.stringify(result)}`,
        );
      });
      return told ? 0 : 3;
    }
    case "status":
      await withPlatform(target, instance, async (platform) => {
        say(
          `recs: ${JSON.stringify(await personalisationService(platform).recommendationStatus())}`,
        );
      });
      return 0;
    case "rollback":
      await withPlatform(target, instance, async (platform) => {
        say(
          `recs rollback: ${JSON.stringify(await personalisationService(platform).rollbackRecommendations())}`,
        );
      });
      return 0;
    default:
      return usage("recs <push|import|status|rollback>");
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv.filter((arg) => arg !== "--"),
    allowPositionals: true,
    options: {
      target: { type: "string" },
      state: { type: "string" },
      port: { type: "string" },
      out: { type: "string" },
      profile: { type: "string" },
      prune: { type: "boolean", default: false },
      "drain-seconds": { type: "string" },
      force: { type: "boolean", default: false },
      demo: { type: "boolean" },
      "no-demo": { type: "boolean", default: false },
      "no-media": { type: "boolean", default: false },
      store: { type: "string" },
      "payment-provider": { type: "string" },
      "grace-minutes": { type: "string" },
      now: { type: "string" },
      "delete-sources": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "recs-bin": { type: "string" },
      run: { type: "string" },
      from: { type: "string" },
      replace: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const command = positionals[0];
  if (!command || values.help) {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  const target = parseTarget(values.target);
  const instance: LocalInstance = {
    state: values.state ? resolve(values.state) : DEFAULT_INSTANCE.state,
    port: values.port ? Number(values.port) : DEFAULT_INSTANCE.port,
  };
  // The demo account (documented credentials) is seeded locally by default, in production
  // only on request (--demo, `make cf-deploy CF_DEMO=1`).
  const seedOptions = {
    force: values.force,
    demo: seedsDemo(target, {
      ...(values.demo === undefined ? {} : { demo: values.demo }),
      noDemo: values["no-demo"],
    }),
    media: !values["no-media"],
  };
  const mediaOptions = {
    profile: values.profile,
    prune: values.prune,
    force: values.force,
    ...(values["drain-seconds"] ? { drainSec: Number(values["drain-seconds"]) } : {}),
  };
  switch (command) {
    case "dev-vars":
      await devVars();
      return 0;
    case "assets": {
      const staged = await stageAssets(
        target,
        values.out ? resolve(values.out) : undefined,
        values["payment-provider"],
      );
      say(`static assets staged: ${staged.files} files, ${(staged.bytes / 1e6).toFixed(1)} MB`);
      return 0;
    }
    case "media":
      await withPlatform(target, instance, (platform) => media(platform, mediaOptions));
      return 0;
    case "seed":
      await withPlatform(target, instance, (platform) => seedCommand(platform, seedOptions));
      return 0;
    case "prepare":
      await withPlatform(target, instance, async (platform) => {
        await media(platform, mediaOptions);
        await seedCommand(platform, seedOptions);
      });
      return 0;
    case "status":
      await withPlatform(target, instance, status);
      return 0;
    case "lake": {
      if (positionals[1] !== "pull" || !values.store) return usage("lake pull --store <dir>");
      const store = resolve(values.store);
      await withPlatform(target, instance, async (platform) => {
        const report = await pullLake(platform, store);
        say(
          `lake → ${store}: ${report.copied} objects copied (${(report.bytes / 1e3).toFixed(1)} kB), ${report.skipped} already there`,
        );
      });
      return 0;
    }
    case "recs":
      return recsCommand(positionals[1], target, instance, values);
    case "jobs":
      return jobsCommand(positionals[1], instance, values);
    default:
      console.error(`Unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`[cf] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
