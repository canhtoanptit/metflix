/**
 * Upload targets: where `webflix-media upload --target <spec>` writes, always through the
 * `BlobStore` port (never by hand into a store's directory: FOUNDATION §7).
 *
 * Adding a store is one line in `BLOB_TARGETS`: map a scheme to a factory that returns a
 * `BlobStore`. In use today:
 *
 *   fs:   the dev store (`make content`)
 *   s3:   any S3 API, configured by WEBFLIX_S3_* (deploy/kind/media.sh runs
 *         `upload --profile p --target s3:` in the media-tools image against in-cluster Garage)
 *
 * Callers that already hold a store skip this table and call `uploadProfile(profile, store,
 * targetId)` from ./upload.ts directly (apps/edge/scripts/lib/media.ts does that with R2).
 *
 * Spec syntax: `<scheme>:<rest>`. `fs:` uses the dev store at `WEBFLIX_BLOB_DIR` (default
 * `.data/blobs`, the same default `apps/api` uses); `fs:<dir>` writes to another directory.
 */
import { resolve } from "node:path";
import { createFsBlobStore } from "@webflix/adapters-node";
import type { BlobStore } from "@webflix/core";
import { defaultBlobDir, REPO_ROOT } from "../paths.ts";

export interface TargetSpec {
  scheme: string;
  /** Everything after `<scheme>:`. */
  path: string;
  raw: string;
}

export type BlobStoreFactory = (spec: TargetSpec) => Promise<BlobStore> | BlobStore;

export const BLOB_TARGETS: Record<string, BlobStoreFactory> = {
  fs: (spec) =>
    createFsBlobStore({ root: spec.path ? resolve(REPO_ROOT, spec.path) : defaultBlobDir() }),
  // k8s (and any S3 API): `s3:`, configured by WEBFLIX_S3_* like apps/api (deploy/kind/up.sh).
  s3: async () => (await import("@webflix/adapters-node/s3")).createS3BlobStoreFromEnv(),
};

export function parseTarget(raw: string): TargetSpec {
  const colon = raw.indexOf(":");
  if (colon <= 0)
    throw new Error(
      `Invalid target "${raw}": expected <scheme>:<location>, e.g. fs: or fs:.data/blobs`,
    );
  return {
    scheme: raw.slice(0, colon),
    path: raw.slice(colon + 1).replace(/^\/\/(?=\/)/, ""),
    raw,
  };
}

export async function openTarget(raw: string): Promise<BlobStore> {
  const spec = parseTarget(raw);
  const factory = BLOB_TARGETS[spec.scheme];
  if (!factory) {
    throw new Error(
      `No upload target "${spec.scheme}:" (known: ${Object.keys(BLOB_TARGETS).join(", ")}). Register one in tools/media/src/upload/targets.ts.`,
    );
  }
  return factory(spec);
}
