import { randomUUID } from "node:crypto";
import {
  copyFile,
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}

/** Write via a temp file and rename, so a crash never leaves a truncated file behind. */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await ensureDir(dirname(path));
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Every file under `root`, as `/`-separated paths relative to it, sorted. */
export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) out.push(relative(root, path).split(sep).join("/"));
    }
  };
  await walk(root);
  return out.sort();
}

/**
 * Place `source` at `target` as a hard link (same bytes, no copy), falling back to a copy
 * across devices. Replaces whatever is at `target`.
 */
export async function linkFile(source: string, target: string): Promise<void> {
  await ensureDir(dirname(target));
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await link(source, temp);
  } catch {
    await copyFile(source, temp);
  }
  await rename(temp, target);
}

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}
