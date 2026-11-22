import { describe, expect, it } from "vitest";
import { base64UrlEncode, randomBytes } from "../encoding.ts";
import {
  createPkceVerifier,
  type IdentityFailureReason,
  type IdentityProvider,
  IdentityProviderError,
  type OidcAuthorizationRequest,
  pkceChallenge,
} from "../ports/identity-provider.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "./harness.ts";

/** A sign-in the harness completes at the issuer, possibly with a fault injected. */
export interface IdentitySignIn {
  email: string;
  emailVerified: boolean;
  name?: string;
  fault?: "wrong_nonce" | "stale_auth_time" | "missing_auth_time";
}

export interface IdentityProviderHarness extends HarnessBase {
  provider: IdentityProvider;
  /** The callback URL registered for the provider's client. */
  redirectUri: string;
  /**
   * Plays the issuer and the member: completes the sign-in `authorizationUrl` started and
   * returns the authorisation response. Memory: `MemoryIdentityProvider.complete`; the generic
   * OIDC adapter: the development issuer's `completeAuthorization` (its faults
   * `wrongNonce`, `staleAuthTime`, `missingAuthTime`).
   */
  signIn(
    authorizationUrl: string,
    signIn: IdentitySignIn,
  ): Promise<{ code: string; state: string }>;
}

