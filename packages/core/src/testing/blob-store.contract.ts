import { describe, expect, it } from "vitest";
import {
  type BlobRange,
  BlobRangeNotSatisfiableError,
  type BlobStore,
  InvalidBlobKeyError,
} from "../ports/blob-store.ts";
import { bytesOf, type HarnessBase, type HarnessFactory, readAll, useHarness } from "./harness.ts";

export interface BlobStoreHarness extends HarnessBase {
  /** An empty store (or an empty scope of one; see `scopeBlobStore`). */
  store: BlobStore;
}

const INVALID_KEYS = [
  "",
  "/leading",
  "trailing/",
  "a//b",
  "a/./b",
  "a/../b",
  "..",
  "a\\b",
  "a\u0000b",
];

/** Contract every `BlobStore` adapter must pass. */
export function describeBlobStoreContract(
  name: string,
  factory: HarnessFactory<BlobStoreHarness>,
): void {
  describe(`BlobStore contract: ${name}`, () => {
    const h = useHarness(factory);

    async function read(store: BlobStore, key: string, range?: BlobRange) {
      const object = await store.get(key, range ? { range } : {});
      if (!object) throw new Error(`expected ${key} to exist`);
      return { object, bytes: await readAll(object.body) };
    }

    it("round-trips binary content", async () => {
      const { store } = h();
      const bytes = bytesOf(70_000);
      const meta = await store.put("vod/a1/seg-0001.m4s", bytes);
      expect(meta).toMatchObject({ key: "vod/a1/seg-0001.m4s", size: bytes.byteLength });
      const { object, bytes: back } = await read(store, "vod/a1/seg-0001.m4s");
      expect(back).toEqual(bytes);
      expect(object.range).toBeNull();
      expect(object.size).toBe(bytes.byteLength);
    });

    it("accepts strings, ArrayBuffers and sized streams", async () => {
      const { store } = h();
      await store.put("s.txt", "héllo");
      await store.put("b.bin", bytesOf(10).buffer);
      const streamed = bytesOf(5_000, 7);
      await store.put("st.bin", {
        stream: new Response(streamed).body ?? new ReadableStream(),
        size: streamed.byteLength,
      });
      expect(new TextDecoder().decode((await read(store, "s.txt")).bytes)).toBe("héllo");
      expect((await read(store, "b.bin")).bytes).toEqual(bytesOf(10));
      expect((await read(store, "st.bin")).bytes).toEqual(streamed);
    });

    it("rejects a stream that does not match its declared size", async () => {
      const { store } = h();
      const body = { stream: new Response(bytesOf(10)).body ?? new ReadableStream(), size: 11 };
      await expect(store.put("short.bin", body)).rejects.toThrow();
      expect(await store.head("short.bin")).toBeNull();
    });

    it("stores metadata, inferring content type from the extension", async () => {
      const { store } = h();
      await store.put("vod/a1/master.m3u8", "#EXTM3U\n");
      await store.put("public/img/x.bin", bytesOf(3), {
        contentType: "application/x-custom",
        cacheControl: "public, max-age=31536000, immutable",
        customMetadata: { source: "contract" },
      });
      const inferred = await store.head("vod/a1/master.m3u8");
      expect(inferred?.contentType).toBe("application/vnd.apple.mpegurl");
      expect(inferred?.cacheControl).toBeNull();
      expect(inferred?.customMetadata).toEqual({});
      const explicit = await store.head("public/img/x.bin");
      expect(explicit).toMatchObject({
        key: "public/img/x.bin",
        size: 3,
        contentType: "application/x-custom",
        cacheControl: "public, max-age=31536000, immutable",
        customMetadata: { source: "contract" },
      });
      expect(typeof explicit?.uploadedAt).toBe("number");
      expect(explicit?.etag).toMatch(/^[^"\s]+$/);
    });

    it("returns null for missing keys", async () => {
      const { store } = h();
      expect(await store.head("nope")).toBeNull();
      expect(await store.get("nope")).toBeNull();
      expect(await store.get("nope", { range: { offset: 0, length: 1 } })).toBeNull();
    });

    it("keeps the etag stable across reads and changes it when content changes", async () => {
      const { store } = h();
      await store.put("e.bin", bytesOf(100, 1));
      const first = await store.head("e.bin");
      const again = await store.head("e.bin");
      expect(again?.etag).toBe(first?.etag);
      await store.put("e.bin", bytesOf(100, 2));
      const changed = await store.head("e.bin");
      expect(changed?.etag).not.toBe(first?.etag);
      expect((await read(store, "e.bin")).bytes).toEqual(bytesOf(100, 2));
    });

    describe("range reads", () => {
      const data = bytesOf(1_000);
      const cases: [string, BlobRange, number, number][] = [
        ["offset + length", { offset: 100, length: 50 }, 100, 50],
        ["offset to end", { offset: 990 }, 990, 10],
        ["length past the end is clamped", { offset: 900, length: 500 }, 900, 100],
        ["suffix", { suffix: 25 }, 975, 25],
        ["suffix larger than the object", { suffix: 5_000 }, 0, 1_000],
        ["first byte", { offset: 0, length: 1 }, 0, 1],
      ];

      it.each(cases)("%s", async (_label, range, offset, length) => {
        const { store } = h();
        await store.put("r.bin", data);
        const { object, bytes } = await read(store, "r.bin", range);
        expect(object.range).toEqual({ offset, length });
        expect(object.size).toBe(data.byteLength);
        expect(bytes).toEqual(data.slice(offset, offset + length));
      });

      it("throws BlobRangeNotSatisfiableError with the size when unsatisfiable", async () => {
        const { store } = h();
        await store.put("r.bin", data);
        await store.put("empty.bin", new Uint8Array(0));
        const attempts: [string, BlobRange, number][] = [
          ["r.bin", { offset: 1_000 }, 1_000],
          ["r.bin", { offset: 5_000, length: 1 }, 1_000],
          ["empty.bin", { offset: 0 }, 0],
          ["empty.bin", { suffix: 10 }, 0],
        ];
        for (const [key, range, size] of attempts) {
          const error = await store.get(key, { range }).catch((caught: unknown) => caught);
          expect(error).toBeInstanceOf(BlobRangeNotSatisfiableError);
          expect((error as BlobRangeNotSatisfiableError).size).toBe(size);
        }
      });
    });

    it("stores empty objects", async () => {
      const { store } = h();
      await store.put("empty.bin", new Uint8Array(0));
      const { object, bytes } = await read(store, "empty.bin");
      expect(object.size).toBe(0);
      expect(bytes.byteLength).toBe(0);
    });

    it("deletes single keys and batches; missing keys are fine", async () => {
      const { store } = h();
      await store.put("d/1", "1");
      await store.put("d/2", "2");
      await store.put("d/3", "3");
      await store.delete("d/1");
      await store.delete(["d/2", "d/3", "d/missing"]);
      await store.delete("never/existed");
      expect((await store.list({ prefix: "d/" })).items).toEqual([]);
    });

    it("lists by prefix in code point order and pages with cursors", async () => {
      const { store } = h();
      const keys = ["a/b", "a/a", "a/Z", "a/é", "a/😀", "a/z", "a/b/c", "a/￮", "b/a"];
      for (const key of keys) await store.put(key, key);

      const expected = keys
        .filter((key) => key.startsWith("a/"))
        .sort((x, y) => {
          const left = [...x].map((char) => char.codePointAt(0) ?? 0);
          const right = [...y].map((char) => char.codePointAt(0) ?? 0);
          for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
            const difference = (left[index] ?? 0) - (right[index] ?? 0);
            if (difference !== 0) return difference;
          }
          return left.length - right.length;
        });

      const all = await store.list({ prefix: "a/" });
      expect(all.items.map((item) => item.key)).toEqual(expected);
      expect(all.cursor).toBeNull();
      expect(all.items[0]?.size).toBeGreaterThan(0);

      const paged: string[] = [];
      let cursor: string | undefined;
      for (let pages = 0; pages < 20; pages += 1) {
        const page = await store.list({ prefix: "a/", limit: 3, ...(cursor ? { cursor } : {}) });
        expect(page.items.length).toBeLessThanOrEqual(3);
        paged.push(...page.items.map((item) => item.key));
        if (page.cursor === null) break;
        cursor = page.cursor;
      }
      expect(paged).toEqual(expected);
    });

    it("round-trips keys with spaces and unicode", async () => {
      const { store } = h();
      const key = "public/img/titles/t 1/Amélie 😀.webp";
      await store.put(key, "x");
      expect((await store.head(key))?.key).toBe(key);
      expect((await store.list({ prefix: "public/img/titles/t 1/" })).items).toHaveLength(1);
    });

    it("rejects invalid keys on every operation", async () => {
      const { store } = h();
      for (const key of INVALID_KEYS) {
        await expect(store.put(key, "x"), key).rejects.toBeInstanceOf(InvalidBlobKeyError);
        await expect(store.get(key), key).rejects.toBeInstanceOf(InvalidBlobKeyError);
        await expect(store.head(key), key).rejects.toBeInstanceOf(InvalidBlobKeyError);
        await expect(store.delete(key), key).rejects.toBeInstanceOf(InvalidBlobKeyError);
      }
    });

    it("rejects invalid list limits", async () => {
      const { store } = h();
      await expect(store.list({ limit: 0 })).rejects.toThrow(RangeError);
      await expect(store.list({ limit: 1_001 })).rejects.toThrow(RangeError);
    });

    it("serves a range from the middle of a multi-megabyte object", async () => {
      const { store } = h();
      const big = bytesOf(5 * 1024 * 1024, 3);
      await store.put("vod/a1/big.mp4", big);
      const offset = 3 * 1024 * 1024 + 17;
      const { bytes } = await read(store, "vod/a1/big.mp4", { offset, length: 65_536 });
      expect(bytes).toEqual(big.slice(offset, offset + 65_536));
    });
  });
}
