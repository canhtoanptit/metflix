import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.ts";
import { redact } from "./secrets.ts";
import { ensurePrivateDir, writePrivateFile } from "./secure-fs.ts";
import { requireState, type SandboxState, writeState } from "./state.ts";
import {
  assertGlobalLocationsUnchanged,
  isolatedEnv,
  type LocationState,
  profileArgs,
  resolveCliBinary,
  runCli,
  snapshotGlobalLocations,
} from "./stripe-cli.ts";

/** What `.cache/stripe/listen/<name>.json` records about a running sidecar. */
export interface ListenerRecord {
  name: string;
  pid: number;
  forwardTo: string;
  /** Empty means `--all-snapshot`. */
  events: string[];
  latest: boolean;
  startedAt: string;
  logFile: string;
  binary: string;
  /** Global Stripe locations when the sidecar started, checked again when it stops. */
  globalLocations: LocationState[];
  /** The API version the CLI said forwarded events are rendered in, from its Ready line. */
  eventApiVersion: string | null;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** An imported key is not in the CLI profile, so the CLI gets it through STRIPE_API_KEY. */
export function importedKey(state: SandboxState): { apiKey?: string } {
  return state.source === "imported" ? { apiKey: state.secretKey } : {};
}

export function recordPath(name: string): string {
  return join(paths.listenDir, `${name}.json`);
}

export function logPath(name: string): string {
  return join(paths.listenDir, `${name}.log`);
}

export function readRecord(name: string): ListenerRecord | null {
  const file = recordPath(name);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as ListenerRecord;
}

export function listRecords(): ListenerRecord[] {
  if (!existsSync(paths.listenDir)) return [];
  return readdirSync(paths.listenDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(paths.listenDir, file), "utf8")) as ListenerRecord);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * True only when the PID is alive AND its command line is this repository's CLI binary running
 * `listen`. A PID file can outlive its process and the PID can be reused by something else, so a
 * bare "is the PID alive" check is not enough to justify a kill.
 */
export function isOurListener(record: ListenerRecord): boolean {
  if (!isAlive(record.pid)) return false;
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(record.pid)], { encoding: "utf8" });
  const command = ps.stdout.trim();
  return command.startsWith(record.binary) && / listen( |$)/.test(command);
}

/** Parse the signing secret out of `stripe listen --print-secret`. */
export function parseSigningSecret(stdout: string): string | null {
  return /\b(whsec_[0-9A-Za-z]+)\b/.exec(stdout)?.[1] ?? null;
}

/** Parse "Ready! You are using Stripe API Version [2026-11-18.endive]. …" from the log. */
export function parseReadyLine(log: string): { ready: boolean; apiVersion: string | null } {
  const ready = /Ready!/.test(log);
  const version = /API Version \[([^\]]+)\]/.exec(log)?.[1] ?? null;
  return { ready, apiVersion: version };
}

/**
 * Ask the CLI for the session's signing secret and store it in the protected state files.
 * Returns whether it differed from the one already stored (never the value).
 */
export async function captureWebhookSecret(): Promise<{ changed: boolean; secret: string }> {
  const state = requireState();
  const result = await runCli(["listen", "--print-secret"], {
    timeoutMs: 60_000,
    ...importedKey(state),
  });
  const secret = parseSigningSecret(result.stdout);
  if (!secret) {
    throw new Error(
      `stripe listen --print-secret failed (exit ${result.code}): ${redact(result.stderr).trim()}`,
    );
  }
  const changed = state.webhookSecret !== null && state.webhookSecret !== secret;
  writeState({
    ...state,
    webhookSecret: secret,
    webhookSecretCapturedAt: new Date().toISOString(),
  });
  return { changed, secret };
}

export interface StartOptions {
  name: string;
  forwardTo: string;
  events: string[];
  latest: boolean;
  log: (line: string) => void;
  readyTimeoutMs?: number;
}

