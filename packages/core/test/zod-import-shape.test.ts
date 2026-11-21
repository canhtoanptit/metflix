/**
 * Every runtime import of zod in the shared packages is a namespace import (`import * as z`).
 * `import { z } from "zod"` binds zod's own namespace object, which bundlers (esbuild, used by
 * wrangler and Vite) then keep whole, with every locale (about 260 KiB of the Worker bundle);
 * a namespace import of the package lets them keep only what is used. Same API, same messages.
 */
import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>("../../*/src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("zod imports", () => {
  it("are namespace imports in every shared package", () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !path.includes("/node_modules/"))
      .filter(([, source]) => /^import\s+\{[^}]*\bz\b[^}]*\}\s+from\s+["']zod["']/m.test(source))
      .map(([path]) => path);
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
