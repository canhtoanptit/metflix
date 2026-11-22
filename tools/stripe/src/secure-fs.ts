import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** Create a directory (and parents) readable by the owner only. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/**
 * Write a file that may hold credentials: owner-only permissions from the first byte (the
 * temporary file is created 0600, then renamed over the target), so there is no window in
 * which the content is readable by others.
 */
export function writePrivateFile(path: string, content: string): void {
  ensurePrivateDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600, flag: "w" });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function readTextIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

/** True when group or others can read or write the file. */
export function isTooOpen(path: string): boolean {
  return (statSync(path).mode & 0o077) !== 0;
}

/** Tighten a credentials file to 0600 if something widened it; returns whether it changed. */
export function tightenPermissions(path: string): boolean {
  if (!existsSync(path) || !isTooOpen(path)) return false;
  chmodSync(path, 0o600);
  return true;
}
