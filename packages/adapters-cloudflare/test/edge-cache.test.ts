/**
 * The edge-cached read path keeps the `BlobStore` port's semantics, both when the origin is
 * reached directly (local dev: the origin sees `Range` and answers 206 itself) and through a
 * cache that strips `Range`, stores the whole object and slices ranges from it (production's
 * Workers Cache; emulated here with the Cache API, which slices the same way).
 */
import { env } from "cloudflare:workers";
import { type BlobRange, type BlobStore, scopeBlobStore } from "@webflix/core";
import { bytesOf, describeBlobStoreContract, readAll } from "@webflix/core/testing";
import { describe, expect, it } from "vitest";
import {
  type BlobOrigin,
  blobKeyFromOriginPath,
  createEdgeCachedBlobStore,
  createR2BlobStore,
  serveBlobOrigin,
} from "../src/index.ts";

const ORIGIN = { cacheControl: "public, max-age=604800", cacheTag: "webflix-media" };

async function deleteAll(store: BlobStore): Promise<void> {
  let cursor: string | null = null;
  do {
    const page = await store.list(cursor ? { cursor } : {});
    if (page.items.length > 0) await store.delete(page.items.map((item) => item.key));
    cursor = page.cursor;
  } while (cursor);
}

/** What the origin saw, to assert on cache behaviour. */
interface Recorded {
  requests: { url: string; range: string | null }[];
}

function directOrigin(base: BlobStore, recorded: Recorded): BlobOrigin {
  return {
    fetch: async (request) => {
      recorded.requests.push({ url: request.url, range: request.headers.get("Range") });
      return serveBlobOrigin(base, request, ORIGIN);
    },
  };
}

/** A caching intermediary: strips Range before the origin, stores 200s, slices on match. */
function cachingOrigin(base: BlobStore, recorded: Recorded, cacheName: string): BlobOrigin {
  return {
    async fetch(request) {
      const cache = await caches.open(cacheName);
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await directOrigin(base, recorded).fetch(new Request(request.url));
      if (response.status !== 200) return response;
      await cache.put(new Request(request.url), response);
      return (await cache.match(request)) ?? new Response(null, { status: 500 });
    },
  };
}

function harness(kind: "direct" | "cached") {
  const base = createR2BlobStore(env.MEDIA);
  const recorded: Recorded = { requests: [] };
  const origin =
    kind === "direct"
      ? directOrigin(base, recorded)
      : cachingOrigin(base, recorded, `edge-${crypto.randomUUID()}`);
  let generation = "g1";
  const cached = createEdgeCachedBlobStore({ origin, store: base, generation: () => generation });
  const store = scopeBlobStore(cached, `t-${crypto.randomUUID()}`);
  return {
    store,
    recorded,
    bump: (next: string) => {
      generation = next;
    },
  };
}

describeBlobStoreContract("R2 through the edge-cache origin (direct)", () => {
  const { store } = harness("direct");
  return { store, cleanup: () => deleteAll(store) };
});

describeBlobStoreContract("R2 through a Range-stripping, slicing cache", () => {
  const { store } = harness("cached");
  return { store, cleanup: () => deleteAll(store) };
});

describe("edge-cached reads", () => {
  it("serves repeated and ranged reads from one cached copy, never from a token-bearing URL", async () => {
    const { store, recorded } = harness("cached");
    const data = bytesOf(200_000, 9);
    await store.put("vod/a1/720p/seg-1.m4s", data);
    const reads: [BlobRange | undefined, Uint8Array][] = [
      [undefined, data],
      [{ offset: 0, length: 100 }, data.slice(0, 100)],
      [{ suffix: 10 }, data.slice(-10)],
    ];
    for (const [range, expected] of reads) {
      const object = await store.get("vod/a1/720p/seg-1.m4s", range ? { range } : {});
      expect(await readAll(object?.body ?? new ReadableStream())).toEqual(expected);
    }
    // One origin fetch for three reads, without Range, at a generation-scoped internal URL.
    expect(recorded.requests).toHaveLength(1);
    expect(recorded.requests[0]?.range).toBeNull();
    expect(new URL(recorded.requests[0]?.url ?? "").pathname).toMatch(
      /^\/g1\/t-[^/]+\/vod\/a1\/720p\/seg-1\.m4s$/,
    );
    await deleteAll(store);
  });

  it("misses into the store again when the generation changes (media replaced in place)", async () => {
    const { store, recorded, bump } = harness("cached");
    await store.put("vod/a1/master.m3u8", "#EXTM3U\n#v1\n");
    expect(await (await store.get("vod/a1/master.m3u8"))?.body.getReader().read()).toBeTruthy();
    await store.put("vod/a1/master.m3u8", "#EXTM3U\n#v2\n");
    bump("g2");
    const object = await store.get("vod/a1/master.m3u8");
    expect(new TextDecoder().decode(await readAll(object?.body ?? new ReadableStream()))).toContain(
      "#v2",
    );
    expect(recorded.requests).toHaveLength(2);
    await deleteAll(store);
  });

  it("bypasses the cache entirely while the generation is null (media being replaced)", async () => {
    const base = createR2BlobStore(env.MEDIA);
    const recorded: Recorded = { requests: [] };
    const prefix = `t-${crypto.randomUUID()}`;
    const store = scopeBlobStore(
      createEdgeCachedBlobStore({
        origin: cachingOrigin(base, recorded, `edge-${crypto.randomUUID()}`),
        store: base,
        generation: () => null,
      }),
      prefix,
    );
    await store.put("vod/a1/seg.m4s", bytesOf(1000, 4));
    const ranged = await store.get("vod/a1/seg.m4s", { range: { offset: 10, length: 5 } });
    expect(ranged?.range).toEqual({ offset: 10, length: 5 });
    expect(await readAll(ranged?.body ?? new ReadableStream())).toEqual(
      bytesOf(1000, 4).slice(10, 15),
    );
    expect(await store.get("vod/a1/missing.m4s")).toBeNull();
    expect(recorded.requests).toHaveLength(0);
    await deleteAll(store);
  });

  it("only answers internal paths that decode to valid keys", () => {
    expect(blobKeyFromOriginPath("/g1/public/img/a%20b.webp")).toBe("public/img/a b.webp");
    expect(blobKeyFromOriginPath("/g1/vod/..%2F..%2Fsecret")).toBeNull();
    expect(blobKeyFromOriginPath("/g1/")).toBeNull();
    expect(blobKeyFromOriginPath("/only-generation")).toBeNull();
  });

  it("marks whole-object answers cacheable and partial ones not", async () => {
    const base = createR2BlobStore(env.MEDIA);
    const key = `t-${crypto.randomUUID()}/public/img/x.webp`;
    await base.put(key, bytesOf(1000));
    const whole = await serveBlobOrigin(base, new Request(`https://o/g1/${key}`), ORIGIN);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("Cache-Control")).toBe("public, max-age=604800");
    expect(whole.headers.get("Cache-Tag")).toBe("webflix-media");
    await whole.body?.cancel();
    const part = await serveBlobOrigin(
      base,
      new Request(`https://o/g1/${key}`, { headers: { Range: "bytes=10-19" } }),
      ORIGIN,
    );
    expect(part.status).toBe(206);
    expect(part.headers.get("Cache-Control")).toBe("no-store");
    expect(part.headers.get("Content-Range")).toBe("bytes 10-19/1000");
    await part.body?.cancel();
    await base.delete(key);
  });
});
