import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root: this file lives in `tools/stripe/src`. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Everything this tooling writes lives under `.cache/stripe` (git-ignored by the root
 * `.gitignore` rule `.cache/`). Directories are created 0700 and files holding credentials
 * 0600 (`secure-fs.ts`).
 */
export const CACHE_DIR = join(REPO_ROOT, ".cache", "stripe");

export const paths = {
  cache: CACHE_DIR,
  /** `XDG_CONFIG_HOME` for the CLI: its profile lands in `<this>/stripe/config.toml`. */
  cliXdgConfigHome: join(CACHE_DIR, "config"),
  cliConfigFile: join(CACHE_DIR, "config", "stripe", "config.toml"),
  /** `HOME` for the CLI, so any undocumented home-directory write stays in the repository. */
  cliHome: join(CACHE_DIR, "home"),
  /** What other tooling reads: keys, account, expiry, webhook signing secret (0600). */
  stateFile: join(CACHE_DIR, "sandbox.json"),
  /** The same values as `KEY=value` lines for shells and dotenv loaders (0600). */
  envFile: join(CACHE_DIR, "stripe.env"),
  /** Non-secret record of every sandbox this checkout created (account id, dates). */
  historyFile: join(CACHE_DIR, "history.jsonl"),
  listenDir: join(CACHE_DIR, "listen"),
  runsDir: join(CACHE_DIR, "runs"),
  fixturesDir: join(REPO_ROOT, "tools", "stripe", "fixtures"),
} as const;

/**
 * The owner's real home directory from the user database, not `$HOME` (which the CLI runs
 * with overridden). Used only to check that the global Stripe locations were left alone.
 */
export function realHomeDir(): string {
  return userInfo().homedir;
}

/** The global Stripe CLI locations this tooling must never create or modify. */
export function globalStripeLocations(home: string = realHomeDir()): string[] {
  return [join(home, ".config", "stripe"), join(home, ".stripe")];
}
