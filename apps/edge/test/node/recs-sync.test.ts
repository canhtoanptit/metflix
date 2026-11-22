/**
 * Moving objects between this mode's stores and a pipeline store (lib/recs.ts): incremental,
 * immutable objects copied once, nothing outside the prefix touched.
 */
import { MemoryBlobStore } from "@webflix/core/memory";
import { describe, expect, it } from "vitest";
import { copyPrefix } from "../../scripts/lib/recs.ts";

const bytes = (text: string) => new Uint8Array(new TextEncoder().encode(text));

describe("copyPrefix", () => {
  it("copies what the target lacks, skips what it holds, and leaves other prefixes alone", async () => {
    const from = new MemoryBlobStore();
    const to = new MemoryBlobStore();
    await from.put("events/dt=2026-11-22/hh=10/a.ndjson.gz", bytes("aaa"), {
      contentType: "application/gzip",
    });
    await from.put("events/dt=2026-11-22/hh=11/b.ndjson.gz", bytes("bbbb"));
    await from.put("recs/current.json", bytes("{}"));
    await to.put("events/dt=2026-11-22/hh=10/a.ndjson.gz", bytes("aaa"));

    expect(await copyPrefix(from, to, "events/")).toEqual({ copied: 1, skipped: 1, bytes: 4 });
    expect(await to.head("recs/current.json")).toBeNull();
    const copied = await to.get("events/dt=2026-11-22/hh=11/b.ndjson.gz");
    expect(new TextDecoder().decode(await new Response(copied?.body).arrayBuffer())).toBe("bbbb");
    // Idempotent: a second run copies nothing.
    expect(await copyPrefix(from, to, "events/")).toEqual({ copied: 0, skipped: 2, bytes: 0 });
  });

  it("recopies an object whose size differs (an interrupted earlier copy)", async () => {
    const from = new MemoryBlobStore();
    const to = new MemoryBlobStore();
    await from.put("recs/v=r/manifest.json", bytes("complete"));
    await to.put("recs/v=r/manifest.json", bytes("part"));
    expect((await copyPrefix(from, to, "recs/v=r/")).copied).toBe(1);
    expect((await to.head("recs/v=r/manifest.json"))?.size).toBe(8);
  });
});
