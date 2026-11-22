/**
 * The production media-token keys (`WEBFLIX_MEDIA_TOKEN_KEYS`, `id:secret[,id:secret]`: the
 * first key signs, every key verifies). Worker secrets are write-only, so these rules decide
 * from what Wrangler reports, and never replace a key unless that is certain to be safe.
 *
 * - First deploy: a key is created only when `wrangler secret list` succeeded and shows no such
 *   secret, or failed with Wrangler's specific "Worker not found" error. Any other failure (a
 *   network error, an API outage, an expired login) aborts the deploy: guessing "absent" would
 *   upload a new key and invalidate every outstanding token, with the old key unrecoverable.
 * - Rotation is two-phase, so no version of the Worker ever meets a token it cannot verify,
 *   even during a gradual rollout: `add` (new key appended: verify-only) → deploy →
 *   `promote` (new key first: it signs) → deploy → after the token lifetime, `retire`.
 */
import { randomBytes } from "node:crypto";
import { type CommandOutput, readSecretListing } from "./secret-listing.ts";

export type { CommandOutput } from "./secret-listing.ts";

export const MEDIA_KEYS_SECRET = "WEBFLIX_MEDIA_TOKEN_KEYS";

export type FirstKeyDecision =
  | { action: "keep" }
  | { action: "create"; why: string }
  | { action: "abort"; reason: string };

/** Whether the first deploy may create a generated key (`secret`), from `wrangler secret list`. */
export function decideFirstKey(
  listing: CommandOutput,
  worker: string,
  secret: string = MEDIA_KEYS_SECRET,
): FirstKeyDecision {
  const read = readSecretListing(listing, worker);
  switch (read.kind) {
    case "listed":
      return read.names.includes(secret)
        ? { action: "keep" }
        : { action: "create", why: `the Worker has no ${secret} secret` };
    case "new-worker":
      return { action: "create", why: `Worker "${worker}" does not exist yet (first deploy)` };
    case "unknown":
      return {
        action: "abort",
        reason: `whether ${secret} is set is unknown; refusing to replace it: ${read.reason}`,
      };
  }
}

export interface SigningKey {
  id: string;
  secret: string;
}

/** Same rules as `loadCoreConfig` (ids `[A-Za-z0-9_-]{1,16}`, secrets ≥ 32 characters). */
export function parseKeys(value: string): SigningKey[] {
  const keys = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(":");
      return { id: entry.slice(0, separator), secret: entry.slice(separator + 1) };
    });
  if (keys.length === 0) throw new Error(`${MEDIA_KEYS_SECRET}: no keys`);
  for (const key of keys) {
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(key.id) || key.secret.length < 32) {
      throw new Error(`${MEDIA_KEYS_SECRET}: expected id:secret pairs (secret ≥ 32 characters)`);
    }
  }
  if (new Set(keys.map((key) => key.id)).size !== keys.length) {
    throw new Error(`${MEDIA_KEYS_SECRET}: duplicate key ids`);
  }
  return keys;
}

export function formatKeys(keys: readonly SigningKey[]): string {
  return keys.map((key) => `${key.id}:${key.secret}`).join(",");
}

/** A fresh 256-bit key, its id from the creation time (`k202611211530`). */
export function newKey(now: Date = new Date()): SigningKey {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 12);
  return { id: `k${stamp}`, secret: randomBytes(32).toString("base64url") };
}

export type RotationStep = "add" | "promote" | "retire";

/** The next key set of a two-phase rotation. Throws when the step does not apply. */
export function rotate(
  keys: readonly SigningKey[],
  step: RotationStep,
  fresh?: SigningKey,
): SigningKey[] {
  switch (step) {
    case "add": {
      if (keys.length !== 1) {
        throw new Error(
          `a rotation is already in progress (${keys.length} keys): promote or retire first`,
        );
      }
      if (!fresh) throw new Error("add needs the new key");
      if (keys.some((key) => key.id === fresh.id)) throw new Error(`key id ${fresh.id} exists`);
      // Appended: every Worker version accepts the new key before any version signs with it.
      return [...keys, fresh];
    }
    case "promote": {
      const [current, added] = keys;
      if (keys.length !== 2 || !current || !added) {
        throw new Error("promote expects exactly two keys (after `add` and its deploy)");
      }
      return [added, current];
    }
    case "retire": {
      const [signing] = keys;
      if (keys.length !== 2 || !signing) {
        throw new Error("retire expects exactly two keys (after `promote` and its deploy)");
      }
      return [signing];
    }
  }
}
