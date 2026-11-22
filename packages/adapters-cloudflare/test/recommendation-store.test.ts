/**
 * The Cloudflare `RecommendationStore` inside workerd: per-profile lists in Workers KV (the
 * models and neighbours side is the D1 store, proven in packages/db's workerd suite; here a
 * memory store stands in for it), and the REST bulk writer against a recorded API.
 */
import { env } from "cloudflare:workers";
import { assignVariants, hashBucket } from "@webflix/core";
import { MemoryRecommendationStore } from "@webflix/core/memory";
import { describeRecommendationStoreContract, experimentDefinition } from "@webflix/core/testing";
import { describe, expect, it } from "vitest";
import {
  createKvRecommendationStore,
  createKvRestBulkWriter,
  KV_REST_BULK_MAX_PAIRS,
  type KvPair,
} from "../src/index.ts";

describeRecommendationStoreContract("Workers KV lists over a models store", () => ({
  // A fresh prefix per test keeps tests independent of storage isolation settings.
  store: createKvRecommendationStore({
    namespace: env.CACHE,
    base: new MemoryRecommendationStore(),
    prefix: `t-${crypto.randomUUID()}:`,
  }),
}));

describe("KV REST bulk writer", () => {
  function recordingApi(unsuccessfulOnce: string[] = []) {
    const requests: { url: string; pairs: KvPair[]; auth: string | null }[] = [];
    let failing = new Set(unsuccessfulOnce);
    const fetch = (async (url: string, init: RequestInit) => {
      const pairs = JSON.parse(String(init.body)) as KvPair[];
      requests.push({ url, pairs, auth: new Headers(init.headers).get("Authorization") });
      const unsuccessful = pairs.map((pair) => pair.key).filter((key) => failing.has(key));
      failing = new Set();
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: {
          successful_key_count: pairs.length - unsuccessful.length,
          unsuccessful_keys: unsuccessful,
        },
      });
    }) as typeof globalThis.fetch;
    return { requests, fetch };
  }

  it("splits at 10,000 pairs per request and retries the keys the API reports", async () => {
    const api = recordingApi(["k-3"]);
    const write = createKvRestBulkWriter({
      accountId: "acc",
      namespaceId: "ns",
      apiToken: "token",
      fetch: api.fetch,
    });
    const pairs = Array.from({ length: KV_REST_BULK_MAX_PAIRS + 5 }, (_, index) => ({
      key: `k-${index}`,
      value: "{}",
      expiration: 2_000_000_000,
    }));
    await write(pairs);
    expect(api.requests.map((request) => request.pairs.length)).toEqual([
      KV_REST_BULK_MAX_PAIRS,
      1,
      5,
    ]);
    expect(api.requests[1]?.pairs[0]?.key).toBe("k-3");
    expect(api.requests[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc/storage/kv/namespaces/ns/bulk",
    );
    expect(api.requests[0]?.auth).toBe("Bearer token");
  });

  it("fails loudly when the API refuses the request", async () => {
    const write = createKvRestBulkWriter({
      accountId: "acc",
      namespaceId: "ns",
      apiToken: "token",
      fetch: (async () =>
        Response.json(
          { success: false, errors: [{ message: "Authentication error" }] },
          { status: 403 },
        )) as typeof globalThis.fetch,
    });
    await expect(write([{ key: "k", value: "v", expiration: 2_000_000_000 }])).rejects.toThrow(
      /Authentication error/,
    );
  });
});

describe("experiment assignment inside workerd", () => {
  it("hashes exactly as Node and Python do (pinned SHA-256 bucket vectors)", async () => {
    expect(await hashBucket("layer:recs:profile:pr-demo")).toBe(5289);
    expect(await hashBucket("enrol:recs.learned-vs-rules:s1:pr-demo")).toBe(3458);
    expect(await hashBucket("variant:recs.learned-vs-rules:s1:pr-demo")).toBe(9957);
    expect(await hashBucket("layer:billing-ui:device:0190e1c2-0000-7000-8000-000000000001")).toBe(
      1896,
    );
    expect(await hashBucket("")).toBe(8894);
  });

  it("assigns the same variants as the Node runtime", async () => {
    const definitions = [experimentDefinition({ startsAt: "2026-01-01T00:00:00.000Z" })];
    const context = { plan: "standard" as const, country: null, isNew: false, restricted: false };
    const now = Date.UTC(2026, 10, 22);
    const variants = await Promise.all(
      ["pr-demo", "pr-a", "pr-b", "pr-c"].map(
        async (id) =>
          (await assignVariants(definitions, { type: "profile", id }, context, now))[
            "recs.learned-vs-rules"
          ],
      ),
    );
    // variant:…:pr-demo is bucket 9957 of 10000: the second half (treatment).
    expect(variants[0]).toBe("treatment");
    expect(variants).toEqual(NODE_VARIANTS);
  });
});

/** What the Node runtime assigns these units (computed there; see the core experiments test). */
const NODE_VARIANTS = ["treatment", "control", "control", "treatment"];
