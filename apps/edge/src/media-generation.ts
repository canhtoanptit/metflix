import { type Logger, serializeError } from "@webflix/core";

/**
 * The media cache generation: part of every edge-cache key for blobs (see
 * `createEdgeCachedBlobStore`). Blob keys are not content-addressed (re-packaging rewrites
 * `vod/{asset}/...` in place), so the generation follows what the bucket serves:
 *
 * - `<hash of the bucket's media manifest>`: cache under this generation;
 * - `uploading-<epoch ms>`: objects are being replaced; readers bypass the edge cache, so no
 *   mix of old and new bytes is ever stored (scripts/lib/generation.ts sets it before an
 *   upload rewrites anything, and the manifest hash only after every object and then the
 *   manifest are written);
 * - absent: `"0"` (nothing uploaded through the tooling yet).
 *
 * No `cloudflare:workers` import: Node tooling imports these from here.
 */
export const MEDIA_GENERATION_KEY = "webflix:media-generation";
export const UPLOADING_PREFIX = "uploading-";

/** How long an isolate trusts its copy before reading KV again. */
export const GENERATION_MEMO_MS = 60_000;
/** After a KV write, how long readers may still act on the previous value: memo + KV propagation. */
export const GENERATION_PROPAGATION_MS = GENERATION_MEMO_MS + 60_000;

const VALID = /^[A-Za-z0-9_-]{1,64}$/;

/** The cache partition for a stored value, or null to bypass the edge cache. */
export function cacheGeneration(stored: string | null): string | null {
  if (stored === null || !VALID.test(stored)) return "0";
  return stored.startsWith(UPLOADING_PREFIX) ? null : stored;
}

/**
 * Memoised per isolate. KV is the right store: the value changes only when media is
 * replaced, readers tolerate a minute of staleness, and reads come from the local data
 * centre's cache. A KV failure must not take playback down: the last value (or "0") is kept.
 */
export function mediaGeneration(cache: KVNamespace, logger: Logger): () => Promise<string | null> {
  let memo: { value: string | null; until: number } | undefined;
  return async () => {
    const now = Date.now();
    if (memo && memo.until > now) return memo.value;
    let value = memo ? memo.value : "0";
    try {
      value = cacheGeneration(await cache.get(MEDIA_GENERATION_KEY, { cacheTtl: 60 }));
    } catch (error) {
      logger.warn("media.generation_read_failed", { error: serializeError(error) });
    }
    memo = { value, until: now + GENERATION_MEMO_MS };
    return value;
  };
}
