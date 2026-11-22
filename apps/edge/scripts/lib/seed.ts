/**
 * Seeding D1 (catalog, search index, synthetic stats, demo account) with the portable seeder
 * from `@webflix/core`, over the platform bindings. The media manifest is read from the
 * bucket (`manifests/media.json`, written last by the media upload), so the seed describes
 * exactly what the bucket serves; without one every title plays the external HLS fallback.
 */
import { createKvCache, createR2BlobStore } from "@webflix/adapters-cloudflare/storage";
import { catalog, demoAccount } from "@webflix/catalog";
import { MediaManifest } from "@webflix/contracts";
import {
  createHmacTokenSigner,
  createJsonLogger,
  createMediaTokens,
  createPbkdf2PasswordHasher,
  createServices,
  createUuidV7Generator,
  type JobQueue,
  type SeedResult,
  type StreamGate,
  systemClock,
} from "@webflix/core";
import { createMemoryAreaPorts } from "@webflix/core/memory";
import { createRepositories, createSqlSearchIndex } from "@webflix/db";
import { createD1Database } from "@webflix/db/d1";
import type { Env } from "../../src/env.ts";
import { loadEdgeConfig } from "../../src/env.ts";
import { type SyncResult, syncGeneration } from "./generation.ts";
import { toolingSecrets } from "./secrets.ts";

/** Key the media upload writes the current manifest to (tools/media `MANIFEST_KEYS.current`). */
export const MANIFEST_KEY = "manifests/media.json";

/** The seeder never touches stream slots or jobs; fail loudly if that ever changes. */
function unavailable<T extends object>(port: string): T {
  return new Proxy({} as T, {
    get: () => () => {
      throw new Error(`${port} is not available to the seed tool`);
    },
  });
}

export interface SeedOutcome {
  result: SeedResult;
  /** The manifest the seed used (null: external HLS fallback). */
  manifest: { key: string } | null;
  /** The media cache generation after the seed (it follows the bucket, see generation.ts). */
  generation: SyncResult;
}

/**
 * Whether a seed includes the demo account (documented, public credentials): locally by
 * default, in production only when asked for.
 */
export function seedsDemo(
  target: "local" | "production",
  flags: { demo?: boolean; noDemo?: boolean },
): boolean {
  if (flags.demo && flags.noDemo) throw new Error("--demo and --no-demo contradict");
  if (flags.noDemo) return false;
  return flags.demo ?? target === "local";
}

/** The manifest text the bucket serves now, or null. */
export async function readManifestText(env: Env): Promise<string | null> {
  const object = await createR2BlobStore(env.MEDIA).get(MANIFEST_KEY);
  return object ? new Response(object.body).text() : null;
}

/** Read and validate the manifest the bucket currently serves, if any. */
async function readManifest(env: Env): Promise<{ manifest: MediaManifest; text: string } | null> {
  const object = await createR2BlobStore(env.MEDIA).get(MANIFEST_KEY);
  if (!object) return null;
  const text = await new Response(object.body).text();
  const parsed = MediaManifest.safeParse(JSON.parse(text));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 10)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(
      `Invalid media manifest in the bucket (${MANIFEST_KEY}):\n  - ${issues.join("\n  - ")}`,
    );
  }
  return { manifest: parsed.data, text };
}

export async function seed(
  env: Env,
  options: { force?: boolean; demo?: boolean; media?: boolean } = {},
): Promise<SeedOutcome> {
  // Seeding signs, derives and sends nothing: throwaway secrets keep config validation happy
  // where the real (production) secrets are, rightly, not available to tooling.
  const config = loadEdgeConfig({ ...env, ...toolingSecrets() });
  const clock = systemClock;
  const logger = createJsonLogger({ level: "warn", bindings: { service: "webflix-ops" } });
  const database = createD1Database(env.DB);
  const cache = createKvCache(env.CACHE);
  const services = createServices({
    // Seeding uses none of milestone 2's ports.
    ...createMemoryAreaPorts({ clock }),
    config: config.core,
    repos: createRepositories(database),
    search: createSqlSearchIndex(database),
    cache,
    streamGate: unavailable<StreamGate>("StreamGate"),
    jobs: unavailable<JobQueue>("JobQueue"),
    passwords: createPbkdf2PasswordHasher({ iterations: config.passwordIterations }),
    mediaTokens: createMediaTokens(
      createHmacTokenSigner({ keys: config.core.media.tokenKeys, clock }),
      clock,
    ),
    clock,
    ids: createUuidV7Generator({ clock }),
    logger,
  });

  // `media: false` seeds the external HLS fallback even when the bucket holds packaged media.
  const stored = options.media === false ? null : await readManifest(env);
  const result = await services.seeder.seed(
    {
      catalog,
      demoAccount: options.demo === false ? null : demoAccount,
      manifest: stored?.manifest ?? null,
    },
    { force: options.force ?? false },
  );

  // The edge-cache generation follows the bucket (not this seed's choice of media), and is
  // left alone while an upload is in progress (src/media-generation.ts, lib/generation.ts).
  const generation = await syncGeneration(env.CACHE, () => readManifestText(env));
  return { result, manifest: stored ? { key: MANIFEST_KEY } : null, generation };
}
