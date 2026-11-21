/**
 * Packaged media → R2, through the media pipeline's own upload function and the same
 * `BlobStore` adapter the Worker reads with (`createR2BlobStore`). Idempotent: the upload
 * skips objects whose stored size and SHA-256 match, and writes the manifest last.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createR2BlobStore } from "@webflix/adapters-cloudflare/storage";
import type { MediaProfile } from "@webflix/contracts";
import type { BlobStore } from "@webflix/core";
import type { Env } from "../../src/env.ts";
import { REPO_ROOT, type Target } from "./platform.ts";
import { MANIFEST_KEY } from "./seed.ts";

const PROFILES: readonly MediaProfile[] = ["fast", "full"];

export function manifestFile(profile: MediaProfile): string {
  return join(REPO_ROOT, ".cache", "media", profile, "manifest.json");
}

/**
 * The profile to publish: the one asked for, else the first packaged one (fast first, like
 * the Node dev mode). Null when nothing was packaged yet (`make content`).
 */
export function pickProfile(requested: string | undefined): MediaProfile | null {
  if (requested) {
    if (!PROFILES.includes(requested as MediaProfile)) {
      throw new Error(`Unknown media profile "${requested}": expected fast or full`);
    }
    const profile = requested as MediaProfile;
    if (!existsSync(manifestFile(profile))) {
      throw new Error(`No packaged media for ${profile}: run \`make content PROFILE=${profile}\``);
    }
    return profile;
  }
  return PROFILES.find((profile) => existsSync(manifestFile(profile))) ?? null;
}

/** The S3 adapter of the Kubernetes mode (`@webflix/adapters-node/s3`). */
interface S3Module {
  createS3BlobStore(options: {
    bucket: string;
    region: string;
    endpoint?: string | null;
    accessKeyId?: string | null;
    secretAccessKey?: string | null;
    forcePathStyle?: boolean;
  }): BlobStore;
}

/**
 * Where uploads go, and over which transport:
 *
 * - R2's S3-compatible API when `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` are set (an R2
 *   API token): the right transport for bulk uploads to a real bucket (no Worker or proxy in
 *   the path). Endpoint: `R2_S3_ENDPOINT`, else the account's
 *   `https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com`. Uses the S3 `BlobStore` the
 *   Kubernetes mode ships, so both modes upload through the same, contract-tested adapter.
 * - Otherwise the R2 binding: the local miniflare bucket, or the real bucket through a remote
 *   binding (fine for the fast profile; every object passes through a proxy Worker).
 */
export async function mediaStore(
  env: Env,
  bucket: string,
): Promise<{ store: BlobStore; transport: string }> {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (accessKeyId && secretAccessKey) {
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    const endpoint =
      process.env.R2_S3_ENDPOINT ??
      (account ? `https://${account}.r2.cloudflarestorage.com` : null);
    if (!endpoint) throw new Error("Set CLOUDFLARE_ACCOUNT_ID (or R2_S3_ENDPOINT) for S3 uploads");
    // Loaded at run time: the Node-typed adapter is checked by its own package.
    const specifier = "@webflix/adapters-node/s3";
    const { createS3BlobStore } = (await import(specifier)) as S3Module;
    const store = createS3BlobStore({
      bucket,
      region: "auto",
      endpoint,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: true,
    });
    return { store, transport: `S3 API (${new URL(endpoint).host})` };
  }
  return { store: createR2BlobStore(env.MEDIA), transport: "R2 binding" };
}

/**
 * True when the bucket already serves this profile's manifest. The upload writes the manifest
 * last, so a matching manifest means every object it references was uploaded before it.
 */
export async function mediaUpToDate(store: BlobStore, profile: MediaProfile): Promise<boolean> {
  const stored = await store.head(MANIFEST_KEY);
  if (!stored?.customMetadata.sha256) return false;
  const local = createHash("sha256")
    .update(await readFile(manifestFile(profile)))
    .digest("hex");
  return stored.customMetadata.sha256 === local;
}

/** The media pipeline's upload API (tools/media/src/upload/upload.ts). */
export interface UploadReport {
  uploaded: number;
  skipped: number;
  deleted: number;
  bytes: number;
}
interface UploadModule {
  uploadProfile(
    profile: MediaProfile,
    store: BlobStore,
    targetId: string,
    options?: { concurrency?: number; prune?: boolean },
  ): Promise<UploadReport>;
}

/**
 * Loaded at run time: tools/media is Node-typed and checked by its own package; importing it
 * statically would type-check it again under this package's Workers-aware settings.
 */
async function loadUploader(): Promise<UploadModule> {
  const specifier = "@webflix/media/src/upload/upload.ts";
  return (await import(specifier)) as UploadModule;
}

export async function uploadMedia(
  store: BlobStore,
  target: Target,
  profile: MediaProfile,
  options: { concurrency?: number; prune?: boolean } = {},
): Promise<UploadReport> {
  // The upload keeps a per-target record of what it sent, so re-runs list instead of HEADing.
  const { uploadProfile } = await loadUploader();
  return uploadProfile(profile, store, `r2:${target}:webflix-media`, {
    concurrency: options.concurrency ?? (target === "local" ? 8 : 16),
    ...(options.prune ? { prune: true } : {}),
  });
}
