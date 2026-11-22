/**
 * Conformance-style walk: the independent relying party in ./support (written from the
 * specifications, sharing no code with the provider) signs in against every profile and every
 * client authentication method, then exercises userinfo, refresh rotation, single sign-on,
 * re-authentication with max_age and RP-initiated logout.
 */
import { describe, expect, it } from "vitest";
import { DEVELOPMENT_APPLE_CLIENT_KEY } from "../src/index.ts";
import {
  startTestIssuer,
  TEST_POST_LOGOUT_URI,
  TEST_REDIRECT_URI,
  type TestIssuer,
} from "../src/testing/index.ts";
import {
  IndependentRp,
  type RpClientAuth,
  RpError,
  signInWith,
  UserAgent,
} from "./support/independent-rp.ts";

const APPLE_JWT: RpClientAuth = {
  method: "apple_jwt",
  privateJwk: { ...DEVELOPMENT_APPLE_CLIENT_KEY },
  teamId: "DEVTEAM001",
  keyId: "DEVKEY0001",
};

function rpFor(
  t: TestIssuer,
  clientId: string,
  auth: RpClientAuth,
  algorithms?: string[],
): IndependentRp {
  return new IndependentRp({
    issuer: t.issuer,
    clientId,
    redirectUri: TEST_REDIRECT_URI,
    auth,
    fetch: t.fetch,
    now: () => t.clock.now(),
    ...(algorithms ? { algorithms } : {}),
  });
}

async function rejected(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpError) return error.code;
    throw error;
  }
  return "accepted";
}

describe("generic profile, every client authentication method", () => {
  const cases: Array<[string, RpClientAuth, string[]?]> = [
    ["confidential-basic", { method: "client_secret_basic", secret: "confidential-basic-secret" }],
    ["confidential-post", { method: "client_secret_post", secret: "confidential-post-secret" }],
    ["public-spa", { method: "none" }],
    ["apple-style", APPLE_JWT],
    [
      "es256-client",
      { method: "client_secret_post", secret: "es256-client-secret-value" },
      ["ES256"],
    ],
  ];
  for (const [clientId, auth, algorithms] of cases) {
    it(`signs in with ${clientId} (${auth.method})`, async () => {
      const t = startTestIssuer();
      const rp = rpFor(t, clientId, auth, algorithms);
      const result = await signInWith(
        rp,
        new UserAgent(t.fetch),
        { persona: "new-member" },
        {
          scope: "openid email profile",
        },
      );
      const header = JSON.parse(atob(result.idToken.split(".")[0] ?? "")) as { alg: string };
      expect(header.alg).toBe(algorithms?.[0] ?? "RS256");
      expect(result.idClaims).toMatchObject({
        iss: t.issuer,
        aud: clientId,
        email: "riley.chen@example.com",
        email_verified: true,
        name: "Riley Chen",
      });
      expect(typeof result.idClaims.picture).toBe("string");
      expect(typeof result.idClaims.auth_time).toBe("number");
      expect(typeof result.idClaims.at_hash).toBe("string");
      const info = await rp.userinfo(result.accessToken, String(result.idClaims.sub));
      expect(info).toMatchObject({ email: "riley.chen@example.com", name: "Riley Chen" });
    });
  }
});

describe("the session, refresh and logout lifecycle (generic profile)", () => {
  it("rotates refresh tokens and detects reuse", async () => {
    const t = startTestIssuer();
    const rp = rpFor(t, "confidential-basic", {
      method: "client_secret_basic",
      secret: "confidential-basic-secret",
    });
    const first = await signInWith(
      rp,
      new UserAgent(t.fetch),
      { persona: "new-member" },
      {
        scope: "openid email profile offline_access",
      },
    );
    expect(first.refreshToken).not.toBeNull();
    t.clock.advance(60_000);
    const second = await rp.refresh(first.refreshToken ?? "", first.idClaims);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.idClaims.auth_time).toBe(first.idClaims.auth_time);
    expect(second.idClaims.nonce).toBeUndefined();
    // The rotated-out token comes back: the whole family is revoked, including the newest token.
    expect(await rejected(rp.refresh(first.refreshToken ?? "", first.idClaims))).toBe(
      "token_error:invalid_grant",
    );
    expect(await rejected(rp.refresh(second.refreshToken ?? "", first.idClaims))).toBe(
      "token_error:invalid_grant",
    );
    expect(await rejected(rp.userinfo(second.accessToken, String(first.idClaims.sub)))).toBe(
      "userinfo_error:401",
    );
  });

  it("signs in silently with a session, and re-authenticates for max_age=0", async () => {
    const t = startTestIssuer();
    const rp = rpFor(t, "confidential-post", {
      method: "client_secret_post",
      secret: "confidential-post-secret",
    });
    const agent = new UserAgent(t.fetch);
    const first = await signInWith(
      rp,
      agent,
      { persona: "demo-verified" },
      { scope: "openid email" },
    );
    t.clock.advance(120_000);
    // Single sign-on: no page, same auth_time.
    const silent = await signInWith(rp, agent, {}, { scope: "openid email", prompt: "none" });
    expect(silent.idClaims.auth_time).toBe(first.idClaims.auth_time);
    expect(silent.idClaims.sub).toBe(first.idClaims.sub);
    // max_age=0: the page is shown again and auth_time is now.
    const fresh = await signInWith(
      rp,
      agent,
      { persona: "demo-verified" },
      { scope: "openid email", maxAge: 0 },
    );
    expect(fresh.idClaims.auth_time).toBe(Math.floor(t.clock.now() / 1000));
    // And prompt=none with max_age=0 cannot be satisfied without interaction.
    const { url, transaction } = await rp.begin({ scope: "openid", prompt: "none", maxAge: 0 });
    const delivered = await agent.authorize(url, {});
    expect(await rejected(rp.callback(delivered.params, transaction))).toBe(
      "authorization_error:login_required",
    );
  });

  it("ends the session through RP-initiated logout", async () => {
    const t = startTestIssuer();
    const rp = rpFor(t, "confidential-basic", {
      method: "client_secret_basic",
      secret: "confidential-basic-secret",
    });
    const agent = new UserAgent(t.fetch);
    const signedIn = await signInWith(
      rp,
      agent,
      { persona: "new-member" },
      { scope: "openid offline_access" },
    );
    const logout = await agent.get(
      await rp.logoutUrl(signedIn.idToken, TEST_POST_LOGOUT_URI, "bye"),
    );
    expect(logout.status).toBe(302);
    expect(logout.headers.get("Location")).toBe(`${TEST_POST_LOGOUT_URI}?state=bye`);
    const { url, transaction } = await rp.begin({ scope: "openid", prompt: "none" });
    const delivered = await agent.authorize(url, {});
    expect(await rejected(rp.callback(delivered.params, transaction))).toBe(
      "authorization_error:login_required",
    );
    // Refresh tokens bound to the ended session stop working too.
    expect(await rejected(rp.refresh(signedIn.refreshToken ?? "", signedIn.idClaims))).toBe(
      "token_error:invalid_grant",
    );
  });
});

