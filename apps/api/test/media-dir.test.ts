import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobRangeNotSatisfiableError } from "@webflix/core";
import { MemoryBlobStore } from "@webflix/core/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDirectoryBlobStore, layerBlobStores } from "../src/media-dir.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "webflix-media-dir-"));
  await mkdir(join(root, "vod", "v-1"), { recursive: true });
  await writeFile(join(root, "vod", "v-1", "master.m3u8"), "#EXTM3U\n");
  await writeFile(
    join(root, "vod", "v-1", "seg.m4s"),
    new Uint8Array(1000).map((_, i) => i % 256),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const read = async (body: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(body).arrayBuffer());

describe("directory blob store (dev media overlay)", () => {
  it("serves files laid out by blob key, with ranges", async () => {
    const store = createDirectoryBlobStore(root);
    expect(await store.head("vod/v-1/master.m3u8")).toMatchObject({
      size: 8,
      contentType: "application/vnd.apple.mpegurl",
    });
    expect(await store.head("vod/v-1/missing.m3u8")).toBeNull();
    const ranged = await store.get("vod/v-1/seg.m4s", { range: { offset: 10, length: 5 } });
    expect(ranged?.range).toEqual({ offset: 10, length: 5 });
    expect([...(await read(ranged?.body ?? new ReadableStream()))]).toEqual([10, 11, 12, 13, 14]);
    await expect(store.get("vod/v-1/seg.m4s", { range: { offset: 5000 } })).rejects.toBeInstanceOf(
      BlobRangeNotSatisfiableError,
    );
    await expect(store.head("vod/../../etc/passwd")).rejects.toThrow();
    await expect(store.put("vod/v-1/x", "nope")).rejects.toThrow(/read-only/);
  });

  it("layers under a writable store", async () => {
    const primary = new MemoryBlobStore();
    await primary.put("vod/v-1/master.m3u8", "#EXTM3U\n#OVERRIDE\n");
    const store = layerBlobStores(primary, createDirectoryBlobStore(root));
    expect((await store.head("vod/v-1/master.m3u8"))?.size).toBe(18);
    expect((await store.head("vod/v-1/seg.m4s"))?.size).toBe(1000);
    await store.put("public/img/new.webp", "x");
    expect(await primary.head("public/img/new.webp")).not.toBeNull();
  });
});
