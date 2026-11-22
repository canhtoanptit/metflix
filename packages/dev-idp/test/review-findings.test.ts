/**
 * Regressions for the findings of an independent security review: each test failed before its fix.
 */
import { describe, expect, it } from "vitest";
import { CookieJar, startTestIssuer, type TestIssuer } from "../src/testing/index.ts";
import {
  authorizeUrl,
  basic,
  decodeJwt,
  freshCode,
  openPicker,
  redeem,
  redirectParams,
  submitPicker,
  tokenRequest,
  userinfo,
} from "./support/flows.ts";

async function signIn(t: TestIssuer, scope: string, persona = "new-member") {
  const { code, verifier, jar } = await freshCode(t, { scope }, persona);
  return { jar, body: (await redeem(t, code, verifier)).body };
}

describe("jwksRotatedMidFlow is confined to the faulted response", () => {
  it("leaves the current key alone and keeps the JWKS bounded", async () => {
    const t = startTestIssuer();
    const current = t.idp.keys
      .list()
      .find((key) => key.alg === "RS256" && key.status === "current")?.kid;
    const before = t.idp.keys.jwks().keys.length;
    for (let index = 0; index < 4; index += 1) {
      const faulted = await t.signIn({
        persona: "new-member",
        faults: { jwksRotatedMidFlow: true },
      });
      const tokens = await t.redeem(faulted.outcome, { verifier: faulted.verifier });
      expect(decodeJwt(tokens.id_token ?? "").header.kid).not.toBe(current);
      // The JWT access token of the same response is signed with the same late key.
      expect(decodeJwt(tokens.access_token).header.kid).toBe(
        decodeJwt(tokens.id_token ?? "").header.kid,
      );
    }
    const normal = await signIn(t, "openid");
    expect(decodeJwt(normal.body.id_token as string).header.kid).toBe(current);
    expect(t.idp.keys.jwks().keys.length).toBe(before + 2);
  });
});

