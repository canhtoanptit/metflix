import { describe, expect, it } from "vitest";
import type { AcquireStreamRequest, StreamGate } from "../ports/stream-gate.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "./harness.ts";

export interface StreamGateHarness extends HarnessBase {
  gate: StreamGate;
}

/** Contract every `StreamGate` adapter must pass. */
export function describeStreamGateContract(
  name: string,
  factory: HarnessFactory<StreamGateHarness>,
): void {
  describe(`StreamGate contract: ${name}`, () => {
    const h = useHarness(factory);
    const account = () => `acct-${crypto.randomUUID()}`;
    const request = (
      accountId: string,
      session: string,
      device: string,
      overrides: Partial<AcquireStreamRequest> = {},
    ): AcquireStreamRequest => ({
      accountId,
      playbackSessionId: session,
      deviceId: device,
      deviceLabel: `Browser ${device}`,
      titleName: "Sintel",
      limit: 2,
      leaseTtlSec: 60,
      ...overrides,
    });

    it("grants leases up to the limit and lists active streams when full", async () => {
      const { gate } = h();
      const id = account();
      const first = await gate.acquire(request(id, "ps-1", "d-1"));
      const second = await gate.acquire(request(id, "ps-2", "d-2"));
      expect(first.ok && second.ok).toBe(true);

      const third = await gate.acquire(request(id, "ps-3", "d-3"));
      expect(third.ok).toBe(false);
      if (third.ok) return;
      expect(third.active.map((lease) => lease.playbackSessionId)).toEqual(["ps-1", "ps-2"]);
      expect(third.active[0]).toMatchObject({
        accountId: id,
        deviceId: "d-1",
        deviceLabel: "Browser d-1",
        titleName: "Sintel",
      });
    });

    it("fills in lease timestamps", async () => {
      const { gate } = h();
      const result = await gate.acquire(request(account(), "ps-1", "d-1"));
      if (!result.ok) throw new Error("expected a lease");
      const { acquiredAt, renewedAt, expiresAt } = result.lease;
      expect(renewedAt).toBeGreaterThanOrEqual(acquiredAt);
      expect(expiresAt).toBeGreaterThan(renewedAt);
      expect(expiresAt - renewedAt).toBeLessThanOrEqual(60_000);
    });

    it("treats re-acquiring the same playback session as a renewal", async () => {
      const { gate } = h();
      const id = account();
      await gate.acquire(request(id, "ps-1", "d-1", { limit: 1 }));
      const again = await gate.acquire(request(id, "ps-1", "d-1", { limit: 1 }));
      expect(again.ok).toBe(true);
      expect(await gate.list(id)).toHaveLength(1);
    });

    it("lets a device replace its own stream without using another slot", async () => {
      const { gate } = h();
      const id = account();
      await gate.acquire(request(id, "ps-1", "d-1", { limit: 1 }));
      const replaced = await gate.acquire(request(id, "ps-2", "d-1", { limit: 1 }));
      expect(replaced).toMatchObject({ ok: true, replaced: "ps-1" });
      const leases = await gate.list(id);
      expect(leases.map((lease) => lease.playbackSessionId)).toEqual(["ps-2"]);
    });

    it("never exceeds the limit under concurrent acquires", async () => {
      const { gate } = h();
      const id = account();
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          gate.acquire(request(id, `ps-${index}`, `d-${index}`, { limit: 2 })),
        ),
      );
      expect(results.filter((result) => result.ok)).toHaveLength(2);
      expect(await gate.list(id)).toHaveLength(2);
    });

    it("renews existing leases and reports gone ones as null", async () => {
      const { gate } = h();
      const id = account();
      await gate.acquire(request(id, "ps-1", "d-1"));
      const renewed = await gate.renew(id, "ps-1", 120);
      expect(renewed?.playbackSessionId).toBe("ps-1");
      expect((renewed?.expiresAt ?? 0) - (renewed?.renewedAt ?? 0)).toBe(120_000);
      expect(await gate.renew(id, "ps-unknown", 60)).toBeNull();
    });

    it("frees slots on release, releaseDevice and releaseAll (all idempotent)", async () => {
      const { gate } = h();
      const id = account();
      await gate.acquire(request(id, "ps-1", "d-1"));
      await gate.acquire(request(id, "ps-2", "d-2"));

      await gate.release(id, "ps-1");
      await gate.release(id, "ps-1");
      expect((await gate.list(id)).map((lease) => lease.playbackSessionId)).toEqual(["ps-2"]);
      expect(await gate.renew(id, "ps-1", 60)).toBeNull();

      await gate.releaseDevice(id, "d-2");
      await gate.releaseDevice(id, "d-2");
      expect(await gate.list(id)).toEqual([]);

      await gate.acquire(request(id, "ps-3", "d-3"));
      await gate.releaseAll(id);
      await gate.releaseAll(id);
      expect(await gate.list(id)).toEqual([]);
      expect((await gate.acquire(request(id, "ps-4", "d-4"))).ok).toBe(true);
    });

    it("isolates accounts", async () => {
      const { gate } = h();
      const [a, b] = [account(), account()];
      await gate.acquire(request(a, "ps-1", "d-1", { limit: 1 }));
      expect((await gate.acquire(request(b, "ps-2", "d-2", { limit: 1 }))).ok).toBe(true);
      await gate.releaseAll(a);
      expect(await gate.list(b)).toHaveLength(1);
    });

    it("applies a lowered limit to new streams without evicting existing ones", async () => {
      const { gate } = h();
      const id = account();
      await gate.acquire(request(id, "ps-1", "d-1", { limit: 2 }));
      await gate.acquire(request(id, "ps-2", "d-2", { limit: 2 }));
      expect((await gate.acquire(request(id, "ps-3", "d-3", { limit: 1 }))).ok).toBe(false);
      expect(await gate.list(id)).toHaveLength(2);
    });

    it("expires leases that are not renewed", async (context) => {
      const { gate, time } = h();
      if (!time) return context.skip();
      const id = account();
      await gate.acquire(request(id, "ps-1", "d-1", { limit: 1, leaseTtlSec: 30 }));
      await time.advance(29_000);
      expect(await gate.renew(id, "ps-1", 30)).not.toBeNull();
      await time.advance(31_000);
      expect(await gate.list(id)).toEqual([]);
      expect(await gate.renew(id, "ps-1", 30)).toBeNull();
      expect((await gate.acquire(request(id, "ps-2", "d-2", { limit: 1 }))).ok).toBe(true);
    });

    it("rejects invalid limits and lease lifetimes", async () => {
      const { gate } = h();
      const id = account();
      await expect(gate.acquire(request(id, "ps-1", "d-1", { limit: 0 }))).rejects.toThrow();
      await expect(gate.acquire(request(id, "ps-1", "d-1", { leaseTtlSec: 0 }))).rejects.toThrow();
    });
  });
}
