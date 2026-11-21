// Bindings declared in vitest.config.ts (miniflare options of the workerd project).
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
