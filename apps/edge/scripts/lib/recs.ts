/**
 * Batch jobs and this mode's stores (docs/BLUEPRINT-M2.md §9, docs/CLOUDFLARE.md §10).
 * Compaction, training, scoring and analysis run outside Workers; this module moves their input
 * and output in and out of the Cloudflare stores, and imports a recommendation run from outside
 * the Worker:
 *
 * - `pullLake`: the event lake (`events/` in R2) into a pipeline store directory (the dev mode's
 *   filesystem `BlobStore` layout, which `services/recs` reads), incrementally;
 * - `pushRecs`: a scored run's artefacts (`recs/v={run}/…`) from a pipeline store into R2, the
 *   pointer `recs/current.json` last, as the pipeline's own `publish` does;
 * - `importRun`: the portable importer (`services.personalisation.importRecommendations`, the
 *   same code the Worker's `recommendations.import` job runs) on the Worker's bindings, from
 *   Node. Inside a Worker each KV `put` is one of the invocation's 1,000 operations to Cloudflare
 *   services, so a run of more than a few hundred profiles cannot be imported there; from
 *   outside, production writes the lists with the KV REST API's bulk endpoint (10,000 pairs per
 *   request), and D1 and R2 through Wrangler's remote bindings.
 *
 * Locally, like every ops command, these run while the dev server is stopped: two runtimes must
 * not own one state directory.
 */
import {
  bindingBulkWriter,
  createKvCache,
  createKvRecommendationStore,
  createKvRestBulkWriter,
  createR2BlobStore,
  type KvBulkWriter,
} from "@webflix/adapters-cloudflare/storage";
import { catalog, demoAccount } from "@webflix/catalog";
import { MediaManifest } from "@webflix/contracts";
import {
  type BlobStore,
  createHmacTokenSigner,
  createJsonLogger,
  createMediaTokens,
  createPbkdf2PasswordHasher,
  createServices,
  createUuidV7Generator,
  type JobQueue,
  publishDemoRecommendations,
  RECS_POINTER_KEY,
  type RecommendationStore,
  type StreamGate,
  systemClock,
} from "@webflix/core";
import { createMemoryAreaPorts } from "@webflix/core/memory";
import {
  createDatabaseRecommendationStore,
  createRepositories,
  createSqlSearchIndex,
} from "@webflix/db";
import { createD1Database } from "@webflix/db/d1";
import { unstable_readConfig } from "wrangler";
import { loadEdgeConfig } from "../../src/env.ts";
import type { Platform } from "./platform.ts";
import { WRANGLER_CONFIG } from "./platform.ts";
import { toolingSecrets } from "./secrets.ts";
import { readManifestText } from "./seed.ts";

export const LAKE_PREFIX = "events/";

/**
 * The dev mode's filesystem `BlobStore` (the pipeline store's layout). Loaded through a
 * specifier TypeScript does not follow: `@webflix/adapters-node` is type-checked by its own
 * package under Node's types only, and does not compile under this app's Node + Workers type
 * sets (two `ReadableStream` declarations). The contract is the port's.
 */
const ADAPTERS_NODE: string = "@webflix/adapters-node";
async function fsStore(root: string): Promise<BlobStore> {
  const module = (await import(ADAPTERS_NODE)) as {
    createFsBlobStore(options: { root: string }): BlobStore;
  };
  return module.createFsBlobStore({ root });
}
const PLACEHOLDER_ID = /^0+$/;

export interface CopyReport {
  copied: number;
  skipped: number;
  bytes: number;
}

/**
 * Copies every object under `prefix` that the target does not hold with the same size. Lake
 * objects and versioned artefacts are immutable (named by a UUIDv7 or a run), so size is a
 * sufficient "already copied" test; the pointer is handled by the caller.
 */
