/**
 * A second, independent check with a maintained open-source client: oauth4webapi (by the author
 * of the OpenID-certified openid-client; zero dependencies, Web-standard). It validates every
 * protocol message the provider sends, and must refuse the faults it is designed to catch.
 */
import * as oauth from "oauth4webapi";
import { describe, expect, it } from "vitest";
import type { DevIdpFaults } from "../src/index.ts";
import {
  createAppleClientSecret,
  startTestIssuer,
  TEST_REDIRECT_URI,
  type TestIssuer,
} from "../src/testing/index.ts";

interface Flow {
  t: TestIssuer;
  as: oauth.AuthorizationServer;
  client: oauth.Client;
  auth: oauth.ClientAuth;
  options: { [oauth.customFetch]: typeof fetch };
}

async function setup(
  profile: "generic" | "google" | "apple" | "keycloak",
  clientId: string,
  auth?: oauth.ClientAuth,
): Promise<Flow> {
  const t = startTestIssuer({ profile });
  const options = { [oauth.customFetch]: t.fetch as unknown as typeof fetch };
  const issuer = new URL(t.issuer);
  const as = await oauth.processDiscoveryResponse(
    issuer,
    await oauth.discoveryRequest(issuer, { ...options, algorithm: "oidc" }),
  );
  return {
    t,
    as,
    client: { client_id: clientId },
    auth: auth ?? oauth.ClientSecretBasic("confidential-basic-secret"),
    options,
  };
}

