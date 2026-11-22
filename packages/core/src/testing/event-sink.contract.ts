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
  });
}
