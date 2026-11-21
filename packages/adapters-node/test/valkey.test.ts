/**
 * Valkey adapters against a real Valkey: every port's contract suite (with a manual clock, so
 * the expiry cases run, and with Valkey's own clock), plus what only matters with several
 * replicas: contention between separate connections, crash recovery of the job queue, and
 * behaviour while Valkey is unreachable.
 *
 * Needs WEBFLIX_TEST_VALKEY_URL: `pnpm --filter @webflix/adapters-node test:services` starts a
 * throwaway Valkey and sets it.
 */
import { type AddressInfo, createServer } from "node:net";
import { AppError, type JobDelivery, type JobProcessor, ManualClock } from "@webflix/core";
import {
  describeJobQueueContract,
  describeKeyValueCacheContract,
  describeRateLimiterContract,
  describeStreamGateContract,
} from "@webflix/core/testing";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  connectValkey,
  createValkeyCache,
  createValkeyJobQueue,
  createValkeyRateLimiter,
  createValkeyStreamGate,
  type ValkeyConnection,
} from "../src/valkey/index.ts";

const url = process.env.WEBFLIX_TEST_VALKEY_URL;
const connections: ValkeyConnection[] = [];

function connect(prefix = `test:${crypto.randomUUID()}:`): ValkeyConnection {
  if (!url) throw new Error("WEBFLIX_TEST_VALKEY_URL is not set");
  const connection = connectValkey({ url, keyPrefix: prefix });
  connections.push(connection);
  return connection;
}

async function deletePrefix(connection: ValkeyConnection): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await connection.client.scan(
      cursor,
      "MATCH",
      `${connection.keyPrefix}*`,
      "COUNT",
      500,
    );
    if (keys.length > 0) await connection.client.del(...keys);
    cursor = next;
  } while (cursor !== "0");
}

afterAll(async () => {
  await Promise.all(connections.map((connection) => connection.close()));
});

