import {
  assertProfileLists,
  type Clock,
  decodeProfileLists,
  encodeProfileLists,
  MAX_PROFILE_ERASURE,
  type ProfileLists,
  type RecommendationStore,
  systemClock,
} from "@webflix/core";

/**
 * One KV write: a key, its value and its absolute expiration (seconds since the epoch). A bulk
 * writer stores many at once; `bindingBulkWriter` is the Worker binding (one `put` per key),
 * `createKvRestBulkWriter` the REST API's bulk endpoint (up to 10,000 pairs per request).
 */
export interface KvPair {
  key: string;
  value: string;
  expiration: number;
}
export type KvBulkWriter = (pairs: readonly KvPair[]) => Promise<void>;

/**
 * Per-profile lists kept a day past their `expiresAt` (they are never served after it; the
 * grace only spares KV a rejected write when an import runs close to expiry).
 */
const LIST_GRACE_SEC = 24 * 60 * 60;
/** KV refuses an expiration less than 60 s ahead (developers.cloudflare.com/kv/api/write-key-value-pairs). */
const MIN_EXPIRATION_AHEAD_SEC = 120;
/**
 * Edge cache of a read. A run's lists never change once it is active, but a read that came
 * before a new key reached this location caches the miss for this long (KV caches negative
 * lookups too): kept at 60 s so a freshly activated run's lists show within about two minutes
 * everywhere (up to 60 s for a key to propagate, then at most this).
 */
const READ_CACHE_TTL_SEC = 60;
/** Binding writes in flight at once (each `put` is one of the invocation's 1,000 KV operations). */
const BINDING_WRITE_CONCURRENCY = 32;
/**
 * Lists one in-Worker import may write through the binding: a Worker invocation has 1,000 KV
 * operations (developers.cloudflare.com/kv/platform/limits), less headroom for the import's own
 * cache reads and invalidations and for other jobs of the same queue batch.
 */
export const KV_BINDING_LISTS_PER_IMPORT = 800;

export interface KvRecommendationStoreOptions {
  /** The namespace holding per-profile lists (`RECS`). */
  namespace: KVNamespace;
  /**
   * Models and neighbours (the database store over D1): registrations, activation and the
   * serving snapshot are D1's, so the switch between runs is one D1 write.
   */
  base: RecommendationStore;
  /** Writes lists; the binding by default. */
  writer?: KvBulkWriter;
  /** Key prefix (tests). Default `recs:v1:`. */
  prefix?: string;
  clock?: Clock;
}

/**
 * `RecommendationStore` for Cloudflare: models and neighbours in D1 (`base`), per-profile lists
 * in Workers KV under `recs:v1:{run}:{profileKey}`, so serving a profile is one KV read and
 * costs no D1 round trip.
 *
 * Publishing across KV and D1 without a transaction works because every list key names its
 * run: the importer writes the new run's keys beside the served run's (no reader asks for them:
 * readers ask for the active run, which D1 still names), then flips the active run in one D1
 * statement. Rolling back is that statement again, since the previous run's keys are kept.
 * Keys are never deleted one by one: each expires a day after its list does (`deleteRun` drops
 * the D1 rows, after which nothing asks for the run's keys). KV is eventually consistent (a new
 * key can take 60 s or more to be visible in other locations, and a miss is cached too), so a
 * location that learns of an activation before the keys reach it serves the rule engine for
 * those profiles until they do: a cold start, not an error.
 */
export function createKvRecommendationStore(
  options: KvRecommendationStoreOptions,
): RecommendationStore {
  const { namespace, base } = options;
  const prefix = options.prefix ?? "recs:v1:";
  const clock = options.clock ?? systemClock;
  const writer = options.writer ?? bindingBulkWriter(namespace);
  const keyOf = (run: string, profileKey: string) => `${prefix}${run}:${profileKey}`;

  return {
    // Through the binding an import is one Worker invocation's KV budget; the REST bulk writer
    // (outside Workers) has none.
    ...(options.writer
      ? {}
      : {
          importCapacity: {
            maxProfileLists: KV_BINDING_LISTS_PER_IMPORT,
            explanation:
              "a Worker invocation may make at most 1,000 Workers KV operations, so a larger run is imported from outside the Worker with the KV REST bulk API: make cf-recs-import (node apps/edge/scripts/ops.ts recs import)",
          },
        }),
    activeModel: () => base.activeModel(),
    models: () => base.models(),
    servingSnapshot: () => base.servingSnapshot(),
    beginImport: (model) => base.beginImport(model),
    putNeighbours: (run, rows) => base.putNeighbours(run, rows),
    failImport: (run, error) => base.failImport(run, error),
    activate: (run, now) => base.activate(run, now),
    deleteRun: (run) => base.deleteRun(run),
    recordManifest: (run, manifestSha256) => base.recordManifest(run, manifestSha256),

    async profileKeys(run, cursor) {
      // One KV list operation per page of up to 1,000 keys. Listings are eventually consistent
      // (a key written within the last minute or so may be missing): the rewrite this serves
      // compares against lists written when the run was imported, long before.
      const page = await namespace.list({ prefix: keyOf(run, ""), ...(cursor ? { cursor } : {}) });
      return {
        keys: page.keys.map((key) => key.name.slice(keyOf(run, "").length)),
        cursor: page.list_complete ? null : page.cursor,
      };
    },

    async deleteProfileLists(profileKeys) {
      if (profileKeys.length > MAX_PROFILE_ERASURE) throw new RangeError("Too many profile keys");
      // Every run still registered: a deleted run's keys are never read again and expire.
      const runs = (await base.models()).map((model) => model.run);
      await Promise.all(
        runs.flatMap((run) =>
          profileKeys.map((profileKey) => namespace.delete(keyOf(run, profileKey))),
        ),
      );
      // The D1 side holds no lists in this mode; the base drops any it might hold.
      await base.deleteProfileLists(profileKeys);
    },

    async profileLists(run, profileKey, now) {
      const value = await namespace.get(keyOf(run, profileKey), {
        type: "text",
        cacheTtl: READ_CACHE_TTL_SEC,
      });
      if (value === null) return null;
      const lists = decodeProfileLists(value);
      return lists.expiresAt > now ? lists : null;
    },

    async putProfileLists(run, lists: readonly ProfileLists[]) {
      assertProfileLists(run, lists);
      const floor = Math.ceil(clock.now() / 1000) + MIN_EXPIRATION_AHEAD_SEC;
      await writer(
        lists.map((list) => ({
          key: keyOf(run, list.profileKey),
          value: encodeProfileLists(list),
          expiration: Math.max(floor, Math.ceil(list.expiresAt / 1000) + LIST_GRACE_SEC),
        })),
      );
    },
  };
}

