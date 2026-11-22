/**
 * The Worker's secrets, as `secrets.required` in wrangler.jsonc lists them (the same names in
 * the local and the production sections; a test keeps them equal).
 *
 * Two kinds:
 * - **Generated** keys the tooling may create because nothing outside Webflix issues them: the
 *   media-token keys and the pseudonym key. Locally they are random per clone (`.dev.vars`); in
 *   production they are created on the first deploy (or taken from the operator's secret
 *   manager) and then never replaced by a deploy: a new media-token key would invalidate every
 *   outstanding token, a new pseudonym key would orphan every subject key in the event lake and
 *   in the recommendation store.
 * - **Provider credentials** (the email provider's API key and webhook secret, Stripe's keys)
 *   are issued by someone else: locally they are empty (= unset: the local Worker uses the D1
 *   outbox and the fake provider), in production they must come from the operator's
 *   environment on the first deploy, and a deploy refuses to start without them.
 *
 * Wrangler loads only the names listed in `secrets.required` from `.dev.vars` (an allowlist),
 * which is why every name is present there, even with an empty value.
 */
import { randomBytes } from "node:crypto";
import { formatKeys, MEDIA_KEYS_SECRET, newKey } from "./media-keys.ts";
import type { SecretListing } from "./secret-listing.ts";

export const PSEUDONYM_KEY_SECRET = "WEBFLIX_PSEUDONYM_KEY";

const random256 = () => randomBytes(32).toString("base64url");

/** Secrets the tooling creates, per target. */
export const GENERATED_SECRETS: Readonly<
  Record<string, { local: () => string; production: () => string }>
> = {
  [MEDIA_KEYS_SECRET]: {
    local: () => `local:${random256()}`,
    production: () => formatKeys([newKey()]),
  },
  [PSEUDONYM_KEY_SECRET]: { local: random256, production: random256 },
};

export function isGenerated(name: string): boolean {
  return Object.hasOwn(GENERATED_SECRETS, name);
}

/** Names assigned in a dotenv-style file (`NAME=value`), comments and blank lines ignored. */
export function assignedNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

/**
 * `.dev.vars` with every required secret assigned: existing lines are kept exactly (a clone's
 * media-token key survives, and so does any credential someone filled in), missing generated
 * keys get a fresh random value, missing provider credentials an empty one. Returns the names
 * it added.
 */
export function completeDevVars(
  existing: string,
  required: readonly string[],
): { text: string; added: string[] } {
  const present = assignedNames(existing);
  const added: string[] = [];
  const lines: string[] = [];
  for (const name of required) {
    if (present.has(name)) continue;
    const generated = GENERATED_SECRETS[name];
    lines.push(`${name}=${generated ? generated.local() : ""}`);
    added.push(name);
  }
  if (added.length === 0) return { text: existing, added };
  const header = existing.trim()
    ? []
    : [
        "# Local secrets of the Cloudflare mode (git-ignored; docs/CLOUDFLARE.md §7). Wrangler loads",
        "# only the names wrangler.jsonc lists in secrets.required. Empty = unset: the local Worker",
        "# then uses the D1 email outbox and the fake payment provider.",
      ];
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  return { text: `${existing}${separator}${[...header, ...lines].join("\n")}\n`, added };
}

/**
 * Throwaway values, valid in form, for every secret either environment requires. Node tooling
 * (seed, the recommendation importer) composes the Worker's configuration to reach the
 * services, and signs, derives or sends nothing with these: production secrets are never
 * available to the tools, and must not need to be.
 */
export function toolingSecrets(): Record<string, string> {
  const throwaway = random256();
  return {
    [MEDIA_KEYS_SECRET]: `ops:${throwaway}`,
    [PSEUDONYM_KEY_SECRET]: `ops-unused-${throwaway}`,
    WEBFLIX_EMAIL_HTTP_API_KEY: `ops-unused-${throwaway}`,
    WEBFLIX_EMAIL_WEBHOOK_SECRET: `ops-unused-${throwaway}`,
    STRIPE_SECRET_KEY: `sk_ops_unused_${throwaway}`,
    STRIPE_PUBLISHABLE_KEY: `pk_ops_unused_${throwaway}`,
    STRIPE_WEBHOOK_SECRET: `whsec_ops_unused_${throwaway}`,
  };
}

/** What a deploy does about each required secret. */
export interface SecretPlan {
  /** Already on the Worker: never touched by a deploy. */
  keep: string[];
  /** Generated keys to set (their value comes from the environment, the key file, or is new). */
  generate: string[];
  /** Provider credentials to set from the environment. */
  fromEnvironment: string[];
  /** Provider credentials that are neither on the Worker nor in the environment. */
  missing: string[];
}

export function planSecrets(
  listing: Exclude<SecretListing, { kind: "unknown" }>,
  required: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): SecretPlan {
  const onWorker = new Set(listing.kind === "listed" ? listing.names : []);
  const plan: SecretPlan = { keep: [], generate: [], fromEnvironment: [], missing: [] };
  for (const name of required) {
    if (onWorker.has(name)) plan.keep.push(name);
    else if (isGenerated(name)) plan.generate.push(name);
    else if (environment[name]) plan.fromEnvironment.push(name);
    else plan.missing.push(name);
  }
  return plan;
}
