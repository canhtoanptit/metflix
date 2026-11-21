import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = join(import.meta.dirname, "..", "..", "packages", "db", "migrations", "d1");
const assets = join(import.meta.dirname, "dist", "public");

// wrangler.jsonc serves ./dist/public (staged by `make cf-assets`). A fresh checkout that only
// runs tests gets a stand-in SPA shell so the asset router can still be exercised.
if (!existsSync(`${assets}/index.html`)) {
  mkdirSync(assets, { recursive: true });
  writeFileSync(`${assets}/index.html`, '<!doctype html><div id="root"></div>\n');
}

/**
 * Two runtimes:
 * - `workerd`: the Worker with the bindings of wrangler.jsonc (top level = local), D1 migrated
 *   with the generated SQL files exactly as `wrangler d1 migrations apply` does.
 * - `node`: invariants of the configuration itself (wrangler.jsonc vs the code).
 */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations(migrations),
                // Test the production (strict) rate-limit defaults, not the local dev profile:
                // empty values are ignored by the config loader.
                WEBFLIX_RATE_LIMIT_AUTH: "",
                WEBFLIX_RATE_LIMIT_SIGNUP: "",
                WEBFLIX_RATE_LIMIT_EMAIL_LOOKUP: "",
                WEBFLIX_RATE_LIMIT_PROFILE_PIN: "",
              },
            },
          })),
        ],
        test: { name: "workerd", include: ["test/**/*.test.ts"], exclude: ["test/node/**"] },
      },
      { test: { name: "node", include: ["test/node/**/*.test.ts"] } },
    ],
  },
});
