import { describe, expect, it } from "vitest";
import type { Es256PrivateKey } from "../areas/identity/jose.ts";
import {
  createOidcIdentityProvider,
  type OidcFetch,
  type OidcProviderOptions,
} from "../areas/identity/oidc.ts";
import { base64UrlEncode, randomBytes } from "../encoding.ts";
import {
  createPkceVerifier,
  type IdentityProvider,
  IdentityProviderError,
  pkceChallenge,
} from "../ports/identity-provider.ts";
import { describeIdentityProviderContract } from "./identity-provider.contract.ts";

/**
 * The generic OpenID relying party (`createOidcIdentityProvider`) against an in-process
 * development issuer (packages/dev-idp, the test kit's `startTestIssuer`), at the adapter level:
 * the `IdentityProvider` contract for each issuer profile, and every token, ID-token,
 * token-response, authorisation-response and endpoint fault of the catalogue with the exact
 * rule that refused it (the federation suite proves the outcomes end to end; this proves each
 * check is the one doing the work). Run in every runtime the adapter ships to.
 */

/** One in-process issuer of the kit (structurally the dev-idp kit's `TestIssuer`). */
export interface KitIssuer {
  issuer: string;
  fetch: OidcFetch;
  clock: { now(): number; advance(ms: number): void };
  authorize(
    url: string,
    choice: {
      email?: { address: string; name?: string; verified?: boolean };
      persona?: string;
      faults?: Record<string, unknown>;
    },
  ): Promise<{
    code: string | null;
    state: string | null;
    iss: string | null;
    error: string | null;
  }>;
  /** Standing faults until replaced (`{}` clears). */
  setFaults(faults: Record<string, unknown>): void;
}

export interface RelyingPartyKit {
  /** A fresh issuer with the Google profile (and the kit's confidential clients). */
  google(): KitIssuer;
  /** A fresh issuer with the Apple profile (form post, JWT client secret, string booleans). */
  apple(): KitIssuer;
  /** Where the kit's clients redirect. */
  redirectUri: string;
  clients: {
    basic: { clientId: string; secret: string };
    /** Signs its ID tokens with ES256. */
    es256: { clientId: string; secret: string };
    apple: { clientId: string; teamId: string; keyId: string; privateKey: Es256PrivateKey };
  };
}

const unique = () => `member-${base64UrlEncode(randomBytes(6)).toLowerCase()}@example.test`;

