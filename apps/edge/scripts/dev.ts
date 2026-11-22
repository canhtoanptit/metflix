#!/usr/bin/env node
/**
 * The local dev server, as a process this repository can identify later.
 *
 *   node scripts/dev.ts start --port 8787 --inspector-port 4609 --state <dir> --assets <dir> [-- <wrangler dev flags>]
 *   node scripts/dev.ts stop  --port 8787 --state <dir>
 *
 * `start` runs `wrangler dev` in the foreground (interactive, Ctrl-C stops it) and records
 * `{pid, port, cwd}` of this runner in `<state>/dev-server.json`. `stop` only signals a process
 * it can prove is this repository's dev server: the recorded runner when it is still alive,
 * still this script and still running in apps/edge; or, for servers started before the
 * record existed, the wrangler process behind the port whose working directory is apps/edge.
 * Anything else listening on the port (8787 is Wrangler's default, so another project's dev
 * server may well be there) is left alone, with an explanation.
 *
 * While the server runs, this runner also fires the Worker's Cron Trigger on its schedule
 * (lib/local-cron.ts): `wrangler dev` never does. `--no-cron` turns that off. With
 * `--jobs-every <sec>` it also runs the pipeline's privacy jobs (erase, export-events) against
 * this server when something is pending (lib/local-jobs.ts, lib/pipeline-jobs.ts).
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { unstable_readConfig } from "wrangler";
import { startLocalCron } from "./lib/local-cron.ts";
import { startJobsLoop } from "./lib/local-jobs.ts";
import {
  type DevServerRecord,
  findRepoDevServer,
  isAlive,
  processCommand,
  processCwd,
  validateRecord,
} from "./lib/processes.ts";

const EDGE_DIR = join(import.meta.dirname, "..");
const RECORD = "dev-server.json";
const say = (message: string) => console.log(`[cf] ${message}`);

function wranglerCli(): string {
  const pkg = createRequire(join(EDGE_DIR, "package.json")).resolve("wrangler/package.json");
  return join(pkg, "..", "wrangler-dist", "cli.js");
}

function readRecord(state: string): DevServerRecord | null {
  try {
    return JSON.parse(readFileSync(join(state, RECORD), "utf8")) as DevServerRecord;
  } catch {
    return null;
  }
}

async function start(options: {
  port: number;
  inspectorPort: number;
  state: string;
  assets: string;
  extra: string[];
  cron: boolean;
  cronEverySec: number | undefined;
  jobs: { everySec: number; store: string | undefined; graceMinutes: string } | undefined;
}): Promise<number> {
  mkdirSync(options.state, { recursive: true });
  // The record says "a dev.ts runner in apps/edge": make the working directory true to it.
  process.chdir(EDGE_DIR);
  const record: DevServerRecord = {
    pid: process.pid,
    port: options.port,
    cwd: EDGE_DIR,
    state: options.state,
    startedAt: new Date().toISOString(),
  };
  const recordPath = join(options.state, RECORD);
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  const child = spawn(
    process.execPath,
    [
      "--no-warnings",
      wranglerCli(),
      "dev",
      "--port",
      String(options.port),
      "--inspector-port",
      String(options.inspectorPort),
      "--persist-to",
      options.state,
      "--assets",
      options.assets,
      "--test-scheduled",
      ...options.extra,
    ],
    { cwd: EDGE_DIR, stdio: "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  const forward = (signal: NodeJS.Signals) => () => {
    if (child.exitCode === null) child.kill(signal);
  };
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGHUP", forward("SIGHUP"));
  const crons = options.cron
    ? (unstable_readConfig({ config: join(EDGE_DIR, "wrangler.jsonc") }, { hideWarnings: true })
        .triggers?.crons ?? [])
    : [];
  const stopCron = startLocalCron({
    port: options.port,
    crons,
    log: say,
    ...(options.cronEverySec ? { everySec: options.cronEverySec } : {}),
  });
  const { jobs } = options;
  const stopJobs = jobs
    ? startJobsLoop({
        everySec: jobs.everySec,
        log: say,
        round: () =>
          new Promise<void>((done) => {
            const round = spawn(
              process.execPath,
              [
                join(EDGE_DIR, "scripts", "ops.ts"),
                "jobs",
                "run",
                "--port",
                String(options.port),
                "--state",
                options.state,
                "--grace-minutes",
                jobs.graceMinutes,
                ...(jobs.store ? ["--store", jobs.store] : []),
              ],
              { cwd: EDGE_DIR, stdio: "inherit" },
            );
            round.once("exit", () => done());
            round.once("error", () => done());
          }),
      })
    : () => undefined;
  return new Promise((resolveExit) => {
    child.once("exit", (code, signal) => {
      stopCron();
      stopJobs();
      // Only remove the record if it is still ours (a second start may have replaced it).
      if (readRecord(options.state)?.pid === process.pid) rmSync(recordPath, { force: true });
      resolveExit(code ?? (signal ? 0 : 1));
    });
  });
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !isAlive(pid);
}

async function stop(options: { port: number; state: string }): Promise<number> {
  const record = readRecord(options.state);
  let target: { pid: number; how: string } | null = null;
  if (record) {
    const verdict = validateRecord(record, {
      cwd: EDGE_DIR,
      script: "scripts/dev.ts",
      alive: isAlive(record.pid),
      command: processCommand(record.pid),
      processCwd: processCwd(record.pid),
    });
    if (verdict.ok) target = { pid: record.pid, how: `recorded in ${join(options.state, RECORD)}` };
    else {
      say(`ignoring a stale dev-server record (${verdict.reason})`);
      rmSync(join(options.state, RECORD), { force: true });
    }
  }
  if (!target) {
    const found = findRepoDevServer(options.port, EDGE_DIR);
    if (found.kind === "none") {
      say(`nothing is listening on ${options.port}`);
      return 0;
    }
    if (found.kind === "foreign") {
      say(
        `port ${options.port} is served by PID ${found.pid} (${found.command}), which is not this repository's dev server: not stopping it`,
      );
      return 1;
    }
    target = { pid: found.pid, how: "wrangler process running in apps/edge" };
  }
  process.kill(target.pid, "SIGTERM");
  if (!(await waitForExit(target.pid, 15_000))) {
    say(`PID ${target.pid} did not stop within 15 s`);
    return 1;
  }
  say(`stopped the dev server on ${options.port} (PID ${target.pid}, ${target.how})`);
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const dash = argv.indexOf("--");
  const own = dash === -1 ? argv : argv.slice(0, dash);
  const extra = dash === -1 ? [] : argv.slice(dash + 1).filter((arg) => arg !== "");
  const { positionals, values } = parseArgs({
    args: own,
    allowPositionals: true,
    options: {
      port: { type: "string", default: "8787" },
      "inspector-port": { type: "string", default: "4609" },
      state: { type: "string", default: join(EDGE_DIR, ".wrangler", "state") },
      assets: { type: "string", default: join(EDGE_DIR, "dist", "public") },
      "no-cron": { type: "boolean", default: false },
      "cron-every": { type: "string" },
      "jobs-every": { type: "string" },
      "jobs-store": { type: "string" },
      "jobs-grace-minutes": { type: "string" },
    },
  });
  const port = Number(values.port);
  const state = resolve(values.state);
  switch (positionals[0]) {
    case "start":
      return start({
        port,
        inspectorPort: Number(values["inspector-port"]),
        state,
        assets: resolve(values.assets),
        extra,
        cron: !values["no-cron"],
        cronEverySec: values["cron-every"] ? Number(values["cron-every"]) : undefined,
        jobs: values["jobs-every"]
          ? {
              everySec: Number(values["jobs-every"]),
              store: values["jobs-store"] ? resolve(values["jobs-store"]) : undefined,
              graceMinutes: values["jobs-grace-minutes"] ?? "0",
            }
          : undefined,
      });
    case "stop":
      return stop({ port, state });
    default:
      console.error(
        "Usage: node scripts/dev.ts <start|stop> [--port] [--state] [--assets] [--no-cron] [--cron-every <sec>] [--jobs-every <sec> [--jobs-store <dir>] [--jobs-grace-minutes <n>]]",
      );
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`[cf] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
