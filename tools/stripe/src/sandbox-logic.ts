/**
 * Pure logic behind `make stripe-sandbox`: parsing what `stripe sandboxes create` printed and
 * deciding whether the configured sandbox can be reused. No I/O here, so every branch is unit
 * tested (`test/sandbox-logic.test.ts`).
 */

export type CreateOutcome =
  | {
      kind: "created";
      secretKey: string;
      publishableKey: string;
      claimUrl: string | null;
      accountId: string;
      expiresOn: string | null;
    }
  | {
      /** The CLI profile already held an unexpired sandbox; the CLI printed its keys. */
      kind: "existing";
      secretKey: string;
      publishableKey: string | null;
      accountId: string | null;
      expiresOn: string | null;
      claimed: boolean;
    }
  /** The CLI found an expired sandbox in its profile and cleared it; run create again. */
  | { kind: "expired" }
  /** Anonymous provisioning failed and the CLI offered a browser login instead. */
  | { kind: "login-fallback" }
  /** The profile holds a real (logged-in) key; the CLI only points at the Dashboard. */
  | { kind: "authenticated" }
  | { kind: "unrecognised" };

const DATE = /(\d{4}-\d{2}-\d{2})/;

/** Extract the first top-level JSON object printed in `text`, if any. */
export function firstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1));
          return typeof parsed === "object" && parsed !== null
            ? (parsed as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function labelledValue(text: string, label: string): string | null {
  const match = new RegExp(`^\\s*${label}:\\s+(\\S+)\\s*$`, "m").exec(text);
  return match?.[1] ?? null;
}

/** Classify the output of `stripe sandboxes create --email … --non-interactive` (CLI 1.55.x). */
export function parseCreateOutput(stdout: string): CreateOutcome {
  const json = firstJsonObject(stdout);
  if (json) {
    if ("browser_url" in json || "verification_code" in json) return { kind: "login-fallback" };
    const secretKey = stringField(json, "secret_key");
    const publishableKey = stringField(json, "publishable_key");
    const accountId = stringField(json, "account_id");
    if (secretKey && publishableKey && accountId) {
      const expires = stringField(json, "expires_at");
      return {
        kind: "created",
        secretKey,
        publishableKey,
        accountId,
        claimUrl: stringField(json, "claim_url"),
        expiresOn: expires ? (DATE.exec(expires)?.[1] ?? null) : null,
      };
    }
  }
  if (/Could not provision a sandbox automatically/i.test(stdout))
    return { kind: "login-fallback" };
  if (/You already have an active sandbox/i.test(stdout)) {
    const secretKey = labelledValue(stdout, "Secret key");
    if (!secretKey) return { kind: "unrecognised" };
    const expiryLine = /expires\s+(\d{4}-\d{2}-\d{2})/.exec(stdout);
    return {
      kind: "existing",
      secretKey,
      publishableKey: labelledValue(stdout, "Publishable key"),
      accountId: labelledValue(stdout, "Account ID"),
      expiresOn: expiryLine?.[1] ?? null,
      claimed: /already been claimed/i.test(stdout),
    };
  }
  if (/sandbox session has expired/i.test(stdout)) return { kind: "expired" };
  if (/already authenticated/i.test(stdout)) return { kind: "authenticated" };
  return { kind: "unrecognised" };
}

/**
 * The instant the CLI starts treating a sandbox as expired: it parses the date-only
 * `sandbox_expires_at` as 00:00 UTC and compares `now > expiry` (pkg/cmd/sandbox.go,
 * isExpiredSandbox). Stripe may keep it alive longer; we use the CLI's conservative reading.
 */
export function expiryInstant(expiresOn: string): Date {
  return new Date(`${expiresOn}T00:00:00Z`);
}

export interface Probe {
  /** valid: the key authenticates; invalid: 401 (expired or deleted); unreachable: network. */
  credentials: "valid" | "invalid" | "unreachable";
  claimed: boolean | null;
}

export type Decision =
  | { action: "reuse"; reason: string }
  | { action: "create"; reason: string }
  | { action: "fail"; reason: string };

export interface DecisionInput {
  hasState: boolean;
  expiresOn: string | null;
  probe: Probe | null;
  now: Date;
  minRemainingHours: number;
}

export function decide(input: DecisionInput): Decision {
  if (!input.hasState || !input.probe)
    return { action: "create", reason: "no sandbox is configured" };
  if (input.probe.credentials === "unreachable") {
    // Never replace a sandbox because the network is down: that would strand a working one.
    return {
      action: "fail",
      reason: "Stripe's API is unreachable, so the sandbox cannot be checked",
    };
  }
  if (input.probe.credentials === "invalid") {
    return {
      action: "create",
      reason: "Stripe rejected the stored key (the sandbox expired or was deleted)",
    };
  }
  if (input.expiresOn) {
    const hoursLeft = (expiryInstant(input.expiresOn).getTime() - input.now.getTime()) / 3_600_000;
    if (hoursLeft < input.minRemainingHours) {
      return {
        action: "create",
        reason: `the sandbox expires in ${Math.max(0, Math.floor(hoursLeft))} h, under the ${input.minRemainingHours} h minimum`,
      };
    }
  }
  return { action: "reuse", reason: "the stored key works and the sandbox is not about to expire" };
}

/** "2026-11-29 (in 7 days)" relative to `now`, with the same day arithmetic as the CLI. */
export function describeExpiry(expiresOn: string | null, now: Date): string {
  if (!expiresOn) return "unknown (the CLI reported no expiry date)";
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round((expiryInstant(expiresOn).getTime() - today) / 86_400_000);
  if (days < 0) return `${expiresOn} (expired)`;
  return `${expiresOn} (in ${days} day${days === 1 ? "" : "s"})`;
}