describe("end-session binds id_token_hint to the session", () => {
  it("a valid hint from another session asks for confirmation instead of signing out", async () => {
    const t = startTestIssuer();
    const victim = await signIn(t, "openid offline_access");
    const attacker = await signIn(t, "openid", "no-email");
    const url = new URL(`${t.issuer}/logout`);
    url.searchParams.set("id_token_hint", attacker.body.id_token as string);
    const cookie = victim.jar.header(url);
    const response = await t.fetch(new Request(url, { headers: cookie ? { Cookie: cookie } : {} }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Sign out of the development issuer?");
    const refreshed = await tokenRequest(t, {
      grant_type: "refresh_token",
      refresh_token: victim.body.refresh_token as string,
    });
    expect(refreshed.status).toBe(200);
  });

  it("revocation outlives the session when refresh tokens live longer", async () => {
    const t = startTestIssuer({ lifetimes: { sessionSec: 3600, refreshTokenSec: 6 * 3600 } });
    const { jar, body } = await signIn(t, "openid offline_access");
    const url = new URL(`${t.issuer}/logout?id_token_hint=${body.id_token as string}`);
    await t.fetch(new Request(url, { headers: { Cookie: jar.header(url) ?? "" } }));
    t.clock.advance(2 * 3600 * 1000);
    const refreshed = await tokenRequest(t, {
      grant_type: "refresh_token",
      refresh_token: body.refresh_token as string,
    });
    expect(refreshed.body.error).toBe("invalid_grant");
  });
});

describe("refresh", () => {
  it("a narrower scope narrows the tokens issued, not the new refresh token (RFC 6749 §6)", async () => {
    const t = startTestIssuer();
    const { body } = await signIn(t, "openid email profile offline_access");
    const narrowed = await tokenRequest(t, {
      grant_type: "refresh_token",
      refresh_token: body.refresh_token as string,
      scope: "openid",
    });
    expect(narrowed.body.scope).toBe("openid");
    const widened = await tokenRequest(t, {
      grant_type: "refresh_token",
      refresh_token: narrowed.body.refresh_token as string,
      scope: "openid email",
    });
    expect(widened.status).toBe(200);
    expect(widened.body.scope).toBe("openid email");
  });

  it("keeps the identity faults of the sign-in: same sub, same email_verified (OIDC Core §12.2)", async () => {
    const t = startTestIssuer();
    const faulted = await t.signIn({
      persona: "new-member",
      scope: "openid email offline_access",
      faults: { subjectChanged: true, emailUnverified: true },
    });
    const tokens = await t.redeem(faulted.outcome, { verifier: faulted.verifier });
    const original = decodeJwt(tokens.id_token ?? "").claims;
    const refreshed = await tokenRequest(t, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token ?? "",
    });
    const claims = decodeJwt(refreshed.body.id_token as string).claims;
    expect(claims.sub).toBe(original.sub);
    expect(claims.email_verified).toBe(false);
  });
});

describe("token faults aimed at an opaque access token", () => {
  it("make the issuer refuse it at userinfo (Google profile)", async () => {
    for (const faults of [
      { expired: { target: "access_token" as const } },
      { wrongAudience: { target: "access_token" as const } },
      { algNone: { target: "both" as const } },
    ]) {
      const t = startTestIssuer({ profile: "google" });
      const result = await t.signIn({
        clientId: "confidential-basic",
        persona: "new-member",
        faults,
      });
      const tokens = await t.redeem(result.outcome, {
        clientId: "confidential-basic",
        verifier: result.verifier,
      });
      expect((await userinfo(t, tokens.access_token)).status).toBe(401);
    }
  });
});

describe("input the stand-in must refuse cleanly", () => {
  it("state and nonce are printable ASCII (VSCHAR) within their limits", async () => {
    const t = startTestIssuer();
    for (const params of [
      { state: "€".repeat(10) },
      { state: "\u0001x" },
      { state: "s".repeat(1025) },
      { nonce: "\u0000" },
      { login_hint: "a‮b@example.com" },
    ]) {
      const { url } = await authorizeUrl(t, params);
      const response = await t.fetch(new Request(url));
      expect(redirectParams(response).get("error")).toBe("invalid_request");
    }
  });

  it("the largest accepted request still fits the sign-in page round trip", async () => {
    const t = startTestIssuer();
    const { url, verifier } = await authorizeUrl(t, {
      state: `"\\`.repeat(512),
      nonce: `"\\`.repeat(256),
      login_hint: `${"é".repeat(300)}@example.com`.slice(0, 320),
    });
    const picker = await openPicker(t, url);
    const response = await submitPicker(t, picker, { persona: "new-member" });
    expect(response.status).toBe(303);
    const params = redirectParams(response);
    expect(params.get("state")).toBe(`"\\`.repeat(512));
    expect((await redeem(t, params.get("code") ?? "", verifier)).status).toBe(200);
  });

  it("a typed email with control or bidi characters is refused", async () => {
    const t = startTestIssuer();
    const picker = await openPicker(t, (await authorizeUrl(t)).url);
    for (const email of ["a\u0000b@example.com", "a‮b@example.com"]) {
      const response = await submitPicker(t, picker, { persona: "__email__", email });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('role="alert"');
    }
  });

  it("authentication schemes are case-insensitive (RFC 7235 §2.1)", async () => {
    const t = startTestIssuer();
    const { code, verifier } = await freshCode(t);
    const lower = basic("confidential-basic", "confidential-basic-secret").replace(
      "Basic",
      "basic",
    );
    const tokens = await redeem(t, code, verifier, {}, { Authorization: lower });
    expect(tokens.status).toBe(200);
    const response = await t.fetch(
      new Request(`${t.issuer}/userinfo`, {
        headers: { Authorization: `bearer ${tokens.body.access_token as string}` },
      }),
    );
    expect(response.status).toBe(200);
  });

  it("a signature of the wrong length is a 401, never a 500 (ES256)", async () => {
    const t = startTestIssuer();
    const { code, verifier } = await freshCode(t, { client_id: "es256-client" });
    const tokens = await redeem(
      t,
      code,
      verifier,
      {},
      { Authorization: basic("es256-client", "es256-client-secret-value") },
    );
    const [h, c] = (tokens.body.access_token as string).split(".");
    for (const signature of ["AAAA", "A".repeat(200), ""]) {
      expect((await userinfo(t, `${h}.${c}.${signature}`)).status).toBe(401);
    }
    const hint = new URL(`${t.issuer}/logout`);
    const [ih, ic] = (tokens.body.id_token as string).split(".");
    hint.searchParams.set("id_token_hint", `${ih}.${ic}.AAAA`);
    expect((await t.fetch(new Request(hint))).status).toBe(400);
  });
});

describe("Apple first authorisation without a store", () => {
  it("forcing it once does not make the next sign-in a first authorisation too", async () => {
    const t = startTestIssuer({ profile: "apple", store: "none" });
    const sent: boolean[] = [];
    for (const forced of [false, false, true, false, false]) {
      const result = await t.signIn({
        clientId: "apple-style",
        persona: "new-member",
        scope: "openid email name",
        firstAuthorisation: forced,
      });
      sent.push(result.outcome.user !== null);
    }
    expect(sent).toEqual([true, false, true, false, false]);
  });
});

describe("the CSRF cookie survives a cross-site arrival", () => {
  it("is SameSite=Lax, so other open sign-in pages keep working", async () => {
    const t = startTestIssuer();
    const jar = new CookieJar();
    const first = await openPicker(t, (await authorizeUrl(t)).url, jar);
    expect(first.response.headers.getSetCookie()[0]).toContain("SameSite=Lax");
    const second = await openPicker(t, (await authorizeUrl(t)).url, jar);
    expect((await submitPicker(t, first, { persona: "new-member" })).status).toBe(303);
    expect((await submitPicker(t, second, { persona: "new-member" })).status).toBe(303);
  });
});
