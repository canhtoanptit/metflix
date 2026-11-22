import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * The same suite runs twice: on Node, and inside workerd (the Workers runtime) to prove the
 * issuer and the test kit use nothing but Web-standard APIs. `test/node` (a real port) is
 * Node-only.
 */
export default defineConfig({
  test: {
    projects: [
      { test: { name: "node", include: ["test/**/*.test.ts"], provide: { runtime: "node" } } },
      {
        plugins: [cloudflareTest({ miniflare: { compatibilityDate: "2026-11-19" } })],
        test: {
          name: "workerd",
          include: ["test/**/*.test.ts"],
          exclude: ["test/node/**"],
          provide: { runtime: "workerd" },
        },
      },
    ],
  },
});