/** Contract every `IdentityProvider` adapter must pass. */
export function describeIdentityProviderContract(
  name: string,
  factory: HarnessFactory<IdentityProviderHarness>,
): void {
  describe(`IdentityProvider contract: ${name}`, () => {
    const h = useHarness(factory);
    const email = () => `member-${base64UrlEncode(randomBytes(6)).toLowerCase()}@example.test`;

    async function start(extra: Partial<OidcAuthorizationRequest> = {}) {
      const verifier = createPkceVerifier();
      const request: OidcAuthorizationRequest = {
        redirectUri: h().redirectUri,
        state: base64UrlEncode(randomBytes(16)),
        nonce: base64UrlEncode(randomBytes(16)),
        codeChallenge: await pkceChallenge(verifier),
        ...extra,
      };
      return { request, verifier, url: await h().provider.authorizationUrl(request) };
    }

    async function signInAs(signIn: IdentitySignIn, extra: Partial<OidcAuthorizationRequest> = {}) {
      const started = await start(extra);
      const response = await h().signIn(started.url, signIn);
      return { ...started, response };
    }

    async function rejection(promise: Promise<unknown>): Promise<IdentityFailureReason> {
      const error = await promise.then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error, "expected the redemption to be rejected").toBeInstanceOf(IdentityProviderError);
      return (error as IdentityProviderError).reason;
    }

    it("sends the protocol parameters an issuer needs (code flow, PKCE S256)", async () => {
      const { request, url } = await start();
      const params = new URL(url).searchParams;
      expect(params.get("response_type")).toBe("code");
      expect(params.get("redirect_uri")).toBe(request.redirectUri);
      expect(params.get("state")).toBe(request.state);
      expect(params.get("nonce")).toBe(request.nonce);
      expect(params.get("code_challenge")).toBe(request.codeChallenge);
      expect(params.get("code_challenge_method")).toBe("S256");
      expect(params.get("client_id")).toBeTruthy();
      expect(params.get("scope")?.split(" ")).toContain("openid");
      expect(params.has("max_age")).toBe(false);
    });

    it("asks for a fresh sign-in with max_age=0", async () => {
      const { url } = await start({ maxAgeSec: 0 });
      expect(new URL(url).searchParams.get("max_age")).toBe("0");
    });

    it("refuses an authorisation request without a valid state, nonce or S256 challenge", async () => {
      const { provider, redirectUri } = h();
      const valid = {
        redirectUri,
        state: "s",
        nonce: "n",
        codeChallenge: await pkceChallenge(createPkceVerifier()),
      };
      for (const broken of [
        { ...valid, state: "" },
        { ...valid, nonce: "" },
        { ...valid, codeChallenge: "plain-verifier" },
        { ...valid, redirectUri: "/relative/callback" },
      ]) {
        await expect(provider.authorizationUrl(broken)).rejects.toBeInstanceOf(
          IdentityProviderError,
        );
      }
    });

    it("redeems a code into a validated identity", async () => {
      const address = email();
      const { request, verifier, response } = await signInAs({
        email: address,
        emailVerified: true,
      });
      expect(response.state).toBe(request.state);
      const identity = await h().provider.redeem({
        code: response.code,
        codeVerifier: verifier,
        redirectUri: request.redirectUri,
        nonce: request.nonce,
      });
      expect(identity.provider).toBe(h().provider.id);
      expect(identity.issuer).toBe(h().provider.issuer);
      expect(identity.subject).toMatch(/^.{1,255}$/);
      expect(identity.email?.toLowerCase()).toBe(address);
      expect(identity.emailVerified).toBe(true);
    });

    it("reports an unverified email as unverified (a boolean, whatever the issuer's form)", async () => {
      const { request, verifier, response } = await signInAs({
        email: email(),
        emailVerified: false,
      });
      const identity = await h().provider.redeem({
        code: response.code,
        codeVerifier: verifier,
        redirectUri: request.redirectUri,
        nonce: request.nonce,
      });
      expect(identity.emailVerified).toBe(false);
    });

    it("keys people by subject: the same person keeps it, another person gets another", async () => {
      const address = email();
      const redeem = async (who: string) => {
        const { request, verifier, response } = await signInAs({ email: who, emailVerified: true });
        return h().provider.redeem({
          code: response.code,
          codeVerifier: verifier,
          redirectUri: request.redirectUri,
          nonce: request.nonce,
        });
      };
      const first = await redeem(address);
      const again = await redeem(address);
      const other = await redeem(email());
      expect(again.subject).toBe(first.subject);
      expect(other.subject).not.toBe(first.subject);
    });

    it("redeems a code at most once", async () => {
      const { request, verifier, response } = await signInAs({
        email: email(),
        emailVerified: true,
      });
      const redemption = {
        code: response.code,
        codeVerifier: verifier,
        redirectUri: request.redirectUri,
        nonce: request.nonce,
      };
      await h().provider.redeem(redemption);
      expect(await rejection(h().provider.redeem(redemption))).toBe("invalid_grant");
    });

    it("refuses a code with the wrong PKCE verifier", async () => {
      const { request, response } = await signInAs({ email: email(), emailVerified: true });
      const reason = await rejection(
        h().provider.redeem({
          code: response.code,
          codeVerifier: createPkceVerifier(),
          redirectUri: request.redirectUri,
          nonce: request.nonce,
        }),
      );
      expect(reason).toBe("invalid_grant");
    });

    it("refuses a code redeemed for another redirect URI", async () => {
      const { request, verifier, response } = await signInAs({
        email: email(),
        emailVerified: true,
      });
      const reason = await rejection(
        h().provider.redeem({
          code: response.code,
          codeVerifier: verifier,
          redirectUri: `${request.redirectUri}-elsewhere`,
          nonce: request.nonce,
        }),
      );
      expect(reason).toBe("invalid_grant");
    });

    it("refuses an ID token whose nonce is not this transaction's", async () => {
      const { request, verifier, response } = await signInAs({
        email: email(),
        emailVerified: true,
        fault: "wrong_nonce",
      });
      const reason = await rejection(
        h().provider.redeem({
          code: response.code,
          codeVerifier: verifier,
          redirectUri: request.redirectUri,
          nonce: request.nonce,
        }),
      );
      expect(reason).toBe("nonce_mismatch");
    });

    it("treats a fresh sign-in as fresh only when auth_time says so", async () => {
      const fresh = await signInAs({ email: email(), emailVerified: true }, { maxAgeSec: 0 });
      const identity = await h().provider.redeem({
        code: fresh.response.code,
        codeVerifier: fresh.verifier,
        redirectUri: fresh.request.redirectUri,
        nonce: fresh.request.nonce,
        maxAgeSec: 0,
      });
      expect(identity.authTime).not.toBeNull();

      const stale = await signInAs(
        { email: email(), emailVerified: true, fault: "stale_auth_time" },
        { maxAgeSec: 0 },
      );
      expect(
        await rejection(
          h().provider.redeem({
            code: stale.response.code,
            codeVerifier: stale.verifier,
            redirectUri: stale.request.redirectUri,
            nonce: stale.request.nonce,
            maxAgeSec: 0,
          }),
        ),
      ).toBe("auth_time_stale");
    });

    it("fails closed when max_age was sent and the token has no auth_time", async () => {
      const missing = await signInAs(
        { email: email(), emailVerified: true, fault: "missing_auth_time" },
        { maxAgeSec: 0 },
      );
      expect(
        await rejection(
          h().provider.redeem({
            code: missing.response.code,
            codeVerifier: missing.verifier,
            redirectUri: missing.request.redirectUri,
            nonce: missing.request.nonce,
            maxAgeSec: 0,
          }),
        ),
      ).toBe("auth_time_missing");
    });
  });
}
