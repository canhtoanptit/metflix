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

export const MEDIA_KEYS_SECRET = "WEBFLIX_MEDIA_TOKEN_KEYS";

export interface CommandOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export type FirstKeyDecision =
  | { action: "keep" }
  | { action: "create"; why: string }
  | { action: "abort"; reason: string };

/**
 * Wrangler 4.x (`secret list`, API codes 10007/10090): `Worker "<name>" (env: <env>) not
 * found.` followed by "If this is a new Worker, run `wrangler deploy` first". A test pins this
 * text against the installed Wrangler, so an upgrade that changes it fails there, not here.
 */
const WORKER_NOT_FOUND = /Worker "([^"]+)"(?: \(env: [^)]+\))? not found\./;

export function decideFirstKey(listing: CommandOutput, worker: string): FirstKeyDecision {
  const output = `${listing.stdout}\n${listing.stderr}`;
  if (listing.code === 0) {
    const start = listing.stdout.search(/\[/);
    let names: string[];
    try {
      if (start === -1) throw new Error("no JSON array");
      const parsed = JSON.parse(listing.stdout.slice(start)) as unknown;
      if (!Array.isArray(parsed)) throw new Error("not an array");
      names = parsed.map((entry) => String((entry as { name?: unknown }).name));
    } catch (error) {
      return {
        action: "abort",
        reason: `could not read \`wrangler secret list\` (${(error as Error).message}): ${listing.stdout.slice(0, 200)}`,
      };
    }
    return names.includes(MEDIA_KEYS_SECRET)
      ? { action: "keep" }
      : { action: "create", why: `the Worker has no ${MEDIA_KEYS_SECRET} secret` };
  }
  const missing = WORKER_NOT_FOUND.exec(output);
  if (missing && missing[1] === worker) {
    return { action: "create", why: `Worker "${worker}" does not exist yet (first deploy)` };
  }
  return {
    action: "abort",
    reason: `\`wrangler secret list\` failed, so whether ${MEDIA_KEYS_SECRET} is set is unknown; refusing to replace it (exit ${listing.code}): ${output.trim().slice(0, 400)}`,
  };
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