async function signIn(
  flow: Flow,
  input: {
    persona: string;
    scope: string;
    faults?: DevIdpFaults;
    maxAge?: number;
    responseMode?: string;
  },
) {
  const { as, client, t } = flow;
  const verifier = oauth.generateRandomCodeVerifier();
  const state = oauth.generateRandomState();
  const nonce = oauth.generateRandomNonce();
  const url = new URL(as.authorization_endpoint ?? "");
  url.searchParams.set("client_id", client.client_id);
  url.searchParams.set("redirect_uri", TEST_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", await oauth.calculatePKCECodeChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  if (input.maxAge !== undefined) url.searchParams.set("max_age", String(input.maxAge));
  if (input.responseMode) url.searchParams.set("response_mode", input.responseMode);
  const outcome = await t.completeAuthorization(url, {
    persona: input.persona,
    faults: input.faults,
  });
  const params = oauth.validateAuthResponse(as, client, outcome.params, state);
  const response = await oauth.authorizationCodeGrantRequest(
    as,
    client,
    flow.auth,
    params,
    TEST_REDIRECT_URI,
    verifier,
    flow.options,
  );
  const result = await oauth.processAuthorizationCodeResponse(as, client, response, {
    expectedNonce: nonce,
    requireIdToken: true,
    maxAge: input.maxAge,
  });
  // The ID token's signature, against the JWKS (oauth4webapi checks it only when asked).
  await oauth.validateApplicationLevelSignature(as, response, flow.options);
  return { result, claims: oauth.getValidatedIdTokenClaims(result), outcome };
}

describe("oauth4webapi walks the provider", () => {
  it("generic profile: code flow, signature, userinfo, refresh, RFC 9068 access token", async () => {
    const flow = await setup("generic", "confidential-basic");
    const { result, claims } = await signIn(flow, {
      persona: "new-member",
      scope: "openid email profile offline_access",
    });
    expect(claims?.email).toBe("riley.chen@example.com");
    const info = await oauth.processUserInfoResponse(
      flow.as,
      flow.client,
      claims?.sub ?? "",
      await oauth.userInfoRequest(flow.as, flow.client, result.access_token, flow.options),
    );
    expect(info.name).toBe("Riley Chen");
    const access = await oauth.validateJwtAccessToken(
      flow.as,
      new Request("https://api.test/", {
        headers: { Authorization: `Bearer ${result.access_token}` },
      }),
      "confidential-basic",
      flow.options,
    );
    expect(access.client_id).toBe("confidential-basic");
    const refreshed = await oauth.processRefreshTokenResponse(
      flow.as,
      flow.client,
      await oauth.refreshTokenGrantRequest(
        flow.as,
        flow.client,
        flow.auth,
        result.refresh_token ?? "",
        flow.options,
      ),
    );
    expect(refreshed.refresh_token).not.toBe(result.refresh_token);
  });

  it("generic profile: a public client (PKCE, no secret) and an ES256 client", async () => {
    const pub = await setup("generic", "public-spa", oauth.None());
    expect(
      (await signIn(pub, { persona: "staff-admin", scope: "openid" })).claims?.sub,
    ).toBeTruthy();
    const es = await setup(
      "generic",
      "es256-client",
      oauth.ClientSecretPost("es256-client-secret-value"),
    );
    es.client.id_token_signed_response_alg = "ES256";
    expect((await signIn(es, { persona: "new-member", scope: "openid" })).claims?.sub).toBeTruthy();
  });

  it("Apple profile: form_post and a JWT client secret", async () => {
    const t0 = startTestIssuer({ profile: "apple" });
    const secret = await createAppleClientSecret({ clientId: "apple-style", audience: t0.issuer });
    const flow = await setup("apple", "apple-style", oauth.ClientSecretPost(secret));
    const { claims, outcome } = await signIn(flow, {
      persona: "private-relay",
      scope: "openid email name",
      responseMode: "form_post",
    });
    expect(outcome.mode).toBe("form_post");
    expect(claims?.email).toBe("x7k2m9q4bd@privaterelay.appleid.com");
  });

  it("Keycloak profile: max_age honoured with auth_time", async () => {
    const flow = await setup("keycloak", "public-spa", oauth.None());
    const { claims } = await signIn(flow, { persona: "staff-support", scope: "openid", maxAge: 0 });
    expect(typeof claims?.auth_time).toBe("number");
  });
});

describe("oauth4webapi refuses the faults it is built to catch", () => {
  // The rule oauth4webapi reports for each (its error code; invalid_grant from the provider).
  const cases: Array<[string, DevIdpFaults, string, { maxAge?: number }?]> = [
    ["wrong nonce", { wrongNonce: true }, "OAUTH_JWT_CLAIM_COMPARISON_FAILED"],
    ["missing nonce", { missingNonce: true }, "OAUTH_INVALID_RESPONSE"],
    ["expired", { expired: true }, "OAUTH_JWT_TIMESTAMP_CHECK_FAILED"],
    ["wrong iss", { wrongIssuer: true }, "OAUTH_JWT_CLAIM_COMPARISON_FAILED"],
    ["wrong aud", { wrongAudience: true }, "OAUTH_JWT_CLAIM_COMPARISON_FAILED"],
    ["alg none", { algNone: true }, "OAUTH_INVALID_RESPONSE"],
    ["HMAC key confusion", { hmacKeyConfusion: true }, "OAUTH_INVALID_RESPONSE"],
    ["unknown key", { unknownKey: true }, "OAUTH_KEY_SELECTION_FAILED"],
    ["key removed from the JWKS", { removedKey: true }, "OAUTH_KEY_SELECTION_FAILED"],
    ["embedded key", { embeddedJwk: true }, "OAUTH_KEY_SELECTION_FAILED"],
    ["tampered state", { tamperedState: true }, "OAUTH_INVALID_RESPONSE"],
    ["wrong iss in the response", { wrongResponseIssuer: true }, "OAUTH_INVALID_RESPONSE"],
    ["PKCE mismatch", { pkceMismatch: true }, "invalid_grant"],
    ["code for another client", { codeForAnotherClient: true }, "invalid_grant"],
    ["replayed code", { codeReplay: true }, "invalid_grant"],
    [
      "stale auth_time",
      { staleAuthTime: true },
      "OAUTH_JWT_TIMESTAMP_CHECK_FAILED",
      { maxAge: 300 },
    ],
    ["missing auth_time", { missingAuthTime: true }, "OAUTH_INVALID_RESPONSE", { maxAge: 300 }],
  ];
  for (const [label, faults, expected, options] of cases) {
    it(label, async () => {
      const flow = await setup("generic", "confidential-basic");
      const error = await signIn(flow, {
        persona: "new-member",
        scope: "openid",
        faults,
        maxAge: options?.maxAge,
      }).then(
        () => null,
        (e: unknown) => e as { code?: string; error?: string },
      );
      expect(error?.code === "OAUTH_RESPONSE_BODY_ERROR" ? error.error : error?.code).toBe(
        expected,
      );
    });
  }

  it("a discovery document naming another issuer", async () => {
    const t = startTestIssuer();
    t.idp.faults.set({ discoveryIssuerMismatch: true });
    const issuer = new URL(t.issuer);
    const options = { [oauth.customFetch]: t.fetch as unknown as typeof fetch };
    await expect(
      oauth.processDiscoveryResponse(
        issuer,
        await oauth.discoveryRequest(issuer, { ...options, algorithm: "oidc" }),
      ),
    ).rejects.toThrow();
  });

  it("a userinfo response for another subject, and an ID token used as an access token", async () => {
    const flow = await setup("generic", "confidential-basic");
    const { result, claims } = await signIn(flow, { persona: "new-member", scope: "openid" });
    flow.t.idp.faults.set({ userinfoSubjectMismatch: true });
    const response = await oauth.userInfoRequest(
      flow.as,
      flow.client,
      result.access_token,
      flow.options,
    );
    await expect(
      oauth.processUserInfoResponse(flow.as, flow.client, claims?.sub ?? "", response),
    ).rejects.toThrow();
    await expect(
      oauth.validateJwtAccessToken(
        flow.as,
        new Request("https://api.test/", {
          headers: { Authorization: `Bearer ${result.id_token}` },
        }),
        "confidential-basic",
        flow.options,
      ),
    ).rejects.toThrow();
  });
});
