#!/usr/bin/env node
/**
 * The host guard (scripts/host-guard.sh) must stop a run when the machine runs short, stop
 * everything the run started, stay out of the way otherwise, and sit in front of every make target
 * that starts browsers. A guard that silently stopped guarding would look exactly like one that
 * works until the next time the host runs out of memory, so this exercises it with a fake probe
 * (HOST_GUARD_PROBE) on any platform, checks the real macOS probes where they exist, and reads the
 * make recipes. Part of `pnpm test`.
 *
 * HOST_GUARD_SCRIPT=<path> checks another copy of the guard (to show this check fails on a broken
 * one).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const guard = process.env.HOST_GUARD_SCRIPT || join(import.meta.dirname, "host-guard.sh");
const scratch = mkdtempSync(join(tmpdir(), "check-host-guard-"));

const clean: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(clean)) if (key.startsWith("HOST_GUARD")) delete clean[key];

interface Outcome {
  code: number | null;
  stderr: string;
  seconds: number;
}

/** Run the guard (directly, so a lost executable bit fails too) with a fake host. */
function runGuard(command: string[], env: Record<string, string>): Outcome {
  const started = Date.now();
  const result = spawnSync(guard, command, {
    env: { ...clean, HOST_GUARD_INTERVAL_SEC: "0.2", HOST_GUARD_GRACE_SEC: "1", ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    code: result.status,
    stderr: `${result.stderr ?? ""}${result.error ? String(result.error) : ""}`,
    seconds: (Date.now() - started) / 1000,
  };
}

/** A fake probe reporting one fixed sample: "<swapMB> <load> <surfaces>". */
const host = (sample: string) => ({ HOST_GUARD_PROBE: `echo ${sample}` });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const checks: Array<[string, () => string | null]> = [];
const check = (name: string, run: () => string | null) => checks.push([name, run]);

check("passes the command's exit code through on a healthy host", () => {
  const out = runGuard(["sh", "-c", "exit 7"], host("300 2.0 190"));
  return out.code === 7 ? null : `exit ${out.code}, want 7 (${out.stderr.trim()})`;
});

check("runs the command as is where the host has no probes (Linux, CI)", () => {
  const ran = join(scratch, "ran-without-probes");
  const out = runGuard(["sh", "-c", `touch ${ran}; exit 5`], { HOST_GUARD_PROBE: "true" });
  if (out.code !== 5) return `exit ${out.code}, want 5 (${out.stderr.trim()})`;
  return existsSync(ran) ? null : "the command did not run";
});

for (const [what, sample] of [
  ["swap above HOST_GUARD_SWAP_MAX_MB", "6001 2.0 190"],
  ["load above HOST_GUARD_LOAD_MAX", "300 45.5 190"],
  ["surfaces above HOST_GUARD_SURFACES_MAX", "300 2.0 3001"],
] as const) {
  check(`does not start the command with ${what} (exit 99)`, () => {
    const ran = join(scratch, `ran-${sample.replaceAll(" ", "-")}`);
    const out = runGuard(["sh", "-c", `touch ${ran}`], host(sample));
    if (out.code !== 99) return `exit ${out.code}, want 99 (${out.stderr.trim()})`;
    return existsSync(ran) ? "the command ran anyway" : null;
  });
}

check("takes a value at a limit as within it (6000 MB, load 45, 3000 surfaces)", () => {
  const out = runGuard(["sh", "-c", "exit 0"], host("6000 45.0 3000"));
  return out.code === 0 ? null : `exit ${out.code}, want 0 (${out.stderr.trim()})`;
});

check("honours the limits from the environment", () => {
  const out = runGuard(["sh", "-c", "exit 0"], {
    ...host("300 2.0 190"),
    HOST_GUARD_SWAP_MAX_MB: "200",
  });
  return out.code === 99 ? null : `exit ${out.code}, want 99 with HOST_GUARD_SWAP_MAX_MB=200`;
});

check("HOST_GUARD=off runs the command unguarded", () => {
  const out = runGuard(["sh", "-c", "exit 3"], { ...host("9000 99 9999"), HOST_GUARD: "off" });
  return out.code === 3 ? null : `exit ${out.code}, want 3 (${out.stderr.trim()})`;
});

check("stops a running command and everything it started when the host runs short", () => {
  // Healthy for the start-up sample, short from then on. The command starts what Playwright
  // starts: a child in a process group of its own (each browser) and one that ignores SIGTERM.
  const count = join(scratch, "samples");
  const pids = join(scratch, "pids.json");
  const probe = `n=$(cat ${count} 2>/dev/null || echo 0); echo $((n + 1)) > ${count}; if [ "$n" -eq 0 ]; then echo 300 2.0 190; else echo 9000 2.0 190; fi`;
  const program = `
    const { spawn } = require("node:child_process");
    const detached = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    const stubborn = spawn("sh", ["-c", "trap '' TERM; exec sleep 60"], { stdio: "ignore" });
    require("node:fs").writeFileSync(${JSON.stringify(pids)}, JSON.stringify([detached.pid, stubborn.pid]));
    setInterval(() => {}, 1000);`;
  const out = runGuard(["node", "-e", program], { HOST_GUARD_PROBE: probe });
  const started = existsSync(pids) ? (JSON.parse(readFileSync(pids, "utf8")) as number[]) : [];
  const survivors = started.filter(alive);
  for (const pid of survivors) process.kill(pid, "SIGKILL");
  if (out.code !== 99) return `exit ${out.code}, want 99 (${out.stderr.trim()})`;
  if (started.length !== 2) return "the command's children never started";
  if (survivors.length > 0) return `left running: ${survivors.join(", ")}`;
  if (out.seconds > 15) return `took ${out.seconds} s to stop it`;
  return /STOPPED/.test(out.stderr) ? null : "said nothing about stopping it";
});

if (process.platform === "darwin") {
  check("reads swap, load and surfaces on this Mac (the guard is live here)", () => {
    const sample = execFileSync(guard, ["--probe"], { env: clean, encoding: "utf8" });
    const fields = Object.fromEntries(
      [...sample.matchAll(/(\w+)=(\S+)/g)].map((match) => [match[1], match[2]]),
    );
    const missing = ["swapMB", "load", "surfaces"].filter(
      (field) => !/^\d+(\.\d+)?$/.test(fields[field] ?? ""),
    );
    return missing.length === 0 ? null : `no reading for ${missing.join(", ")}: ${sample.trim()}`;
  });
}

// Through make for real: `verify`'s dry run starts nothing, so a short host must stop it at the
// guard (99), and HOST_GUARD=off must reach the guard from the environment and from make's command
// line. A make variable named like the switch once overrode it in the recipe's environment.
for (const [name, args, env, stopped] of [
  ["stops make verify on a short host (make: Error 99)", [], {}, true],
  ["HOST_GUARD=off from the environment reaches it through make", [], { HOST_GUARD: "off" }, false],
  ["HOST_GUARD=off on make's command line reaches it", ["HOST_GUARD=off"], {}, false],
] as const) {
  check(name, () => {
    const result = spawnSync("make", ["-s", "-C", root, "verify", "TARGET=dev", ...args], {
      env: { ...clean, ...host("9000 2.0 190"), VERIFY_DRY_RUN: "1", ...env },
      encoding: "utf8",
    });
    const wasStopped = result.status !== 0 && /Error 99/.test(result.stderr);
    const ran = result.status === 0 && /browser suite: /.test(result.stdout);
    return (stopped ? wasStopped : ran)
      ? null
      : `exit ${result.status}, want it ${stopped ? "stopped" : "run"} (${result.stderr.trim()})`;
  });
}

for (const target of ["e2e", "e2e-throttled", "verify", "e2e-mock", "screenshots"]) {
  check(`make ${target} runs through the guard`, () => {
    const recipe = execFileSync("make", ["-n", "-s", "-C", root, target, "TARGET=dev"], {
      env: clean,
      encoding: "utf8",
    });
    return /e2e\/scripts\/host-guard\.sh /.test(recipe) ? null : `recipe: ${recipe.trim()}`;
  });
}

let failures = 0;
for (const [name, run] of checks) {
  let problem: string | null;
  try {
    problem = run();
  } catch (error) {
    problem = String(error);
  }
  if (problem) failures += 1;
  console.log(`${problem ? "FAIL" : "ok  "} host guard ${name}${problem ? `: ${problem}` : ""}`);
}
rmSync(scratch, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
