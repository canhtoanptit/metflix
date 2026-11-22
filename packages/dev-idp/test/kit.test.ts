/** The relying-party test kit itself, and the runtime the suite runs in. */
import { describe, expect, inject, it } from "vitest";
import {
  CookieJar,
  completeAuthorization,
  createPkce,
  ManualClock,
  startTestIssuer,
  TEST_REDIRECT_URI,
} from "../src/testing/index.ts";

describe("the runtime", () => {
  it("is the one this project claims", () => {
    const runtime = inject("runtime");
    expect(
      navigator.userAgent.startsWith(runtime === "workerd" ? "Cloudflare-Workers" : "Node.js"),
    ).toBe(true);
  });
});

describe("ManualClock", () => {
  it("starts at the real time in whole seconds and only moves when told", () => {
    const clock = new ManualClock();
    expect(clock.now() % 1000).toBe(0);
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(5000);
    clock.advance(1500);
    clock.set(0);
    expect(clock.now()).toBe(0);
    expect(() => clock.advance(-1)).toThrow(RangeError);
  });
});

describe("completeAuthorization", () => {
  it("drives an authorisation URL an application built, and builds the callback request", async () => {
    const t = startTestIssuer();
    const { challenge } = await createPkce();
    const url = new URL(`${t.issuer}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: "public-spa",
      redirect_uri: TEST_REDIRECT_URI,
      scope: "openid",
      state: "st",
      nonce: "nn",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    const outcome = await completeAuthorization(url, { persona: "new-member" }, { fetch: t.fetch });
    expect(outcome).toMatchObject({
      mode: "query",
      redirectUri: TEST_REDIRECT_URI,
      state: "st",
      iss: t.issuer,
      interactive: true,
    });
    const request = outcome.toRequest({ headers: { Cookie: "rp=1" } });
    expect(request.method).toBe("GET");
    expect(new URL(request.url).searchParams.get("code")).toBe(outcome.code);
    expect(request.headers.get("Cookie")).toBe("rp=1");

    url.searchParams.set("response_mode", "form_post");
    const posted = await completeAuthorization(url, { persona: "new-member" }, { fetch: t.fetch });
    const post = posted.toRequest();
    expect(post.method).toBe("POST");
    expect(post.url).toBe(TEST_REDIRECT_URI);
    expect(new URLSearchParams(await post.text()).get("code")).toBe(posted.code);
  });

  it("single sign-on with a shared jar, cancel, and an issuer error page", async () => {
    const t = startTestIssuer();
    const jar = new CookieJar();
    const first = await t.signIn({ persona: "demo-verified", jar });
    expect(first.outcome.interactive).toBe(true);
    const second = await t.signIn({ jar });
    expect(second.outcome.interactive).toBe(false);
    expect(second.outcome.code).toBeTruthy();
    expect((await t.signIn({ cancel: true })).outcome.error).toBe("access_denied");
    await expect(
      t.signIn({ persona: "new-member", redirectUri: "https://evil.test/" }),
    ).rejects.toThrow(/Redirect URI not registered/);
    await expect(t.signIn({})).rejects.toThrow(/Choose a persona/);
  });

  it("typed emails and per-sign-in faults", async () => {
    const t = startTestIssuer();
    const result = await t.signIn({
      email: { address: "kit@example.com", verified: false },
      faults: { tamperedState: true },
    });
    expect(result.outcome.state).not.toBe(result.state);
    const tokens = await t.redeem(result.outcome, { verifier: result.verifier });
    const claims = JSON.parse(
      atob((tokens.id_token ?? "").split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/") ?? ""),
    ) as Record<string, unknown>;
    expect(claims).toMatchObject({ email: "kit@example.com", email_verified: false });
  });

  it("standing faults apply to silent sign-ins too, until cleared", async () => {
    const t = startTestIssuer();
    const jar = new CookieJar();
    await t.signIn({ persona: "new-member", jar });
    t.idp.faults.set({ wrongResponseIssuer: true });
    expect(t.idp.faults.active).toEqual({ wrongResponseIssuer: true });
    expect((await t.signIn({ jar })).outcome.iss).toBe(`${t.issuer}-mixup`);
    t.idp.faults.clear();
    expect((await t.signIn({ jar })).outcome.iss).toBe(t.issuer);
  });
});
