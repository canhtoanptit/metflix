/** Userinfo (bearer tokens, RFC 6750) and RP-initiated logout. */
import { describe, expect, it } from "vitest";
import {
  CookieJar,
  startTestIssuer,
  TEST_POST_LOGOUT_URI,
  type TestIssuer,
} from "../src/testing/index.ts";
import {
  authorizeUrl,
  decodeJwt,
  freshCode,
  redeem,
  redirectParams,
  userinfo,
} from "./support/flows.ts";

interface Tokens {
  access_token: string;
  id_token: string;
  jar: CookieJar;
}

async function tokens(
  t: TestIssuer,
  scope = "openid email profile",
  persona = "new-member",
): Promise<Tokens> {
  const { code, verifier, jar } = await freshCode(t, { scope }, persona);
  const { body } = await redeem(t, code, verifier);
  return { access_token: String(body.access_token), id_token: String(body.id_token), jar };
}

describe("userinfo", () => {
  it("answers with the claims the scopes release, by GET or POST", async () => {
    const t = startTestIssuer();
    const { access_token } = await tokens(t);
    for (const method of ["GET", "POST"]) {
      const response = await userinfo(t, access_token, { method });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        email: "riley.chen@example.com",
        email_verified: true,
        name: "Riley Chen",
      });
    }
    const emailOnly = await tokens(t, "openid email");
    const body = (await (await userinfo(t, emailOnly.access_token)).json()) as Record<
      string,
      unknown
    >;
    expect(body.email).toBe("riley.chen@example.com");
    expect(body.name).toBeUndefined();
  });

  it("refuses a missing, malformed, misplaced, forged, foreign or expired token", async () => {
    const t = startTestIssuer();
    const { access_token, id_token } = await tokens(t);
    const bare = await t.fetch(new Request(`${t.issuer}/userinfo`));
    expect(bare.status).toBe(401);
    expect(bare.headers.get("WWW-Authenticate")).toBe('Bearer realm="dev-idp"');
    const malformed = await t.fetch(
      new Request(`${t.issuer}/userinfo`, { headers: { Authorization: "Bearer a b" } }),
    );
    expect(malformed.status).toBe(400);
    const inQuery = await t.fetch(new Request(`${t.issuer}/userinfo?access_token=${access_token}`));
    expect(inQuery.status).toBe(400);
    const forged = await userinfo(t, `${access_token.slice(0, -4)}AAAA`);
    expect(forged.status).toBe(401);
    expect(forged.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
    expect((await userinfo(t, id_token)).status).toBe(401);
    // Same development keys, another issuer: the iss check refuses it.
    const other = startTestIssuer({ issuer: "https://other.test" });
    expect((await userinfo(t, (await tokens(other)).access_token)).status).toBe(401);
    t.clock.advance(301_000);
    expect((await userinfo(t, access_token)).status).toBe(401);
  });

  it("opaque access tokens (Google profile) work and are revoked with the session", async () => {
    const t = startTestIssuer({ profile: "google" });
    const { access_token } = await tokens(t);
    expect(access_token.split(".")).toHaveLength(1);
    const body = (await (await userinfo(t, access_token)).json()) as Record<string, unknown>;
    expect(body.sub).toMatch(/^\d{21}$/);
  });

  it("does not exist for the Apple profile", async () => {
    const t = startTestIssuer({ profile: "apple" });
    expect((await t.fetch(new Request(`${t.issuer}/userinfo`))).status).toBe(404);
  });
});

