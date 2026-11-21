import { afterEach, beforeEach } from "vitest";

/**
 * Lets a suite move time forward. Provide it when the adapter reads time from an injected
 * `Clock` (pass a `ManualClock` and `advance` it); omit it for backends with server-side
 * time (Valkey TTLs, KV expiry) and the time-dependent cases are skipped.
 *
 * Adapters whose expiry logic runs in application code (a Durable Object's lease table, a
 * Valkey Lua script given `now` as an argument) should take a `Clock` precisely so these cases
 * run against them: lease expiry and rate-limit refill are where such adapters go wrong.
 */
export interface TimeControl {
  advance(ms: number): void | Promise<void>;
}

export interface HarnessBase {
  time?: TimeControl;
  /** Called after each test (drop tables, delete prefixes, close connections). */
  cleanup?(): void | Promise<void>;
}

export type HarnessFactory<H extends HarnessBase> = () => H | Promise<H>;

/**
 * Creates a fresh harness before each test and cleans it up after. Returns an accessor:
 * `const h = useHarness(factory); it("...", async () => h().subject...)`.
 */
export function useHarness<H extends HarnessBase>(factory: HarnessFactory<H>): () => H {
  let current: H | undefined;
  beforeEach(async () => {
    current = await factory();
  });
  afterEach(async () => {
    await current?.cleanup?.();
    current = undefined;
  });
  return () => {
    if (!current) throw new Error("Harness used outside of a test");
    return current;
  };
}

/** Collects a stream into bytes (Web-standard). */
export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function bytesOf(length: number, seed = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + seed) & 0xff;
  return bytes;
}
