import { rm } from "node:fs/promises";
import { join } from "node:path";
import { exists, readJson, writeJson } from "./fs.ts";

interface Stamp<T> {
  key: string;
  value: T;
  /** Absolute paths that must still exist for the stamp to count. */
  outputs: string[];
}

/**
 * Incremental build step. `key` is a hash of every input (data, source bytes, code
 * fingerprint, tool image). When the stamp records the same key and all its outputs still
 * exist, the step is skipped and its recorded value returned, so a re-run with unchanged
 * inputs does no work.
 */
export async function cachedStep<T>(
  stampFile: string,
  key: string,
  produce: () => Promise<{ value: T; outputs: string[]; provisional?: boolean }>,
): Promise<{ value: T; cached: boolean }> {
  const stamp = await readJson<Stamp<T>>(stampFile);
  if (stamp && stamp.key === key) {
    const present = await Promise.all(stamp.outputs.map((path) => exists(path)));
    if (present.every(Boolean)) return { value: stamp.value, cached: true };
  }
  const { value, outputs, provisional } = await produce();
  // A provisional result (made with a fallback because a source was missing) is used but not
  // remembered, so the next run tries the real source again.
  if (provisional) await rm(stampFile, { force: true });
  else await writeJson(stampFile, { key, value, outputs } satisfies Stamp<T>);
  return { value, cached: false };
}

export function stampPath(dir: string, ...parts: string[]): string {
  return `${join(dir, ".stamps", ...parts)}.json`;
}