export async function startListener(options: StartOptions): Promise<ListenerRecord> {
  const { name, forwardTo, log } = options;
  if (!NAME.test(name))
    throw new Error(`Invalid listener name "${name}" (lowercase letters, digits, dashes).`);
  if (!/^https?:\/\/[^\s]+$/.test(forwardTo))
    throw new Error(`Invalid --forward-to URL: ${forwardTo}`);

  const existing = readRecord(name);
  if (existing) {
    if (isOurListener(existing)) {
      if (existing.forwardTo === options.forwardTo) {
        log(
          `stripe listen "${name}" is already running (pid ${existing.pid}) → ${existing.forwardTo}`,
        );
        return existing;
      }
      throw new Error(
        `stripe listen "${name}" is running (pid ${existing.pid}) to ${existing.forwardTo}; ` +
          `stop it first: make stripe-listen-stop NAME=${name}`,
      );
    }
    log(`Removing a stale record for "${name}" (pid ${existing.pid} is not our listener).`);
    rmSync(recordPath(name));
  }

  const { changed } = await captureWebhookSecret();
  log(
    `Webhook signing secret captured to ${paths.stateFile} and ${paths.envFile}` +
      (changed ? " (it CHANGED since the last capture: restart your app with the new value)" : ""),
  );

  ensurePrivateDir(paths.listenDir);
  const logFile = logPath(name);
  const fd = openSync(logFile, "a", 0o600);
  chmodSync(logFile, 0o600);
  const offset = statSync(logFile).size;
  const binary = resolveCliBinary();
  const eventArgs =
    options.events.length > 0 ? ["--events", options.events.join(",")] : ["--all-snapshot"];
  const args = [
    "listen",
    "--forward-to",
    forwardTo,
    ...eventArgs,
    ...(options.latest ? ["--latest"] : []),
  ];
  const globalLocations = snapshotGlobalLocations();
  const { apiKey } = importedKey(requireState());
  // Detached with its own process group, output to a 0600 log (it prints the signing secret),
  // and no key on the command line: the CLI reads it from the repository-local profile, or an
  // imported key from STRIPE_API_KEY in its environment.
  const child = spawn(binary, [...args, ...profileArgs()], {
    env: isolatedEnv(apiKey ? { STRIPE_API_KEY: apiKey } : {}),
    detached: true,
    stdio: ["ignore", fd, fd],
    cwd: paths.cache,
  });
  closeSync(fd);
  const pid = child.pid;
  if (pid === undefined) throw new Error("Could not start stripe listen.");
  child.unref();

  const record: ListenerRecord = {
    name,
    pid,
    forwardTo,
    events: options.events,
    latest: options.latest,
    startedAt: new Date().toISOString(),
    logFile,
    binary,
    globalLocations,
    eventApiVersion: null,
  };
  writePrivateFile(recordPath(name), `${JSON.stringify(record, null, 2)}\n`);

  const deadline = Date.now() + (options.readyTimeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    const text = readFileSync(logFile, "utf8").slice(offset);
    const { ready, apiVersion } = parseReadyLine(text);
    if (ready) {
      const readyRecord = { ...record, eventApiVersion: apiVersion };
      writePrivateFile(recordPath(name), `${JSON.stringify(readyRecord, null, 2)}\n`);
      log(
        `stripe listen "${name}" ready (pid ${pid}) → ${forwardTo}; ` +
          `events rendered in API version ${apiVersion ?? "unknown"}; log ${logFile}`,
      );
      return readyRecord;
    }
    if (!isAlive(pid)) {
      rmSync(recordPath(name));
      throw new Error(`stripe listen exited before it was ready:\n${redact(text).trim()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await stopListener(name, () => {});
  throw new Error(
    `stripe listen was not ready within ${(options.readyTimeoutMs ?? 60_000) / 1000} s.`,
  );
}

export async function stopListener(name: string, log: (line: string) => void): Promise<boolean> {
  const record = readRecord(name);
  if (!record) {
    log(`stripe listen "${name}" is not running.`);
    return false;
  }
  if (!isOurListener(record)) {
    log(
      `stripe listen "${name}": pid ${record.pid} is not our listener any more; removing the stale record.`,
    );
    rmSync(recordPath(name));
    return false;
  }
  process.kill(record.pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (isAlive(record.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isAlive(record.pid)) process.kill(record.pid, "SIGKILL");
  rmSync(recordPath(name));
  assertGlobalLocationsUnchanged(record.globalLocations);
  log(`stripe listen "${name}" stopped (pid ${record.pid}).`);
  return true;
}

/** The last lines of a listener's log, redacted. */
export function tailLog(name: string, lines = 40): string {
  const file = logPath(name);
  if (!existsSync(file)) return `(no log for "${name}")`;
  return redact(readFileSync(file, "utf8")).trimEnd().split("\n").slice(-lines).join("\n");
}