if (!url) {
  describe.skip("Valkey adapters (set WEBFLIX_TEST_VALKEY_URL, or run test:services)", () => {
    it("needs a Valkey server", () => {});
  });
} else {
  describeKeyValueCacheContract("valkey", () => {
    const valkey = connect();
    return { cache: createValkeyCache(valkey), cleanup: () => deletePrefix(valkey) };
  });

  describeRateLimiterContract("valkey, manual clock", () => {
    const valkey = connect();
    const clock = new ManualClock();
    return {
      limiter: createValkeyRateLimiter(valkey, { clock }),
      time: { advance: (ms) => clock.advance(ms) },
      cleanup: () => deletePrefix(valkey),
    };
  });

  describeRateLimiterContract("valkey, server clock", () => {
    const valkey = connect();
    return { limiter: createValkeyRateLimiter(valkey), cleanup: () => deletePrefix(valkey) };
  });

  describeStreamGateContract("valkey, manual clock", () => {
    const valkey = connect();
    const clock = new ManualClock();
    return {
      gate: createValkeyStreamGate(valkey, { clock }),
      time: { advance: (ms) => clock.advance(ms) },
      cleanup: () => deletePrefix(valkey),
    };
  });

  describeStreamGateContract("valkey, server clock", () => {
    const valkey = connect();
    return { gate: createValkeyStreamGate(valkey), cleanup: () => deletePrefix(valkey) };
  });

  describeJobQueueContract("valkey streams, manual clock", (processor) => {
    const valkey = connect();
    const clock = new ManualClock();
    const queue = createValkeyJobQueue(valkey, {
      clock,
      maxAttempts: 3,
      pollIntervalMs: 20,
      blockMs: 200,
    });
    queue.startConsumer(processor);
    return {
      queue,
      drain: () => queue.drain(),
      deadLetters: () => queue.deadLetters(),
      maxAttempts: 3,
      time: { advance: (ms) => clock.advance(ms) },
      cleanup: async () => {
        await queue.stop();
        await deletePrefix(valkey);
      },
    };
  });

  describeJobQueueContract("valkey streams, server clock", (processor) => {
    const valkey = connect();
    const queue = createValkeyJobQueue(valkey, {
      maxAttempts: 3,
      pollIntervalMs: 20,
      blockMs: 200,
    });
    queue.startConsumer(processor);
    return {
      queue,
      drain: () => queue.drain(),
      deadLetters: () => queue.deadLetters(),
      maxAttempts: 3,
      cleanup: async () => {
        await queue.stop();
        await deletePrefix(valkey);
      },
    };
  });

  describe("Valkey adapters across replicas", () => {
    it("sets a server-side TTL on cache entries", async () => {
      const valkey = connect();
      await createValkeyCache(valkey).set("k", "v", { ttlSec: 90 });
      const ttl = await valkey.client.pttl(`${valkey.keyPrefix}cache:k`);
      expect(ttl).toBeGreaterThan(85_000);
      expect(ttl).toBeLessThanOrEqual(90_000);
      await deletePrefix(valkey);
    });

    it("enforces a stream limit across connections racing for the same account", async () => {
      const prefix = `test:${crypto.randomUUID()}:`;
      const replicas = Array.from({ length: 4 }, () => createValkeyStreamGate(connect(prefix)));
      const accountId = `acct-${crypto.randomUUID()}`;
      const results = await Promise.all(
        Array.from({ length: 24 }, (_, index) =>
          (replicas[index % replicas.length] ?? replicas[0])?.acquire({
            accountId,
            playbackSessionId: `ps-${index}`,
            deviceId: `d-${index}`,
            deviceLabel: `Device ${index}`,
            titleName: null,
            limit: 2,
            leaseTtlSec: 60,
          }),
        ),
      );
      expect(results.filter((result) => result?.ok)).toHaveLength(2);
      const listed = await replicas[3]?.list(accountId);
      expect(listed).toHaveLength(2);
      // Sign-out everywhere on one replica is visible on every other at once.
      await replicas[0]?.releaseAll(accountId);
      for (const replica of replicas) expect(await replica.list(accountId)).toEqual([]);
    });

    it("counts rate limits exactly across connections", async () => {
      const prefix = `test:${crypto.randomUUID()}:`;
      const replicas = Array.from({ length: 3 }, () => createValkeyRateLimiter(connect(prefix)));
      const policy = { name: "login", limit: 10, windowSec: 60 };
      const decisions = await Promise.all(
        Array.from({ length: 30 }, (_, index) =>
          replicas[index % replicas.length]?.consume(policy, "203.0.113.7"),
        ),
      );
      expect(decisions.filter((decision) => decision?.allowed)).toHaveLength(10);
    });

    it("shares work between consumers without delivering an acknowledged job twice", async () => {
      const prefix = `test:${crypto.randomUUID()}:`;
      const seen: string[] = [];
      const processor: JobProcessor = async (delivery) => {
        seen.push(delivery.id);
        await new Promise((resolve) => setTimeout(resolve, 2));
        return { action: "ack" };
      };
      const workers = ["a", "b", "c"].map((consumer) =>
        createValkeyJobQueue(connect(prefix), { consumer, blockMs: 200, pollIntervalMs: 20 }),
      );
      for (const worker of workers) worker.startConsumer(processor);
      const [producer] = workers;
      for (let batch = 0; batch < 3; batch += 1) {
        await producer?.publishBatch(
          Array.from({ length: 50 }, (_, index) => ({ type: "work.item", payload: index })),
        );
      }
      await producer?.drain();
      expect(seen).toHaveLength(150);
      expect(new Set(seen).size).toBe(150);
      await Promise.all(workers.map((worker) => worker.stop()));
    });

    it("recovers the job of a consumer that died mid-delivery (no loss)", async () => {
      const prefix = `test:${crypto.randomUUID()}:`;
      const crashed = connect(prefix);
      const deliveries: JobDelivery[] = [];
      // Consumer A takes the job and never settles it (its process is about to be killed).
      const doomed = createValkeyJobQueue(crashed, {
        consumer: "worker-a",
        blockMs: 100,
        visibilityTimeoutMs: 400,
      });
      let taken!: () => void;
      const tookIt = new Promise<void>((resolve) => {
        taken = resolve;
      });
      doomed.startConsumer(async (delivery) => {
        deliveries.push(delivery);
        taken();
        return new Promise<never>(() => {});
      });
      await doomed.publish({ type: "stats.rollup-day", payload: { day: "2026-11-21" } });
      await tookIt;
      // Kill A's connections without letting it stop gracefully.
      crashed.client.disconnect();
      await doomed.stop(10);

      const survivor = createValkeyJobQueue(connect(prefix), {
        consumer: "worker-b",
        blockMs: 100,
        pollIntervalMs: 20,
        visibilityTimeoutMs: 400,
      });
      survivor.startConsumer(async (delivery) => {
        deliveries.push(delivery);
        return { action: "ack" };
      });
      await expect
        .poll(() => deliveries.length, { timeout: 5000, interval: 50 })
        .toBeGreaterThanOrEqual(2);
      await survivor.drain();
      expect(deliveries.map((delivery) => delivery.attempt)).toEqual([1, 2]);
      expect(deliveries[1]?.id).toBe(deliveries[0]?.id);
      expect(deliveries[1]?.payload).toEqual({ day: "2026-11-21" });
      expect(await survivor.stats()).toMatchObject({ stream: 0, pending: 0, delayed: 0 });
      await survivor.stop();
    });

    it("dead-letters a job that keeps crashing its consumers", async () => {
      const prefix = `test:${crypto.randomUUID()}:`;
      const options = {
        maxAttempts: 2,
        blockMs: 100,
        pollIntervalMs: 20,
        visibilityTimeoutMs: 300,
      };
      const attempts: number[] = [];
      // A consumer that takes a delivery and dies before settling it.
      const crashOnce = async (consumer: string) => {
        const worker = createValkeyJobQueue(connect(prefix), { ...options, consumer });
        let taken!: () => void;
        const tookIt = new Promise<void>((resolve) => {
          taken = resolve;
        });
        worker.startConsumer(async (delivery) => {
          attempts.push(delivery.attempt);
          taken();
          return new Promise<never>(() => {});
        });
        return { worker, tookIt };
      };
      const first = await crashOnce("w1");
      await first.worker.publish({ type: "poison.pill", payload: 1 });
      await first.tookIt;
      await first.worker.stop(10);
      // w2 reclaims w1's abandoned delivery (attempt 1 failed), gets attempt 2, dies too.
      const second = await crashOnce("w2");
      await second.tookIt;
      await second.worker.stop(10);
      // w3 reclaims attempt 2: attempts are exhausted, so it is dead-lettered, not delivered.
      const healthy = vi.fn<JobProcessor>(async () => ({ action: "ack" }));
      const third = createValkeyJobQueue(connect(prefix), { ...options, consumer: "w3" });
      third.startConsumer(healthy);
      await expect.poll(async () => (await third.deadLetters()).length, { timeout: 5000 }).toBe(1);
      expect(attempts).toEqual([1, 2]);
      expect(healthy).not.toHaveBeenCalled();
      expect((await third.deadLetters())[0]).toMatchObject({ type: "poison.pill", attempt: 2 });
      expect(await third.stats()).toMatchObject({ stream: 0, pending: 0, dead: 1 });
      await third.stop();
    });

    it("keeps working after Valkey drops the connection (reconnects)", async () => {
      const valkey = connect();
      const cache = createValkeyCache(valkey);
      await cache.set("k", "before", { ttlSec: 60 });
      const id = await valkey.client.client("ID");
      const admin = connect();
      await admin.client.client("KILL", "ID", String(id));
      await expect.poll(() => cache.get("k"), { timeout: 5000 }).toBe("before");
      await valkey.ping();
      await deletePrefix(valkey);
    });

    it("answers service_unavailable when Valkey is full (noeviction refuses writes)", async () => {
      const valkey = connect();
      const admin = connect();
      const [, original = "0"] = (await admin.client.config("GET", "maxmemory")) as string[];
      await admin.client.config("SET", "maxmemory-policy", "noeviction");
      await admin.client.config("SET", "maxmemory", "1");
      try {
        const failures = await Promise.all([
          createValkeyCache(valkey)
            .set("k", "v", { ttlSec: 60 })
            .catch((error: unknown) => error),
          createValkeyRateLimiter(valkey)
            .consume({ name: "auth", limit: 5, windowSec: 60 }, "203.0.113.1")
            .catch((error: unknown) => error),
          createValkeyStreamGate(valkey)
            .acquire({
              accountId: "acct-oom",
              playbackSessionId: "ps-1",
              deviceId: "d-1",
              deviceLabel: "Device",
              titleName: null,
              limit: 1,
              leaseTtlSec: 60,
            })
            .catch((error: unknown) => error),
          createValkeyJobQueue(valkey)
            .publish({ type: "stats.rollup-day", payload: { day: "2026-11-21" } })
            .catch((error: unknown) => error),
        ]);
        for (const failure of failures) {
          expect(AppError.is(failure, "service_unavailable"), String(failure)).toBe(true);
        }
      } finally {
        await admin.client.config("SET", "maxmemory", original);
        await deletePrefix(valkey);
      }
    });

    it("fails fast with service_unavailable while Valkey is unreachable", async () => {
      // A port that was just free: nothing listens there.
      const closed = await new Promise<number>((resolve) => {
        const probe = createServer();
        probe.listen(0, "127.0.0.1", () => {
          const { port } = probe.address() as AddressInfo;
          probe.close(() => resolve(port));
        });
      });
      const down = connectValkey({ url: `redis://127.0.0.1:${closed}`, commandTimeoutMs: 300 });
      connections.push(down);
      const started = Date.now();
      const error = await createValkeyStreamGate(down)
        .list("acct")
        .catch((caught: unknown) => caught);
      expect(AppError.is(error, "service_unavailable")).toBe(true);
      expect(Date.now() - started).toBeLessThan(2000);
      // Down for over a second: later requests fail at once instead of waiting it out.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const again = Date.now();
      const fast = await createValkeyStreamGate(down)
        .list("acct")
        .catch((caught: unknown) => caught);
      expect(AppError.is(fast, "service_unavailable")).toBe(true);
      expect(Date.now() - again).toBeLessThan(100);
      await expect(down.ping()).rejects.toThrow();
      await expect(
        createValkeyRateLimiter(down).consume({ name: "auth", limit: 1, windowSec: 60 }, "ip"),
      ).rejects.toSatisfy((caught: unknown) => AppError.is(caught, "service_unavailable"));
    });
  });
}