export async function copyPrefix(
  from: BlobStore,
  to: BlobStore,
  prefix: string,
  options: { exclude?: (key: string) => boolean } = {},
): Promise<CopyReport> {
  const report: CopyReport = { copied: 0, skipped: 0, bytes: 0 };
  let cursor: string | null = null;
  do {
    const page = await from.list({ prefix, ...(cursor ? { cursor } : {}), limit: 1000 });
    for (const item of page.items) {
      if (options.exclude?.(item.key)) continue;
      const existing = await to.head(item.key);
      if (existing && existing.size === item.size) {
        report.skipped += 1;
        continue;
      }
      await copyObject(from, to, item.key);
      report.copied += 1;
      report.bytes += item.size;
    }
    cursor = page.cursor;
  } while (cursor);
  return report;
}

async function copyObject(from: BlobStore, to: BlobStore, key: string): Promise<void> {
  const object = await from.get(key);
  if (!object) throw new Error(`${key} vanished while copying`);
  // Buffered: lake objects and artefact shards are small (KiB to a few MiB) and both stores
  // accept bytes; R2's binding needs a known length for a stream it did not create.
  const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
  await to.put(key, bytes, { contentType: object.contentType });
}

/** The event lake from R2 into a pipeline store directory. */
export async function pullLake(platform: Platform, storeDir: string): Promise<CopyReport> {
  return copyPrefix(createR2BlobStore(platform.env.MEDIA), await fsStore(storeDir), LAKE_PREFIX);
}

interface Pointer {
  format: string;
  run: string;
  manifest: string;
}

/**
 * A run's artefacts from a pipeline store into R2. With `run`: that version only, no pointer
 * (import it with `--run`). Without: the store's published run, then its pointer, last.
 */
export async function pushRecs(
  platform: Platform,
  storeDir: string,
  run?: string,
): Promise<CopyReport & { run: string; pointer: boolean }> {
  const store = await fsStore(storeDir);
  const bucket = createR2BlobStore(platform.env.MEDIA);
  let pointerBytes: Uint8Array<ArrayBuffer> | null = null;
  let target = run;
  if (!target) {
    const pointer = await store.get(RECS_POINTER_KEY);
    if (!pointer) {
      throw new Error(
        `${storeDir} has no ${RECS_POINTER_KEY}: pass --run <run> for an unpublished version`,
      );
    }
    pointerBytes = new Uint8Array(await new Response(pointer.body).arrayBuffer());
    const parsed = JSON.parse(new TextDecoder().decode(pointerBytes)) as Pointer;
    if (parsed.format !== "webflix.recs-pointer")
      throw new Error(`${RECS_POINTER_KEY}: unknown format ${parsed.format}`);
    target = parsed.run;
  }
  if (!(await store.head(`recs/v=${target}/manifest.json`))) {
    throw new Error(
      `${storeDir} has no recs/v=${target}/manifest.json (an incomplete version is never pushed)`,
    );
  }
  const report = await copyPrefix(store, bucket, `recs/v=${target}/`);
  if (pointerBytes)
    await bucket.put(RECS_POINTER_KEY, pointerBytes, { contentType: "application/json" });
  return { ...report, run: target, pointer: pointerBytes !== null };
}

/** The KV writer for per-profile lists: the binding locally, the REST bulk API in production. */
function listWriter(platform: Platform): KvBulkWriter {
  if (platform.target === "local") return bindingBulkWriter(requireRecs(platform));
  const config = unstable_readConfig(
    { config: WRANGLER_CONFIG, env: "production" },
    { hideWarnings: true },
  );
  const namespaceId = config.kv_namespaces.find((kv) => kv.binding === "RECS")?.id;
  if (!namespaceId || PLACEHOLDER_ID.test(namespaceId)) {
    throw new Error("env.production RECS has no namespace id yet: run `make cf-provision` first");
  }
  const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = process.env;
  if (!accountId || !apiToken) {
    throw new Error(
      "A production import writes the lists with the KV REST API: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers KV Storage: Write)",
    );
  }
  return createKvRestBulkWriter({ accountId, namespaceId, apiToken });
}

