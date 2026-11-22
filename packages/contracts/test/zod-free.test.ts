/**
 * The client, constants and media helpers must stay free of zod at runtime so the web app's
 * initial bundle does not ship a schema library. This walks the runtime (non-type) imports of
 * each zod-free module transitively and fails on any path that reaches "zod".
 */
import { describe, expect, it } from "vitest";
import {
  ADMIN_ROUTE_INDEX,
  adminRoutes,
  isClientRoute,
  isNavigationRoute,
  NAVIGATION_ROUTE_INDEX,
  ROUTE_INDEX,
  type RouteTable,
  routeIndexOf,
  routes,
} from "../src/index.ts";

const sources = import.meta.glob<string>("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

const ZOD_FREE = [
  "client.ts",
  "constants.ts",
  "error-codes.ts",
  "http.ts",
  "media-helpers.ts",
  "route-index.gen.ts",
  "route.ts",
  "time-left.ts",
];

const IMPORT = /^\s*import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/gm;

/** Runtime import specifiers of a module (`import type` and all-`type` lists excluded). */
function runtimeImports(source: string): string[] {
  const found: string[] = [];
  for (const [, typeOnly, clause = "", specifier = ""] of source.matchAll(IMPORT)) {
    if (typeOnly) continue;
    const named = /^\{([\s\S]*)\}$/.exec(clause.trim());
    const allTypes = named?.[1]
      ?.split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .every((part) => part.startsWith("type "));
    if (!allTypes) found.push(specifier);
  }
  return found;
}

function reachesZod(file: string, seen = new Set<string>()): string[] | null {
  if (seen.has(file)) return null;
  seen.add(file);
  const source = sources[`../src/${file}`];
  if (source === undefined) throw new Error(`Unknown module ${file}`);
  for (const specifier of runtimeImports(source)) {
    if (specifier === "zod" || specifier.startsWith("zod/")) return [file, specifier];
    if (specifier.startsWith("./")) {
      const path = reachesZod(specifier.slice(2), seen);
      if (path) return [file, ...path];
    }
  }
  return null;
}

describe("zod-free runtime modules", () => {
  it.each(ZOD_FREE)("%s does not import zod at runtime", (file) => {
    expect(reachesZod(file)).toBeNull();
  });

  it("detects a runtime zod import (self-test)", () => {
    expect(runtimeImports('import { z } from "zod";')).toEqual(["zod"]);
    expect(runtimeImports('import type { z } from "zod";')).toEqual([]);
    expect(runtimeImports('import { type A, type B } from "./x.ts";')).toEqual([]);
    expect(runtimeImports('import { type A, b } from "./x.ts";')).toEqual(["./x.ts"]);
    expect(reachesZod("media.ts")).not.toBeNull();
  });
});

const pick = (table: RouteTable, keep: (route: RouteTable[string]) => boolean) =>
  Object.fromEntries(Object.entries(table).filter(([, route]) => keep(route)));

describe("generated route index", () => {
  it("matches the route tables (run `pnpm --filter @webflix/contracts generate`)", () => {
    expect(ROUTE_INDEX).toEqual(routeIndexOf(pick(routes, isClientRoute)));
    expect(NAVIGATION_ROUTE_INDEX).toEqual(routeIndexOf(pick(routes, isNavigationRoute)));
    expect(ADMIN_ROUTE_INDEX).toEqual(routeIndexOf(pick(adminRoutes, isClientRoute)));
  });
});
