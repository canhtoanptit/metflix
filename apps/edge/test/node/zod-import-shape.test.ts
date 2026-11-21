/**
 * Runtime zod imports under apps/edge and packages/adapters-cloudflare are namespace imports
 * (`import * as z from "zod"`). `import { z } from "zod"` binds zod's own namespace object,
 * which esbuild keeps whole, every locale included (≈ 260 KiB of the Worker bundle); the
 * shared packages have the same guard (packages/core/test/zod-import-shape.test.ts), and
 * `make cf-bundle` checks the built Worker itself.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const EDGE = join(import.meta.dirname, "..", "..");
const ROOTS = [
  join(EDGE, "src"),
  join(EDGE, "scripts"),
  join(EDGE, "test"),
  join(EDGE, "..", "..", "packages", "adapters-cloudflare", "src"),
  join(EDGE, "..", "..", "packages", "adapters-cloudflare", "test"),
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules") return [];
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

/** Value imports of "zod" other than `import * as z from "zod"` (type-only imports are free). */
const NAMED_OR_DEFAULT = /^import\s+(?!type\b)(?!\*\s+as\s+\w+\s+from)[^;]*?from\s+["']zod["']/m;

describe("zod imports", () => {
  it("are namespace imports in the Worker and its adapters", () => {
    const all = ROOTS.flatMap(files);
    expect(all.length).toBeGreaterThan(30);
    const offenders = all
      .filter((path) => NAMED_OR_DEFAULT.test(readFileSync(path, "utf8")))
      .map((path) => relative(EDGE, path));
    expect(offenders).toEqual([]);
  });

  it("recognises the shapes it must refuse", () => {
    expect(NAMED_OR_DEFAULT.test('import { z } from "zod";')).toBe(true);
    expect(NAMED_OR_DEFAULT.test('import z from "zod";')).toBe(true);
    expect(NAMED_OR_DEFAULT.test('import * as z from "zod";')).toBe(false);
    expect(NAMED_OR_DEFAULT.test('import type { ZodType } from "zod";')).toBe(false);
  });
});
