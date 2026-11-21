/**
 * Bindings for Node tooling, through Wrangler's `getPlatformProxy`.
 *
 * The proxy is started from a bindings-only config derived from wrangler.jsonc (D1, KV, R2 and
 * the vars of the chosen environment), written to `.wrangler/ops/<target>.json`. The Worker
 * itself is not involved, so there are no Durable Object or queue warnings, and the deploy
 * config does not need `remote` flags:
 *
 * - `local`: the derived config keeps the local resource ids and the proxy persists to
 *   `apps/edge/.wrangler/state`, i.e. exactly the state `wrangler dev` serves from. Only one
 *   process may own that state at a time, so local operations refuse to run while the dev
 *   server is up.
 * - `production`: the derived config marks every binding `remote: true`, so the proxy talks to
 *   the deployed D1, KV and R2 (needs `wrangler login`, or CLOUDFLARE_API_TOKEN and
 *   CLOUDFLARE_ACCOUNT_ID).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { getPlatformProxy, unstable_readConfig } from "wrangler";
import type { Env } from "../../src/env.ts";

export const EDGE_DIR = join(import.meta.dirname, "..", "..");
export const REPO_ROOT = join(EDGE_DIR, "..", "..");
export const WRANGLER_CONFIG = join(EDGE_DIR, "wrangler.jsonc");
/** `wrangler dev --persist-to` default; it keeps its data in `<state>/v3`. */
export const DEFAULT_STATE = join(EDGE_DIR, ".wrangler", "state");
export const DEFAULT_PORT = 8787;

/** Which local instance the tools act on: its state directory and the port it serves. */
export interface LocalInstance {
  state: string;
  port: number;
}

export const DEFAULT_INSTANCE: LocalInstance = { state: DEFAULT_STATE, port: DEFAULT_PORT };

export type Target = "local" | "production";

export function parseTarget(value: string | undefined): Target {
  if (value === undefined || value === "local") return "local";
  if (value === "production") return "production";
  throw new Error(`Unknown target "${value}": expected local or production`);
}

/** True when something accepts connections on localhost:port. */
export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "localhost", port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

/** `KEY=value` lines of a dotenv-style file (local secrets in `.dev.vars`). */
async function readDevVars(): Promise<Record<string, string>> {
  let text: string;
  try {
    text = await readFile(join(EDGE_DIR, ".dev.vars"), "utf8");
  } catch {
    return {};
  }
  const vars: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match?.[1] && match[2] !== undefined) vars[match[1]] = match[2].replace(/^"(.*)"$/, "$1");
  }
  return vars;
}

/** The D1/KV/R2 bindings and vars of one environment, as a standalone Wrangler config. */
export async function derivedConfig(
  target: Target,
  instance: LocalInstance = DEFAULT_INSTANCE,
): Promise<string> {
  const config = unstable_readConfig(
    { config: WRANGLER_CONFIG, ...(target === "production" ? { env: "production" } : {}) },
    { hideWarnings: true },
  );
  const remote = target === "production" ? { remote: true } : {};
  const derived = {
    name: "webflix-ops",
    compatibility_date: config.compatibility_date,
    vars: {
      ...config.vars,
      // Local secrets come from .dev.vars; production secrets are never needed by the tools.
      ...(target === "local" ? await readDevVars() : {}),
    },
    d1_databases: config.d1_databases.map((db) => ({
      binding: db.binding,
      database_name: db.database_name,
      database_id: db.database_id,
      ...remote,
    })),
    kv_namespaces: config.kv_namespaces.map((kv) => ({
      binding: kv.binding,
      id: kv.id,
      ...remote,
    })),
    r2_buckets: config.r2_buckets.map((r2) => ({
      binding: r2.binding,
      bucket_name: r2.bucket_name,
      ...remote,
    })),
  };
  // One file per instance: two local instances may run tools at the same time.
  const suffix =
    target === "local"
      ? `-${createHash("sha256").update(instance.state).digest("hex").slice(0, 8)}`
      : "";
  const path = join(EDGE_DIR, ".wrangler", "ops", `${target}${suffix}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(derived, null, 2)}\n`);
  return path;
}

export interface Platform {
  target: Target;
  env: Env;
  /** The media bucket's name in this environment (for S3-API uploads). */
  bucket: string;
  dispose(): Promise<void>;
}

export async function openPlatform(
  target: Target,
  instance: LocalInstance = DEFAULT_INSTANCE,
): Promise<Platform> {
  if (target === "local" && (await portInUse(instance.port))) {
    throw new Error(
      `Something is serving localhost:${instance.port} (the dev server?). Local seeding and media ` +
        "upload write the dev server's state directly; stop it first (Ctrl-C in `make cf-dev`, " +
        "or `make cf-stop`), then run this again.",
    );
  }
  const configPath = await derivedConfig(target, instance);
  const derived = JSON.parse(await readFile(configPath, "utf8")) as {
    r2_buckets: { bucket_name: string }[];
  };
  const proxy = await getPlatformProxy<Env>({
    configPath,
    persist: target === "local" ? { path: join(instance.state, "v3") } : false,
    remoteBindings: target === "production",
    envFiles: [],
  });
  return {
    target,
    env: proxy.env,
    bucket: derived.r2_buckets[0]?.bucket_name ?? "webflix-media",
    dispose: () => proxy.dispose(),
  };
}
