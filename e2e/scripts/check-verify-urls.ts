#!/usr/bin/env node
/**
 * `make verify` must point each suite at the right origin for every target. The conformance
 * suite talks to the API: in dev mode that is :4000, not the web origin :5173. A recipe that let
 * bash resolve the URLs got this wrong without any run failing, so this asserts the resolution
 * with a dry run (`VERIFY_DRY_RUN=1`, nothing is contacted). Part of `pnpm test`.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");

interface Case {
  name: string;
  args: string[];
  env?: Record<string, string>;
  e2e: string;
  conformance: string;
}

const cases: Case[] = [
  {
    name: "dev",
    args: ["TARGET=dev"],
    e2e: "http://localhost:5173",
    conformance: "http://localhost:4000",
  },
  {
    name: "k8s",
    args: ["TARGET=k8s"],
    e2e: "http://localhost:8080",
    conformance: "http://localhost:8080",
  },
  {
    name: "cf",
    args: ["TARGET=cf"],
    e2e: "http://localhost:8787",
    conformance: "http://localhost:8787",
  },
  {
    name: "BASE_URL on the command line",
    args: ["BASE_URL=http://localhost:5012"],
    e2e: "http://localhost:5012",
    conformance: "http://localhost:5012",
  },
  {
    name: "BASE_URL and SMOKE_BASE_URL",
    args: ["BASE_URL=http://localhost:5012", "SMOKE_BASE_URL=http://localhost:5011"],
    e2e: "http://localhost:5012",
    conformance: "http://localhost:5011",
  },
  {
    name: "BASE_URL from the environment",
    args: ["TARGET=dev"],
    env: { BASE_URL: "http://localhost:5030" },
    e2e: "http://localhost:5030",
    conformance: "http://localhost:5030",
  },
];

// The dry run starts nothing, so it skips the host guard (scripts/check-host-guard.ts covers it).
const clean: NodeJS.ProcessEnv = { ...process.env, HOST_GUARD: "off" };
delete clean.BASE_URL;
delete clean.SMOKE_BASE_URL;
delete clean.TARGET;

// Also under zsh: bash 3.2 runs a lone `-c` command through a one-shot path in which a later
// prefix assignment does not see an earlier one, which hid the original bug under make; any
// other shell (or the same line after another command) shows it.
const shells: Array<string | null> = [null, ...(existsSync("/bin/zsh") ? ["/bin/zsh"] : [])];

let failures = 0;
for (const shell of shells) {
  for (const testCase of cases) {
    const shellArgs = shell ? [`SHELL=${shell}`] : [];
    const output = execFileSync(
      "make",
      ["-s", "-C", root, "verify", ...testCase.args, ...shellArgs],
      { env: { ...clean, ...testCase.env, VERIFY_DRY_RUN: "1" }, encoding: "utf8" },
    );
    const e2e = /browser suite: (\S+)/.exec(output)?.[1];
    const conformance = /conformance: (\S+)/.exec(output)?.[1];
    const ok = e2e === testCase.e2e && conformance === testCase.conformance;
    if (!ok) failures += 1;
    console.log(
      `${ok ? "ok  " : "FAIL"} ${testCase.name}${shell ? ` (${shell})` : ""}: browser suite ${e2e} (want ${testCase.e2e}), conformance ${conformance} (want ${testCase.conformance})`,
    );
  }
}
process.exit(failures === 0 ? 0 : 1);
