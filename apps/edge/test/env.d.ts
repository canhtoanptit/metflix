import type { Env as WorkerEnv } from "../src/index.ts";

// `env` from "cloudflare:workers" carries the bindings declared in wrangler.jsonc, plus the
// D1 migrations the test config reads from packages/db/migrations/d1.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    }
  }
}
