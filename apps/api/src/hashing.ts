import type { PasswordHasher } from "@webflix/core";

/**
 * Password and PIN hashing, a few at a time.
 *
 * scrypt (and WebCrypto's PBKDF2) run on libuv's threadpool, four threads by default, which every
 * DNS lookup, file read, compression and WebCrypto call of the process shares, PostgreSQL's
 * SCRAM sign-in included. Handed to the threadpool all at once, a burst of sign-ins or PIN
 * checks fills its queue for seconds: measured in an API pod (1 CPU), sixty PIN hashes made a
 * DNS lookup of the database wait 8.8 s and SCRAM's key derivation 8.8 s, so every connection
 * opened meanwhile hit its 5 s timeout and its request answered 503. Kept to two at a time
 * here, the rest wait in this queue, in order, and the threadpool keeps threads for everything
 * else (the same lookup: 18 ms), while the burst itself finishes no later (one CPU hashes no
 * faster with four threads than with two).
 */
export interface HashingGate {
  /** Runs `task` once fewer than `limit` tasks are running; first come, first served. */
  run<T>(task: () => Promise<T>): Promise<T>;
  readonly limit: number;
  /** Tasks running now. */
  readonly running: number;
  /** Tasks waiting for a slot. */
  readonly queued: number;
}

export function createHashingGate(limit: number): HashingGate {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError(`limit must be 1 or more: ${limit}`);
  let running = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  };
  return {
    limit,
    get running() {
      return running;
    },
    get queued() {
      return waiting.length;
    },
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (running < limit) running += 1;
      // A slot is handed over directly by the task that frees it (running stays the same).
      else await new Promise<void>((resolve) => waiting.push(resolve));
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

/** The same hasher, its hashing and verifying through `gate`. */
export function gatedPasswordHasher(hasher: PasswordHasher, gate: HashingGate): PasswordHasher {
  return {
    algorithm: hasher.algorithm,
    supports: (encoded) => hasher.supports(encoded),
    hash: (password) => gate.run(() => hasher.hash(password)),
    verify: (password, encoded) => gate.run(() => hasher.verify(password, encoded)),
  };
}
