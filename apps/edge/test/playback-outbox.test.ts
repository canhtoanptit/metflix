/**
 * Two heartbeats of one playback session reaching the Worker together (the same report, the same
 * millisecond: seen in a browser run on the local Worker) are both answered as recorded, and the
 * event they both produce is in the outbox once. The outbox row's id is derived from the session
 * and the milestone, so the second write of it is "already there", never a failed request.
 */
import { applyD1Migrations, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { FIXTURE_CATALOG, FIXTURE_DEMO_ACCOUNT, FIXTURE_MANIFEST } from "@webflix/core/testing";
import { createRepositories } from "@webflix/db";
import { createD1Database } from "@webflix/db/d1";
import { beforeAll, describe, expect, it } from "vitest";
import { getRuntime } from "../src/runtime.ts";

const jar = new Map<string, string>();

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("X-Webflix-Client", "web");
  headers.set("Content-Type", "application/json");
  headers.set("CF-Connecting-IP", "192.0.2.44");
  if (jar.size > 0) headers.set("Cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
  const response = await SELF.fetch(`http://localhost:8787${path}`, { ...init, headers });
  for (const cookie of response.headers.getSetCookie()) {
    const [pair = ""] = cookie.split(";");
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  }
  return response;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await getRuntime(env).services.seeder.seed({
    catalog: FIXTURE_CATALOG,
    demoAccount: FIXTURE_DEMO_ACCOUNT,
    manifest: FIXTURE_MANIFEST,
  });
  const login = await call("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: FIXTURE_DEMO_ACCOUNT.email, password: "webflix-demo" }),
  });
  if (login.status !== 200) throw new Error(`login: ${login.status} ${await login.text()}`);
  await call("/api/v1/session/profile", {
    method: "PUT",
    body: JSON.stringify({ profileId: "pr-demo" }),
  });
});

describe("the playback outbox through the Worker", () => {
  it("answers two identical heartbeats arriving together, and keeps their event once", async () => {
    const start = await call("/api/v1/playback/sessions", {
      method: "POST",
      body: JSON.stringify({ titleId: "t-orbit" }),
    });
    expect(start.status).toBe(201);
    const session = (await start.json()) as { id: string };
    // Past 95% of the item: both reports cross the completion milestone, the same event.
    const report = JSON.stringify({ positionSec: 5200, durationSec: 5400, state: "playing" });
    const [first, second] = await Promise.all(
      [1, 2].map(() =>
        call(`/api/v1/playback/sessions/${session.id}/heartbeat`, {
          method: "POST",
          body: report,
        }),
      ),
    );
    expect([first?.status, second?.status]).toEqual([200, 200]);
    const repos = createRepositories(createD1Database(env.DB));
    const rows = await repos.events.takeOutbox(100);
    const completes = rows.filter((row) => row.payload.includes("playback.complete"));
    expect(completes).toHaveLength(1);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    // The progress landed once, at the reported position.
    expect(await repos.playback.get(session.id)).toMatchObject({
      positionSec: 5200,
      endedAt: null,
    });
  });
});
