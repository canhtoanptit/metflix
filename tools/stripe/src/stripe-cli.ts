import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { globalStripeLocations, paths } from "./paths.ts";
import { ensurePrivateDir } from "./secure-fs.ts";

/** The repository-local CLI profile name: never `default`, see `isolatedEnv`. */
export const CLI_PROJECT_NAME = "webflix";

const PLATFORM_PACKAGES: Record<string, { pkg: string; bin: string }> = {
  "darwin-arm64": { pkg: "@stripe/cli-darwin-arm64", bin: "stripe" },
  "darwin-x64": { pkg: "@stripe/cli-darwin-x64", bin: "stripe" },
  "linux-x64": { pkg: "@stripe/cli-linux-x64", bin: "stripe" },
  "linux-arm64": { pkg: "@stripe/cli-linux-arm64", bin: "stripe" },
  "win32-x64": { pkg: "@stripe/cli-win32-x64", bin: "stripe.exe" },
};

/**
 * The CLI binary from the `@stripe/cli` dev dependency (pinned in `tools/stripe/package.json`,
 * integrity-checked by the pnpm lockfile). Resolved directly rather than through the npm shim so
 * nothing but this process sits between us and the binary, and so we can pass an exact
 * environment.
 */
export function resolveCliBinary(): string {
  const require = createRequire(import.meta.url);
  const cliPackageJson = require.resolve("@stripe/cli/package.json");
  const platform = PLATFORM_PACKAGES[`${process.platform}-${process.arch}`];
  if (!platform) {
    throw new Error(
      `The Stripe CLI npm package has no binary for ${process.platform}-${process.arch}.`,
    );
  }
  const fromCli = createRequire(cliPackageJson);
  const binary = join(
    dirname(fromCli.resolve(`${platform.pkg}/package.json`)),
    "bin",
    platform.bin,
  );
  if (!existsSync(binary))
    throw new Error(`Stripe CLI binary missing at ${binary}; run pnpm install.`);
  return binary;
}

/** The version pinned in package.json; the binary must report exactly this. */
export function pinnedCliVersion(): string {
  const manifest = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
  ) as { devDependencies?: Record<string, string> };
  const version = manifest.devDependencies?.["@stripe/cli"];
  if (!version) throw new Error("@stripe/cli is not a devDependency of tools/stripe.");
  return version;
}

/**
 * The environment every CLI invocation gets. Nothing is inherited from the caller except PATH,
 * TERM and proxy settings, so a STRIPE_API_KEY or XDG_CONFIG_HOME exported in the owner's shell
 * cannot redirect the CLI to another profile or account.
 *
 * Why each variable (behaviour read from the CLI 1.55.14 source, `pkg/config`, `pkg/version`,
 * `pkg/autoupdate`, `cmd/stripe/main.go`):
 * - XDG_CONFIG_HOME: the documented way to move the config directory. `--config` alone moves
 *   only config.toml; the keyring fallback file (credentials.json), plugins, pending-login state
 *   and the docs cache follow XDG_CONFIG_HOME, not `--config`.
 * - HOME: defence in depth. The update check writes `~/.stripe/state/latest_release.json` and
 *   the auto-updater keeps state in `~/.stripe/state` regardless of XDG_CONFIG_HOME.
 * - STRIPE_NO_UPDATE_CHECK: skips that update check (and its call to GitHub) entirely.
 * - STRIPE_NO_AUTO_UPDATE, STRIPE_CLI_NO_PLUGIN_AUTO_INSTALL: no self-modification.
 * - STRIPE_CLI_TELEMETRY_OPTOUT: no telemetry or crash reports.
 * - The profile is `webflix`, not `default`: keyring items are keyed `uat:<profile>` except for
 *   `default`, whose key is the bare `uat` a global `stripe login` would use.
 */
export function isolatedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: paths.cliHome,
    XDG_CONFIG_HOME: paths.cliXdgConfigHome,
    STRIPE_NO_UPDATE_CHECK: "1",
    STRIPE_NO_AUTO_UPDATE: "1",
    STRIPE_CLI_NO_PLUGIN_AUTO_INSTALL: "1",
    STRIPE_CLI_TELEMETRY_OPTOUT: "1",
    // Plain output: no spinners or colour codes in logs we parse.
    NO_COLOR: "1",
  };
  for (const name of [
    "TERM",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
  ]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

/** Flags that pin every invocation to the repository-local profile. */
export function profileArgs(): string[] {
  return ["--config", paths.cliConfigFile, "--project-name", CLI_PROJECT_NAME, "--color", "off"];
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI with output captured. Callers must never print `stdout`/`stderr` without passing
 * them through `redact()`: several commands print keys.
 */
/**
 * `apiKey`: only for keys imported with make stripe-use-key, which the CLI profile does not hold;
 * passed as STRIPE_API_KEY in the environment (never on the command line).
 */
export function runCli(
  args: string[],
  options: { timeoutMs?: number; apiKey?: string } = {},
): Promise<CliResult> {
  ensurePrivateDir(paths.cliHome);
  ensurePrivateDir(paths.cliXdgConfigHome);
  const before = snapshotGlobalLocations();
  const binary = resolveCliBinary();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, [...args, ...profileArgs()], {
      env: isolatedEnv(options.apiKey ? { STRIPE_API_KEY: options.apiKey } : {}),
      stdio: ["ignore", "pipe", "pipe"],
      cwd: paths.cache,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 120_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        assertGlobalLocationsUnchanged(before);
      } catch (error) {
        reject(error);
        return;
      }
      resolvePromise({ code, stdout, stderr });
    });
  });
}

/** Version reported by the binary, e.g. "1.55.14". */
export async function cliVersion(): Promise<string> {
  const result = await runCli(["version"], { timeoutMs: 30_000 });
  const match = /stripe version (\S+)/.exec(result.stdout);
  if (!match?.[1]) throw new Error("Could not read the Stripe CLI version.");
  return match[1];
}

// --- Global profile guard -------------------------------------------------------------------

export interface LocationState {
  path: string;
  exists: boolean;
  /** Modification time of the location itself (a directory), when it exists. */
  mtimeMs: number | null;
}

/**
 * Existence and modification time of the global Stripe locations. Only `stat` is used: the
 * contents of an owner's existing profile are never read.
 */
export function snapshotGlobalLocations(): LocationState[] {
  return globalStripeLocations().map((path) => {
    if (!existsSync(path)) return { path, exists: false, mtimeMs: null };
    return { path, exists: true, mtimeMs: statSync(path).mtimeMs };
  });
}

/** Throw loudly if a CLI run created or touched a global Stripe location. */
export function assertGlobalLocationsUnchanged(before: LocationState[]): void {
  const after = snapshotGlobalLocations();
  for (const [index, prior] of before.entries()) {
    const now = after[index];
    if (!now) continue;
    if (prior.exists !== now.exists || prior.mtimeMs !== now.mtimeMs) {
      throw new Error(
        `The Stripe CLI changed ${now.path} (existed: ${prior.exists} -> ${now.exists}). ` +
          "The isolation in tools/stripe/src/stripe-cli.ts is broken; stop and investigate.",
      );
    }
  }
}

/**
 * Whether the macOS keychain holds any item of the CLI's credential service ("StripeCLI").
 * Exit status only: `security` is not asked for item contents (no -g / -w).
 */
export function keychainHasStripeItems(): boolean | null {
  if (process.platform !== "darwin") return null;
  const result = spawnSync("/usr/bin/security", ["find-generic-password", "-s", "StripeCLI"], {
    stdio: "ignore",
  });
  if (result.status === 0) return true;
  if (result.status === 44) return false;
  return null;
}
