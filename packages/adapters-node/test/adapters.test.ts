import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPasswordHasherChain, createPbkdf2PasswordHasher } from "@webflix/core";
import {
  describeBlobStoreContract,
  describePasswordHasherContract,
  readAll,
} from "@webflix/core/testing";
import { describe, expect, it } from "vitest";
import { createFsBlobStore, createScryptPasswordHasher } from "../src/index.ts";

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "webflix-blobs-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describeBlobStoreContract("filesystem", async () => {
  const { root, cleanup } = await tempRoot();
  return { store: createFsBlobStore({ root }), cleanup };
});

describePasswordHasherContract("scrypt (cheap test parameters)", () => ({
  hasher: createScryptPasswordHasher({ logN: 10, r: 8, p: 1 }),
}));

describePasswordHasherContract("chain: scrypt primary, pbkdf2 legacy", () => ({
  hasher: createPasswordHasherChain(
    createScryptPasswordHasher({ logN: 10, r: 8, p: 1 }),
    createPbkdf2PasswordHasher({ iterations: 1_000 }),
  ),
}));

describe("filesystem BlobStore specifics", () => {
  it("keeps keys apart that a case-insensitive filesystem would merge", async () => {
    const { root, cleanup } = await tempRoot();
    try {
      const store = createFsBlobStore({ root });
      await store.put("a/Z", "upper");
      await store.put("a/z", "lower");
      const upper = await store.get("a/Z");
      expect(new TextDecoder().decode(await readAll(upper?.body ?? new ReadableStream()))).toBe(
        "upper",
      );
      expect((await store.list({ prefix: "a/" })).items.map((item) => item.key)).toEqual([
        "a/Z",
        "a/z",
      ]);
    } finally {
      await cleanup();
    }
  });

  it("stores layout keys under readable paths and leaves no temp files", async () => {
    const { root, cleanup } = await tempRoot();
    try {
      const store = createFsBlobStore({ root });
      await store.put("vod/v-sintel/720p/seg-00001.m4s", new Uint8Array([1, 2, 3]));
      expect(await readdir(join(root, "data", "vod", "v-sintel", "720p"))).toEqual([
        "seg-00001.m4s~",
      ]);
      expect(await readdir(join(root, "tmp"))).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("serves files copied in without a sidecar, inferring metadata", async () => {
    const { root, cleanup } = await tempRoot();
    try {
      await mkdir(join(root, "data", "public", "previews", "v1"), { recursive: true });
      await writeFile(join(root, "data", "public", "previews", "v1", "preview.mp4~"), "mp4");
      const store = createFsBlobStore({ root });
      const meta = await store.head("public/previews/v1/preview.mp4");
      expect(meta).toMatchObject({ size: 3, contentType: "video/mp4", cacheControl: null });
      expect(meta?.etag).toMatch(/^[0-9a-f]+-[0-9a-f]+$/);
    } finally {
      await cleanup();
    }
  });

  it("ignores a sidecar that no longer describes the data file", async () => {
    const { root, cleanup } = await tempRoot();
    try {
      const store = createFsBlobStore({ root });
      const before = await store.put("public/img/x.webp", "old", { contentType: "image/x-old" });
      // Simulate a put interrupted after the data rename but before the sidecar rename.
      await writeFile(join(root, "data", "public", "img", "x.webp~"), "new!");
      const after = await store.head("public/img/x.webp");
      expect(after?.etag).not.toBe(before.etag);
      expect(after?.contentType).toBe("image/webp");
      expect(after?.size).toBe(4);
    } finally {
      await cleanup();
    }
  });

  it("treats scrypt hashes with hostile parameters as invalid without throwing", async () => {
    const hasher = createScryptPasswordHasher({ logN: 10 });
    const encoded = await hasher.hash("pw");
    for (const params of ["ln=20,r=32,p=1", "ln=4,r=1,p=16", "ln=0,r=8,p=1", "ln=10,r=8,p=99"]) {
      const tampered = encoded.replace(/\$ln=[^$]+\$/, `$${params}$`);
      expect(await hasher.verify("pw", tampered), params).toEqual({
        valid: false,
        needsRehash: false,
      });
    }
  });

  it("upgrades legacy pbkdf2 hashes to scrypt via needsRehash", async () => {
    const chain = createPasswordHasherChain(
      createScryptPasswordHasher({ logN: 10 }),
      createPbkdf2PasswordHasher({ iterations: 1_000 }),
    );
    const legacy = await createPbkdf2PasswordHasher({ iterations: 1_000 }).hash("pw");
    expect(await chain.verify("pw", legacy)).toEqual({ valid: true, needsRehash: true });
    expect((await chain.hash("pw")).startsWith("$scrypt$ln=10,r=8,p=3$")).toBe(true);
  });
});
