import { readFileSync } from "node:fs";
import { describeKey } from "./secrets.ts";
import { appendHistory, readState, type SandboxState, writeState } from "./state.ts";
import { pinnedCliVersion } from "./stripe-cli.ts";

/**
 * `make stripe-use-key`: use test keys the owner supplies instead of the anonymous sandbox's
 * (for example a claimed sandbox's full test key, which may create test clocks; the claimable
 * sandbox key may not). Keys are read from a file or a hidden prompt, never from the command
 * line, and only test-mode keys are accepted.
 */

export interface ImportedKeys {
  secretKey: string;
  publishableKey: string;
}

/** Parse `KEY=value` lines (the format of .cache/stripe/stripe.env). */
export function parseKeyFile(text: string): Partial<ImportedKeys> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z_]+)\s*=\s*['"]?([^'"\s]*)['"]?\s*$/.exec(line);
    if (match?.[1] && match[2] !== undefined) values.set(match[1], match[2]);
  }
  const out: Partial<ImportedKeys> = {};
  const secret = values.get("STRIPE_SECRET_KEY");
  const publishable = values.get("STRIPE_PUBLISHABLE_KEY");
  if (secret) out.secretKey = secret;
  if (publishable) out.publishableKey = publishable;
  return out;
}

/** Test-mode only, and the right kind in each slot. Returns problems, never the values. */
export function validateKeys(keys: Partial<ImportedKeys>): string[] {
  const problems: string[] = [];
  if (!keys.secretKey) problems.push("STRIPE_SECRET_KEY is missing");
  else if (!/^(sk|rk|rkcs)_test_[0-9A-Za-z]{16,}$/.test(keys.secretKey)) {
    problems.push(
      /_live_/.test(keys.secretKey)
        ? "STRIPE_SECRET_KEY is a live-mode key; only test-mode keys are accepted"
        : "STRIPE_SECRET_KEY is not a test-mode secret or restricted key",
    );
  }
  if (!keys.publishableKey) problems.push("STRIPE_PUBLISHABLE_KEY is missing");
  else if (!/^pk_test_[0-9A-Za-z]{16,}$/.test(keys.publishableKey)) {
    problems.push("STRIPE_PUBLISHABLE_KEY is not a test-mode publishable key");
  }
  return problems;
}

async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "No terminal to read the key from: pass FROM=<file> with STRIPE_SECRET_KEY= and STRIPE_PUBLISHABLE_KEY= lines.",
    );
  }
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const done = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          done();
          resolve(value.trim());
          return;
        }
        if (ch === "\u0003") {
          done();
          reject(new Error("Cancelled."));
          return;
        }
        value = ch === "\u007f" || ch === "\b" ? value.slice(0, -1) : value + ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function stripeGet(
  path: string,
  key: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`https://api.stripe.com${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

export async function importKeys(
  from: string | undefined,
  log: (line: string) => void,
): Promise<SandboxState> {
  const keys: Partial<ImportedKeys> = from
    ? parseKeyFile(readFileSync(from, "utf8"))
    : {
        secretKey: await promptHidden("Test-mode secret key (input hidden): "),
        publishableKey: await promptHidden("Test-mode publishable key (input hidden): "),
      };
  const problems = validateKeys(keys);
  if (problems.length > 0) throw new Error(problems.join("; "));
  const { secretKey, publishableKey } = keys as ImportedKeys;

  const account = await stripeGet("/v1/account", secretKey);
  if (account.status !== 200 || typeof account.body.id !== "string") {
    throw new Error(`Stripe did not accept the key (HTTP ${account.status}).`);
  }
  const previous = readState();
  const state: SandboxState = {
    schema: 1,
    source: "imported",
    accountId: account.body.id,
    secretKey,
    publishableKey,
    claimUrl: null,
    expiresOn: previous?.accountId === account.body.id ? previous.expiresOn : null,
    createdAt: new Date().toISOString(),
    cliVersion: pinnedCliVersion(),
    webhookSecret: null,
    webhookSecretCapturedAt: null,
  };
  writeState(state);
  appendHistory({ event: "imported", accountId: state.accountId, expiresOn: state.expiresOn });
  log(`Using ${describeKey(secretKey)} for ${state.accountId} (values not shown).`);
  log("make stripe-listen and make stripe-proof now use it; make stripe-reset forgets it.");
  return state;
}
