import { existsSync, rmSync } from "node:fs";
import { probeSandbox } from "./api.ts";
import { paths } from "./paths.ts";
import { type CreateOutcome, decide, describeExpiry, parseCreateOutput } from "./sandbox-logic.ts";
import { describeKey, redact } from "./secrets.ts";
import { appendHistory, readState, type SandboxState, writeState } from "./state.ts";
import { cliVersion, pinnedCliVersion, runCli } from "./stripe-cli.ts";

/**
 * Sent to Stripe only to prefill the registration form if someone later claims the sandbox
 * (`--email` help text). A reserved example.com address by default, so no real person is
 * enrolled or emailed; set STRIPE_SANDBOX_EMAIL to your own address if you intend to claim.
 */
export const DEFAULT_SANDBOX_EMAIL = "webflix-sandbox@example.com";

export interface SandboxOptions {
  email: string;
  /** Replace the sandbox when fewer hours than this remain before it expires. */
  minRemainingHours: number;
  log: (line: string) => void;
}

export async function ensureSandbox(options: SandboxOptions): Promise<SandboxState> {
  const { log } = options;
  const version = await cliVersion();
  const pinned = pinnedCliVersion();
  if (version !== pinned) {
    throw new Error(
      `Stripe CLI reports ${version} but tools/stripe pins ${pinned}; run pnpm install.`,
    );
  }

  const state = readState();
  const probe = state ? await probeSandbox(state.secretKey) : null;
  const now = new Date();
  const decision = decide({
    hasState: state !== null,
    expiresOn: state?.expiresOn ?? null,
    probe,
    now,
    minRemainingHours: options.minRemainingHours,
  });

  if (decision.action === "fail") throw new Error(`Cannot decide: ${decision.reason}.`);
  if (decision.action === "reuse" && state) {
    log(`Stripe sandbox: reusing ${state.accountId} (${decision.reason}).`);
    printSummary(state, probe?.claimed ?? null, log);
    return state;
  }

  log(`Stripe sandbox: creating a new one (${decision.reason}).`);
  if (state) {
    // The old sandbox stays on Stripe's side until it expires; record that we let it go.
    appendHistory({ event: "forgotten", accountId: state.accountId, expiresOn: state.expiresOn });
    forgetCliProfile();
  }

  const created = await provision(options.email, version, log);
  appendHistory({ event: "created", accountId: created.accountId, expiresOn: created.expiresOn });
  printSummary(created, false, log);
  return created;
}

async function provision(
  email: string,
  version: string,
  log: (line: string) => void,
): Promise<SandboxState> {
  // Two attempts: the first may find a sandbox left in the CLI profile (adopted if it works) or
  // an expired one (which the CLI clears, so the second attempt provisions).
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await runCli(["sandboxes", "create", "--email", email, "--non-interactive"], {
      timeoutMs: 300_000,
    });
    const outcome = parseCreateOutput(result.stdout);
    const adopted = await adopt(outcome, version, log);
    if (adopted) return adopted;
    if (outcome.kind === "expired") {
      log("  The CLI profile held an expired sandbox; it cleared it. Provisioning again.");
      continue;
    }
    throw new Error(explainFailure(outcome, result.code, result.stderr));
  }
  throw new Error("The Stripe CLI did not provision a sandbox after clearing an expired one.");
}

async function adopt(
  outcome: CreateOutcome,
  version: string,
  log: (line: string) => void,
): Promise<SandboxState | null> {
  if (outcome.kind === "created") {
    const state: SandboxState = {
      schema: 1,
      accountId: outcome.accountId,
      secretKey: outcome.secretKey,
      publishableKey: outcome.publishableKey,
      claimUrl: outcome.claimUrl,
      expiresOn: outcome.expiresOn,
      createdAt: new Date().toISOString(),
      cliVersion: version,
      webhookSecret: null,
      webhookSecretCapturedAt: null,
    };
    writeState(state);
    log(
      `  Provisioned ${state.accountId} with Stripe's anonymous sandbox flow (no login, no browser).`,
    );
    return state;
  }
  if (outcome.kind === "existing" && outcome.accountId && outcome.publishableKey) {
    const probe = await probeSandbox(outcome.secretKey);
    if (probe.credentials !== "valid") return null;
    log(`  The CLI profile already held sandbox ${outcome.accountId}; adopting it.`);
    const state: SandboxState = {
      schema: 1,
      accountId: outcome.accountId,
      secretKey: outcome.secretKey,
      publishableKey: outcome.publishableKey,
      claimUrl: null,
      expiresOn: outcome.expiresOn,
      createdAt: new Date().toISOString(),
      cliVersion: version,
      webhookSecret: null,
      webhookSecretCapturedAt: null,
    };
    writeState(state);
    return state;
  }
  return null;
}

function explainFailure(outcome: CreateOutcome, code: number | null, stderr: string): string {
  const detail = redact(stderr).trim().split("\n").slice(-5).join("\n    ");
  switch (outcome.kind) {
    case "login-fallback":
      return (
        "Stripe's anonymous sandbox provisioning failed and the CLI offered a browser login instead. " +
        "This tooling does not log in to any Stripe account. Retry later, or claim/log in yourself.\n    " +
        detail
      );
    case "authenticated":
      return "The repository CLI profile holds a logged-in key, so the CLI will not create an anonymous sandbox. Run make stripe-reset.";
    default:
      return `The Stripe CLI exited with ${code} and output this tool does not recognise.\n    ${detail}`;
  }
}

/** Remove the CLI's repository-local profile (it holds the previous sandbox's keys). */
export function forgetCliProfile(): boolean {
  if (!existsSync(paths.cliConfigFile)) return false;
  rmSync(paths.cliConfigFile);
  return true;
}

function printSummary(
  state: SandboxState,
  claimed: boolean | null,
  log: (line: string) => void,
): void {
  const now = new Date();
  log(`  Account:     ${state.accountId}`);
  log(`  Key:         ${describeKey(state.secretKey)} (value not shown)`);
  log(
    `  Expires:     ${describeExpiry(state.expiresOn, now)}; the CLI treats it as expired from 00:00 UTC that day`,
  );
  log(`  Claimed:     ${claimed === null ? "unknown" : claimed ? "yes" : "no"}`);
  log(`  Credentials: ${paths.stateFile} and ${paths.envFile} (owner-only, git-ignored)`);
  log(`  CLI profile: ${paths.cliConfigFile} (project "webflix"; nothing in ~/.config/stripe)`);
  if (claimed !== true) {
    log(
      "  Claiming:    an unclaimed sandbox and its data disappear when it expires. Claiming needs a",
    );
    log(
      "               Stripe account and is the owner's decision: `make stripe-claim` opens Stripe's",
    );
    log(
      "               claim page for this sandbox. Nothing in this repository claims it automatically.",
    );
  }
}
