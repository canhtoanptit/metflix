/** Shipped personas and profiles, and the Webflix host every local mode mounts. */
import { DEMO_ACCOUNT_EMAIL as CONTRACTS_DEMO_EMAIL } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import {
  createWebflixDevIdp,
  DEMO_ACCOUNT_EMAIL,
  STAFF_ROLE_CLIENT,
  STAFF_ROLES,
  WEBFLIX_DEV_CLIENTS,
} from "../src/index.ts";
import { startTestIssuer, type TestIssuer } from "../src/testing/index.ts";
import { decodeJwt, freshCode, redeem } from "./support/flows.ts";
import { IndependentRp, signInWith, UserAgent } from "./support/independent-rp.ts";

async function idClaims(t: TestIssuer, persona: string, params: Record<string, string> = {}) {
  const { code, verifier } = await freshCode(
    t,
    { scope: "openid email profile", ...params },
    persona,
  );
  return decodeJwt((await redeem(t, code, verifier)).body.id_token as string).claims;
}

describe("consumer personas", () => {
  it("the demo email matches the seeded demo account", () => {
    expect(DEMO_ACCOUNT_EMAIL).toBe(CONTRACTS_DEMO_EMAIL);
  });

  it("ship each case the sign-in rules must handle", async () => {
    const t = startTestIssuer({ profile: "google" });
    const fresh = await idClaims(t, "new-member");
    expect(fresh).toMatchObject({
      email_verified: true,
      name: "Riley Chen",
      given_name: "Riley",
      family_name: "Chen",
    });
    const verified = await idClaims(t, "demo-verified");
    const unverified = await idClaims(t, "demo-unverified");
    expect(verified).toMatchObject({ email: DEMO_ACCOUNT_EMAIL, email_verified: true });
    expect(unverified).toMatchObject({ email: DEMO_ACCOUNT_EMAIL, email_verified: false });
    expect(verified.sub).not.toBe(unverified.sub);
    const noEmail = await idClaims(t, "no-email");
    expect(noEmail.email).toBeUndefined();
    expect(noEmail.email_verified).toBeUndefined();
    const names = [];
    for (let index = 0; index < 4; index += 1) names.push((await idClaims(t, "renamed")).name);
    expect(names).toEqual(["Sam Rivera", "Samantha Rivera-Ortiz", "Sam R.", "Sam Rivera"]);
  });

  it("subjects are stable per issuer, distinct across issuers, shaped like the provider's", async () => {
    const a = await idClaims(startTestIssuer({ profile: "google" }), "new-member");
    const b = await idClaims(startTestIssuer({ profile: "google" }), "new-member");
    const elsewhere = await idClaims(
      startTestIssuer({ profile: "google", issuer: "https://elsewhere.test" }),
      "new-member",
    );
    expect(a.sub).toBe(b.sub);
    expect(a.sub).not.toBe(elsewhere.sub);
    expect(a.sub).toMatch(/^\d{21}$/);
    expect((await idClaims(startTestIssuer(), "new-member")).sub).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("Apple personas and behaviour", () => {
  it("private relay addresses, string booleans, and the name only on a first authorisation", async () => {
    const t = startTestIssuer({ profile: "apple" });
    const first = await t.signIn({
      clientId: "apple-style",
      persona: "private-relay",
      scope: "openid email name",
    });
    expect(first.outcome.mode).toBe("form_post");
    expect(JSON.parse(first.outcome.user ?? "null")).toEqual({
      name: { firstName: "Alex", lastName: "Morgan" },
      email: "x7k2m9q4bd@privaterelay.appleid.com",
    });
    const tokens = await t.redeem(first.outcome, {
      clientId: "apple-style",
      verifier: first.verifier,
    });
    const claims = decodeJwt(tokens.id_token ?? "").claims;
    expect(claims).toMatchObject({
      is_private_email: "true",
      email_verified: "true",
      nonce_supported: true,
    });
    expect(claims.name).toBeUndefined();
    const again = await t.signIn({
      clientId: "apple-style",
      persona: "private-relay",
      scope: "openid email name",
    });
    expect(again.outcome.user).toBeNull();
    const reset = await t.signIn({
      clientId: "apple-style",
      persona: "private-relay",
      scope: "openid email name",
      firstAuthorisation: true,
    });
    expect(reset.outcome.user).not.toBeNull();
    // Only the openid scope: Apple sends no user object, and query mode is allowed.
    const bare = await t.signIn({
      clientId: "apple-style",
      persona: "new-member",
      scope: "openid",
      responseMode: "query",
    });
    expect(bare.outcome.mode).toBe("query");
    expect(bare.outcome.user).toBeNull();
  });
});

describe("staff personas (Keycloak profile)", () => {
  it("one per role, one without, one with a role for another client only", async () => {
    const t = startTestIssuer({ profile: "keycloak" });
    const ids = t.idp.personas.map((persona) => persona.id);
    for (const role of STAFF_ROLES) {
      const tokens = await t.idp.mintTokens({ persona: `staff-${role}`, clientId: "public-spa" });
      const access = decodeJwt(tokens.access_token).claims as {
        resource_access: Record<string, { roles: string[] }>;
      };
      expect(access.resource_access[STAFF_ROLE_CLIENT]?.roles).toEqual([role]);
    }
    expect(ids).toContain("staff-no-role");
    const none = decodeJwt(
      (await t.idp.mintTokens({ persona: "staff-no-role", clientId: "public-spa" })).access_token,
    ).claims as {
      resource_access: Record<string, unknown>;
    };
    expect(none.resource_access[STAFF_ROLE_CLIENT]).toBeUndefined();
    const other = decodeJwt(
      (await t.idp.mintTokens({ persona: "staff-other-client-admin", clientId: "public-spa" }))
        .access_token,
    ).claims as { resource_access: Record<string, { roles: string[] }> };
    expect(other.resource_access["other-app"]?.roles).toEqual(["admin"]);
    expect(other.resource_access[STAFF_ROLE_CLIENT]).toBeUndefined();
  });

  it("the sign-in page shows the roles", async () => {
    const t = startTestIssuer({ profile: "keycloak" });
    const url = new URL(
      `${t.issuer}/authorize?response_type=code&client_id=public-spa&redirect_uri=https%3A%2F%2Frp.test%2Fcallback&scope=openid&state=s&nonce=n&code_challenge=${"a".repeat(43)}&code_challenge_method=S256`,
    );
    const html = await (await t.fetch(new Request(url))).text();
    expect(html).toContain("role: billing");
    expect(html).toContain("role: admin (other-app)");
    expect(html).not.toContain("manage-account");
  });
});

describe("mintTokens (resource-server tests)", () => {
  it("mints with faults, for typed identities too, and refuses unknown clients and personas", async () => {
    const t = startTestIssuer({ profile: "keycloak" });
    const expired = await t.idp.mintTokens({
      persona: "staff-admin",
      clientId: "public-spa",
      faults: { expired: { target: "both" } },
    });
    const now = Math.floor(t.clock.now() / 1000);
    expect(decodeJwt(expired.access_token).claims.exp).toBeLessThan(now);
    expect(decodeJwt(expired.id_token ?? "").claims.exp).toBeLessThan(now);
    const typed = await t.idp.mintTokens({
      persona: { email: "ops@example.com", verified: true },
      clientId: "public-spa",
    });
    expect(decodeJwt(typed.access_token).claims.email).toBe("ops@example.com");
    await expect(
      t.idp.mintTokens({ persona: "staff-admin", clientId: "nobody" }),
    ).rejects.toThrow();
    await expect(t.idp.mintTokens({ persona: "nobody", clientId: "public-spa" })).rejects.toThrow();
    await expect(
      t.idp.mintTokens({ persona: "staff-admin", clientId: "public-spa", scope: "openid admin" }),
    ).rejects.toThrow();
  });
});

describe("the Webflix host", () => {
  const origin = "http://localhost:4000";

  it("mounts google, apple and staff under /dev-idp, with an index", async () => {
    const host = createWebflixDevIdp({
      environment: "development",
      origin,
      appOrigins: [origin, "http://localhost:5173"],
    });
    const index = (await (await host.fetch(new Request(`${origin}/dev-idp`))).json()) as {
      issuers: Record<string, { issuer: string }>;
    };
    expect(Object.keys(index.issuers)).toEqual(["google", "apple", "staff"]);
    expect(index.issuers.staff?.issuer).toBe(`${origin}/dev-idp/staff`);
    for (const realm of ["google", "apple", "staff"]) {
      const response = await host.fetch(
        new Request(`${origin}/dev-idp/${realm}/.well-known/openid-configuration`),
      );
      expect(((await response.json()) as { issuer: string }).issuer).toBe(
        `${origin}/dev-idp/${realm}`,
      );
    }
    expect((await host.fetch(new Request(`${origin}/dev-idp/nope/jwks`))).status).toBe(404);
    expect((await host.fetch(new Request(`${origin}/dev-idp/__proto__/jwks`))).status).toBe(404);
    // Distinct issuers sign with distinct keys.
    const kids = await Promise.all(
      ["google", "apple", "staff"].map(
        async (realm) =>
          (
            (await (await host.fetch(new Request(`${origin}/dev-idp/${realm}/jwks`))).json()) as {
              keys: Array<{ kid: string }>;
            }
          ).keys[0]?.kid,
      ),
    );
    expect(new Set(kids).size).toBe(3);
  });

  it("an independent client signs in at each realm with the published development registrations", async () => {
    const host = createWebflixDevIdp({
      environment: "development",
      origin,
      secret: "x".repeat(32),
    });
    const fetch = (request: Request) => host.fetch(request);
    const { google, apple, staff } = WEBFLIX_DEV_CLIENTS;
    const google_ = new IndependentRp({
      issuer: `${origin}/dev-idp/google`,
      clientId: google.clientId,
      redirectUri: `${origin}${google.callbackPath}`,
      auth: { method: "client_secret_basic", secret: google.clientSecret },
      fetch,
    });
    expect(
      (
        await signInWith(
          google_,
          new UserAgent(fetch),
          { persona: "demo-verified" },
          { scope: "openid email profile" },
        )
      ).idClaims.email,
    ).toBe(DEMO_ACCOUNT_EMAIL);
    const apple_ = new IndependentRp({
      issuer: `${origin}/dev-idp/apple`,
      clientId: apple.clientId,
      redirectUri: `${origin}${apple.callbackPath}`,
      auth: {
        method: "apple_jwt",
        privateJwk: { ...apple.privateKey },
        teamId: apple.teamId,
        keyId: apple.keyId,
      },
      fetch,
    });
    const appleResult = await signInWith(
      apple_,
      new UserAgent(fetch),
      { persona: "new-member" },
      {
        scope: "openid email name",
        responseMode: "form_post",
      },
    );
    expect(appleResult.delivered.mode).toBe("form_post");
    const staff_ = new IndependentRp({
      issuer: `${origin}/dev-idp/staff`,
      clientId: staff.clientId,
      redirectUri: `${origin}${staff.callbackPath}`,
      auth: { method: "none" },
      fetch,
    });
    const staffResult = await signInWith(
      staff_,
      new UserAgent(fetch),
      { persona: "staff-content" },
      { scope: "openid profile" },
    );
    const access = await staff_.validateAccessToken(
      staffResult.accessToken,
      staff.audience,
      "keycloak",
    );
    expect(access.resource_access).toMatchObject({ [STAFF_ROLE_CLIENT]: { roles: ["content"] } });
  });
});
