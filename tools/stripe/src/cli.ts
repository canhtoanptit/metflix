#!/usr/bin/env node
import { parseArgs } from "node:util";
import { claim, reset, status } from "./commands.ts";
import { importKeys } from "./import-key.ts";
import { listRecords, startListener, stopListener, tailLog } from "./listen.ts";
import { DEFAULT_SANDBOX_EMAIL, ensureSandbox } from "./sandbox.ts";
import { redact } from "./secrets.ts";

/**
 * Every line this tool prints goes through `redact()`, so a key can only reach the terminal if
 * it has a shape none of the patterns in `secrets.ts` recognises.
 */
function log(line: string): void {
  process.stdout.write(`${redact(line)}\n`);
}

const USAGE = `webflix-stripe <command>

  sandbox                       create or reuse the Stripe sandbox (idempotent)
  status                        sandbox, listeners and isolation checks
  listen --name N --forward-to URL [--events a,b] [--latest]
                                start a managed stripe listen sidecar
  listen-stop --name N | --all  stop sidecars by PID
  listen-logs --name N          last lines of a sidecar log, redacted
  reset                         forget the local sandbox credentials
  claim                         open Stripe's claim page (owner only, interactive)
  use-key [--from FILE]         use your own test keys (e.g. a claimed sandbox's full key)`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      name: { type: "string" },
      "forward-to": { type: "string" },
      events: { type: "string" },
      latest: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      from: { type: "string" },
    },
    strict: true,
  });

  switch (command) {
    case "sandbox":
      await ensureSandbox({
        email: process.env.STRIPE_SANDBOX_EMAIL || DEFAULT_SANDBOX_EMAIL,
        minRemainingHours: Number(process.env.STRIPE_SANDBOX_MIN_HOURS || 24),
        log,
      });
      return 0;
    case "status":
      await status(log);
      return 0;
    case "listen": {
      const forwardTo = values["forward-to"];
      if (!forwardTo) throw new Error("--forward-to is required");
      await startListener({
        name: values.name ?? "dev",
        forwardTo,
        events: values.events
          ? values.events
              .split(",")
              .map((event) => event.trim())
              .filter(Boolean)
          : [],
        latest: values.latest ?? false,
        log,
      });
      return 0;
    }
    case "listen-stop":
      if (values.all) for (const record of listRecords()) await stopListener(record.name, log);
      else await stopListener(values.name ?? "dev", log);
      return 0;
    case "listen-logs":
      log(tailLog(values.name ?? "dev"));
      return 0;
    case "reset":
      await reset(log);
      return 0;
    case "claim":
      return claim();
    case "use-key":
      await importKeys(values.from, log);
      return 0;
    default:
      process.stdout.write(`${USAGE}\n`);
      return command === undefined || command === "help" ? 0 : 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  },
);
