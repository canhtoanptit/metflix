/**
 * The S3 `BlobStore` against a real S3-compatible store (Garage, the store the Helm chart
 * deploys). Needs WEBFLIX_TEST_S3_*: `pnpm --filter @webflix/adapters-node test:services`
 * starts a throwaway Garage and sets them.
 */
import { type BlobStore, scopeBlobStore } from "@webflix/core";
import { describeBlobStoreContract, readAll } from "@webflix/core/testing";
import { afterAll, describe, expect, it } from "vitest";
import { createS3BlobStore, type S3BlobStore } from "../src/s3-blob-store.ts";

const env = {
  endpoint: process.env.WEBFLIX_TEST_S3_ENDPOINT,
  region: process.env.WEBFLIX_TEST_S3_REGION ?? "us-east-1",
  bucket: process.env.WEBFLIX_TEST_S3_BUCKET ?? "webflix-media",
  accessKeyId: process.env.WEBFLIX_TEST_S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.WEBFLIX_TEST_S3_SECRET_ACCESS_KEY,
};

const stores: S3BlobStore[] = [];
function open(overrides: Partial<typeof env> = {}): S3BlobStore {
  const settings = { ...env, ...overrides };
  const store = createS3BlobStore({
    bucket: settings.bucket,
    region: settings.region,
    endpoint: settings.endpoint ?? null,
    accessKeyId: settings.accessKeyId ?? null,
    secretAccessKey: settings.secretAccessKey ?? null,
    forcePathStyle: true,
  });
  stores.push(store);
  return store;
}

async function deleteAll(store: BlobStore): Promise<void> {
  for (;;) {
    const page = await store.list({ limit: 1000 });
    if (page.items.length === 0) return;
    await store.delete(page.items.map((item) => item.key));
  }
}

afterAll(() => {
  for (const store of stores) store.destroy();
});

if (!env.endpoint) {
  describe.skip("S3 BlobStore (set WEBFLIX_TEST_S3_*, or run test:services)", () => {
    it("needs an S3-compatible store", () => {});
  });
} else {
  describeBlobStoreContract("s3 (garage)", () => {
    const store = scopeBlobStore(open(), `test-${crypto.randomUUID()}`);
    return { store, cleanup: () => deleteAll(store) };
  });

  describe("S3 BlobStore specifics", () => {
    it("reaches the bucket, and reports a missing one", async () => {
      await expect(open().ping()).resolves.toBeUndefined();
      await expect(open({ bucket: "no-such-bucket-webflix" }).ping()).rejects.toThrow();
    });

    it("keeps custom metadata exactly, even where S3 headers cannot", async () => {
      const store = scopeBlobStore(open(), `test-${crypto.randomUUID()}`);
      try {
        await store.put("plain.bin", "x", { customMetadata: { sha256: "ab12", "x-source": "t" } });
        await store.put("fancy.bin", "x", { customMetadata: { Title: "Amélie 😀", sha256: "ab" } });
        expect((await store.head("plain.bin"))?.customMetadata).toEqual({
          sha256: "ab12",
          "x-source": "t",
        });
        expect((await store.head("fancy.bin"))?.customMetadata).toEqual({
          Title: "Amélie 😀",
          sha256: "ab",
        });
      } finally {
        await deleteAll(store);
      }
    });

    it("streams a large upload without buffering and reads a range from its end", async () => {
      const store = scopeBlobStore(open(), `test-${crypto.randomUUID()}`);
      try {
        const size = 12 * 1024 * 1024;
        let sent = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= size) {
              controller.close();
              return;
            }
            const chunk = new Uint8Array(Math.min(256 * 1024, size - sent)).fill(sent % 251);
            sent += chunk.byteLength;
            controller.enqueue(chunk);
          },
        });
        const meta = await store.put("vod/a/big.m4s", { stream, size });
        expect(meta.size).toBe(size);
        const tail = await store.get("vod/a/big.m4s", { range: { suffix: 10 } });
        expect(tail?.range).toEqual({ offset: size - 10, length: 10 });
        expect((await readAll(tail?.body ?? new ReadableStream())).byteLength).toBe(10);
      } finally {
        await deleteAll(store);
      }
    });

    it("rejects bad credentials", async () => {
      const store = open({ secretAccessKey: "wrong".repeat(10) });
      await expect(store.head("anything")).rejects.toThrow();
    });
  });
}
