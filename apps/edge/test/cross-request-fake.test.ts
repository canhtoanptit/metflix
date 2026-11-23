/**
 * One request never awaits a promise another request created or will settle (docs/CLOUDFLARE.md
 * §2), here through the fake payment provider: waves of concurrent clock advances for one
 * customer (`SELF`: each one its own request context in this isolate), and afterwards the
 * isolate must still answer.
 *
 * Before the fix, the fake queued every operation on a customer, and its webhook pump, on
 * in-memory promise chains that every request of the isolate shared. workerd cancelled requests
 * waiting in those queues as "hung" (19 of the first 140 advances, 3 runs out of 3). On Workers
 * the fake runs without them (`inProcessQueues: false`): its compare-and-set on the database
 * already makes concurrent operations safe.
 */
import { applyD1Migrations, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createRouteClient, routes } from "@webflix/contracts";
import { FIXTURE_CATALOG, FIXTURE_MANIFEST } from "@webflix/core/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { getRuntime } from "../src/runtime.ts";

const ORIGIN = "http://localhost:8787";
const WAVES = 20;
const WIDTH = 20;
const JSON_WEB = { "Content-Type": "application/json", "X-Webflix-Client": "web" };

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await getRuntime(env).services.seeder.seed({
    catalog: FIXTURE_CATALOG,
    demoAccount: null,
    manifest: FIXTURE_MANIFEST,
  });
});

/** A browser: its own cookie jar, every request a separate request into the Worker. */
function browser() {
  let cookie = "";
  const send = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set("Cookie", cookie);
    const response = await SELF.fetch(new URL(path, ORIGIN), { ...init, headers });
    for (const value of response.headers.getSetCookie()) {
      const [pair] = value.split(";");
      const [name] = (pair ?? "").split("=");
      if (name && pair) {
        cookie = [
          ...cookie.split("; ").filter((part) => part && !part.startsWith(`${name}=`)),
          pair,
        ].join("; ");
      }
    }
    return response;
  };
  const api = createRouteClient(routes, {
    baseUrl: ORIGIN,
    fetch: (url: string, init: RequestInit) =>
      send(new URL(url).pathname + new URL(url).search, init),
  });
  return { send, api };
}

async function outcome(run: () => Promise<Response>): Promise<string> {
  try {
    const response = await run();
    await response.arrayBuffer();
    return String(response.status);
  } catch (error) {
    // A request workerd cancels rejects here ("... your Worker's code had hung ...").
    return /hung/.test(String(error)) ? "hung" : `error: ${String(error).slice(0, 120)}`;
  }
}

describe("concurrent requests on one customer of the fake provider", () => {
  it("never wait on one another, and leave the isolate answering", async () => {
    const b = browser();
    await b.api.signup({
      body: { email: "concurrent@example.test", password: "correct horse battery" },
    });
    const started = await b.api.startCheckout({ body: { planId: "premium" } });
    const paid = await b.send("/_pay/form", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: started.clientSecret ?? "", card: "visa" }),
    });
    expect(paid.status).toBe(200);
    await b.api.confirmCheckout({ params: { id: started.id } });

    const advance = () =>
      b.send("/api/v1/diagnostics/billing/clock", {
        method: "POST",
        headers: JSON_WEB,
        body: JSON.stringify({ seconds: 3600 }),
      });
    // 503 is the fake's own answer when twenty writers keep beating each other to one
    // customer's compare-and-set ("the state kept changing; retry"), as a real provider may.
    const expected = new Set(["200", "503"]);
    const outcomes: Record<string, number> = {};
    for (let wave = 0; wave < WAVES; wave += 1) {
      const answers = await Promise.all(Array.from({ length: WIDTH }, () => outcome(advance)));
      for (const answer of answers) outcomes[answer] = (outcomes[answer] ?? 0) + 1;
      if (Object.keys(outcomes).some((key) => !expected.has(key))) break;
    }
    expect(Object.keys(outcomes).filter((key) => !expected.has(key))).toEqual([]);
    expect(outcomes["200"]).toBeGreaterThan((WAVES * WIDTH) / 2);
    expect(await outcome(advance)).toBe("200");
    expect(await outcome(() => b.send(`/api/v1/billing/checkout/${started.id}`))).toBe("200");
  }, 60_000);
});
