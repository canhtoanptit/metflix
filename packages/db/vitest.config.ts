import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const d1MigrationsDir = fileURLToPath(new URL("./migrations/d1", import.meta.url));

/**
 * Two projects, one suite per runtime the repositories ship to:
 * - `node`: SQLite (node:sqlite) always, Postgres when WEBFLIX_TEST_POSTGRES_URL is set
 *   (`pnpm --filter @webflix/db test:postgres` starts a container and sets it).
 * - `workerd`: D1 inside the Workers runtime, migrated with the generated SQL files exactly as
 *   `wrangler d1 migrations apply` would.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["test/**/*.test.ts"],
          exclude: ["test/workerd/**"],
          globalSetup: ["test/postgres-global-setup.ts"],
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
