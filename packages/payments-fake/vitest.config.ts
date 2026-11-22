import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const d1MigrationsDir = fileURLToPath(new URL("../db/migrations/d1", import.meta.url));

/**
 * The fake runs in both runtimes it ships to:
 * - `node`: the provider over memory and over SQLite (`test/node`), the form over HTTP;
 * - `workerd`: the provider over D1 inside the Workers runtime, migrated with the generated
 *   SQL files exactly as `wrangler d1 migrations apply` would.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["test/**/*.test.ts"],
          exclude: ["test/workerd/**"],
        },
      },
      {
        plugins: [
          cloudflareTest(async () => ({
            miniflare: {
              compatibilityDate: "2026-11-01",
              d1Databases: ["DB"],
              bindings: { TEST_MIGRATIONS: await readD1Migrations(d1MigrationsDir) },
            },
          })),
        ],
        test: {
          name: "workerd",
          include: ["test/workerd/**/*.test.ts"],
        },
      },
    ],
  },
});
