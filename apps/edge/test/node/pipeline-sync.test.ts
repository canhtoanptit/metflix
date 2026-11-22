/**
 * The round trips' sync between R2 and the pipeline store (lib/pipeline-jobs.ts `Mirror`): what
 * the pipeline removed is removed from R2, what it rewrote is rewritten, a manifest goes after
 * its data, and nothing the Worker wrote after the pull is touched.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlobPutOptions, BlobStore } from "@webflix/core";
import { MemoryBlobStore } from "@webflix/core/memory";
import { afterAll, describe, expect, it } from "vitest";
import { Mirror } from "../../scripts/lib/pipeline-jobs.ts";

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));
const bytes = (text: string) => new Uint8Array(new TextEncoder().encode(text));
const text = async (store: BlobStore, key: string) => {
  const object = await store.get(key);
  return object ? new TextDecoder().decode(await new Response(object.body).arrayBuffer()) : null;
};

/** R2 that records the order of writes and deletions. */
function recordingR2(log: string[]): BlobStore {
  const inner = new MemoryBlobStore();
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "put") {
        return (key: string, body: Uint8Array<ArrayBuffer>, options?: BlobPutOptions) => {
          log.push(`put ${key}`);
          return target.put(key, body, options);
        };
      }
      if (property === "delete") {
        return (keys: string | readonly string[]) => {
          log.push(`delete ${[keys].flat().join(",")}`);
          return target.delete(keys);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "webflix-sync-test-"));
  dirs.push(dir);
  const log: string[] = [];
  const r2 = recordingR2(log);
  const store = new MemoryBlobStore();
  return { dir, log, r2, store };
}

describe("the round trips' mirror", () => {
  it("pulls R2 exactly (mirror) or merged (overlay), then only what changed", async () => {
    const { dir, r2, store } = await setup();
    await r2.put("events/dt=d/hh=10/a.ndjson.gz", bytes("a"));
    await r2.put("recs/v=r/manifest.json", bytes("served"));
    await store.put("events/dt=d/hh=09/stale.ndjson.gz", bytes("gone from R2"));
    await store.put("recs/v=local/manifest.json", bytes("the store's own run"));
    const first = new Mirror(r2, store, dir);
    await first.load();
    const pulled = await first.pull([
      { prefix: "events/", mode: "mirror" },
      { prefix: "recs/", mode: "overlay" },
    ]);
    expect(pulled).toMatchObject({ downloaded: 2, removed: 1 });
    expect(await store.head("events/dt=d/hh=09/stale.ndjson.gz")).toBeNull();
    expect(await text(store, "recs/v=local/manifest.json")).toBe("the store's own run");
    const again = new Mirror(r2, store, dir);
    await again.load();
    expect(await again.pull([{ prefix: "events/", mode: "mirror" }])).toMatchObject({
      downloaded: 0,
      unchanged: 1,
    });
  });

  it("pushes rewrites and new files (manifests last), then removals; leaves later writes alone", async () => {
    const { dir, log, r2, store } = await setup();
    await r2.put("events/dt=d/hh=10/a.ndjson.gz", bytes("member and others"));
    await r2.put("events/dt=d/hh=10/b.ndjson.gz", bytes("member only"));
    await r2.put("events/dt=d/hh=09/untouched.ndjson.gz", bytes("another member"));
    const mirror = new Mirror(r2, store, dir);
    await mirror.load();
    await mirror.pull([{ prefix: "events/", mode: "mirror" }]);
    // The job: an erasure rewrites a, deletes b, writes a Parquet file and its manifest.
    await store.put("events/dt=d/hh=10/a.ndjson.gz", bytes("others"));
    await store.delete("events/dt=d/hh=10/b.ndjson.gz");
    await store.put("events/dt=d/hh=10/_compaction.json", bytes("{}"));
    await store.put("events/dt=d/hh=10/part-0123456789abcdef.parquet", bytes("PAR1"));
    // Meanwhile the Worker writes a new raw object.
    await r2.put("events/dt=d/hh=11/c.ndjson.gz", bytes("written after the pull"));
    log.length = 0;
    const pushed = await mirror.push([{ prefix: "events/", mode: "mirror" }]);
    expect(pushed).toMatchObject({ uploaded: 3, deleted: 1 });
    expect(log).toEqual([
      "put events/dt=d/hh=10/a.ndjson.gz",
      "put events/dt=d/hh=10/part-0123456789abcdef.parquet",
      "put events/dt=d/hh=10/_compaction.json",
      "delete events/dt=d/hh=10/b.ndjson.gz",
    ]);
    expect(await text(r2, "events/dt=d/hh=10/a.ndjson.gz")).toBe("others");
    expect(await text(r2, "events/dt=d/hh=11/c.ndjson.gz")).toBe("written after the pull");
  });

  it("rewrites only the runs R2 serves under recs/ (overlay)", async () => {
    const { dir, log, r2, store } = await setup();
    await r2.put("recs/v=served/profiles/part-00000.parquet", bytes("with the member"));
    const mirror = new Mirror(r2, store, dir);
    await mirror.load();
    await mirror.pull([{ prefix: "recs/", mode: "overlay" }]);
    await store.put("recs/v=served/profiles/part-00000.parquet", bytes("without"));
    await store.put("recs/v=unpushed/manifest.json", bytes("local work"));
    log.length = 0;
    await mirror.push([{ prefix: "recs/", mode: "overlay" }]);
    expect(log).toEqual(["put recs/v=served/profiles/part-00000.parquet"]);
  });
});
