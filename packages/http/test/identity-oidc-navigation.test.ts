/**
 * The OpenID callbacks are browser navigations: a request refused before its handler runs (by
 * validation, a mistyped or oversized form body, or the `oidc` rate limit) is still answered
 * with the redirect every other failure gets, never a problem document. So is a refused start a
 * browser followed; a programmatic caller of the start keeps the problem document. And the
 * sign-in issuers a deployment offers are listed for anonymous visitors without touching the
 * database.
 */
import { createMemoryRepositories, MemoryIdentityProvider } from "@webflix/core/memory";
import { describe, expect, it } from "vitest";
import { createTestApp, type Device, type TestApp } from "./support.ts";

const CALLBACK = "/api/v1/auth/oidc/google/callback";
const APPLE_CALLBACK = "/api/v1/auth/oidc/apple/callback";

async function offer(t: TestApp): Promise<void> {
  t.deps.identityProviders.google = new MemoryIdentityProvider({ id: "google", clock: t.clock });
  t.deps.identityProviders.apple = new MemoryIdentityProvider({ id: "apple", clock: t.clock });
}

function expectFailedRedirect(response: Response, path = "/", error?: string): void {
  expect(response.status).toBe(303);
  expect(response.headers.get("Location")).toBe(
    `http://localhost:5173${path}?oidc=failed${error ? `&oidcError=${error}` : ""}`,
  );
  expect(response.headers.get("Content-Type") ?? "").not.toMatch(/json/);
}

const NAVIGATE = { "Sec-Fetch-Mode": "navigate", Accept: "text/html" };

async function startAt(device: Device, provider: string, returnTo: string): Promise<void> {
  const started = await device.request(
    `/api/v1/auth/oidc/${provider}/start?returnTo=${encodeURIComponent(returnTo)}`,
  );
  expect(started.status).toBe(302);
  expect([...device.cookies.keys()]).toContain(`webflix_oidc_${provider}`);
}

describe("OpenID callbacks refused before their handler", () => {
  it("redirect an invalid query, an unknown issuer and a malformed form post back to the app", async () => {
    const t = await createTestApp();
    await offer(t);
    const device = t.device();
    await startAt(device, "google", "/after");
    // Over the contract's limits: validation refuses it before the handler.
    const oversized = await device.request(`${CALLBACK}?code=${"x".repeat(5000)}&state=s`);
    expectFailedRedirect(oversized, "/after");
    // The transaction is abandoned: the browser drops its cookie.
    expect(device.cookies.has("webflix_oidc_google")).toBe(false);
    expectFailedRedirect(
      await device.request("/api/v1/auth/oidc/facebook/callback?code=c&state=s"),
    );

    await startAt(device, "apple", "/apple-return");
    const form = (body: string, type = "application/x-www-form-urlencoded") =>
      device.request(APPLE_CALLBACK, { method: "POST", headers: { "Content-Type": type }, body });
    expectFailedRedirect(await form("code=a&code=b&state=s"), "/apple-return"); // a repeated field
    expectFailedRedirect(await form('{"code":"a"}', "application/json")); // not a form
    expectFailedRedirect(await form(`user=${"x".repeat(40_000)}`)); // over the body cap
  });

  it("keep the oidc rate limit, refusing over it with the same redirect", async () => {
    const t = await createTestApp({ config: { WEBFLIX_RATE_LIMIT_OIDC: "3/60" } });
    await offer(t);
    const device = t.device();
    await startAt(device, "google", "/limited"); // 1
    expectFailedRedirect(await device.request(`${CALLBACK}?code=c&state=s`), "/limited"); // 2: the handler refuses the state
    await startAt(device, "google", "/limited"); // 3
    // 4: over the limit, refused by the guard before the handler; the reason is marked.
    const limited = await device.request(`${CALLBACK}?code=c&state=s`);
    expectFailedRedirect(limited, "/limited", "rate_limited");
    expect(limited.headers.get("Retry-After")).toBeNull();
    const apple = await device.request(APPLE_CALLBACK, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "code=c&state=s",
    });
    expectFailedRedirect(apple, "/", "rate_limited");
    const refusals = t.logger.records.filter((record) => record.msg === "identity.oidc_refused");
    expect(refusals.map((record) => record.code)).toEqual(["rate_limited", "rate_limited"]);
    // A start followed from a link: back to its returnTo with the reason; a script: 429.
    expectFailedRedirect(
      await device.request("/api/v1/auth/oidc/google/start?returnTo=/signin", {
        headers: NAVIGATE,
      }),
      "/signin",
      "rate_limited",
    );
    const scripted = await device.request("/api/v1/auth/oidc/google/start?returnTo=/signin");
    expect(scripted.status).toBe(429);
    expect(scripted.headers.get("Retry-After")).not.toBeNull();
    expect(
      t.logger.records
        .filter((record) => record.msg === "identity.oidc_start_refused")
        .map((record) => record.code),
    ).toEqual(["rate_limited"]);
  });

  it("send a refused start a browser followed back with the reason, never a problem document", async () => {
    const t = await createTestApp();
    await offer(t);
    const device = t.device();
    // Signed out, a link or a proof cannot start.
    const link = await device.request(
      "/api/v1/auth/oidc/google/start?intent=link&returnTo=/account",
      { headers: NAVIGATE },
    );
    expectFailedRedirect(link, "/account", "unauthenticated");
    expect(device.cookies.has("webflix_oidc_google")).toBe(false);
    // An issuer Webflix does not know: the returnTo asked for is still honoured.
    expectFailedRedirect(
      await device.request("/api/v1/auth/oidc/facebook/start?returnTo=/x", { headers: NAVIGATE }),
      "/x",
      "validation_failed",
    );
    // An invalid returnTo: the root.
    for (const returnTo of ["https://evil.example/", "//evil.example", "/\\evil.example"]) {
      expectFailedRedirect(
        await device.request(
          `/api/v1/auth/oidc/google/start?intent=reauth&returnTo=${encodeURIComponent(returnTo)}`,
          { headers: NAVIGATE },
        ),
        "/",
        "validation_failed",
      );
    }
    // The page's own fetch is not a navigation.
    const fetched = await device.request(
      "/api/v1/auth/oidc/google/start?intent=link&returnTo=/account",
      { headers: { "Sec-Fetch-Mode": "cors", Accept: "text/html" } },
    );
    expect(fetched.status).toBe(401);
    expect(fetched.headers.get("Content-Type")).toMatch(/problem\+json/);
  });
});

describe("GET /auth/providers", () => {
  it("lists the configured issuers in button order, publicly cacheable, without a database read", async () => {
    const repos = createMemoryRepositories();
    const t = await createTestApp({ repos });
    await offer(t);
    const before = repos.store.queries;
    const response = await t.request("/api/v1/auth/providers");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        { id: "google", displayName: "google" },
        { id: "apple", displayName: "apple" },
      ],
    });
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(response.headers.get("Vary") ?? "").not.toMatch(/Cookie/);
    expect(repos.store.queries).toBe(before);
  });

  it("is empty when no issuer is offered", async () => {
    const t = await createTestApp();
    expect(await (await t.request("/api/v1/auth/providers")).json()).toEqual({ items: [] });
  });
});
