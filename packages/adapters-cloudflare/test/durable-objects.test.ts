/**
 * The Durable Object adapters (rate limiter, stream gate) inside workerd, on SQLite-backed
 * objects: the contract suites with a manual clock (so expiry and refill are exercised), plus
 * the platform behaviour they rely on (durability across eviction, alarm-driven cleanup).
 */

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ManualClock } from "@webflix/core";
import { describeRateLimiterContract, describeStreamGateContract } from "@webflix/core/testing";
import { describe, expect, it } from "vitest";
import {
  createDurableObjectRateLimiter,
  createDurableObjectStreamGate,
  type RateLimiterObject,
  type StreamGateObject,
} from "../src/index.ts";

describeRateLimiterContract("Durable Object", () => {
  const clock = new ManualClock(Date.now());
  return {
    limiter: createDurableObjectRateLimiter(env.LIMITS, { clock }),
    time: { advance: (ms) => clock.advance(ms) },
  };
});

describeRateLimiterContract("Durable Object, system clock", () => ({
  limiter: createDurableObjectRateLimiter(env.LIMITS),
}));

describeStreamGateContract("Durable Object per account", () => {
  const clock = new ManualClock(Date.now());
  return {
    gate: createDurableObjectStreamGate(env.STREAMS, { clock }),
    time: { advance: (ms) => clock.advance(ms) },
  };
});

const policy = { name: "auth", limit: 2, windowSec: 60 };

describe("RateLimiterObject on the platform", () => {
  it("keeps its count across eviction (state is in storage, not memory)", async () => {
    const limiter = createDurableObjectRateLimiter(env.LIMITS);
    const key = `ip:${crypto.randomUUID()}`;
    await limiter.consume(policy, key);
    await limiter.consume(policy, key);
    await evictDurableObject(env.LIMITS.getByName(`auth:${key}`));
    expect((await limiter.consume(policy, key)).allowed).toBe(false);
  });

  it("deletes its state once idle, via an alarm", async () => {
    const limiter = createDurableObjectRateLimiter(env.LIMITS);
    const key = `ip:${crypto.randomUUID()}`;
    await limiter.consume(policy, key);
    const stub = env.LIMITS.getByName(`auth:${key}`);
    expect(await runInDurableObject(stub, (_, state) => state.storage.getAlarm())).not.toBeNull();
    // Pretend the window has passed: move the recorded idle time into the past, run the alarm.
    await runInDurableObject(stub, (_: RateLimiterObject, state) => {
      const current = state.storage.kv.get<{ tat: number; idleAt: number }>("state");
      if (current) state.storage.kv.put("state", { ...current, idleAt: Date.now() - 1 });
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const keys = await runInDurableObject(stub, (_, state) => [...state.storage.kv.list()]);
    expect(keys).toEqual([]);
  });
});

describe("StreamGateObject on the platform", () => {
  const request = (accountId: string, session: string, device: string) => ({
    accountId,
    playbackSessionId: session,
    deviceId: device,
    deviceLabel: "Chrome on macOS",
    titleName: "Sintel",
    limit: 1,
    leaseTtlSec: 60,
  });

  it("keeps leases across eviction", async () => {
    const gate = createDurableObjectStreamGate(env.STREAMS);
    const account = `acct-${crypto.randomUUID()}`;
    expect((await gate.acquire(request(account, "ps-1", "d-1"))).ok).toBe(true);
    await evictDurableObject(env.STREAMS.getByName(account));
    expect((await gate.acquire(request(account, "ps-2", "d-2"))).ok).toBe(false);
    expect((await gate.list(account)).map((lease) => lease.playbackSessionId)).toEqual(["ps-1"]);
  });

  it("arms an alarm for the earliest expiry and drops all storage when no lease is left", async () => {
    const gate = createDurableObjectStreamGate(env.STREAMS);
    const account = `acct-${crypto.randomUUID()}`;
    await gate.acquire(request(account, "ps-1", "d-1"));
    const stub = env.STREAMS.getByName(account);
    const alarm = await runInDurableObject(stub, (_, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThan(Date.now());
    expect(alarm).toBeLessThanOrEqual(Date.now() + 60_000);

    // Expire the lease on the object's own clock, then let the alarm clean up.
    await runInDurableObject(stub, (_: StreamGateObject, state) => {
      state.storage.sql.exec("UPDATE leases SET expires_at_local = ?", Date.now() - 1);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const tables = await runInDurableObject(stub, (_, state) =>
      state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((row) => row.name)
        .filter((name) => !name.startsWith("_cf_") && !name.startsWith("sqlite_")),
    );
    expect(tables).toEqual([]);
    expect(await runInDurableObject(stub, (_, state) => state.storage.getAlarm())).toBeNull();
  });

  it("signs out everywhere at once: releaseAll frees every slot immediately", async () => {
    const gate = createDurableObjectStreamGate(env.STREAMS);
    const account = `acct-${crypto.randomUUID()}`;
    await gate.acquire({ ...request(account, "ps-1", "d-1"), limit: 2 });
    await gate.acquire({ ...request(account, "ps-2", "d-2"), limit: 2 });
    await gate.releaseAll(account);
    expect(await gate.list(account)).toEqual([]);
    expect(await gate.renew(account, "ps-1", 60)).toBeNull();
  });
});
