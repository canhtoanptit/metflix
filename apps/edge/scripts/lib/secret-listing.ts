/** Reading `wrangler secret list` (no dependencies: shared by media-keys.ts and secrets.ts). */

export interface CommandOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/** What `wrangler secret list` says about the deployed Worker. */
export type SecretListing =
  | { kind: "listed"; names: string[] }
  | { kind: "new-worker" }
  | { kind: "unknown"; reason: string };

/**
 * Wrangler 4.x (`secret list`, API codes 10007/10090): `Worker "<name>" (env: <env>) not
 * found.` followed by "If this is a new Worker, run `wrangler deploy` first". A test pins this
 * text against the installed Wrangler, so an upgrade that changes it fails there, not here.
 */
const WORKER_NOT_FOUND = /Worker "([^"]+)"(?: \(env: [^)]+\))? not found\./;

/**
 * Reads `wrangler secret list --format json`. Only two answers allow creating a secret: a
 * listing that parses, or Wrangler's specific "Worker not found" for this Worker (a first
 * deploy). Anything else (a network error, an API outage, an expired login) is `unknown`, and
 * nothing may be created: guessing "absent" could replace a key that exists.
 */
export function readSecretListing(listing: CommandOutput, worker: string): SecretListing {
  const output = `${listing.stdout}\n${listing.stderr}`;
  if (listing.code === 0) {
    const start = listing.stdout.search(/\[/);
    try {
      if (start === -1) throw new Error("no JSON array");
      const parsed = JSON.parse(listing.stdout.slice(start)) as unknown;
      if (!Array.isArray(parsed)) throw new Error("not an array");
      return {
        kind: "listed",
        names: parsed.map((entry) => String((entry as { name?: unknown }).name)),
      };
    } catch (error) {
      return {
        kind: "unknown",
        reason: `could not read \`wrangler secret list\` (${(error as Error).message}): ${listing.stdout.slice(0, 200)}`,
      };
    }
  }
  const missing = WORKER_NOT_FOUND.exec(output);
  if (missing && missing[1] === worker) return { kind: "new-worker" };
  return {
    kind: "unknown",
    reason: `\`wrangler secret list\` failed (exit ${listing.code}): ${output.trim().slice(0, 400)}`,
  };
}
