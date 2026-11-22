import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryBlobStore } from "@webflix/core/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTarget } from "../src/upload/targets.ts";
import { cacheControlForKey, MANIFEST_KEYS, uploadTree } from "../src/upload/upload.ts";

describe("upload", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "webflix-media-upload-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = join(dir, "fast");
    await mkdir(join(root, "public/img/titles/t-a"), { recursive: true });
    await mkdir(join(root, "vod/v-a/720p"), { recursive: true });
    await writeFile(join(root, "public/img/titles/t-a/card-320.webp"), "card");
    await writeFile(join(root, "vod/v-a/master.m3u8"), "#EXTM3U\n");
    await writeFile(join(root, "vod/v-a/720p/seg_00000.m4s"), "segment");
    await writeFile(join(root, "manifest.json"), '{"version":1}');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  const tree = () => ({
    profile: "fast" as const,
    root: join(dir, "fast"),
    manifestFile: join(dir, "fast", "manifest.json"),
    stateDir: join(dir, "state"),
    targetId: "memory:",
  });

  it("uploads through the port, then skips everything unchanged", async () => {
    const store = new MemoryBlobStore();
    const first = await uploadTree(tree(), store);
    expect(first.uploaded).toBe(5);
    const card = await store.head("public/img/titles/t-a/card-320.webp");
    expect(card?.contentType).toBe("image/webp");
    expect(card?.cacheControl).toBe("public, max-age=31536000, immutable");
    expect(card?.customMetadata.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.head(MANIFEST_KEYS.current)).not.toBeNull();

    const second = await uploadTree(tree(), store);
    expect(second.uploaded).toBe(0);
    expect(second.skipped).toBe(5);
  });

  it("re-uploads changed files and prunes stale objects on request", async () => {
    const store = new MemoryBlobStore();
    await uploadTree(tree(), store);
    await store.put("vod/v-old/master.m3u8", "#EXTM3U\n");
    await writeFile(join(dir, "fast/vod/v-a/master.m3u8"), "#EXTM3U\n#EXT-X-VERSION:7\n");
    const report = await uploadTree(tree(), store, { prune: true });
    expect(report.uploaded).toBe(1);
    expect(report.deleted).toBe(1);
    expect(await store.head("vod/v-old/master.m3u8")).toBeNull();
  });

  it("never replaces a published preview clip in place (it is cached as immutable)", async () => {
    const store = new MemoryBlobStore();
    await mkdir(join(dir, "fast/public/previews/v-a"), { recursive: true });
    await writeFile(join(dir, "fast/public/previews/v-a/preview.mp4"), "clip");
    await uploadTree(tree(), store);
    await writeFile(join(dir, "fast/public/previews/v-a/preview.mp4"), "another clip");
    await expect(uploadTree(tree(), store)).rejects.toThrow(/new asset id.*v-a\/preview\.mp4/);
    // Same bytes again: nothing to refuse.
    await writeFile(join(dir, "fast/public/previews/v-a/preview.mp4"), "clip");
    expect((await uploadTree(tree(), store)).uploaded).toBe(0);
  });

  it("parses target specs and picks cache headers by key", () => {
    expect(parseTarget("fs:")).toEqual({ scheme: "fs", path: "", raw: "fs:" });
    expect(parseTarget("s3://bucket/prefix").scheme).toBe("s3");
    expect(() => parseTarget("nowhere")).toThrow(/expected <scheme>/);
    expect(cacheControlForKey("vod/v/master.m3u8")).toBe("private, max-age=300");
    expect(cacheControlForKey("vod/v/720p/seg_00001.m4s")).toBe(
      "private, max-age=31536000, immutable",
    );
  });
});
