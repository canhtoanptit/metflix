import type { LakeEvent } from "@webflix/contracts";
import { makeLakeEvent } from "@webflix/contracts/fixtures";
import { describe, expect, it } from "vitest";
import type { EventSink } from "../ports/event-sink.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "./harness.ts";

export interface EventSinkHarness extends HarnessBase {
  sink: EventSink;
  /**
   * Everything stored so far, object by object (memory: its objects; the lake writer: list the
   * blob store under `events/` and decode each object with `decodeLakeObject`).
   */
  readBack(): Promise<{ key: string; events: unknown[] }[]>;
}

const OBJECT_KEY = /^events\/dt=\d{4}-\d{2}-\d{2}\/hh=\d{2}\/[A-Za-z0-9_-]+\.ndjson\.gz$/;

/** Contract every `EventSink` adapter must pass. */
export function describeEventSinkContract(
  name: string,
  factory: HarnessFactory<EventSinkHarness>,
): void {
  describe(`EventSink contract: ${name}`, () => {
    const h = useHarness(factory);
    const at = (iso: string): LakeEvent => makeLakeEvent("impression", { receivedAt: iso });

    it("stores a batch in its receipt hour's partition, readable back exactly", async () => {
      const events = [at("2026-11-22T10:05:00.000Z"), at("2026-11-22T10:59:59.999Z")];
      const receipt = await h().sink.append(events);
      expect(receipt.objects).toHaveLength(1);
      expect(receipt.objects[0]).toMatch(OBJECT_KEY);
      expect(receipt.objects[0]).toContain("events/dt=2026-11-22/hh=10/");
      const stored = await h().readBack();
      expect(stored.map((object) => object.key)).toEqual(receipt.objects);
      expect(stored[0]?.events).toEqual(events);
    });

    it("splits a batch that spans hours (and days): an object never mixes hours", async () => {
      const events = [
        at("2026-11-22T23:59:59.000Z"),
        at("2026-11-23T00:00:00.000Z"),
        at("2026-11-22T23:30:00.000Z"),
      ];
      const receipt = await h().sink.append(events);
      expect(receipt.objects).toHaveLength(2);
      const stored = await h().readBack();
      const byHour = Object.fromEntries(
        stored.map((object) => [object.key.split("/").slice(1, 3).join("/"), object.events]),
      );
      expect(byHour["dt=2026-11-22/hh=23"]).toEqual([events[0], events[2]]);
      expect(byHour["dt=2026-11-23/hh=00"]).toEqual([events[1]]);
    });

    it("never overwrites: two appends in one hour are two objects", async () => {
      const first = await h().sink.append([at("2026-11-22T10:00:01.000Z")]);
      const second = await h().sink.append([at("2026-11-22T10:00:01.000Z")]);
      expect(first.objects[0]).not.toBe(second.objects[0]);
      expect(await h().readBack()).toHaveLength(2);
    });

    it("keeps concurrent appends apart (no lost events)", async () => {
      const batches = Array.from({ length: 8 }, (_, index) => [
        at(`2026-11-22T11:00:0${index}.000Z`),
        at(`2026-11-22T11:00:0${index}.500Z`),
      ]);
      await Promise.all(batches.map((batch) => h().sink.append(batch)));
      const stored = (await h().readBack()).flatMap((object) => object.events);
      expect(stored).toHaveLength(16);
    });

    it("writes nothing for an empty batch", async () => {
      expect((await h().sink.append([])).objects).toEqual([]);
      expect(await h().readBack()).toEqual([]);
    });

    it("stores server and client events alike, byte for byte as JSON", async () => {
      const events = [
        makeLakeEvent("playback.start", { receivedAt: "2026-11-22T12:00:00.000Z" }),
        makeLakeEvent("auth.signin", { receivedAt: "2026-11-22T12:00:00.000Z" }),
        makeLakeEvent("search.query", { receivedAt: "2026-11-22T12:00:00.000Z" }),
      ];
      await h().sink.append(events);
      const [object] = await h().readBack();
      expect(JSON.stringify(object?.events)).toBe(JSON.stringify(events));
    });

    it("scans stored objects of a receipt-time range, in time order, page by page", async () => {
      const hours = ["2026-11-20T08", "2026-11-21T23", "2026-11-22T00", "2026-11-22T05"];
      const stored = hours.map((hour) => at(`${hour}:15:00.000Z`));
      for (const event of stored) await h().sink.append([event]);
      const from = Date.parse("2026-11-21T23:30:00.000Z"); // inside the 23:00 hour: included
      const to = Date.parse("2026-11-22T05:00:00.000Z"); // the 05:00 hour starts here: excluded
      const seen: unknown[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await h().sink.scan({ fromMs: from, toMs: to, cursor, limit: 1 });
        seen.push(...page.objects.flatMap((object) => object.events));
        cursor = page.cursor;
        pages += 1;
      } while (cursor !== null && pages < 50);
      expect(seen).toEqual([stored[1], stored[2]]);
      const wide = await h().sink.scan({ fromMs: 0, toMs: Date.parse("2027-01-01T00:00:00Z") });
      const all = [...wide.objects];
      let next = wide.cursor;
      while (next !== null) {
        const page = await h().sink.scan({
          fromMs: 0,
          toMs: Date.parse("2027-01-01"),
          cursor: next,
        });
        all.push(...page.objects);
        next = page.cursor;
      }
      expect(all.flatMap((object) => object.events)).toEqual(stored);
    });

    it("scans nothing outside the stored hours and refuses a forged cursor", async () => {
      await h().sink.append([at("2026-11-22T10:05:00.000Z")]);
      const empty = await h().sink.scan({
        fromMs: Date.parse("2026-11-23T00:00:00.000Z"),
        toMs: Date.parse("2026-11-24T00:00:00.000Z"),
      });
      expect(empty).toEqual({ objects: [], cursor: null });
      await expect(
        h().sink.scan({ fromMs: 0, toMs: Date.now(), cursor: "not-a-cursor!" }),
      ).rejects.toThrow();
    });

    it("keeps private documents beside the lake, never under a served prefix", async () => {
      const bytes = new Uint8Array([1, 2, 3, 250]);
      const key = await h().sink.putDocument("exports/req-1.json.gz", bytes);
      expect(key).toBe("privacy/exports/req-1.json.gz");
      expect(await h().sink.getDocument(key)).toEqual(bytes);
      await expect(h().sink.putDocument("exports/req-1.json.gz", bytes)).rejects.toThrow();
      await expect(h().sink.putDocument("../public/x", bytes)).rejects.toThrow();
      await expect(h().sink.getDocument("public/img/x.webp")).rejects.toThrow();
      await h().sink.deleteDocument(key);
      await h().sink.deleteDocument(key);
      expect(await h().sink.getDocument(key)).toBeNull();
      // Documents are not lake objects.
      expect(await h().readBack()).toEqual([]);
    });
  });
}
