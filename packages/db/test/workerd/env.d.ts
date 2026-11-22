// Bindings declared in vitest.config.ts (miniflare options of the workerd project).
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    /** A second database for the milestone 1 → 2 upgrade test (test/workerd/upgrade.test.ts). */
    DB_UPGRADE: D1Database;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
