/**
 * What a Stripe credential looks like, shared by three consumers: the redactor that filters
 * every line of CLI output before it reaches a terminal, the fixture scrubber, and the
 * repository-wide secret scan (`test/secret-scan.test.ts`).
 *
 * The patterns are deliberately broad. A false positive costs a redacted word; a false negative
 * leaks a credential. Minimum lengths keep documentation placeholders such as `sk_test_...` or
 * `whsec_xxx` from matching.
 */
export interface SecretPattern {
  readonly kind: string;
  readonly pattern: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  // API keys of every flavour: sk_, rk_, pk_, the sandbox `rkcs_` keys, ephemeral `ek_`, and any
  // future `<prefix>_test_` / `<prefix>_live_` credential.
  { kind: "api_key", pattern: /\b[a-z]{2,6}_(?:test|live)_[0-9A-Za-z]{16,}\b/g },
  // Stripe's own masked form in permission errors ("The provided key '<prefix>, a run of
  // asterisks, <last four>' does not have …"): not the key, but it leaks its first and last
  // characters.
  { kind: "masked_key", pattern: /\b[a-z]{2,6}_(?:test|live)_[0-9A-Za-z]*\*{4,}[0-9A-Za-z]*/g },
  // Webhook endpoint and `stripe listen` signing secrets.
  { kind: "webhook_secret", pattern: /\bwhsec_[0-9A-Za-z]{16,}\b/g },
  // Client secrets handed to the browser: pi_…_secret_…, seti_…_secret_…, cs_…_secret_….
  { kind: "client_secret", pattern: /\b[a-z]{2,6}_[0-9A-Za-z_]{8,}_secret_[0-9A-Za-z]{8,}\b/g },
  // CLI OAuth access tokens and refresh tokens.
  { kind: "oauth_token", pattern: /\b(?:oak|ort|uat)_[0-9A-Za-z]{16,}\b/g },
];

/**
 * Capability URLs: whoever opens the sandbox claim link can take ownership of the sandbox, so it
 * is treated like a secret (only the owner should see it, through `make stripe-claim`). Observed
 * shape (CLI 1.55.14): `https://dashboard.stripe.com/onboard_sandbox/<55-character token>`; the
 * word "claim" does not appear in it.
 */
export const SENSITIVE_URL_PATTERN = /https?:\/\/[^\s"'<>]*(?:claim|onboard)[^\s"'<>]*/gi;

export interface SecretFinding {
  kind: string;
  /** 1-based line number. */
  line: number;
  /** The first characters of the match only, never the whole value. */
  preview: string;
}

/** A claim link with its token, strict enough for a repository-wide scan. */
const CLAIM_URL_WITH_TOKEN: SecretPattern = {
  kind: "claim_url",
  pattern: /https?:\/\/[^\s"'<>]*\/(?:onboard_[a-z]+|claim[a-z_]*)\/[A-Za-z0-9_-]{20,}/g,
};

/** Locate secrets in a text without returning them (the preview keeps the prefix only). */
export function findSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const { kind, pattern } of [...SECRET_PATTERNS, CLAIM_URL_WITH_TOKEN]) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const index = match.index ?? 0;
      const line = text.slice(0, index).split("\n").length;
      findings.push({ kind, line, preview: `${match[0].slice(0, 8)}…` });
    }
  }
  return findings;
}

/** Replace every secret-looking token and claim URL with a labelled placeholder. */
export function redact(text: string): string {
  let out = text;
  for (const { kind, pattern } of SECRET_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, pattern.flags), `[redacted ${kind}]`);
  }
  return out.replace(
    new RegExp(SENSITIVE_URL_PATTERN.source, SENSITIVE_URL_PATTERN.flags),
    "[redacted claim url]",
  );
}

/** Describe a key without revealing it: its kind from the prefix, never its body. */
export function describeKey(key: string): string {
  const prefix = /^([a-z]+)_(test|live)_/.exec(key);
  if (!prefix) return "unrecognised key format";
  const [, type, mode] = prefix;
  const kinds: Record<string, string> = {
    sk: "secret key",
    rk: "restricted key",
    rkcs: "restricted sandbox key",
    pk: "publishable key",
  };
  return `${kinds[type ?? ""] ?? `${type} key`} (${mode} mode)`;
}
