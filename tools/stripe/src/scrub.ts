import { SECRET_PATTERNS, SENSITIVE_URL_PATTERN } from "./secrets.ts";

/**
 * Deterministic scrubber for recorded Stripe traffic. One `Scrubber` instance is used for a
 * whole corpus so that an id rewritten in one file is rewritten identically everywhere:
 * `cus_RkQ8tZ3cVhJ2aB` → `cus_WFX0000000001` in the API response, the webhook payload and the
 * scenario notes alike. Same input, same output: numbering follows first appearance in
 * traversal order. Scrubbing already-scrubbed data changes nothing.
 *
 * What it removes or rewrites:
 * - credentials (every `SECRET_PATTERNS` shape, Stripe's masked keys, claim URLs): replaced
 *   with `[redacted <kind>]`, except client secrets, which keep their rewritten intent id;
 * - object ids (`<prefix>_<base62>`): rewritten consistently, prefix kept;
 * - email addresses: `member-<n>@example.test`;
 * - card fingerprints: rewritten consistently (equality between two cards is preserved);
 * - client IP addresses and user agents (mandates, customer acceptance): `[redacted]`;
 * - URLs on Stripe-hosted pages (hosted invoices, receipts, PDFs, 3-D Secure): host kept, the
 *   capability token in the path and query dropped.
 */

/** Marks ids this scrubber produced, so a second pass leaves them alone. */
const MARK = "WFX";

/**
 * `<prefix>_<body>` with a body of 10+ base62 characters containing at least one digit or
 * uppercase letter. The second condition keeps API enum values such as `create_prorations` or
 * `charge_automatically` (all lowercase) from being mistaken for ids.
 */
// Prefixes may have up to three words: `sub_sched_…`, `il_tmp_…` (preview lines),
// `upcoming_in_…` (preview invoices).
const ID = /\b([a-z]{2,12}(?:_[a-z]{2,12}){0,2})_([A-Za-z0-9]{10,})\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const STRIPE_HOSTED_URL =
  /https:\/\/((?:invoice|pay|hooks|files|dashboard|checkout|billing|connect|verify)\.stripe\.com)(\/[^\s"'<>]*)?/g;
const CLIENT_SECRET = /\b([a-z]{2,6}_[0-9A-Za-z]+)_secret_[0-9A-Za-z]+\b/g;

const FIELDS_REDACTED = new Set(["ip_address", "ip", "user_agent"]);
const FIELDS_FINGERPRINT = new Set(["fingerprint"]);

function base62(n: number, width: number): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let out = "";
  let value = n;
  do {
    out = alphabet[value % 62] + out;
    value = Math.floor(value / 62);
  } while (value > 0);
  return out.padStart(width, "0");
}

export class Scrubber {
  private readonly ids = new Map<string, string>();
  private readonly counters = new Map<string, number>();
  private readonly emails = new Map<string, string>();
  private readonly fingerprints = new Map<string, string>();

  /** Rewrite one id, keeping its prefix and a realistic body length. */
  rewriteId(prefix: string, body: string): string {
    if (body.startsWith(MARK)) return `${prefix}_${body}`;
    const original = `${prefix}_${body}`;
    const known = this.ids.get(original);
    if (known) return known;
    const next = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, next);
    const rewritten = `${prefix}_${MARK}${base62(next, Math.max(10, Math.min(body.length, 24)) - MARK.length)}`;
    this.ids.set(original, rewritten);
    return rewritten;
  }

  private rewriteEmail(email: string): string {
    if (email.endsWith("@example.test") && email.startsWith("member-")) return email;
    const known = this.emails.get(email.toLowerCase());
    if (known) return known;
    const rewritten = `member-${this.emails.size + 1}@example.test`;
    this.emails.set(email.toLowerCase(), rewritten);
    return rewritten;
  }

  private rewriteFingerprint(value: string): string {
    if (value.startsWith(MARK)) return value;
    const known = this.fingerprints.get(value);
    if (known) return known;
    const rewritten = `${MARK}${base62(this.fingerprints.size + 1, Math.max(13, value.length - MARK.length))}`;
    this.fingerprints.set(value, rewritten);
    return rewritten;
  }

  scrubString(input: string): string {
    let out = input;
    // Client secrets first, so the intent id survives (rewritten) and only the secret goes.
    out = out.replace(CLIENT_SECRET, (_match, id: string) => {
      const [, prefix = "", body = ""] = /^([a-z]{2,6})_(.*)$/.exec(id) ?? [];
      return `${this.rewriteId(prefix, body)}_secret_[redacted]`;
    });
    // Then every credential shape, the client-secret pattern included as a safety net for
    // shapes the rewrite above does not recognise (already-scrubbed ones no longer match).
    for (const { kind, pattern } of SECRET_PATTERNS) {
      out = out.replace(new RegExp(pattern.source, pattern.flags), `[redacted ${kind}]`);
    }
    out = out.replace(
      new RegExp(SENSITIVE_URL_PATTERN.source, SENSITIVE_URL_PATTERN.flags),
      "[redacted claim url]",
    );
    out = out.replace(STRIPE_HOSTED_URL, (_match, host: string, path?: string) =>
      path && path !== "/" ? `https://${host}/[redacted]` : `https://${host}/`,
    );
    out = out.replace(EMAIL, (email) => this.rewriteEmail(email));
    out = out.replace(ID, (match, prefix: string, body: string) =>
      /[0-9A-Z]/.test(body) ? this.rewriteId(prefix, body) : match,
    );
    return out;
  }

  scrub(value: unknown, key?: string): unknown {
    if (typeof value === "string") {
      if (key && FIELDS_REDACTED.has(key)) return "[redacted]";
      if (key && FIELDS_FINGERPRINT.has(key)) return this.rewriteFingerprint(value);
      return this.scrubString(value);
    }
    if (Array.isArray(value)) return value.map((item) => this.scrub(item));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.scrub(v, k);
      return out;
    }
    return value;
  }

  /** How many distinct values were rewritten, for the fixture index. */
  stats(): { ids: number; emails: number; fingerprints: number } {
    return { ids: this.ids.size, emails: this.emails.size, fingerprints: this.fingerprints.size };
  }
}

/**
 * Prefixes of id-shaped tokens that were not rewritten (the guard run on every fixture file
 * before it is written). Returns prefixes only, never the ids.
 */
export function unscrubbedIds(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(new RegExp(ID.source, ID.flags))) {
    const [, prefix = "", body = ""] = match;
    if (!body.startsWith(MARK) && /[0-9A-Z]/.test(body)) out.push(prefix);
  }
  return out;
}
