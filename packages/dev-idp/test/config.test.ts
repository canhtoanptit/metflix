/** The production guard and configuration validation: invalid setups fail at construction. */
import { describe, expect, it } from "vitest";
import { DEVELOPMENT_KEY_SETS } from "../src/development-keys.ts";
import {
  createDevIdp,
  createDevIdpHost,
  createWebflixDevIdp,
  type DevIdpClient,
  DevIdpConfigError,
  type DevIdpOptions,
  toPublicJwk,
} from "../src/index.ts";

const CLIENT: DevIdpClient = {
  clientId: "app",
  clientSecret: "a-secret-of-sixteen-chars",
  redirectUris: ["https://rp.test/callback"],
};

function options(overrides: Partial<DevIdpOptions> = {}): DevIdpOptions {
  return { issuer: "https://idp.test", environment: "test", clients: [CLIENT], ...overrides };
}

describe("the production guard", () => {
  for (const environment of [
    "production",
    "prod",
    "Production",
    "staging",
    "",
    " test",
    undefined,
    null,
  ]) {
    it(`refuses environment ${JSON.stringify(environment)}`, () => {
      expect(() => createDevIdp(options({ environment: environment as string }))).toThrow(
        DevIdpConfigError,
      );
      expect(() =>
        createDevIdpHost({
          environment: environment as string,
          origin: "http://localhost:4000",
          realms: {},
        }),
      ).toThrow(DevIdpConfigError);
      expect(() =>
        createWebflixDevIdp({
          environment: environment as string,
          origin: "http://localhost:4000",
        }),
      ).toThrow(DevIdpConfigError);
    });
  }

  it("accepts development and test", () => {
    expect(createDevIdp(options({ environment: "development" })).issuer).toBe("https://idp.test");
    expect(createDevIdp(options({ environment: "test" })).issuer).toBe("https://idp.test");
  });
});

describe("issuer", () => {
  for (const issuer of [
    "https://idp.test/",
    "https://idp.test/realm/",
    "https://idp.test?x=1",
    "https://idp.test#f",
    "https://user:pass@idp.test",
    "HTTPS://IDP.TEST",
    "ftp://idp.test",
    "idp.test",
  ]) {
    it(`refuses ${issuer}`, () => {
      expect(() => createDevIdp(options({ issuer }))).toThrow(DevIdpConfigError);
    });
  }

  it("accepts an issuer with a path", () => {
    expect(createDevIdp(options({ issuer: "http://localhost:4000/dev-idp/staff" })).issuer).toBe(
      "http://localhost:4000/dev-idp/staff",
    );
  });
});

describe("clients", () => {
  const invalid: Array<[string, Partial<DevIdpClient>]> = [
    ["a redirect URI with a fragment", { redirectUris: ["https://rp.test/cb#x"] }],
    ["a javascript: redirect URI", { redirectUris: ["javascript:alert(1)"] }],
    ["a relative redirect URI", { redirectUris: ["/callback"] }],
    ["no redirect URI", { redirectUris: [] }],
    ["a short secret", { clientSecret: "short" }],
    ["a public client that opts out of PKCE", { clientSecret: undefined, requirePkce: false }],
    ["a public client with a secret", { tokenEndpointAuthMethods: ["none"] }],
    [
      "a confidential method without a secret",
      { clientSecret: undefined, tokenEndpointAuthMethods: ["client_secret_post"] },
    ],
    ["a scope the profile lacks", { allowedScopes: ["openid", "admin"] }],
    ["an invalid client id", { clientId: "app with spaces" }],
    [
      "both kinds of secret",
      {
        signedClientSecret: {
          teamId: "T",
          keyId: "K",
          publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
        },
      },
    ],
    [
      "a private key as the client's public key",
      {
        clientSecret: undefined,
        signedClientSecret: {
          teamId: "T",
          keyId: "K",
          publicKey: { ...DEVELOPMENT_KEY_SETS.generic[2] },
        },
      },
    ],
  ];
  for (const [label, override] of invalid) {
    it(`refuses ${label}`, () => {
      expect(() => createDevIdp(options({ clients: [{ ...CLIENT, ...override }] }))).toThrow(
        DevIdpConfigError,
      );
    });
  }

  it("refuses duplicate clients and no clients", () => {
    expect(() => createDevIdp(options({ clients: [CLIENT, CLIENT] }))).toThrow(DevIdpConfigError);
    expect(() => createDevIdp(options({ clients: [] }))).toThrow(DevIdpConfigError);
  });

  it("refuses an algorithm the key ring cannot sign with", () => {
    const rsaOnly = DEVELOPMENT_KEY_SETS.generic.filter((key) => key.alg === "RS256");
    expect(() =>
      createDevIdp(
        options({ keys: rsaOnly, clients: [{ ...CLIENT, idTokenSignedResponseAlg: "ES256" }] }),
      ),
    ).toThrow(/no ES256 key/);
  });

  it("refuses a method the profile does not support (Apple accepts client_secret_post only)", () => {
    expect(() => createDevIdp(options({ profile: "apple" }))).toThrow(
      /does not support client_secret_basic/,
    );
    expect(() =>
      createDevIdp(
        options({
          profile: "apple",
          clients: [
            {
              clientId: "apple",
              redirectUris: ["https://rp.test/cb"],
              signedClientSecret: {
                teamId: "T",
                keyId: "K",
                publicKey: toPublicJwk(DEVELOPMENT_KEY_SETS.generic[2]),
              },
            },
          ],
        }),
      ),
    ).not.toThrow();
  });
});

