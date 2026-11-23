/**
 * One request never awaits a promise another request created or will settle (docs/CLOUDFLARE.md
 * §2). Waves of concurrent requests through the real Worker (`SELF`: each one its own request
 * context in this isolate), each running two D1 queries one after the other (the session, then
 * the consent row), and afterwards the isolate must still answer.
 *
 * Before the fix, Kysely's SQLite adapter declared one connection, so its RuntimeDriver put a
 * process-wide promise lock in front of every D1 query: requests waited on each other's promises.
 * workerd cancelled some of them as "hung", a cancelled request never released the lock, and
 * every later query of the isolate waited for ever (every request a 500, `/readyz` timing out).
 * This test failed 3 runs out of 3 that way, within the first waves.
 */
import { applyD1Migrations, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { FIXTURE_CATALOG, FIXTURE_DEMO_ACCOUNT, FIXTURE_MANIFEST } from "@webflix/core/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { getRuntime } from "../src/runtime.ts";

const BASE = "http://localhost:8787";
const WAVES = 20;
const WIDTH = 200;
let cookie = "";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await getRuntime(env).services.seeder.seed({
    catalog: FIXTURE_CATALOG,
    demoAccount: FIXTURE_DEMO_ACCOUNT,
    manifest: FIXTURE_MANIFEST,
  });
  const login = await SELF.fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Webflix-Client": "web" },
    body: JSON.stringify({ email: FIXTURE_DEMO_ACCOUNT.email, password: "webflix-demo" }),
  });
  expect(login.status).toBe(200);
  cookie = login.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
});

async function readConsent(): Promise<string> {
  try {
    const response = await SELF.fetch(`${BASE}/api/v1/privacy/consent`, {
      headers: { Cookie: cookie },
    });
    await response.arrayBuffer();
    return String(response.status);
  } catch (error) {
    // A request workerd cancels rejects here ("... your Worker's code had hung ...").
    return /hung/.test(String(error)) ? "hung" : `error: ${String(error).slice(0, 120)}`;
  }
}

describe("concurrent requests through one isolate", () => {
  it("never wait on one another, and leave the database answering", async () => {
    const outcomes: Record<string, number> = {};
    for (let wave = 0; wave < WAVES; wave += 1) {
      const answers = await Promise.all(Array.from({ length: WIDTH }, readConsent));
      for (const outcome of answers) outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      // Stop at the first bad wave: a stuck isolate would only repeat it.
      if (Object.keys(outcomes).some((key) => key !== "200")) break;
    }
    expect(outcomes).toEqual({ 200: WAVES * WIDTH });
    // A request that starts afterwards is still served, database included.
    expect(await readConsent()).toBe("200");
    const ready = await SELF.fetch(`${BASE}/readyz`);
    expect(ready.status).toBe(200);
  });
});
