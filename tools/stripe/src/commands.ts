import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { probeSandbox } from "./api.ts";
import { isOurListener, listRecords, stopListener } from "./listen.ts";
import { paths } from "./paths.ts";
import { describeExpiry } from "./sandbox-logic.ts";
import { describeKey } from "./secrets.ts";
import { appendHistory, deleteState, readHistory, readState } from "./state.ts";
import {
  cliVersion,
  isolatedEnv,
  keychainHasStripeItems,
  pinnedCliVersion,
  profileArgs,
  resolveCliBinary,
  snapshotGlobalLocations,
} from "./stripe-cli.ts";

type Log = (line: string) => void;

export async function status(log: Log): Promise<void> {
  const version = await cliVersion();
  const pinned = pinnedCliVersion();
  log(
    `Stripe CLI:    ${version}${version === pinned ? " (matches the pinned version)" : ` (pinned ${pinned}: run pnpm install)`}`,
  );
  log(
    `CLI profile:   ${paths.cliConfigFile} (${existsSync(paths.cliConfigFile) ? "present" : "absent"}), project "webflix"`,
  );

  const state = readState();
  if (!state) {
    log("Sandbox:       none configured (make stripe-sandbox)");
  } else {
    const probe = await probeSandbox(state.secretKey);
    log(`Sandbox:       ${state.accountId}, created ${state.createdAt} by CLI ${state.cliVersion}`);
    log(`Key:           ${describeKey(state.secretKey)}; Stripe says: ${probe.credentials}`);
    log(`Expires:       ${describeExpiry(state.expiresOn, new Date())}`);
    log(`Claimed:       ${probe.claimed === null ? "unknown" : probe.claimed ? "yes" : "no"}`);
    log(
      `Webhook secret: ${state.webhookSecret ? `captured ${state.webhookSecretCapturedAt}` : "not captured (make stripe-listen)"}`,
    );
  }

  const records = listRecords();
  if (records.length === 0) log("Listeners:     none");
  for (const record of records) {
    const running = isOurListener(record);
    log(
      `Listener:      "${record.name}" pid ${record.pid} ${running ? "running" : "NOT running (stale record)"} → ` +
        `${record.forwardTo}, events ${record.events.length ? record.events.join(",") : "all snapshot"}, ` +
        `API version ${record.eventApiVersion ?? "unknown"}, since ${record.startedAt}`,
    );
  }

  const history = readHistory();
  const created = history.filter((entry) => entry.event === "created");
  log(`History:       ${created.length} sandbox(es) created from this checkout`);
  for (const entry of created)
    log(`               ${entry.accountId} created ${entry.at}, expires ${entry.expiresOn ?? "?"}`);

  for (const location of snapshotGlobalLocations()) {
    log(
      `Global:        ${location.path} ${location.exists ? "EXISTS (not created by this tooling; never read)" : "absent"}`,
    );
  }
  const keychain = keychainHasStripeItems();
  if (keychain !== null) {
    log(
      `Keychain:      ${keychain ? "has StripeCLI items (not ours; never read)" : "no StripeCLI items"}`,
    );
  }
}

export async function reset(log: Log): Promise<void> {
  for (const record of listRecords()) await stopListener(record.name, log);
  const state = readState();
  const removed = deleteState();
  for (const dir of [paths.cliXdgConfigHome, paths.cliHome, paths.runsDir, paths.listenDir]) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    }
  }
  for (const item of removed) log(`Removed ${item}`);
  if (!state) {
    log("No sandbox was configured.");
    return;
  }
  appendHistory({ event: "forgotten", accountId: state.accountId, expiresOn: state.expiresOn });
  log("");
  log(`Forgot sandbox ${state.accountId} locally. On Stripe's side nothing was deleted:`);
  log(`  the sandbox and everything created in it (products, prices, customers, subscriptions,`);
  log(
    `  test clocks, events) remain until it expires (${describeExpiry(state.expiresOn, new Date())}),`,
  );
  log("  unless someone claims it first. Deleting it earlier needs a logged-in Stripe account");
  log(
    "  (`stripe sandboxes delete`), which this tooling never uses. The next `make stripe-sandbox`",
  );
  log("  provisions a new sandbox.");
}

/**
 * `make stripe-claim`: for the owner only. Runs `stripe sandboxes claim` interactively with the
 * repository profile, which opens Stripe's claim page. The claim URL is a capability, so it is
 * shown here only because the owner asked for it.
 */
export function claim(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveCliBinary(), ["sandboxes", "claim", ...profileArgs()], {
      env: isolatedEnv(),
      stdio: "inherit",
      cwd: paths.cache,
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