export function describeOidcRelyingParty(name: string, kit: () => RelyingPartyKit): void {
  describe(`OpenID relying party: ${name}`, () => {
    function googleProvider(
      issuer: KitIssuer,
      overrides: Partial<OidcProviderOptions> = {},
    ): IdentityProvider {
      const { basic } = kit().clients;
      return createOidcIdentityProvider({
        id: "google",
        displayName: "Google",
        issuer: issuer.issuer,
        clientId: basic.clientId,
        clientAuthentication: { method: "client_secret_basic", secret: basic.secret },
        reportsAuthTime: true,
        fetch: issuer.fetch,
        clock: issuer.clock,
        timeoutMs: 400,
        jwksRefetchCooldownSec: 0,
        ...overrides,
      });
    }

    function appleProvider(issuer: KitIssuer, privateKey?: Es256PrivateKey): IdentityProvider {
      const { apple } = kit().clients;
      return createOidcIdentityProvider({
        id: "apple",
        displayName: "Apple",
        issuer: issuer.issuer,
        clientId: apple.clientId,
        clientAuthentication: {
          method: "apple_client_secret",
          teamId: apple.teamId,
          keyId: apple.keyId,
          privateKey: privateKey ?? apple.privateKey,
        },
        scopes: ["openid", "email", "name"],
        responseMode: "form_post",
        reportsAuthTime: true,
        fetch: issuer.fetch,
        clock: issuer.clock,
        timeoutMs: 400,
        jwksRefetchCooldownSec: 0,
      });
    }

    const FAULT_NAMES = {
      wrong_nonce: "wrongNonce",
      stale_auth_time: "staleAuthTime",
      missing_auth_time: "missingAuthTime",
    } as const;

    for (const [profile, build] of [
      ["google profile", (issuer: KitIssuer) => googleProvider(issuer)],
      [
        "apple profile (form post, ES256 client secret)",
        (issuer: KitIssuer) => appleProvider(issuer),
      ],
    ] as const) {
      describeIdentityProviderContract(`oidc, ${profile} (${name})`, () => {
        const issuer = profile.startsWith("google") ? kit().google() : kit().apple();
        return {
          provider: build(issuer),
          redirectUri: kit().redirectUri,
          async signIn(url, signIn) {
            const outcome = await issuer.authorize(url, {
              email: {
                address: signIn.email,
                verified: signIn.emailVerified,
                ...(signIn.name ? { name: signIn.name } : {}),
              },
              ...(signIn.fault ? { faults: { [FAULT_NAMES[signIn.fault]]: true } } : {}),
            });
            return { code: outcome.code ?? "", state: outcome.state ?? "", iss: outcome.iss };
          },
        };
      });
    }

    /** One sign-in with `faults`, redeemed; the rule that refused it (or "accepted"). */
    async function attempt(
      issuer: KitIssuer,
      provider: IdentityProvider,
      faults: Record<string, unknown>,
      options: { maxAgeSec?: number; tamperState?: boolean } = {},
    ): Promise<string> {
      const verifier = createPkceVerifier();
      const state = base64UrlEncode(randomBytes(16));
      const nonce = base64UrlEncode(randomBytes(16));
      const url = await provider.authorizationUrl({
        redirectUri: kit().redirectUri,
        state,
        nonce,
        codeChallenge: await pkceChallenge(verifier),
        ...(options.maxAgeSec !== undefined ? { maxAgeSec: options.maxAgeSec } : {}),
      });
      const outcome = await issuer.authorize(url, {
        email: { address: unique(), verified: true },
        faults,
      });
      if (outcome.state !== state) return "state_mismatch";
      try {
        await provider.redeem({
          code: outcome.code ?? "",
          codeVerifier: verifier,
          redirectUri: kit().redirectUri,
          nonce,
          ...(options.maxAgeSec !== undefined ? { maxAgeSec: options.maxAgeSec } : {}),
          responseIssuer: outcome.iss,
        });
        return "accepted";
      } catch (error) {
        if (error instanceof IdentityProviderError) return `${error.reason}:${error.message}`;
        throw error;
      }
    }

    describe("refuses each fault by its own rule", () => {
      const cases: Array<[string, Record<string, unknown>, string, { maxAgeSec?: number }?]> = [
        ["unknownKey", { unknownKey: true }, "invalid_token:unknown_kid"],
        ["removedKey", { removedKey: true }, "invalid_token:unknown_kid"],
        ["algNone", { algNone: true }, "invalid_token:alg_not_allowed"],
        ["hmacKeyConfusion", { hmacKeyConfusion: true }, "invalid_token:alg_not_allowed"],
        ["embeddedJwk", { embeddedJwk: true }, "invalid_token:unknown_kid"],
        ["wrongIssuer", { wrongIssuer: true }, "issuer_mismatch:iss_mismatch"],
        ["wrongAudience", { wrongAudience: true }, "audience_mismatch:aud_mismatch"],
        ["extraAudience", { extraAudience: true }, "audience_mismatch:untrusted_audience"],
        ["expired", { expired: true }, "expired:expired"],
        ["notYetValid", { notYetValid: true }, "invalid_token:issued_in_future"],
        ["wrongNonce", { wrongNonce: true }, "nonce_mismatch:nonce_mismatch"],
        ["missingNonce", { missingNonce: true }, "nonce_mismatch:nonce_missing"],
        ["wrongAtHash", { wrongAtHash: true }, "invalid_token:at_hash_mismatch"],
        [
          "staleAuthTime",
          { staleAuthTime: true },
          "auth_time_stale:auth_too_old",
          { maxAgeSec: 0 },
        ],
        [
          "missingAuthTime",
          { missingAuthTime: true },
          "auth_time_missing:auth_time_missing",
          { maxAgeSec: 0 },
        ],
        [
          "idTokenAsAccessToken",
          { idTokenAsAccessToken: true },
          "invalid_token:id_token_as_access_token",
        ],
        [
          "codeForAnotherClient",
          { codeForAnotherClient: true },
          "invalid_grant:token_error:invalid_grant",
        ],
        ["codeReplay", { codeReplay: true }, "invalid_grant:token_error:invalid_grant"],
        ["pkceMismatch", { pkceMismatch: true }, "invalid_grant:token_error:invalid_grant"],
        [
          "wrongResponseIssuer",
          { wrongResponseIssuer: true },
          "issuer_mismatch:response_iss_mismatch",
        ],
      ];
      for (const [label, faults, rule, options] of cases) {
        it(`${label} → ${rule}`, async () => {
          const issuer = kit().google();
          expect(await attempt(issuer, googleProvider(issuer), faults, options)).toBe(rule);
        });
      }

      it("tamperedState: the response's state is not the one sent (the caller refuses it first)", async () => {
        const issuer = kit().google();
        expect(await attempt(issuer, googleProvider(issuer), { tamperedState: true })).toBe(
          "state_mismatch",
        );
      });

      it("staleAuthTime and missingAuthTime matter only when max_age was sent", async () => {
        const issuer = kit().google();
        expect(await attempt(issuer, googleProvider(issuer), { staleAuthTime: true })).toBe(
          "accepted",
        );
        expect(await attempt(issuer, googleProvider(issuer), { missingAuthTime: true })).toBe(
          "accepted",
        );
      });

      it("the algorithm comes from configuration: an ES256 token for an RS256 client is refused", async () => {
        const issuer = kit().google();
        const { es256 } = kit().clients;
        const options = {
          clientId: es256.clientId,
          clientAuthentication: { method: "client_secret_basic" as const, secret: es256.secret },
        };
        expect(await attempt(issuer, googleProvider(issuer, options), {})).toBe(
          "invalid_token:alg_not_allowed",
        );
        expect(
          await attempt(issuer, googleProvider(issuer, { ...options, algorithms: ["ES256"] }), {}),
        ).toBe("accepted");
      });

      it("jwksRotatedMidFlow: an unknown key refetches the JWKS once and is accepted when published", async () => {
        const issuer = kit().google();
        const provider = googleProvider(issuer);
        expect(await attempt(issuer, provider, {})).toBe("accepted");
        expect(await attempt(issuer, provider, { jwksRotatedMidFlow: true })).toBe("accepted");
      });

      it("refetches at most once per cooldown for an unknown key", async () => {
        const issuer = kit().google();
        let jwksFetches = 0;
        const counting: OidcFetch = (request) => {
          if (new URL(request.url).pathname.endsWith("/jwks")) jwksFetches += 1;
          return issuer.fetch(request);
        };
        const provider = googleProvider(issuer, { fetch: counting, jwksRefetchCooldownSec: 60 });
        expect(await attempt(issuer, provider, {})).toBe("accepted");
        expect(await attempt(issuer, provider, { unknownKey: true })).toBe(
          "invalid_token:unknown_kid",
        );
        expect(jwksFetches).toBe(1);
        issuer.clock.advance(61_000);
        expect(await attempt(issuer, provider, { unknownKey: true })).toBe(
          "invalid_token:unknown_kid",
        );
        expect(jwksFetches).toBe(2);
      });

      it("discoveryIssuerMismatch: the configuration is refused", async () => {
        const issuer = kit().google();
        issuer.setFaults({ discoveryIssuerMismatch: true });
        const provider = googleProvider(issuer);
        const error = await provider
          .authorizationUrl({
            redirectUri: kit().redirectUri,
            state: "state-value",
            nonce: "nonce-value",
            codeChallenge: await pkceChallenge(createPkceVerifier()),
          })
          .then(
            () => null,
            (caught: unknown) => caught,
          );
        expect(error).toBeInstanceOf(IdentityProviderError);
        expect((error as IdentityProviderError).message).toBe("discovery_issuer_mismatch");
      });

      it("jwksSlow: times out cleanly", async () => {
        const issuer = kit().google();
        issuer.setFaults({ jwksSlow: { delayMs: 1500 } });
        expect(await attempt(issuer, googleProvider(issuer), {})).toBe(
          "provider_unavailable:issuer_timeout",
        );
      });

      it("jwksFailing: refused without keys; keys already trusted keep working", async () => {
        const issuer = kit().google();
        issuer.setFaults({ jwksFailing: { status: 503 } });
        expect(await attempt(issuer, googleProvider(issuer), {})).toBe(
          "provider_unavailable:jwks_status_503",
        );
        const warm = googleProvider(issuer);
        issuer.setFaults({});
        expect(await attempt(issuer, warm, {})).toBe("accepted");
        issuer.setFaults({ jwksFailing: { status: 503 } });
        issuer.clock.advance(2 * 60 * 60 * 1000); // past the cache's lifetime: a refresh fails
        expect(await attempt(issuer, warm, {})).toBe("accepted");
      });

      it("userinfoSubjectMismatch: identity comes from the ID token only (userinfo is never called)", async () => {
        const issuer = kit().google();
        issuer.setFaults({ userinfoSubjectMismatch: true });
        let userinfo = 0;
        const counting: OidcFetch = (request) => {
          if (new URL(request.url).pathname.endsWith("/userinfo")) userinfo += 1;
          return issuer.fetch(request);
        };
        expect(await attempt(issuer, googleProvider(issuer, { fetch: counting }), {})).toBe(
          "accepted",
        );
        expect(userinfo).toBe(0);
      });

      it("refuses the same faults through Apple's form-post profile", async () => {
        for (const [faults, rule] of [
          [{ algNone: true }, "invalid_token:alg_not_allowed"],
          [{ wrongNonce: true }, "nonce_mismatch:nonce_mismatch"],
          [{ wrongAudience: true }, "audience_mismatch:aud_mismatch"],
          [{ expired: true }, "expired:expired"],
        ] as const) {
          const issuer = kit().apple();
          expect(await attempt(issuer, appleProvider(issuer), faults)).toBe(rule);
        }
      });
    });

    describe("Apple", () => {
      it("signs the client secret with a PKCS#8 key as Apple hands it out (a .p8 file)", async () => {
        const { apple } = kit().clients;
        if (typeof apple.privateKey === "string") return;
        const { kty, crv, x, y, d } = apple.privateKey;
        const extractable = await crypto.subtle.importKey(
          "jwk",
          { kty, crv, x, y, d },
          { name: "ECDSA", namedCurve: "P-256" },
          true,
          ["sign"],
        );
        const der = new Uint8Array(
          (await crypto.subtle.exportKey("pkcs8", extractable)) as ArrayBuffer,
        );
        let binary = "";
        for (const byte of der) binary += String.fromCharCode(byte);
        const pem = `-----BEGIN PRIVATE KEY-----\n${(btoa(binary).match(/.{1,64}/g) ?? []).join("\n")}\n-----END PRIVATE KEY-----\n`;
        const issuer = kit().apple();
        expect(await attempt(issuer, appleProvider(issuer, pem), {})).toBe("accepted");
      });

      it("reads Apple's string email_verified, false included", async () => {
        const issuer = kit().apple();
        const provider = appleProvider(issuer);
        const verifier = createPkceVerifier();
        const nonce = base64UrlEncode(randomBytes(16));
        const url = await provider.authorizationUrl({
          redirectUri: kit().redirectUri,
          state: "state-for-apple",
          nonce,
          codeChallenge: await pkceChallenge(verifier),
        });
        expect(new URL(url).searchParams.get("response_mode")).toBe("form_post");
        const outcome = await issuer.authorize(url, {
          email: { address: unique(), verified: false },
        });
        const identity = await provider.redeem({
          code: outcome.code ?? "",
          codeVerifier: verifier,
          redirectUri: kit().redirectUri,
          nonce,
          responseIssuer: outcome.iss,
        });
        expect(identity.emailVerified).toBe(false);
      });
    });
  });
}
