/**
 * Keeping the media generation (src/media-generation.ts) true to what the bucket serves, in
 * every path that changes the bucket. The invariants:
 *
 * - No reader caches under a generation while the objects behind it change: before the first
 *   object is rewritten the generation becomes `uploading-<time>` (readers bypass the edge
 *   cache), and the upload waits until every isolate can have seen that (memo + KV
 *   propagation) when readers exist.
 * - A generation names a complete upload: the manifest hash is written only after every object
 *   and then the manifest (which `uploadProfile` writes last) are in the bucket.
 * - A failed upload leaves the bypass in place: only a completed upload re-enables caching,
 *   and the seed never clears an upload in progress.
 *
 * - Every completed upload gets a fresh generation (`<manifest hash>-<time>`): objects can
 *   change while the manifest does not (a re-encode with the same layout), so the manifest
 *   alone cannot name the bucket's content.
 *
 * In-place rewrites of an asset a player is streaming can still mix for that player (the
 * bucket itself changes under it); nothing mixed is ever cached, and new playbacks see one
 * consistent version once the new generation is out.
 */
import { createHash } from "node:crypto";
import { MEDIA_GENERATION_KEY, UPLOADING_PREFIX } from "../../src/media-generation.ts";

export interface GenerationStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/** The manifest part of a generation (`none` without a manifest). */
export function manifestGeneration(manifestText: string | null): string {
  return manifestText === null
    ? "none"
    : createHash("sha256").update(manifestText).digest("hex").slice(0, 16);
}

/** A generation no earlier upload used: `<manifest hash>-<time, base 36>`. */
export function freshGeneration(manifestText: string | null, now: number): string {
  return `${manifestGeneration(manifestText)}-${now.toString(36)}`;
}

/** Was `generation` minted for this manifest (by an upload or a seed that saw it)? */
export function matchesManifest(generation: string | null, manifestText: string | null): boolean {
  const part = manifestGeneration(manifestText);
  return generation === part || (generation?.startsWith(`${part}-`) ?? false);
}

export interface PublishSteps<R> {
  kv: GenerationStore;
  /** True when the bucket already serves the local manifest (nothing to upload). */
  upToDate(): Promise<boolean>;
  /** Uploads every changed object, then the manifest. */
  upload(): Promise<R>;
  /** The manifest the bucket serves now, or null. */
  readManifest(): Promise<string | null>;
  /** How long readers may act on a previous generation (0 when nobody reads: local tooling). */
  drainMs: number;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(message: string): void;
}

export interface PublishResult<R> {
  report: R | null;
  generation: string;
}

export async function publishMedia<R>(steps: PublishSteps<R>): Promise<PublishResult<R>> {
  const current = await steps.kv.get(MEDIA_GENERATION_KEY);
  // An interrupted upload may have rewritten objects without writing the manifest, so a
  // matching manifest proves nothing then: finish with a full (idempotent) upload first.
  const interrupted = current?.startsWith(UPLOADING_PREFIX) ?? false;
  if (!interrupted && (await steps.upToDate())) {
    const manifest = await steps.readManifest();
    if (current !== null && matchesManifest(current, manifest)) {
      return { report: null, generation: current };
    }
    // The bucket changed by other means (or was never tracked): start a clean partition.
    const generation = freshGeneration(manifest, steps.now());
    await steps.kv.put(MEDIA_GENERATION_KEY, generation);
    return { report: null, generation };
  }
  if (interrupted) {
    steps.log("a previous upload did not complete: uploading again before re-enabling the cache");
  }
  await steps.kv.put(MEDIA_GENERATION_KEY, `${UPLOADING_PREFIX}${steps.now()}`);
  if (steps.drainMs > 0) {
    steps.log(
      `edge cache bypassed for the upload; waiting ${Math.round(steps.drainMs / 1000)} s until every reader has stopped caching`,
    );
    await steps.sleep(steps.drainMs);
  }
  const report = await steps.upload();
  const generation = freshGeneration(await steps.readManifest(), steps.now());
  await steps.kv.put(MEDIA_GENERATION_KEY, generation);
  return { report, generation };
}

export interface SyncResult {
  generation: string;
  changed: boolean;
  /** An upload is in progress (or failed): left alone, the cache stays bypassed. */
  uploading: boolean;
}

/**
 * For paths that do not upload (the seed): follow the bucket's manifest, e.g. after media was
 * uploaded by other means, but never re-enable caching in the middle of an upload.
 */
export async function syncGeneration(
  kv: GenerationStore,
  readManifest: () => Promise<string | null>,
  now: () => number = Date.now,
): Promise<SyncResult> {
  const current = await kv.get(MEDIA_GENERATION_KEY);
  if (current?.startsWith(UPLOADING_PREFIX)) {
    return { generation: current, changed: false, uploading: true };
  }
  const manifest = await readManifest();
  if (current !== null && matchesManifest(current, manifest)) {
    return { generation: current, changed: false, uploading: false };
  }
  const generation = freshGeneration(manifest, now());
  await kv.put(MEDIA_GENERATION_KEY, generation);
  return { generation, changed: true, uploading: false };
}
