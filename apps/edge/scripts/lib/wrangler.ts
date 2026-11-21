/** Running the Wrangler CLI from the tooling: always the workspace's pinned copy, never a global one. */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { EDGE_DIR } from "./platform.ts";

const WRANGLER_BIN = join(
  createRequire(join(EDGE_DIR, "package.json")).resolve("wrangler/package.json"),
  "..",
  "bin",
  "wrangler.js",
);

export interface WranglerResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WranglerOptions {
  /** Pass stdio through (long-running or interactive commands). Default: captured. */
  inherit?: boolean;
  input?: string;
  /** Do not throw on a non-zero exit. */
  allowFailure?: boolean;
}

export function wrangler(
  args: readonly string[],
  options: WranglerOptions = {},
): Promise<WranglerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRANGLER_BIN, ...args], {
      cwd: EDGE_DIR,
      stdio: options.inherit ? "inherit" : ["pipe", "pipe", "pipe"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    if (child.stdin) child.stdin.end(options.input ?? "");
    child.once("error", reject);
    child.once("close", (code) => {
      const result = { code: code ?? 1, stdout, stderr };
      if (result.code !== 0 && !options.allowFailure) {
        reject(
          new Error(
            `wrangler ${args.join(" ")} exited with ${result.code}\n${(stderr || stdout).trim()}`,
          ),
        );
      } else resolve(result);
    });
  });
}

/** The first JSON array or object in a command's output (Wrangler may print banners first). */
export function parseJsonOutput<T>(output: string): T {
  const start = output.search(/[[{]/);
  if (start === -1) throw new Error(`Expected JSON from wrangler, got: ${output.slice(0, 200)}`);
  return JSON.parse(output.slice(start)) as T;
}
