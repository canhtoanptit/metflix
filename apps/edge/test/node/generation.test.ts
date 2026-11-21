/**
 * L11: the media cache generation follows what the bucket serves in every path that changes
 * it, so no reader ever caches a mix of old and new objects.
 */
import { describe, expect, it } from "vitest";
import {
  type GenerationStore,
  manifestGeneration,
  matchesManifest,
  publishMedia,
  syncGeneration,
} from "../../scripts/lib/generation.ts";
import {
  cacheGeneration,
  MEDIA_GENERATION_KEY,
  UPLOADING_PREFIX,
} from "../../src/media-generation.ts";

function harness(initial: string | null, bucketManifest: string | null) {
  const events: string[] = [];
  let value = initial;
  let manifest = bucketManifest;
  const kv: GenerationStore = {
    get: async (key) => (key === MEDIA_GENERATION_KEY ? value : null),
    put: async (key, next) => {
      if (key === MEDIA_GENERATION_KEY) {
        value = next;
        events.push(`generation=${next.startsWith(UPLOADING_PREFIX) ? "uploading" : next}`);
      }
    },
  };
  return {
    kv,
    events,
    value: () => value,
    setManifest: (text: string) => {
      manifest = text;
    },
    readManifest: async () => manifest,
  };
}

describe("publishing media", () => {
  it("bypasses the cache before rewriting objects and names the new manifest only after the last object", async () => {
    const h = harness(manifestGeneration("v1"), "v1");
    const result = await publishMedia({
      kv: h.kv,
      upToDate: async () => false,
      upload: async () => {
        h.events.push("objects written");
        h.setManifest("v2");
        h.events.push("manifest written");
        return { uploaded: 3 };
      },
      readManifest: h.readManifest,
      drainMs: 120_000,
      sleep: async (ms) => {
        h.events.push(`waited ${ms} ms`);
      },
      now: () => 1_000,
      log: () => {},
    });
    const fresh = `${manifestGeneration("v2")}-${(1_000).toString(36)}`;
    expect(h.events).toEqual([
      "generation=uploading",
      "waited 120000 ms",
      "objects written",
      "manifest written",
      `generation=${fresh}`,
    ]);
    expect(result.generation).toBe(fresh);
    expect(cacheGeneration(h.value())).toBe(fresh);
  });

  it("changes the generation when objects change but the manifest does not", async () => {
    // Seen for real: a re-encode rewrote 1,407 objects under an identical manifest.
    const before = `${manifestGeneration("v1")}-a`;
    const h = harness(before, "v1");
    const result = await publishMedia({
      kv: h.kv,
      upToDate: async () => false,
      upload: async () => ({ uploaded: 1407 }),
      readManifest: h.readManifest,
      drainMs: 0,
      sleep: async () => {},
      now: () => 99_999,
      log: () => {},
    });
    expect(result.generation).not.toBe(before);
    expect(matchesManifest(result.generation, "v1")).toBe(true);
  });

  it("leaves the cache bypassed when the upload fails part-way", async () => {
    const h = harness(manifestGeneration("v1"), "v1");
    await expect(
      publishMedia({
        kv: h.kv,
        upToDate: async () => false,
        upload: async () => {
          throw new Error("network");
        },
        readManifest: h.readManifest,
        drainMs: 0,
        sleep: async () => {},
        now: () => 1,
        log: () => {},
      }),
    ).rejects.toThrow("network");
    expect(cacheGeneration(h.value())).toBeNull();
  });

  it("completes an interrupted upload even when the bucket's manifest already matches", async () => {
    // A failed run may have rewritten objects without reaching the manifest.
    const h = harness(`${UPLOADING_PREFIX}1`, "v2");
    let uploads = 0;
    const result = await publishMedia({
      kv: h.kv,
      upToDate: async () => true,
      upload: async () => {
        uploads += 1;
        return { uploaded: 0 };
      },
      readManifest: h.readManifest,
      drainMs: 0,
      sleep: async () => {},
      now: () => 2,
      log: () => {},
    });
    expect(uploads).toBe(1);
    expect(matchesManifest(result.generation, "v2")).toBe(true);
    expect(cacheGeneration(h.value())).toBe(result.generation);
  });

  it("does nothing but confirm the generation when the bucket is already current", async () => {
    const h = harness(`${manifestGeneration("v2")}-k3`, "v2");
    const result = await publishMedia({
      kv: h.kv,
      upToDate: async () => true,
      upload: async () => {
        throw new Error("not called");
      },
      readManifest: h.readManifest,
      drainMs: 0,
      sleep: async () => {},
      now: () => 2,
      log: () => {},
    });
    expect(result).toEqual({ report: null, generation: `${manifestGeneration("v2")}-k3` });
    expect(h.events).toEqual([]);
  });
});

describe("seeding", () => {
  it("follows the bucket's manifest but never re-enables caching during an upload", async () => {
    const fresh = harness(null, "v1");
    const synced = await syncGeneration(fresh.kv, fresh.readManifest, () => 5);
    expect(synced).toMatchObject({ changed: true, uploading: false });
    expect(matchesManifest(synced.generation, "v1")).toBe(true);
    // Same manifest, already tracked: nothing to do.
    expect(await syncGeneration(fresh.kv, fresh.readManifest)).toMatchObject({ changed: false });
    const uploading = harness(`${UPLOADING_PREFIX}5`, "v1");
    expect(await syncGeneration(uploading.kv, uploading.readManifest)).toMatchObject({
      uploading: true,
      changed: false,
    });
    expect(cacheGeneration(uploading.value())).toBeNull();
  });
});

describe("what readers do with the stored value", () => {
  it("caches under the manifest hash, bypasses while uploading, defaults to 0", () => {
    expect(cacheGeneration("23d55ac7dbbdf9a4")).toBe("23d55ac7dbbdf9a4");
    expect(cacheGeneration(`${UPLOADING_PREFIX}1795000000000`)).toBeNull();
    expect(cacheGeneration(null)).toBe("0");
    expect(cacheGeneration("not/valid")).toBe("0");
  });
});