/** Writes through the Worker binding, a bounded number of `put`s at a time. */
export function bindingBulkWriter(namespace: KVNamespace): KvBulkWriter {
  return async (pairs) => {
    for (let index = 0; index < pairs.length; index += BINDING_WRITE_CONCURRENCY) {
      await Promise.all(
        pairs
          .slice(index, index + BINDING_WRITE_CONCURRENCY)
          .map((pair) => namespace.put(pair.key, pair.value, { expiration: pair.expiration })),
      );
    }
  };
}

/** The REST API's bulk write accepts at most 10,000 pairs and 100 MB per request. */
export const KV_REST_BULK_MAX_PAIRS = 10_000;
export const KV_REST_BULK_MAX_BYTES = 100_000_000;

export interface KvRestBulkWriterOptions {
  accountId: string;
  namespaceId: string;
  /** An API token with Workers KV Storage: Edit. */
  apiToken: string;
  fetch?: typeof fetch;
  /** Default `https://api.cloudflare.com/client/v4`. */
  apiBase?: string;
  /** Attempts per request for keys the API reports as unsuccessful (default 3). */
  attempts?: number;
}

/**
 * Bulk writes through the REST API (`PUT .../storage/kv/namespaces/{id}/bulk`, documented at
 * developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/bulk_update): up to
 * 10,000 pairs and 100 MB per request, keys the API reports in `unsuccessful_keys` retried. For
 * an importer that runs outside Workers, where the binding's 1,000 operations per invocation
 * would not cover a run's lists (the full simulated run has 89,000 profiles).
 */
export function createKvRestBulkWriter(options: KvRestBulkWriterOptions): KvBulkWriter {
  const doFetch = options.fetch ?? fetch;
  const url = `${options.apiBase ?? "https://api.cloudflare.com/client/v4"}/accounts/${encodeURIComponent(options.accountId)}/storage/kv/namespaces/${encodeURIComponent(options.namespaceId)}/bulk`;
  const attempts = options.attempts ?? 3;

  async function send(batch: readonly KvPair[]): Promise<void> {
    let pending = batch;
    for (let attempt = 1; pending.length > 0; attempt += 1) {
      const response = await doFetch(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${options.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          pending.map((pair) => ({
            key: pair.key,
            value: pair.value,
            expiration: pair.expiration,
          })),
        ),
      });
      const body = (await response.json().catch(() => null)) as {
        success?: boolean;
        result?: { unsuccessful_keys?: string[] } | null;
        errors?: { message?: string }[];
      } | null;
      if (!response.ok || body?.success !== true) {
        throw new Error(
          `KV bulk write failed (${response.status}): ${body?.errors?.map((error) => error.message).join("; ") ?? "no detail"}`,
        );
      }
      const failed = new Set(body.result?.unsuccessful_keys ?? []);
      pending = pending.filter((pair) => failed.has(pair.key));
      if (pending.length > 0 && attempt >= attempts) {
        throw new Error(`KV bulk write: ${pending.length} keys still unsuccessful`);
      }
    }
  }

  return async (pairs) => {
    let batch: KvPair[] = [];
    let bytes = 2;
    for (const pair of pairs) {
      const size = pair.key.length + pair.value.length * 3 + 64;
      if (batch.length >= KV_REST_BULK_MAX_PAIRS || bytes + size > KV_REST_BULK_MAX_BYTES) {
        await send(batch);
        batch = [];
        bytes = 2;
      }
      batch.push(pair);
      bytes += size;
    }
    if (batch.length > 0) await send(batch);
  };
}
