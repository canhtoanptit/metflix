import { scrypt } from "node:crypto";
import { lookup } from "node:dns/promises";
import { ConfigError, type PasswordHasher } from "@webflix/core";
import { describe, expect, it } from "vitest";
import { loadApiConfig } from "../src/config.ts";
import { createHashingGate, gatedPasswordHasher } from "../src/hashing.ts";

const base = { WEBFLIX_MODE: "k8s", WEBFLIX_DATABASE_URL: "postgres://u:p@db:5432/webflix" };

/** A task that finishes when told to, recording when it started. */
function deferred(log: string[], name: string) {
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const done = new Promise<string>((resolve, reject) => {
    finish = () => resolve(name);
    fail = reject;
  });
  return {
    task: () => {
      log.push(`start ${name}`);
      return done;
    },
    finish,
    fail,
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("hashing gate", () => {
  it("runs at most its limit at once, the rest in the order they came", async () => {
    const gate = createHashingGate(2);
    const log: string[] = [];
    const tasks = ["a", "b", "c", "d"].map((name) => deferred(log, name));
    const results = tasks.map((task) => gate.run(task.task));
    await tick();
    expect(log).toEqual(["start a", "start b"]);
    expect([gate.running, gate.queued]).toEqual([2, 2]);
    tasks[1]?.finish();
    await tick();
    expect(log).toEqual(["start a", "start b", "start c"]);
    expect([gate.running, gate.queued]).toEqual([2, 1]);
    tasks[0]?.finish();
    tasks[2]?.finish();
    await tick();
    expect(log.at(-1)).toBe("start d");
    tasks[3]?.finish();
    expect(await Promise.all(results)).toEqual(["a", "b", "c", "d"]);
    expect([gate.running, gate.queued]).toEqual([0, 0]);
  });

  it("frees the slot of a task that fails", async () => {
    const gate = createHashingGate(1);
    const log: string[] = [];
    const first = deferred(log, "first");
    const second = deferred(log, "second");
    const failing = gate.run(first.task);
    const next = gate.run(second.task);
    await tick();
    first.fail(new Error("no"));
    await expect(failing).rejects.toThrow("no");
    await tick();
    expect(log).toEqual(["start first", "start second"]);
    second.finish();
    expect(await next).toBe("second");
    expect(gate.running).toBe(0);
  });

  it("refuses a limit below one", () => {
    expect(() => createHashingGate(0)).toThrow(RangeError);
  });

  it("gates both hashing and verifying, and leaves the rest of the hasher alone", async () => {
    const gate = createHashingGate(1);
    let concurrent = 0;
    let peak = 0;
    const slow = async <T>(value: T) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
      return value;
    };
    const inner: PasswordHasher = {
      algorithm: "test",
      supports: (encoded) => encoded.startsWith("$test$"),
      hash: (password) => slow(`$test$${password}`),
      verify: (password, encoded) =>
        slow({ valid: encoded === `$test$${password}`, needsRehash: false }),
    };
    const gated = gatedPasswordHasher(inner, gate);
    expect(gated.algorithm).toBe("test");
    expect(gated.supports("$test$x")).toBe(true);
    const outcomes = await Promise.all([
      gated.hash("a"),
      gated.verify("a", "$test$a"),
      gated.verify("b", "$test$a"),
      gated.hash("b"),
    ]);
    expect(outcomes).toEqual([
      "$test$a",
      { valid: true, needsRehash: false },
      { valid: false, needsRehash: false },
      "$test$b",
    ]);
    expect(peak).toBe(1);
  });

  it("keeps libuv's threadpool for DNS lookups while a burst of scrypt hashes waits its turn", async () => {
    // The threadpool's default 4 threads; scrypt cheap enough for a test, still on the pool.
    const hash = () =>
      new Promise<void>((resolve, reject) =>
        scrypt("1234", "salt", 32, { N: 2 ** 12, r: 8, p: 4 }, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    const timeLookupDuring = async (burst: () => Promise<unknown>) => {
      const running = burst();
      await tick();
      const started = performance.now();
      await lookup("localhost");
      const elapsed = performance.now() - started;
      await running;
      return elapsed;
    };
    const gate = createHashingGate(2);
    const gated = await timeLookupDuring(() =>
      Promise.all(Array.from({ length: 64 }, () => gate.run(hash))),
    );
    const ungated = await timeLookupDuring(() =>
      Promise.all(Array.from({ length: 64 }, () => hash())),
    );
    // Ungated, the lookup waits behind every queued hash; gated, behind at most the two running.
    expect(gated).toBeLessThan(ungated / 4);
  });
});

describe("hashing concurrency setting", () => {
  it("leaves two of the threadpool's threads free by default, and at least one hashing", () => {
    expect(loadApiConfig(base).hashConcurrency).toBe(2);
    expect(loadApiConfig({ ...base, UV_THREADPOOL_SIZE: "8" }).hashConcurrency).toBe(6);
    expect(loadApiConfig({ ...base, UV_THREADPOOL_SIZE: "2" }).hashConcurrency).toBe(1);
    expect(loadApiConfig({ ...base, WEBFLIX_HASH_CONCURRENCY: "3" }).hashConcurrency).toBe(3);
  });

  it("refuses a concurrency that would take the whole threadpool", () => {
    expect(() => loadApiConfig({ ...base, WEBFLIX_HASH_CONCURRENCY: "4" })).toThrow(ConfigError);
    expect(() =>
      loadApiConfig({ ...base, UV_THREADPOOL_SIZE: "1", WEBFLIX_HASH_CONCURRENCY: "1" }),
    ).toThrow(/at most 0|take all 1 threads/);
  });

  it("keeps a warm minimum of database connections, never above the maximum", () => {
    const database = (env: Record<string, string>) => {
      const config = loadApiConfig({ ...base, ...env }).database;
      return config.kind === "postgres" ? [config.minConnections, config.maxConnections] : null;
    };
    expect(database({})).toEqual([4, 10]);
    expect(database({ WEBFLIX_DATABASE_POOL_MIN: "0" })).toEqual([0, 10]);
    expect(database({ WEBFLIX_DATABASE_POOL_MIN: "12", WEBFLIX_DATABASE_POOL_MAX: "6" })).toEqual([
      6, 6,
    ]);
  });
});
