/** Discovery (per profile), the JWKS and key rotation, routing. */
import { describe, expect, it } from "vitest";
import { startTestIssuer } from "../src/testing/index.ts";
import { decodeJwt, freshCode, redeem } from "./support/flows.ts";

async function getJson(fetch: (request: Request) => Promise<Response>, url: string) {
  const response = await fetch(new Request(url));
  return { response, body: (await response.json()) as Record<string, unknown> };
}

describe("discovery", () => {
  it("generic: every supported feature, truthfully", async () => {
    const t = startTestIssuer();
    const { response, body } = await getJson(
      t.fetch,
      `${t.issuer}/.well-known/openid-configuration`,
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(body).toEqual({
      issuer: t.issuer,
      authorization_endpoint: `${t.issuer}/authorize`,
      token_endpoint: `${t.issuer}/token`,
      jwks_uri: `${t.issuer}/jwks`,
      userinfo_endpoint: `${t.issuer}/userinfo`,
      end_session_endpoint: `${t.issuer}/logout`,
      scopes_supported: ["openid", "email", "profile", "offline_access"],
      response_types_supported: ["code"],
      response_modes_supported: ["query", "form_post"],
      grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256", "ES256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      code_challenge_methods_supported: ["S256"],
      claims_supported: expect.arrayContaining([
        "sub",
        "email",
        "email_verified",
        "auth_time",
        "nonce",
      ]),
      prompt_values_supported: ["none", "login", "consent", "select_account"],
      claims_parameter_supported: false,
      request_parameter_supported: false,
      request_uri_parameter_supported: false,
      authorization_response_iss_parameter_supported: true,
    });
  });

  it("profiles advertise what their real counterparts do", async () => {
    const google = (
      await getJson(
        startTestIssuer({ profile: "google" }).fetch,
        "https://dev-idp.test/.well-known/openid-configuration",
      )
    ).body;
    expect(google.end_session_endpoint).toBeUndefined();
    expect(google.scopes_supported).toEqual(["openid", "email", "profile"]);
    const apple = (
      await getJson(
        startTestIssuer({ profile: "apple" }).fetch,
        "https://dev-idp.test/.well-known/openid-configuration",
      )
    ).body;
    expect(apple.userinfo_endpoint).toBeUndefined();
    expect(apple.end_session_endpoint).toBeUndefined();
    expect(apple.authorization_response_iss_parameter_supported).toBe(false);
    expect(apple.token_endpoint_auth_methods_supported).toEqual(["client_secret_post"]);
    expect(apple.scopes_supported).toEqual(["openid", "email", "name"]);
    const keycloak = (
      await getJson(
        startTestIssuer({ profile: "keycloak" }).fetch,
        "https://dev-idp.test/.well-known/openid-configuration",
      )
    ).body;
    expect(keycloak.scopes_supported).toContain("roles");
    expect(keycloak.end_session_endpoint).toBe("https://dev-idp.test/logout");
  });

  it("is served at the issuer's path, and nothing outside it", async () => {
    const t = startTestIssuer({ issuer: "https://idp.test/realms/staff" });
    expect(
      (await t.fetch(new Request("https://idp.test/realms/staff/.well-known/openid-configuration")))
        .status,
    ).toBe(200);
    expect(
      (await t.fetch(new Request("https://idp.test/.well-known/openid-configuration"))).status,
    ).toBe(404);
    expect((await t.fetch(new Request("https://idp.test/realms/staffx/jwks"))).status).toBe(404);
    expect((await t.fetch(new Request("https://idp.test/realms/staff/jwks/"))).status).toBe(404);
    expect((await t.fetch(new Request("https://idp.test/realms/staff/nope"))).status).toBe(404);
    const post = await t.fetch(
      new Request("https://idp.test/realms/staff/jwks", { method: "POST" }),
    );
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET");
  });

  it("refuses to let a test fetch leave the issuer's origin", async () => {
    const t = startTestIssuer();
    await expect(t.fetch(new Request("https://elsewhere.test/"))).rejects.toThrow(TypeError);
  });
});

describe("JWKS", () => {
  it("publishes two keys per algorithm, public members only", async () => {
    const t = startTestIssuer();
    const { body } = await getJson(t.fetch, `${t.issuer}/jwks`);
    const keys = body.keys as Array<Record<string, unknown>>;
    expect(keys.filter((key) => key.alg === "RS256")).toHaveLength(2);
    expect(keys.filter((key) => key.alg === "ES256")).toHaveLength(2);
    for (const key of keys) {
      expect(key.use).toBe("sig");
      expect(typeof key.kid).toBe("string");
      for (const secret of ["d", "p", "q", "dp", "dq", "qi", "k"])
        expect(key[secret]).toBeUndefined();
    }
    expect(new Set(keys.map((key) => key.kid)).size).toBe(keys.length);
  });

  it("rotates: next signs, the old key stays published, a second rotation retires it", async () => {
    const t = startTestIssuer();
    const before = t.idp.keys.list().filter((key) => key.alg === "RS256");
    const current = before.find((key) => key.status === "current")?.kid;
    const next = before.find((key) => key.status === "next")?.kid;
    const { code, verifier } = await freshCode(t);
    const issuedBefore = (await redeem(t, code, verifier)).body.id_token as string;
    expect(decodeJwt(issuedBefore).header.kid).toBe(current);

    const [signing] = await t.idp.keys.rotate("RS256");
    expect(signing).toBe(next);
    const kids = t.idp.keys.jwks().keys.map((key) => key.kid);
    expect(kids).toContain(current);
    expect(kids).toContain(next);
    const second = await freshCode(t);
    expect(
      decodeJwt((await redeem(t, second.code, second.verifier)).body.id_token as string).header.kid,
    ).toBe(next);

    await t.idp.keys.rotate("RS256");
    expect(t.idp.keys.jwks().keys.map((key) => key.kid)).not.toContain(current);
    expect(t.idp.keys.list().find((key) => key.kid === current)?.status).toBe("retired");
  });

  it("retires a key on request (the current key hands over to next)", async () => {
    const t = startTestIssuer();
    const current =
      t.idp.keys.list().find((key) => key.alg === "ES256" && key.status === "current")?.kid ?? "";
    t.idp.keys.retire(current);
    expect(t.idp.keys.jwks().keys.map((key) => key.kid)).not.toContain(current);
    expect(
      t.idp.keys.list().filter((key) => key.alg === "ES256" && key.status === "current"),
    ).toHaveLength(1);
    expect(() => t.idp.keys.retire("no-such-kid")).toThrow();
  });

  it("generated keys work for signing after rotation (Web Crypto key generation)", async () => {
    const t = startTestIssuer({
      clients: [
        {
          clientId: "confidential-basic",
          clientSecret: "confidential-basic-secret",
          idTokenSignedResponseAlg: "ES256",
          redirectUris: ["https://rp.test/callback"],
        },
      ],
    });
    await t.idp.keys.rotate("ES256");
    await t.idp.keys.rotate("ES256");
    const { code, verifier } = await freshCode(t);
    const token = (await redeem(t, code, verifier)).body.id_token as string;
    const current = t.idp.keys
      .list()
      .find((key) => key.alg === "ES256" && key.status === "current")?.kid;
    expect(decodeJwt(token).header.kid).toBe(current);
  });
});

describe("avatars", () => {
  it("serves the default persona pictures as inert SVG", async () => {
    const t = startTestIssuer();
    const { code, verifier } = await freshCode(t);
    const picture = decodeJwt((await redeem(t, code, verifier)).body.id_token as string).claims
      .picture as string;
    expect(picture).toMatch(/^https:\/\/dev-idp\.test\/avatars\/[0-9a-f]{16}\.svg$/);
    const response = await t.fetch(new Request(picture));
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'none'");
    expect(await response.text()).not.toMatch(/<script|on\w+=/i);
    expect((await t.fetch(new Request(`${t.issuer}/avatars/../jwks.svg`))).status).toBe(404);
  });
});