describe("personas, keys, store, faults, lifetimes", () => {
  it("refuses invalid personas", () => {
    const persona = { id: "p", email: "p@example.com" };
    expect(() => createDevIdp(options({ personas: [persona, persona] }))).toThrow(
      /Duplicate persona/,
    );
    expect(() => createDevIdp(options({ personas: [{ id: "Bad Id", email: null }] }))).toThrow(
      DevIdpConfigError,
    );
    expect(() => createDevIdp(options({ personas: [{ id: "p", email: "not-an-email" }] }))).toThrow(
      /invalid email/,
    );
    expect(() =>
      createDevIdp(options({ personas: [{ id: "p", email: null, claims: { iss: "evil" } }] })),
    ).toThrow(/set by the issuer/);
    expect(() => createDevIdp(options({ personas: [{ id: "p", email: null, name: [] }] }))).toThrow(
      /empty list/,
    );
  });

  it("refuses invalid keys", () => {
    const [rsa] = DEVELOPMENT_KEY_SETS.generic;
    expect(() => createDevIdp(options({ keys: [rsa, rsa] }))).toThrow(/Duplicate signing key/);
    expect(() => createDevIdp(options({ keys: [{ ...rsa, d: undefined } as never] }))).toThrow(
      /private member/,
    );
    expect(() => createDevIdp(options({ keys: [{ ...rsa, alg: "ES256" } as never] }))).toThrow(
      /kty/,
    );
    expect(() => createDevIdp(options({ keys: [{ ...rsa, alg: "HS256" } as never] }))).toThrow(
      /alg/,
    );
  });

  it("refuses a short secret, invalid lifetimes and unknown faults", () => {
    expect(() => createDevIdp(options({ secret: "too short" }))).toThrow(/32 characters/);
    expect(() => createDevIdp(options({ lifetimes: { codeSec: 0 } }))).toThrow(/positive integer/);
    expect(() => createDevIdp(options({ lifetimes: { codeSec: 3600 } }))).toThrow(/at most 600/);
    expect(() => createDevIdp(options({ faults: { nope: true } as never }))).toThrow(
      /Unknown fault/,
    );
    expect(() => createDevIdp(options({ faults: { jwksSlow: { delayMs: -1 } } }))).toThrow(
      DevIdpConfigError,
    );
  });

  it("refuses codeReplay without a store, at construction and at run time", () => {
    expect(() => createDevIdp(options({ store: "none", faults: { codeReplay: true } }))).toThrow(
      /store/,
    );
    const idp = createDevIdp(options({ store: "none" }));
    expect(() => idp.faults.set({ codeReplay: true })).toThrow(/store/);
  });

  it("refuses invalid host settings", () => {
    const base = { environment: "test", origin: "http://localhost:4000", realms: {} };
    expect(() => createDevIdpHost({ ...base, basePath: "dev-idp" })).toThrow(DevIdpConfigError);
    expect(() => createDevIdpHost({ ...base, basePath: "/dev-idp/" })).toThrow(DevIdpConfigError);
    expect(() => createDevIdpHost({ ...base, origin: "http://localhost:4000/path" })).toThrow(
      DevIdpConfigError,
    );
    expect(() =>
      createDevIdpHost({ ...base, realms: { "Bad Realm": { clients: [CLIENT] } } }),
    ).toThrow(DevIdpConfigError);
  });
});
