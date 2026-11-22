import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkPublished,
  mergeLedgers,
  publishedBefore,
  unversionedConflicts,
} from "../src/published.ts";

describe("immutable public keys", () => {
  const before = mergeLedgers(
    { "public/previews/v-a/preview.mp4": ["aaa"] },
    // An upload record of another store, with the same key published as other bytes.
    { "public/previews/v-b/preview.mp4": ["bbb"] },
    { "public/previews/v-b/preview.mp4": ["bbb"], "public/img/titles/t-x/card-320.webp": ["iii"] },
  );

  it("passes keys that keep their bytes, new keys, and versioned keys that change", () => {
    expect(
      unversionedConflicts(before, {
        "public/previews/v-a/preview.mp4": "aaa",
        "public/previews/v-new/preview.mp4": "nnn",
        "public/img/titles/t-x/card-320.webp": "changed: carries ?v=",
        "vod/v-a/master.m3u8": "private, tokenised",
      }),
    ).toEqual([]);
  });

  it("fails a preview key published before with other bytes, listing each one", () => {
    const conflicts = unversionedConflicts(before, {
      "public/previews/v-a/preview.mp4": "aaa",
      "public/previews/v-b/preview.mp4": "BBB",
    });
    expect(conflicts).toEqual([
      { key: "public/previews/v-b/preview.mp4", before: ["bbb"], now: "BBB" },
    ]);
  });

  it("treats a key with two histories as already burnt", () => {
    const burnt = mergeLedgers(before, { "public/previews/v-a/preview.mp4": ["zzz"] });
    expect(burnt["public/previews/v-a/preview.mp4"]).toEqual(["aaa", "zzz"]);
    expect(
      unversionedConflicts(burnt, { "public/previews/v-a/preview.mp4": "aaa" }).map((c) => c.key),
    ).toEqual(["public/previews/v-a/preview.mp4"]);
  });

  it("fails the build when the previous manifest's preview comes back with other bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "webflix-media-published-"));
    const key = "public/previews/v-a/preview.mp4";
    const tree = join(root, ".cache", "media", "fast");
    const work = join(root, ".cache", "media", "work", "fast");
    await mkdir(join(tree, "public", "previews", "v-a"), { recursive: true });
    await mkdir(work, { recursive: true });
    await writeFile(join(tree, key), "first clip");
    await writeFile(
      join(tree, "manifest.json"),
      JSON.stringify({ videoAssets: [{ assetId: "v-a", preview: { key } }] }),
    );
    // Another store was sent an older clip under a key this build no longer makes.
    await writeFile(
      join(work, "uploaded-0123456789ab.json"),
      JSON.stringify({ "public/previews/v-old/preview.mp4": "0".repeat(64) }),
    );
    try {
      const before = await publishedBefore("fast", root);
      expect(Object.keys(before).sort()).toEqual([key, "public/previews/v-old/preview.mp4"]);
      // Same bytes rebuilt: fine, and recorded in the ledger.
      await checkPublished("fast", before, [key], root);
      // The next build snapshots, then packages different bytes under the same key: it fails
      // with the key listed.
      const snapshot = await publishedBefore("fast", root);
      await writeFile(join(tree, key), "another clip");
      await expect(checkPublished("fast", snapshot, [key], root)).rejects.toThrow(
        /v-a\/preview\.mp4: was [0-9a-f]{12}, now [0-9a-f]{12}/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
