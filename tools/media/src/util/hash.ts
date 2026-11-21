import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** JSON with sorted object keys, so equal values always hash equally. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(inner).sort()) {
      sorted[key] = (inner as Record<string, unknown>)[key];
    }
    return sorted;
  });
}

export function hashJson(value: unknown): string {
  return sha256(stableStringify(value));
}

/** URL- and key-safe short content hash (`ArtworkImage.version`, image tags). */
export function shortHash(hex: string, length = 12): string {
  return Buffer.from(hex.slice(0, 32), "hex").toString("base64url").slice(0, length);
}

/** Fingerprint of source files, so a code change re-runs exactly the stage it belongs to. */
export async function fingerprintFiles(paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    hash.update(path.split("/").slice(-3).join("/"));
    hash.update(await readFile(path));
  }
  return hash.digest("hex");
}
