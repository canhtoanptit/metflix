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
 *
 * Every command is idempotent. See docs/CLOUDFLARE.md for how they fit together.
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { GENERATION_PROPAGATION_MS, MEDIA_GENERATION_KEY } from "../src/media-generation.ts";
import { stageAssets } from "./lib/assets.ts";
import { publishMedia } from "./lib/generation.ts";
import { mediaStore, mediaUpToDate, pickProfile, uploadMedia } from "./lib/media.ts";
import {
  DEFAULT_INSTANCE,
  type LocalInstance,
  openPlatform,
  type Platform,
  parseTarget,
  type Target,
} from "./lib/platform.ts";
import { MANIFEST_KEY, readManifestText, seed, seedsDemo } from "./lib/seed.ts";

const USAGE = `Usage: node scripts/ops.ts <assets|media|seed|prepare|status> [options]

  --target local|production   bindings to use (default local: the wrangler dev state)
  --state <dir>               local: the instance's state directory (default .wrangler/state)
  --port <n>                  local: the port its dev server uses (default 8787)
  --out <dir>                 assets: where to stage (default dist/public or dist/production-assets)
  --profile fast|full         media profile to upload (default: the first one packaged)
  --prune                     media: delete stored objects the profile no longer has (after
                              the new media was uploaded and seeded)
  --drain-seconds <n>         media: wait before rewriting objects (default 120 in production:
                              readers must stop caching under the old generation first)
  --force                     media: re-check every object; seed: re-apply even if unchanged
                              (resets the demo account)
  --demo | --no-demo          seed: the demo account (default: locally yes, in production no)
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
    case "assets": {
      const staged = await stageAssets(target, values.out ? resolve(values.out) : undefined);
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
