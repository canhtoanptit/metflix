/** `createR2BlobStore` against miniflare's R2, inside workerd. */
import { env } from "cloudflare:workers";
import { BlobRangeNotSatisfiableError, type BlobStore, scopeBlobStore } from "@webflix/core";
import { bytesOf, describeBlobStoreContract, readAll } from "@webflix/core/testing";
import { describe, expect, it } from "vitest";
import { createR2BlobStore } from "../src/index.ts";

async function deleteAll(store: BlobStore): Promise<void> {
  let cursor: string | null = null;
  do {
    const page = await store.list(cursor ? { cursor } : {});
    if (page.items.length > 0) await store.delete(page.items.map((item) => item.key));
    cursor = page.cursor;
  } while (cursor);
}

function scoped(): { store: BlobStore; prefix: string } {
  const prefix = `t-${crypto.randomUUID()}`;
  return { store: scopeBlobStore(createR2BlobStore(env.MEDIA), prefix), prefix };
}

describeBlobStoreContract("R2", () => {
  const { store } = scoped();
  return { store, cleanup: () => deleteAll(store) };
});

describe("R2 specifics", () => {
  it("writes HTTP metadata R2 itself serves (content type, cache control, custom metadata)", async () => {
    const { store, prefix } = scoped();
    await store.put("public/img/a.webp", bytesOf(10), {
      cacheControl: "public, max-age=31536000, immutable",
      customMetadata: { source: "test" },
    });
    const raw = await env.MEDIA.head(`${prefix}/public/img/a.webp`);
    expect(raw?.httpMetadata).toMatchObject({
      contentType: "image/webp",
      cacheControl: "public, max-age=31536000, immutable",
    });
    expect(raw?.customMetadata).toEqual({ source: "test" });
    // The port's etag is R2's unquoted etag; HTTP gets the quoted form.
    expect(raw?.httpEtag).toBe(`"${(await store.head("public/img/a.webp"))?.etag}"`);
    await deleteAll(store);
  });

  it("stores nothing when a stream produces more bytes than declared", async () => {
    const { store } = scoped();
    const body = { stream: new Response(bytesOf(20)).body ?? new ReadableStream(), size: 10 };
    await expect(store.put("long.bin", body)).rejects.toThrow();
    expect(await store.head("long.bin")).toBeNull();
  });

  it("streams a large sized body without buffering it in the adapter", async () => {
    const { store } = scoped();
    const chunk = bytesOf(64 * 1024, 5);
    const chunks = 48; // 3 MiB
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === chunks) return controller.close();
        sent += 1;
        controller.enqueue(chunk.slice());
      },
    });
    const meta = await store.put("vod/a/seg.m4s", { stream, size: chunk.byteLength * chunks });
    expect(meta.size).toBe(chunk.byteLength * chunks);
    const tail = await store.get("vod/a/seg.m4s", { range: { suffix: 10 } });
    expect(tail?.range).toEqual({ offset: chunk.byteLength * chunks - 10, length: 10 });
    expect(await readAll(tail?.body ?? new ReadableStream())).toEqual(chunk.slice(-10));
    await deleteAll(store);
  });

  it("reports a 416 with the object size for ranges R2 itself rejects", async () => {
    const { store } = scoped();
    await store.put("r.bin", bytesOf(100));
    const error = await store.get("r.bin", { range: { offset: 100, length: 5 } }).catch((e) => e);
    expect(error).toBeInstanceOf(BlobRangeNotSatisfiableError);
    expect((error as BlobRangeNotSatisfiableError).size).toBe(100);
    await deleteAll(store);
  });
});