describe("Google profile", () => {
  it("behaves like Google: numeric sub, opaque access token, no end_session, no refresh without access_type=offline", async () => {
    const t = startTestIssuer({ profile: "google" });
    const rp = rpFor(t, "confidential-post", {
      method: "client_secret_post",
      secret: "confidential-post-secret",
    });
    const metadata = await rp.discover();
    expect(metadata.end_session_endpoint).toBeUndefined();
    expect(metadata.token_endpoint_auth_methods_supported).toEqual([
      "client_secret_post",
      "client_secret_basic",
    ]);
    const result = await signInWith(
      rp,
      new UserAgent(t.fetch),
      { persona: "new-member" },
      {
        scope: "openid email profile",
      },
    );
    expect(result.idClaims.sub).toMatch(/^\d{21}$/);
    expect(result.idClaims.azp).toBe("confidential-post");
    expect(result.accessToken.split(".")).toHaveLength(1);
    expect(result.refreshToken).toBeNull();
    const info = await rp.userinfo(result.accessToken, String(result.idClaims.sub));
    expect(info.email_verified).toBe(true);
  });
});

describe("Apple profile", () => {
  it("behaves like Apple: form_post, JWT client secret, string booleans, the name once", async () => {
    const t = startTestIssuer({ profile: "apple" });
    const rp = rpFor(t, "apple-style", APPLE_JWT);
    const metadata = await rp.discover();
    expect(metadata.userinfo_endpoint).toBeUndefined();
    expect(metadata.subject_types_supported).toEqual(["pairwise"]);
    expect(metadata.id_token_signing_alg_values_supported).toContain("RS256");
    const agent = new UserAgent(t.fetch);
    const options = { scope: "openid email name", responseMode: "form_post" };
    const first = await signInWith(rp, agent, { persona: "renamed" }, options);
    expect(first.delivered.mode).toBe("form_post");
    expect(first.idClaims.sub).toMatch(/^\d{6}\.[0-9a-f]{32}\.\d{4}$/);
    expect(first.idClaims.email_verified).toBe("true");
    expect(first.idClaims.is_private_email).toBe("false");
    expect(first.idClaims.name).toBeUndefined();
    expect(JSON.parse(first.delivered.params.get("user") ?? "{}")).toEqual({
      name: { firstName: "Sam", lastName: "Rivera" },
      email: "sam.rivera@example.com",
    });
    expect(first.refreshToken).not.toBeNull();
    const second = await signInWith(
      rp,
      agent,
      { persona: "renamed" },
      { ...options, prompt: "login" },
    );
    expect(second.delivered.params.has("user")).toBe(false);
    expect(second.idClaims.sub).toBe(first.idClaims.sub);
  });

  it("refuses the query response mode when name or email is requested", async () => {
    const t = startTestIssuer({ profile: "apple" });
    const rp = rpFor(t, "apple-style", APPLE_JWT);
    const { url, transaction } = await rp.begin({ scope: "openid email" });
    const delivered = await new UserAgent(t.fetch).authorize(url, {});
    expect(await rejected(rp.callback(delivered.params, transaction))).toBe(
      "authorization_error:invalid_request",
    );
  });
});

describe("Keycloak profile (staff)", () => {
  it("issues access tokens a resource server can validate offline, with Keycloak's role claims", async () => {
    const t = startTestIssuer({ profile: "keycloak" });
    const rp = rpFor(t, "public-spa", { method: "none" });
    const result = await signInWith(
      rp,
      new UserAgent(t.fetch),
      { persona: "staff-billing" },
      {
        scope: "openid email profile",
      },
    );
    expect(result.idClaims.typ).toBe("ID");
    const access = await rp.validateAccessToken(result.accessToken, "test-api", "keycloak");
    expect(access).toMatchObject({
      typ: "Bearer",
      azp: "public-spa",
      aud: ["test-api", "account"],
      realm_access: { roles: ["default-roles-webflix", "offline_access", "uma_authorization"] },
      resource_access: {
        "webflix-admin": { roles: ["billing"] },
        account: { roles: ["manage-account", "manage-account-links", "view-profile"] },
      },
    });
    // The ID token is not an access token.
    expect(await rejected(rp.validateAccessToken(result.idToken, "test-api", "keycloak"))).toBe(
      "not_an_access_token",
    );
    expect(result.refreshToken).not.toBeNull();
  });
});