function requireRecs(platform: Platform): KVNamespace {
  if (!platform.env.RECS) throw new Error("wrangler.jsonc binds no RECS namespace");
  return platform.env.RECS;
}

/** Unavailable ports: the importer never touches stream slots or jobs. */
function unavailable<T extends object>(port: string): T {
  return new Proxy({} as T, {
    get: () => () => {
      throw new Error(`${port} is not available to the recommendation importer`);
    },
  });
}

/**
 * The personalisation service on the Worker's bindings, from Node: the same importer, rollback
 * and status as the Worker's job and the staff API, and the same cache invalidation (the shared
 * model cache in KV), so a Worker serves the new run within its isolate memo (30 s).
 */
export function personalisationService(
  platform: Platform,
  writer: KvBulkWriter = listWriter(platform),
) {
  const { env } = platform;
  const config = loadEdgeConfig({ ...env, ...toolingSecrets() });
  if (config.core.personalisation.recommendationStore !== "kv") {
    throw new Error(
      `WEBFLIX_RECOMMENDATION_STORE=${config.core.personalisation.recommendationStore}: this importer writes the kv store`,
    );
  }
  const clock = systemClock;
  const database = createD1Database(env.DB);
  const recommendations: RecommendationStore = createKvRecommendationStore({
    namespace: requireRecs(platform),
    base: createDatabaseRecommendationStore(database),
    writer,
  });
  const services = createServices({
    ...createMemoryAreaPorts({ clock }),
    recommendations,
    recommendationArtefacts: createR2BlobStore(env.MEDIA),
    config: config.core,
    repos: createRepositories(database),
    search: createSqlSearchIndex(database),
    cache: createKvCache(env.CACHE),
    streamGate: unavailable<StreamGate>("StreamGate"),
    jobs: unavailable<JobQueue>("JobQueue"),
    passwords: createPbkdf2PasswordHasher({ iterations: config.passwordIterations }),
    mediaTokens: createMediaTokens(
      createHmacTokenSigner({ keys: config.core.media.tokenKeys, clock }),
      clock,
    ),
    clock,
    ids: createUuidV7Generator({ clock }),
    logger: createJsonLogger({
      level: "info",
      bindings: { service: "webflix-ops", component: "recs" },
    }),
  });
  return services.personalisation;
}

/** Imports the published run (or `run`) from R2, or from a pipeline store directory. */
export async function importRun(platform: Platform, options: { run?: string; from?: string }) {
  const personalisation = personalisationService(platform);
  return personalisation.importRecommendations({
    ...(options.run ? { run: options.run } : {}),
    ...(options.from ? { artefacts: await fsStore(options.from) } : {}),
  });
}

/**
 * A demo run for the local Worker (docs/RECOMMENDATIONS.md, "A demo run"): lists for the demo
 * account's profiles, filed under the keys the Worker derives with its own pseudonym key (the
 * clone's `.dev.vars`), published into R2 (version, then pointer) and imported by the same
 * importer as `importRun`, checksums included. Local only: production's pseudonym key is never
 * available to the tools, and a demo run is not something to serve there.
 */
export async function importDemoRun(platform: Platform, options: { replace: boolean }) {
  if (platform.target !== "local") {
    throw new Error(
      "A demo run is for the local Worker only: the tools never hold production's pseudonym key",
    );
  }
  const text = await readManifestText(platform.env);
  return publishDemoRecommendations({
    personalisation: personalisationService(platform),
    blobs: createR2BlobStore(platform.env.MEDIA),
    catalog,
    demoAccount,
    manifest: text === null ? null : MediaManifest.parse(JSON.parse(text)),
    // What the Worker itself derives profile keys with (not the tooling's throwaway secrets).
    pseudonymKey: loadEdgeConfig(platform.env).core.events.pseudonymKey,
    now: Date.now(),
    replace: options.replace,
  });
}
