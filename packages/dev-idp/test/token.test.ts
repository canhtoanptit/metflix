/** The token endpoint: client authentication, the code grant with PKCE, refresh rotation. */
import { describe, expect, it } from "vitest";
import { DEVELOPMENT_APPLE_CLIENT_KEY, DEVELOPMENT_KEY_SETS } from "../src/development-keys.ts";
import {
  createAppleClientSecret,
  startTestIssuer,
  TEST_REDIRECT_URI,
} from "../src/testing/index.ts";
import {
  BASIC,
  basic,
  decodeJwt,
  freshCode,
  redeem,
  tokenRequest,
  userinfo,
} from "./support/flows.ts";

describe("the request itself", () => {
  it("only POST, form-encoded, small, each parameter once, a supported grant", async () => {
    const t = startTestIssuer();
    expect((await t.fetch(new Request(`${t.issuer}/token`))).status).toBe(405);
    const json = await t.fetch(
      new Request(`${t.issuer}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: BASIC },
        body: JSON.stringify({ grant_type: "authorization_code" }),
      }),
    );
    expect(json.status).toBe(400);
    expect(((await json.json()) as { error: string }).error).toBe("invalid_request");
    const big = await t.fetch(
      new Request(`${t.issuer}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: BASIC },
        body: `grant_type=authorization_code&code=${"x".repeat(40_000)}`,
      }),
    );
    expect(big.status).toBe(413);
    const duplicate = await t.fetch(
      new Request(`${t.issuer}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: BASIC },
        body: "grant_type=authorization_code&code=a&code=b",
      }),
    );
    expect(((await duplicate.json()) as { error: string }).error).toBe("invalid_request");
    expect((await tokenRequest(t, {})).body.error).toBe("invalid_request");
    for (const grant of ["password", "implicit", "urn:ietf:params:oauth:grant-type:device_code"]) {
      expect((await tokenRequest(t, { grant_type: grant })).body.error).toBe(
        "unsupported_grant_type",
      );
    }
    // The generic profile supports client credentials, but only for a client configured with a
    // service account (test/client-credentials.test.ts); this client has none.
    expect((await tokenRequest(t, { grant_type: "client_credentials" })).body.error).toBe(
      "unauthorized_client",
    );
  });

  it("answers with no-store, Bearer tokens and the granted scope", async () => {
    const t = startTestIssuer();
    const { code, verifier } = await freshCode(t);
    const { status, body, headers } = await redeem(t, code, verifier);
    expect(status).toBe(200);
    expect(headers.get("Cache-Control")).toBe("no-store");
    expect(headers.get("Pragma")).toBe("no-cache");
    expect(headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(body).toMatchObject({
      token_type: "Bearer",
      expires_in: 300,
      scope: "openid email profile",
    });
    expect(body.refresh_token).toBeUndefined();
  });
});

describe("client authentication", () => {
  async function attempt(headers: Record<string, string>, body: Record<string, string> = {}) {
    const t = startTestIssuer();
    const { code, verifier } = await freshCode(t);
    return redeem(t, code, verifier, body, headers);
  }

  it("client_secret_basic: the right secret, and nothing else", async () => {
    expect((await attempt({ Authorization: BASIC })).status).toBe(200);
    const wrong = await attempt({ Authorization: basic("confidential-basic", "wrong-secret") });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe("invalid_client");
    expect(wrong.headers.get("WWW-Authenticate")).toContain("Basic");
    expect((await attempt({ Authorization: "Basic !!!" })).body.error).toBe("invalid_client");
    expect((await attempt({ Authorization: "Bearer abc" })).body.error).toBe("invalid_client");
    expect((await attempt({ Authorization: basic("nobody", "x") })).body.error).toBe(
      "invalid_client",
    );
  });

  it("one method per request, matching client_id, and only registered methods", async () => {
    expect(
      (await attempt({ Authorization: BASIC }, { client_secret: "confidential-basic-secret" })).body
        .error,
    ).toBe("invalid_request");
    expect(
      (await attempt({ Authorization: BASIC }, { client_id: "confidential-post" })).body.error,
    ).toBe("invalid_request");
    // confidential-basic registered client_secret_basic only.
    expect(
      (
        await attempt(
          {},
          { client_id: "confidential-basic", client_secret: "confidential-basic-secret" },
        )
      ).status,
    ).toBe(401);
    // Without any authentication a confidential client is refused.
    expect((await attempt({}, { client_id: "confidential-basic" })).status).toBe(401);
    expect((await attempt({}, {})).status).toBe(401);
    expect(
      (
        await attempt(
          {},
          {
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            client_assertion: "x",
          },
        )
      ).body.error,
    ).toBe("invalid_client");
  });

  it("decodes Basic credentials as RFC 6749 §2.3.1 says (form-encoded, then base64)", async () => {
    const secret = "s3cr3t:with+special&chars é";
    const t = startTestIssuer({
      clients: [
        { clientId: "odd.client~1", clientSecret: secret, redirectUris: [TEST_REDIRECT_URI] },
      ],
    });
    const { code, verifier } = await freshCode(t, { client_id: "odd.client~1" });
    expect(
      (await redeem(t, code, verifier, {}, { Authorization: basic("odd.client~1", secret) }))
        .status,
    ).toBe(200);
  });

  it("client_secret_post and none", async () => {
    const t = startTestIssuer();
    const post = await freshCode(t, { client_id: "confidential-post" });
    expect(
      (
        await redeem(
          t,
          post.code,
          post.verifier,
          { client_id: "confidential-post", client_secret: "confidential-post-secret" },
          {},
        )
      ).status,
    ).toBe(200);
    const pub = await freshCode(t, { client_id: "public-spa" });
    expect((await redeem(t, pub.code, pub.verifier, { client_id: "public-spa" }, {})).status).toBe(
      200,
    );
    // A public client has no secret to send.
    const pub2 = await freshCode(t, { client_id: "public-spa" });
    expect(
      (
        await redeem(
          t,
          pub2.code,
          pub2.verifier,
          { client_id: "public-spa", client_secret: "anything" },
          {},
        )
      ).status,
    ).toBe(401);
  });

  describe("Apple's JWT client secret", () => {
    async function withSecret(secret: string) {
      const t = startTestIssuer();
      const { code, verifier } = await freshCode(t, { client_id: "apple-style" });
      return redeem(t, code, verifier, { client_id: "apple-style", client_secret: secret }, {});
    }
    const now = () => Math.floor(Date.now() / 1000);

    it("accepts a valid one", async () => {
      expect(
        (
          await withSecret(
            await createAppleClientSecret({
              clientId: "apple-style",
              audience: "https://dev-idp.test",
            }),
          )
        ).status,
      ).toBe(200);
    });

    const cases: Array<[string, Parameters<typeof createAppleClientSecret>[0]]> = [
      [
        "wrong team (iss)",
        { clientId: "apple-style", audience: "https://dev-idp.test", teamId: "OTHERTEAM1" },
      ],
      [
        "wrong key id",
        { clientId: "apple-style", audience: "https://dev-idp.test", keyId: "OTHERKEY01" },
      ],
      ["wrong sub", { clientId: "other-client", audience: "https://dev-idp.test" }],
      ["wrong aud", { clientId: "apple-style", audience: "https://appleid.apple.com" }],
      [
        "expired",
        { clientId: "apple-style", audience: "https://dev-idp.test", nowSec: now() - 7200 },
      ],
      [
        "issued in the future",
        { clientId: "apple-style", audience: "https://dev-idp.test", nowSec: now() + 3600 },
      ],
      [
        "living longer than six months",
        { clientId: "apple-style", audience: "https://dev-idp.test", lifetimeSec: 15_777_001 },
      ],
      [
        "signed by another key",
        {
          clientId: "apple-style",
          audience: "https://dev-idp.test",
          privateKey: DEVELOPMENT_KEY_SETS.generic[2],
        },
      ],
    ];
    for (const [label, input] of cases) {
      it(`refuses one ${label}`, async () => {
        const response = await withSecret(await createAppleClientSecret(input));
        expect(response.status).toBe(401);
        expect(response.body.error).toBe("invalid_client");
      });
    }

    it("refuses a shared secret or a non-ES256 JWT in its place", async () => {
      expect((await withSecret("just-a-string")).status).toBe(401);
      const header = btoa(JSON.stringify({ alg: "none", kid: "DEVKEY0001" })).replace(/=+$/, "");
      const claims = btoa(
        JSON.stringify({
          iss: "DEVTEAM001",
          sub: "apple-style",
          aud: "https://dev-idp.test",
          iat: now(),
          exp: now() + 60,
        }),
      ).replace(/=+$/, "");
      expect((await withSecret(`${header}.${claims}.`)).status).toBe(401);
      expect(DEVELOPMENT_APPLE_CLIENT_KEY.alg).toBe("ES256");
    });
  });
});

describe("the authorization code grant", () => {
  it("refuses missing, garbage, expired, foreign codes with invalid_grant", async () => {
    const t = startTestIssuer();
    expect((await tokenRequest(t, { grant_type: "authorization_code" })).body.error).toBe(
      "invalid_request",
    );
    expect((await redeem(t, "garbage", "v".repeat(43))).body.error).toBe("invalid_grant");
    const expired = await freshCode(t);
    t.clock.advance(61_000);
    expect((await redeem(t, expired.code, expired.verifier)).body.error).toBe("invalid_grant");
    const other = startTestIssuer();
    const foreign = await freshCode(other);
    expect((await redeem(t, foreign.code, foreign.verifier)).body.error).toBe("invalid_grant");
  });

  it("binds the code to its client and redirect URI", async () => {
    const t = startTestIssuer();
    const { code, verifier } = await freshCode(t);
    const asPost = await redeem(
      t,
      code,
      verifier,
      { client_id: "confidential-post", client_secret: "confidential-post-secret" },
      {},
    );
    expect(asPost.body.error).toBe("invalid_grant");
    expect(
      (await redeem(t, code, verifier, { redirect_uri: "https://rp.test/other" })).body.error,
    ).toBe("invalid_grant");
    expect(
      (await tokenRequest(t, { grant_type: "authorization_code", code, code_verifier: verifier }))
        .body.error,
    ).toBe("invalid_grant");
    // None of those attempts burned the code for its rightful client.
    expect((await redeem(t, code, verifier)).status).toBe(200);
  });

  it("PKCE: missing, malformed and wrong verifiers fail; a verifier without a challenge is a downgrade", async () => {
    const t = startTestIssuer({
      clients: [
        {
          clientId: "confidential-basic",
          clientSecret: "confidential-basic-secret",
          redirectUris: [TEST_REDIRECT_URI],
        },
        {
          clientId: "relaxed",
          clientSecret: "relaxed-client-secret",
          requirePkce: false,
          redirectUris: [TEST_REDIRECT_URI],
        },
      ],
    });
    const { code, verifier } = await freshCode(t);
    expect((await redeem(t, code, undefined)).body.error).toBe("invalid_grant");
    expect((await redeem(t, code, "short")).body.error).toBe("invalid_grant");
    const wrong = `${verifier.slice(0, -1)}${verifier.endsWith("A") ? "B" : "A"}`;
    expect((await redeem(t, code, wrong)).body.error).toBe("invalid_grant");
    expect((await redeem(t, code, verifier)).status).toBe(200);
    const relaxed = await freshCode(t, {
      client_id: "relaxed",
      code_challenge: undefined,
      code_challenge_method: undefined,
    });
    const headers = { Authorization: basic("relaxed", "relaxed-client-secret") };
    expect((await redeem(t, relaxed.code, "v".repeat(43), {}, headers)).body.error).toBe(
      "invalid_grant",
    );
    expect((await redeem(t, relaxed.code, undefined, {}, headers)).status).toBe(200);
  });

  it("single use: a replay fails and revokes what the first redemption obtained", async () => {
    const t = startTestIssuer();
    const { code, verifier } = await freshCode(t, { scope: "openid email offline_access" });
    const first = await redeem(t, code, verifier);
    expect(first.status).toBe(200);
    expect((await userinfo(t, first.body.access_token as string)).status).toBe(200);
    expect((await redeem(t, code, verifier)).body.error).toBe("invalid_grant");
    expect((await userinfo(t, first.body.access_token as string)).status).toBe(401);
    const refreshed = await tokenRequest(t, {
      grant_type: "refresh_token",
      refresh_token: first.body.refresh_token as string,
    });
    expect(refreshed.body.error).toBe("invalid_grant");
  });
});

describe("the refresh token grant", () => {
  async function signedIn(scope = "openid email profile offline_access") {
    const t = startTestIssuer();
    const { code, verifier } = await freshCode(t, { scope });
    const { body } = await redeem(t, code, verifier);
    return { t, tokens: body };
  }

  it("rotates, keeps auth_time, drops the nonce, and may narrow the scope", async () => {
    const { t, tokens } = await signedIn();
    const original = decodeJwt(tokens.id_token as string).claims;
    t.clock.advance(30_000);
    const next = await tokenRequest(t, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token as string,
      scope: "openid email",
    });
    expect(next.status).toBe(200);
    expect(next.body.refresh_token).not.toBe(tokens.refresh_token);
    expect(next.body.scope).toBe("openid email");
    const claims = decodeJwt(next.body.id_token as string).claims;
    expect(claims.auth_time).toBe(original.auth_time);
    expect(claims.sub).toBe(original.sub);
    expect(claims.nonce).toBeUndefined();
    expect(claims.iat).toBe((original.iat as number) + 30);
    expect(claims.name).toBeUndefined();
  });

  it("refuses widening the scope, another client, garbage and expiry", async () => {
    const { t, tokens } = await signedIn("openid offline_access");
    const refresh = tokens.refresh_token as string;
    expect(
      (
        await tokenRequest(t, {
          grant_type: "refresh_token",
          refresh_token: refresh,
          scope: "openid email",
        })
      ).body.error,
    ).toBe("invalid_scope");
    expect(
      (
        await tokenRequest(
          t,
          {
            grant_type: "refresh_token",
            refresh_token: refresh,
            client_id: "confidential-post",
            client_secret: "confidential-post-secret",
          },
          {},
        )
      ).body.error,
    ).toBe("invalid_grant");
    expect(
      (await tokenRequest(t, { grant_type: "refresh_token", refresh_token: "garbage" })).body.error,
    ).toBe("invalid_grant");
    expect((await tokenRequest(t, { grant_type: "refresh_token" })).body.error).toBe(
      "invalid_request",
    );
    t.clock.advance(12 * 3600 * 1000 + 1000);
    expect(
      (await tokenRequest(t, { grant_type: "refresh_token", refresh_token: refresh })).body.error,
    ).toBe("invalid_grant");
  });

  it("the family has an absolute lifetime", async () => {
    const { t, tokens } = await signedIn("openid offline_access");
    let refresh = tokens.refresh_token as string;
    for (let hour = 0; hour < 23; hour += 1) {
      t.clock.advance(3600 * 1000);
      const next = await tokenRequest(t, { grant_type: "refresh_token", refresh_token: refresh });
      expect(next.status).toBe(200);
      refresh = next.body.refresh_token as string;
    }
    t.clock.advance(3600 * 1000 + 1000);
    expect(
      (await tokenRequest(t, { grant_type: "refresh_token", refresh_token: refresh })).body.error,
    ).toBe("invalid_grant");
  });

  it("is issued by each profile's rule", async () => {
    const generic = await signedIn("openid email");
    expect(generic.tokens.refresh_token).toBeUndefined();
    const google = startTestIssuer({ profile: "google" });
    const without = await freshCode(google, { client_id: "confidential-basic", scope: "openid" });
    expect(
      (await redeem(google, without.code, without.verifier)).body.refresh_token,
    ).toBeUndefined();
    const offline = await freshCode(google, {
      client_id: "confidential-basic",
      scope: "openid",
      access_type: "offline",
    });
    expect((await redeem(google, offline.code, offline.verifier)).body.refresh_token).toBeTypeOf(
      "string",
    );
    const keycloak = startTestIssuer({ profile: "keycloak" });
    const staff = await freshCode(keycloak, { scope: "openid" }, "staff-admin");
    expect((await redeem(keycloak, staff.code, staff.verifier)).body.refresh_token).toBeTypeOf(
      "string",
    );
  });
});

describe("CORS for browser clients", () => {
  it("answers preflights and responses for registered origins only", async () => {
    const t = startTestIssuer();
    const preflight = await t.fetch(
      new Request(`${t.issuer}/token`, {
        method: "OPTIONS",
        headers: { Origin: "https://rp.test", "Access-Control-Request-Method": "POST" },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("https://rp.test");
    expect(preflight.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    const evil = await t.fetch(
      new Request(`${t.issuer}/token`, {
        method: "OPTIONS",
        headers: { Origin: "https://evil.test", "Access-Control-Request-Method": "POST" },
      }),
    );
    expect(evil.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const pub = await freshCode(t, { client_id: "public-spa" });
    const response = await redeem(
      t,
      pub.code,
      pub.verifier,
      { client_id: "public-spa" },
      { Origin: "https://rp.test" },
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://rp.test");
  });
});