describe("RP-initiated logout", () => {
  function logoutUrl(t: TestIssuer, params: Record<string, string>): URL {
    const url = new URL(`${t.issuer}/logout`);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    return url;
  }
  async function get(t: TestIssuer, url: URL, jar: CookieJar) {
    const cookie = jar.header(url);
    const response = await t.fetch(new Request(url, { headers: cookie ? { Cookie: cookie } : {} }));
    jar.store(url, response);
    return response;
  }
  async function stillSignedIn(t: TestIssuer, jar: CookieJar): Promise<boolean> {
    const { url } = await authorizeUrl(t, { prompt: "none" });
    return redirectParams(await get(t, url, jar)).has("code");
  }

  it("with a valid id_token_hint: ends the session at once and returns to a registered address", async () => {
    const t = startTestIssuer();
    const { id_token, jar } = await tokens(t);
    expect(await stillSignedIn(t, jar)).toBe(true);
    const response = await get(
      t,
      logoutUrl(t, {
        id_token_hint: id_token,
        post_logout_redirect_uri: TEST_POST_LOGOUT_URI,
        state: "s1",
      }),
      jar,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`${TEST_POST_LOGOUT_URI}?state=s1`);
    expect(
      response.headers.getSetCookie().some((cookie) => /_session=; .*Max-Age=0/.test(cookie)),
    ).toBe(true);
    expect(await stillSignedIn(t, jar)).toBe(false);
  });

  it("accepts an expired hint, but never an unregistered address or a forged hint", async () => {
    const t = startTestIssuer();
    const { id_token, jar } = await tokens(t);
    const unregistered = await get(
      t,
      logoutUrl(t, { id_token_hint: id_token, post_logout_redirect_uri: "https://evil.test/" }),
      jar,
    );
    expect(unregistered.status).toBe(400);
    expect(unregistered.headers.get("Location")).toBeNull();
    const nearMiss = await get(
      t,
      logoutUrl(t, {
        id_token_hint: id_token,
        post_logout_redirect_uri: `${TEST_POST_LOGOUT_URI}/`,
      }),
      jar,
    );
    expect(nearMiss.status).toBe(400);
    const noClient = await get(
      t,
      logoutUrl(t, { post_logout_redirect_uri: TEST_POST_LOGOUT_URI }),
      jar,
    );
    expect(noClient.status).toBe(400);
    const forged = await get(
      t,
      logoutUrl(t, { id_token_hint: `${id_token.slice(0, -4)}AAAA` }),
      jar,
    );
    expect(forged.status).toBe(400);
    const mismatch = await get(
      t,
      logoutUrl(t, { id_token_hint: id_token, client_id: "confidential-post" }),
      jar,
    );
    expect(mismatch.status).toBe(400);
    expect(await stillSignedIn(t, jar)).toBe(true);
    t.clock.advance(3600_000);
    const expired = await get(
      t,
      logoutUrl(t, { id_token_hint: id_token, post_logout_redirect_uri: TEST_POST_LOGOUT_URI }),
      jar,
    );
    expect(expired.status).toBe(302);
  });

  it("without a hint: asks for confirmation, protected against CSRF", async () => {
    const t = startTestIssuer();
    const { jar } = await tokens(t);
    const url = logoutUrl(t, {
      client_id: "confidential-basic",
      post_logout_redirect_uri: TEST_POST_LOGOUT_URI,
      state: "s2",
    });
    const page = await get(t, url, jar);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Sign out of the development issuer?");
    expect(page.headers.get("Content-Security-Policy")).toContain(
      "form-action https://dev-idp.test https://rp.test",
    );
    expect(await stillSignedIn(t, jar)).toBe(true);
    const txn = /name="txn" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const post = (cookie: string | undefined, headers: Record<string, string> = {}) =>
      t.fetch(
        new Request(`${t.issuer}/logout`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            ...(cookie ? { Cookie: cookie } : {}),
            ...headers,
          },
          body: new URLSearchParams({ txn, action: "logout" }),
        }),
      );
    expect((await post(undefined)).status).toBe(403);
    expect((await post(jar.header(url), { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    const confirmed = await post(jar.header(url));
    expect(confirmed.status).toBe(303);
    expect(confirmed.headers.get("Location")).toBe(`${TEST_POST_LOGOUT_URI}?state=s2`);
    jar.store(url, confirmed);
    expect(await stillSignedIn(t, jar)).toBe(false);
  });

  it("without a session: a signed-out page", async () => {
    const t = startTestIssuer();
    const response = await get(t, logoutUrl(t, {}), new CookieJar());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Signed out");
  });

  it("does not exist for the Google profile", async () => {
    const t = startTestIssuer({ profile: "google" });
    expect((await t.fetch(new Request(`${t.issuer}/logout`))).status).toBe(404);
  });

  it("ends the access tokens of the session at userinfo", async () => {
    const t = startTestIssuer();
    const { id_token, access_token, jar } = await tokens(t);
    await get(t, logoutUrl(t, { id_token_hint: id_token }), jar);
    expect((await userinfo(t, access_token)).status).toBe(401);
    expect(decodeJwt(access_token).header.typ).toBe("at+jwt");
  });
});
