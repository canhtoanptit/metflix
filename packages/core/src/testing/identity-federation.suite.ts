import { describe, expect, it } from "vitest";
import { type HarnessBase, type HarnessFactory, useHarness } from "./harness.ts";

/**
 * Federated sign-in, end to end through a deployment's HTTP surface (milestone 2 §4): the API
 * (`/api/v1/auth/oidc/*`, the session, identities, the account-holder proof, email) and the
 * development issuer mounted beside it (`/dev-idp/*`). Run in every runtime the relying party
 * ships to: the Node runtime on SQLite (apps/api) and the Worker under workerd (apps/edge).
 *
 * Every fault of the development issuer's catalogue (packages/dev-idp/README.md, 29 faults) is
 * injected through the issuer and must end in the outcome the relying party's rule prescribes:
 * no session, no account, no link, no proof, unless the rule says the flow must survive it.
 * `FEDERATION_FAULTS_COVERED` lists them, so each runtime's test file checks the list against the
 * issuer's own catalogue.
 */

/** What the member does at the issuer's sign-in page (the issuer's own test kit drives it). */
export interface IssuerChoice {
  persona?: string;
  email?: { address: string; name?: string; verified?: boolean };
  /** Flow faults, by catalogue name: `{ wrongNonce: true }`. */
  faults?: Record<string, unknown>;
  cancel?: boolean;
}

/** The authorisation response, as the browser would deliver it to the callback. */
export interface IssuerOutcome {
  mode: "query" | "form_post";
  code: string | null;
  state: string | null;
  toRequest(init?: { headers?: Record<string, string> }): Request;
}

export type IssuerRealm = "google" | "apple";

export interface FederationHarness extends HarnessBase {
  /** The deployment's public origin (`WEBFLIX_PUBLIC_ORIGIN`). */
  origin: string;
  /** One request to the deployment: the API and `/dev-idp/*`. */
  fetch(request: Request): Promise<Response>;
  /** Plays the member at the development issuer: completes an authorisation URL. */
  authorize(url: string, choice: IssuerChoice): Promise<IssuerOutcome>;
  /** Standing faults on a realm (endpoint faults: discovery, JWKS, userinfo). */
  setStandingFaults(realm: IssuerRealm, faults: Record<string, unknown>): void;
  /** Delivers every queued job (email jobs mint links and send through the mailbox). */
  drainJobs(): Promise<void>;
  /** Seeds the shared demo account (`demo@webflix.dev`, password `webflix-demo`). */
  seedDemo(): Promise<void>;
}

/** Every fault of the issuer's catalogue this suite injects (29). */
export const FEDERATION_FAULTS_COVERED = [
  "unknownKey",
  "removedKey",
  "algNone",
  "hmacKeyConfusion",
  "embeddedJwk",
  "wrongIssuer",
  "wrongAudience",
  "extraAudience",
  "expired",
  "notYetValid",
  "wrongNonce",
  "missingNonce",
  "wrongAtHash",
  "staleAuthTime",
  "missingAuthTime",
  "emailUnverified",
  "emailVerifiedAbsent",
  "subjectChanged",
  "idTokenAsAccessToken",
  "jwksRotatedMidFlow",
  "codeForAnotherClient",
  "codeReplay",
  "pkceMismatch",
  "tamperedState",
  "wrongResponseIssuer",
  "discoveryIssuerMismatch",
  "jwksSlow",
  "jwksFailing",
  "userinfoSubjectMismatch",
] as const;

const API = "/api/v1";
const CLIENT = { "X-Webflix-Client": "web" };
/** What a browser sends when a person follows a link (Fetch Metadata). */
const NAVIGATE = {
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};
const PASSWORD = "correct horse battery";

/** Faults that break a token or the authorisation response: the sign-in must fail outright. */
const REJECTED_FAULTS = [
  "unknownKey",
  "removedKey",
  "algNone",
  "hmacKeyConfusion",
  "embeddedJwk",
  "wrongIssuer",
  "wrongAudience",
  "extraAudience",
  "expired",
  "notYetValid",
  "wrongNonce",
  "missingNonce",
  "wrongAtHash",
  "idTokenAsAccessToken",
  "codeForAnotherClient",
  "codeReplay",
  "pkceMismatch",
  "tamperedState",
  "wrongResponseIssuer",
] as const;

export function describeFederatedSignIn(
  name: string,
  factory: HarnessFactory<FederationHarness>,
): void {
  describe(`Federated sign-in: ${name}`, () => {
    const h = useHarness(factory);
    let counter = 0;
    const unique = (label: string) => {
      counter += 1;
      return `${label}-${Date.now().toString(36)}-${counter}@example.test`;
    };

    /**
     * A browser: its own cookie jar and client address (`address` for a check that must not share
     * a rate-limit bucket), every request through the deployment.
     */
    function browser(address?: string) {
      const cookies = new Map<string, string>();
      const ip = address ?? `198.51.100.${(counter % 250) + 1}`;
      const header = () => [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
      /** The request with this browser's cookies and address, as it would leave the browser. */
      const prepare = (request: Request): Request => {
        const headers = new Headers(request.headers);
        if (cookies.size > 0) headers.set("Cookie", header());
        headers.set("CF-Connecting-IP", ip);
        return new Request(request, { headers });
      };
      const send = async (request: Request, prepared = false): Promise<Response> => {
        const response = await h().fetch(prepared ? request : prepare(request));
        for (const line of response.headers.getSetCookie()) {
          const [pair = ""] = line.split(";");
          const at = pair.indexOf("=");
          const key = pair.slice(0, at).trim();
          const value = pair.slice(at + 1).trim();
          if (value === "" || /max-age=0|expires=thu, 01 jan 1970/i.test(line)) cookies.delete(key);
          else cookies.set(key, value);
        }
        return response;
      };
      const json = async (method: string, path: string, body?: unknown) => {
        const response = await send(
          new Request(`${h().origin}${API}${path}`, {
            method,
            headers: {
              ...CLIENT,
              ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
        const text = await response.text();
        return {
          status: response.status,
          body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
        };
      };
      return { send, prepare, json, cookies, header };
    }
    type Browser = ReturnType<typeof browser>;

    interface Flow {
      outcome: string | null;
      location: string;
      /** The callback request exactly as the browser sent it (for replay attempts). */
      callback: Request | null;
      issuerOutcome: IssuerOutcome | null;
    }

    async function start(
      b: Browser,
      provider: string,
      options: { intent?: string; returnTo?: string } = {},
    ): Promise<Response> {
      const query = new URLSearchParams({
        ...(options.intent ? { intent: options.intent } : {}),
        returnTo: options.returnTo ?? "/browse",
      });
      return b.send(new Request(`${h().origin}${API}/auth/oidc/${provider}/start?${query}`));
    }

    const outcomeOf = (location: string) => new URL(location, h().origin).searchParams.get("oidc");

    /** Start, sign in at the issuer, deliver the response to the callback. */
    async function flow(
      b: Browser,
      provider: IssuerRealm,
      choice: IssuerChoice,
      options: { intent?: string; returnTo?: string; tamper?: (request: Request) => Request } = {},
    ): Promise<Flow> {
      const started = await start(b, provider, options);
      expect(started.status).toBe(302);
      const location = started.headers.get("Location") ?? "";
      if (!location.startsWith(`${h().origin}/dev-idp/`)) {
        return { outcome: outcomeOf(location), location, callback: null, issuerOutcome: null };
      }
      const issued = await h().authorize(location, choice);
      const delivered = issued.toRequest();
      const callback = b.prepare(options.tamper ? options.tamper(delivered) : delivered);
      // Exactly what went over the wire, transaction cookie included (for replay attempts).
      const replayable = callback.clone();
      const finished = await b.send(callback, true);
      expect(finished.status).toBe(303);
      const next = finished.headers.get("Location") ?? "";
      return {
        outcome: outcomeOf(next),
        location: next,
        callback: replayable,
        issuerOutcome: issued,
      };
    }

    async function session(b: Browser) {
      return (await b.json("GET", "/session")).body as {
        authenticated: boolean;
        account?: { id: string; email: string; emailVerified?: boolean; hasPassword?: boolean };
        subscription?: { status: string };
      };
    }

    async function emailStatus(email: string): Promise<string> {
      const b = browser();
      const response = await b.json("GET", `/auth/email-status?email=${encodeURIComponent(email)}`);
      return String(response.body?.next);
    }

    /** Make the browser an account holder: a profile without parental controls, selected. */
    async function becomeHolder(b: Browser): Promise<void> {
      const created = await b.json("POST", "/profiles", { name: "Main", avatarId: "av-fox" });
      expect(created.status).toBe(201);
      const selected = await b.json("PUT", "/session/profile", {
        profileId: (created.body as { id: string }).id,
      });
      expect(selected.status).toBe(200);
    }

    async function passwordAccount(email: string): Promise<Browser> {
      const b = browser();
      const created = await b.json("POST", "/auth/signup", { email, password: PASSWORD });
      expect(created.status).toBe(201);
      return b;
    }

    async function mailbox(to: string) {
      await h().drainJobs();
      const response = await browser().json(
        "GET",
        `/diagnostics/mailbox?to=${encodeURIComponent(to)}`,
      );
      expect(response.status).toBe(200);
      return (
        response.body as { items: Array<{ template: string; links: string[]; subject: string }> }
      ).items;
    }

    async function verifyEmail(email: string): Promise<void> {
      const message = (await mailbox(email)).findLast((item) => item.template === "verify-email");
      const link = message?.links.find((candidate) => candidate.includes("#token="));
      expect(link).toBeDefined();
      const token = new URL(link ?? "").hash.replace("#token=", "");
      const confirmed = await browser().json("POST", "/auth/email-verification/confirm", { token });
      expect(confirmed.status).toBe(204);
    }

    async function elevate(b: Browser): Promise<void> {
      const response = await b.json("POST", "/session/elevation", { password: PASSWORD });
      expect(response.status).toBe(200);
    }

    async function identities(b: Browser): Promise<string[]> {
      const response = await b.json("GET", "/account/identities");
      expect(response.status).toBe(200);
      return (response.body as { items: Array<{ provider: string }> }).items.map(
        (item) => item.provider,
      );
    }

    // --- Journeys -----------------------------------------------------------------------------

    describe("sign-up and sign-in", () => {
      for (const provider of ["google", "apple"] as const) {
        it(`signs up with ${provider} (a verified address: membership none, no password) and signs in again`, async () => {
          const email = unique(`new-${provider}`);
          const b = browser();
          const first = await flow(b, provider, { email: { address: email, verified: true } });
          expect(first.outcome).toBe("signed-up");
          expect(first.issuerOutcome?.mode).toBe(provider === "apple" ? "form_post" : "query");
          expect(new URL(first.location).pathname).toBe("/browse");
          const signedUp = await session(b);
          expect(signedUp).toMatchObject({
            authenticated: true,
            account: { email, emailVerified: true, hasPassword: false },
          });
          // No membership is exactly that: no subscription or plan stands in for it.
          expect(signedUp).toMatchObject({ subscription: null, plan: null });

          const again = browser();
          expect(
            (await flow(again, provider, { email: { address: email, verified: true } })).outcome,
          ).toBe("signed-in");
          expect((await session(again)).account?.id).toBe(signedUp.account?.id);
          // The welcome email went to the address the issuer verified.
          expect((await mailbox(email)).map((item) => item.template)).toContain("welcome");
        });
      }

      it("refuses a sign-up with an address the issuer did not verify (no squatting)", async () => {
        const email = unique("unverified");
        const b = browser();
        expect(
          (await flow(b, "google", { email: { address: email, verified: false } })).outcome,
        ).toBe("failed");
        expect((await session(b)).authenticated).toBe(false);
        expect(await emailStatus(email)).toBe("signup");
      });

      it("refuses an identity without an address, and a cancelled sign-in", async () => {
        const b = browser();
        expect((await flow(b, "google", { persona: "no-email" })).outcome).toBe("failed");
        expect((await flow(b, "google", { persona: "new-member", cancel: true })).outcome).toBe(
          "cancelled",
        );
        expect((await session(b)).authenticated).toBe(false);
      });

      it("returns to a same-origin path only", async () => {
        const b = browser();
        for (const returnTo of ["//evil.example/x", "https://evil.example/", "/\\evil.example"]) {
          const response = await start(b, "google", { returnTo });
          expect(response.status).toBe(400);
        }
        const done = await flow(
          b,
          "google",
          { email: { address: unique("return"), verified: true } },
          { returnTo: "/title/t-1?x=1" },
        );
        const url = new URL(done.location);
        expect(url.origin).toBe(h().origin);
        expect(url.pathname).toBe("/title/t-1");
        expect(url.searchParams.get("x")).toBe("1");
      });

      it("lists the offered issuers for the sign-in buttons", async () => {
        const response = await browser().send(new Request(`${h().origin}${API}/auth/providers`));
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
        expect(await response.json()).toEqual({
          items: [
            { id: "google", displayName: "Google" },
            { id: "apple", displayName: "Apple" },
          ],
        });
      });

      it("answers a callback refused before its handler with a redirect, never JSON", async () => {
        const b = browser();
        await start(b, "google", { returnTo: "/after" });
        const oversized = await b.send(
          new Request(
            `${h().origin}${API}/auth/oidc/google/callback?code=${"x".repeat(5000)}&state=s`,
          ),
        );
        expect(oversized.status).toBe(303);
        expect(oversized.headers.get("Location")).toBe(`${h().origin}/after?oidc=failed`);
        await start(b, "apple", { returnTo: "/apple" });
        const repeated = await b.send(
          new Request(`${h().origin}${API}/auth/oidc/apple/callback`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "code=a&code=b&state=s",
          }),
        );
        expect(repeated.status).toBe(303);
        expect(repeated.headers.get("Location")).toBe(`${h().origin}/apple?oidc=failed`);
        expect(repeated.headers.get("Content-Type") ?? "").not.toMatch(/json/);
        expect((await session(b)).authenticated).toBe(false);
      });

      it("sends a browser back from a refused start with the reason; a script gets the problem document", async () => {
        const b = await passwordAccount(unique("refused-start"));
        await becomeHolder(b);
        const link = (headers: Record<string, string>, returnTo = "/account") =>
          b.send(
            new Request(
              `${h().origin}${API}/auth/oidc/google/start?intent=link&returnTo=${encodeURIComponent(returnTo)}`,
              { headers },
            ),
          );
        // A followed link without a fresh proof: back where it came from, the reason marked.
        const navigated = await link(NAVIGATE);
        expect(navigated.status).toBe(303);
        expect(navigated.headers.get("Location")).toBe(
          `${h().origin}/account?oidc=failed&oidcError=reauthentication_required`,
        );
        expect(navigated.headers.get("Content-Type") ?? "").not.toMatch(/json/);
        expect(navigated.headers.getSetCookie().some((line) => line.includes("_oidc_"))).toBe(
          false,
        );
        // A browser without Fetch Metadata asks for HTML: the same answer.
        expect((await link({ Accept: "text/html" })).headers.get("Location")).toBe(
          navigated.headers.get("Location"),
        );
        // A programmatic caller, or the page's own fetch: the problem document, as before.
        const scriptedHeaders: Record<string, string>[] = [
          {},
          { "Sec-Fetch-Mode": "cors", Accept: "text/html" },
        ];
        for (const headers of scriptedHeaders) {
          const scripted = await link(headers);
          expect(scripted.status).toBe(403);
          expect(((await scripted.json()) as { code: string }).code).toBe(
            "reauthentication_required",
          );
        }
        // `returnTo` is checked as the route checks it: anything else goes to the root.
        expect((await link(NAVIGATE, "//evil.example/x")).headers.get("Location")).toBe(
          `${h().origin}/?oidc=failed&oidcError=validation_failed`,
        );
        // Signed out, a proof cannot even start.
        const signedOut = await browser().send(
          new Request(
            `${h().origin}${API}/auth/oidc/google/start?intent=reauth&returnTo=/account`,
            {
              headers: NAVIGATE,
            },
          ),
        );
        expect(signedOut.headers.get("Location")).toBe(
          `${h().origin}/account?oidc=failed&oidcError=unauthenticated`,
        );
      });

      it("keeps the rate limit: a browser is sent back to try again later, a script gets 429", async () => {
        const b = browser("203.0.113.30");
        let refused: Response | null = null;
        // The `oidc` budget: 30 a minute by default, 300 in a Node dev configuration.
        for (let attempt = 0; attempt < 400 && refused === null; attempt += 1) {
          const response = await b.send(
            new Request(`${h().origin}${API}/auth/oidc/google/start?returnTo=/signin`, {
              headers: NAVIGATE,
            }),
          );
          if (response.status !== 302) refused = response;
        }
        expect(refused?.status).toBe(303);
        expect(refused?.headers.get("Location")).toBe(
          `${h().origin}/signin?oidc=failed&oidcError=rate_limited`,
        );
        expect(refused?.headers.get("Retry-After")).toBeNull();
        const scripted = await start(b, "google");
        expect(scripted.status).toBe(429);
        expect(((await scripted.json()) as { code: string }).code).toBe("rate_limited");
        // The callback of a sign-in started before the limit: back to its returnTo, same reason.
        const callback = await b.send(
          new Request(`${h().origin}${API}/auth/oidc/google/callback?code=c&state=s`, {
            headers: NAVIGATE,
          }),
        );
        expect(callback.status).toBe(303);
        expect(callback.headers.get("Location")).toBe(
          `${h().origin}/signin?oidc=failed&oidcError=rate_limited`,
        );
      });

      it("does not offer an issuer the deployment does not configure", async () => {
        expect((await start(browser(), "keycloak")).status).toBe(404);
      });
    });

    describe("the linking rule (§4.1): no takeover by asserting an address", () => {
      it("links automatically only when both sides verified the address", async () => {
        const email = unique("victim");
        await passwordAccount(email);
        // The account has not proved its address: an issuer asserting it, verified or not, is not enough.
        const attacker = browser();
        expect(
          (await flow(attacker, "google", { email: { address: email, verified: true } })).outcome,
        ).toBe("link-required");
        expect((await session(attacker)).authenticated).toBe(false);

        await verifyEmail(email);
        const unverifiedAtIssuer = browser();
        expect(
          (await flow(unverifiedAtIssuer, "google", { email: { address: email, verified: false } }))
            .outcome,
        ).toBe("link-required");
        expect((await session(unverifiedAtIssuer)).authenticated).toBe(false);

        // Both verified: the identity is linked and signs in to the account.
        const owner = browser();
        expect(
          (await flow(owner, "apple", { email: { address: email, verified: true } })).outcome,
        ).toBe("signed-in");
        expect((await session(owner)).account?.email).toBe(email);
        expect((await mailbox(email)).map((item) => item.template)).toContain("security-change");
      });

      it("emailUnverified, emailVerifiedAbsent: never sign in to an existing account by its address", async () => {
        const email = unique("verified-owner");
        await passwordAccount(email);
        await verifyEmail(email);
        for (const fault of ["emailUnverified", "emailVerifiedAbsent"]) {
          const attacker = browser();
          const done = await flow(attacker, "google", {
            email: { address: email, verified: true },
            faults: { [fault]: true },
          });
          expect(done.outcome, fault).toBe("link-required");
          expect((await session(attacker)).authenticated, fault).toBe(false);
        }
        // And with no account, no sign-up either.
        const fresh = unique("absent");
        const b = browser();
        expect(
          (
            await flow(b, "google", {
              email: { address: fresh, verified: true },
              faults: { emailVerifiedAbsent: true },
            })
          ).outcome,
        ).toBe("failed");
        expect(await emailStatus(fresh)).toBe("signup");
      });

      it("subjectChanged: a new subject with a known address is a new identity, never the old one", async () => {
        const email = unique("subject");
        const b = browser();
        expect(
          (await flow(b, "google", { email: { address: email, verified: true } })).outcome,
        ).toBe("signed-up");
        const changed = browser();
        const done = await flow(changed, "google", {
          email: { address: email, verified: true },
          faults: { subjectChanged: true },
        });
        // The account already has a Google identity (another subject): nothing is replaced.
        expect(done.outcome).toBe("link-required");
        expect((await session(changed)).authenticated).toBe(false);
      });

      it("never links an identity to the shared demo account", async () => {
        await h().seedDemo();
        const b = browser();
        expect((await flow(b, "google", { persona: "demo-verified" })).outcome).toBe(
          "link-required",
        );
        expect((await session(b)).authenticated).toBe(false);
      });
    });

    describe("linking and unlinking from Account", () => {
      it("needs a fresh account-holder proof, links once, refuses an identity of another account", async () => {
        const email = unique("linker");
        const b = await passwordAccount(email);
        await becomeHolder(b);
        const refused = await start(b, "google", { intent: "link" });
        expect(refused.status).toBe(403);
        expect(((await refused.json()) as { code: string }).code).toBe("reauthentication_required");

        await elevate(b);
        const googleEmail = unique("linked-google");
        expect(
          (
            await flow(
              b,
              "google",
              { email: { address: googleEmail, verified: true } },
              { intent: "link" },
            )
          ).outcome,
        ).toBe("linked");
        expect(await identities(b)).toEqual(["google"]);
        // Linking the same identity again is idempotent.
        expect(
          (
            await flow(
              b,
              "google",
              { email: { address: googleEmail, verified: true } },
              { intent: "link" },
            )
          ).outcome,
        ).toBe("linked");

        const other = await passwordAccount(unique("other"));
        await becomeHolder(other);
        await elevate(other);
        expect(
          (
            await flow(
              other,
              "google",
              { email: { address: googleEmail, verified: true } },
              { intent: "link" },
            )
          ).outcome,
        ).toBe("identity-in-use");
        expect(await identities(other)).toEqual([]);

        // Signing in with the linked identity reaches the first account.
        const later = browser();
        expect(
          (await flow(later, "google", { email: { address: googleEmail, verified: true } }))
            .outcome,
        ).toBe("signed-in");
        expect((await session(later)).account?.email).toBe(email);
      });

      it("refuses to link an identity whose address the issuer did not verify", async () => {
        const b = await passwordAccount(unique("strict"));
        await becomeHolder(b);
        await elevate(b);
        expect(
          (
            await flow(
              b,
              "google",
              { email: { address: unique("x"), verified: false } },
              { intent: "link" },
            )
          ).outcome,
        ).toBe("failed");
        expect(await identities(b)).toEqual([]);
      });

      it("an unlinked identity does not come back by itself (M2-F5): only the deliberate link", async () => {
        const email = unique("unlink-sticks");
        const owner = await passwordAccount(email);
        await becomeHolder(owner);
        await elevate(owner);
        // Linked under the account's own address, then used once (which verifies the address).
        expect(
          (
            await flow(
              owner,
              "google",
              { email: { address: email, verified: true } },
              { intent: "link" },
            )
          ).outcome,
        ).toBe("linked");
        expect(
          (await flow(browser(), "google", { email: { address: email, verified: true } })).outcome,
        ).toBe("signed-in");
        expect((await owner.json("DELETE", "/account/identities/google")).status).toBe(204);

        // Both addresses verified, yet the removed identity is not linked again automatically.
        const lost = browser();
        expect(
          (await flow(lost, "google", { email: { address: email, verified: true } })).outcome,
        ).toBe("link-required");
        expect((await session(lost)).authenticated).toBe(false);
        expect(await identities(owner)).toEqual([]);

        // The deliberate, proven path links it again, and then it signs in.
        await elevate(owner);
        expect(
          (
            await flow(
              owner,
              "google",
              { email: { address: email, verified: true } },
              { intent: "link" },
            )
          ).outcome,
        ).toBe("linked");
        expect(
          (await flow(browser(), "google", { email: { address: email, verified: true } })).outcome,
        ).toBe("signed-in");
      });

      it("unlinks with a fresh proof while another way to sign in remains", async () => {
        const b = browser();
        const email = unique("passwordless");
        expect(
          (await flow(b, "google", { email: { address: email, verified: true } })).outcome,
        ).toBe("signed-up");
        await becomeHolder(b);
        expect((await b.json("DELETE", "/account/identities/google")).body?.code).toBe(
          "reauthentication_required",
        );
        expect(
          (
            await flow(
              b,
              "google",
              { email: { address: email, verified: true } },
              { intent: "reauth" },
            )
          ).outcome,
        ).toBe("reauthenticated");
        expect((await b.json("DELETE", "/account/identities/google")).body?.code).toBe(
          "identity_last_sign_in_method",
        );
        expect(
          (
            await flow(
              b,
              "apple",
              { email: { address: unique("apple"), verified: true } },
              { intent: "link" },
            )
          ).outcome,
        ).toBe("linked");
        expect(await identities(b)).toEqual(["google", "apple"]);
        expect((await b.json("DELETE", "/account/identities/google")).status).toBe(204);
        expect(await identities(b)).toEqual(["apple"]);
        expect((await b.json("DELETE", "/account/identities/google")).status).toBe(404);
      });
    });

    describe("the account-holder proof without a password (§4.2)", () => {
      it("a fresh sign-in with a linked issuer elevates the session; the password never works", async () => {
        const email = unique("proof");
        const b = browser();
        expect(
          (await flow(b, "google", { email: { address: email, verified: true } })).outcome,
        ).toBe("signed-up");
        const before = (await b.json("GET", "/session/elevation")).body as {
          elevatedUntil: string | null;
          methods: string[];
        };
        expect(before).toEqual({ elevatedUntil: null, methods: ["google"] });
        // There is no password: none, of any value, is accepted (the stored hash is empty).
        expect((await b.json("POST", "/session/elevation", { password: "" })).status).toBe(400);
        for (const password of [" ", "x", PASSWORD]) {
          const attempt = await b.json("POST", "/session/elevation", { password });
          expect(attempt.status, JSON.stringify(password)).toBe(403);
          expect(attempt.body?.code, JSON.stringify(password)).toBe("password_required");
        }
        const signIn = await browser().json("POST", "/auth/login", {
          email,
          password: "anything at all",
        });
        expect(signIn.status).toBe(401);

        expect(
          (
            await flow(
              b,
              "google",
              { email: { address: email, verified: true } },
              { intent: "reauth" },
            )
          ).outcome,
        ).toBe("reauthenticated");
        const after = (await b.json("GET", "/session/elevation")).body as {
          elevatedUntil: string | null;
        };
        expect(after.elevatedUntil).not.toBeNull();
      });

      it("staleAuthTime, missingAuthTime: a sign-in that is not fresh is never a proof", async () => {
        const email = unique("stale");
        const b = browser();
        expect(
          (await flow(b, "google", { email: { address: email, verified: true } })).outcome,
        ).toBe("signed-up");
        for (const fault of ["staleAuthTime", "missingAuthTime"]) {
          const done = await flow(
            b,
            "google",
            { email: { address: email, verified: true }, faults: { [fault]: true } },
            { intent: "reauth" },
          );
          expect(done.outcome, fault).toBe("failed");
          expect(
            ((await b.json("GET", "/session/elevation")).body as { elevatedUntil: unknown })
              .elevatedUntil,
            fault,
          ).toBeNull();
        }
      });

      it("refuses a proof by an identity linked to another account", async () => {
        const mine = browser();
        expect(
          (await flow(mine, "google", { email: { address: unique("mine"), verified: true } }))
            .outcome,
        ).toBe("signed-up");
        const theirs = unique("theirs");
        expect(
          (await flow(browser(), "google", { email: { address: theirs, verified: true } })).outcome,
        ).toBe("signed-up");
        expect(
          (
            await flow(
              mine,
              "google",
              { email: { address: theirs, verified: true } },
              { intent: "reauth" },
            )
          ).outcome,
        ).toBe("failed");
        expect(
          ((await mine.json("GET", "/session/elevation")).body as { elevatedUntil: unknown })
            .elevatedUntil,
        ).toBeNull();
      });
    });

    describe("the callback trusts nothing it did not start", () => {
      it("refuses a replayed callback, a missing or foreign transaction, and another browser's response", async () => {
        const b = browser();
        const done = await flow(b, "google", {
          email: { address: unique("replay"), verified: true },
        });
        expect(done.outcome).toBe("signed-up");
        // The same request again, transaction cookie included (a captured callback).
        const replay = await h().fetch(done.callback as Request);
        expect(outcomeOf(replay.headers.get("Location") ?? "")).toBe("failed");
        expect(
          replay.headers
            .getSetCookie()
            .some((line) => /webflix_session=[^;]+/.test(line) && !/max-age=0/i.test(line)),
        ).toBe(false);

        // An authorisation response delivered to a browser that never started it (login CSRF).
        const attacker = browser();
        const started = await start(attacker, "google");
        const issued = await h().authorize(started.headers.get("Location") ?? "", {
          email: { address: unique("attacker"), verified: true },
        });
        const victim = browser();
        await start(victim, "google"); // the victim has a transaction of their own
        const forced = await victim.send(issued.toRequest());
        expect(outcomeOf(forced.headers.get("Location") ?? "")).toBe("failed");
        expect((await session(victim)).authenticated).toBe(false);

        // No transaction at all, or a tampered one.
        const bare = await h().fetch(issued.toRequest());
        expect(outcomeOf(bare.headers.get("Location") ?? "")).toBe("failed");
        const forged = browser();
        await start(forged, "google");
        for (const [key, value] of forged.cookies)
          forged.cookies.set(key, `${value.slice(0, -4)}AAAA`);
        expect(
          outcomeOf((await forged.send(issued.toRequest())).headers.get("Location") ?? ""),
        ).toBe("failed");
      });

      it("refuses a transaction started for another issuer", async () => {
        const b = browser();
        const started = await start(b, "apple");
        expect(started.status).toBe(302);
        const appleCookie = [...b.cookies].find(([key]) => key.includes("oidc_apple"));
        expect(appleCookie).toBeDefined();
        const google = browser();
        const googleStart = await start(google, "google");
        const issued = await h().authorize(googleStart.headers.get("Location") ?? "", {
          email: { address: unique("mixed"), verified: true },
        });
        const [, value = ""] = appleCookie ?? [];
        google.cookies.clear();
        google.cookies.set(
          [...b.cookies.keys()][0]?.replace("apple", "google") ?? "webflix_oidc_google",
          value,
        );
        expect(
          outcomeOf((await google.send(issued.toRequest())).headers.get("Location") ?? ""),
        ).toBe("failed");
      });
    });

    // --- The fault catalogue ----------------------------------------------------------------

    describe("faults the relying party must reject", () => {
      for (const provider of ["google", "apple"] as const) {
        for (const fault of REJECTED_FAULTS) {
          it(`${provider}: ${fault}`, async () => {
            const email = unique(`fault-${fault}`);
            const b = browser();
            const done = await flow(b, provider, {
              email: { address: email, verified: true },
              faults: { [fault]: true },
            });
            // The issuer answered and the callback ran: the relying party refused the response.
            expect(done.issuerOutcome).not.toBeNull();
            expect(done.outcome).toBe("failed");
            expect((await session(b)).authenticated).toBe(false);
            expect(await emailStatus(email)).toBe("signup");
          });
        }
      }

      it("jwksRotatedMidFlow: a key published during the flow is fetched once and accepted", async () => {
        const warm = browser();
        expect(
          (await flow(warm, "google", { email: { address: unique("warm"), verified: true } }))
            .outcome,
        ).toBe("signed-up");
        const b = browser();
        const done = await flow(b, "google", {
          email: { address: unique("rotated"), verified: true },
          faults: { jwksRotatedMidFlow: true },
        });
        expect(done.outcome).toBe("signed-up");
      });

      it("discoveryIssuerMismatch: a discovery document naming another issuer is refused before any sign-in", async () => {
        h().setStandingFaults("google", { discoveryIssuerMismatch: true });
        const b = browser();
        const done = await flow(b, "google", {
          email: { address: unique("mixup"), verified: true },
        });
        expect(done.outcome).toBe("failed");
        expect(done.issuerOutcome).toBeNull();
        expect((await session(b)).authenticated).toBe(false);
      });

      it("jwksSlow: an issuer that does not answer in time fails the sign-in cleanly", async () => {
        h().setStandingFaults("google", { jwksSlow: { delayMs: 3000 } });
        const b = browser();
        const email = unique("slow");
        const done = await flow(b, "google", { email: { address: email, verified: true } });
        expect(done.outcome).toBe("failed");
        expect(await emailStatus(email)).toBe("signup");
        // Everything that does not need the issuer keeps working.
        expect((await b.json("GET", "/session")).status).toBe(200);
      });

      it("jwksFailing: no key set, no sign-in; a key set already trusted keeps working", async () => {
        h().setStandingFaults("google", { jwksFailing: { status: 503 } });
        const email = unique("failing");
        expect(
          (await flow(browser(), "google", { email: { address: email, verified: true } })).outcome,
        ).toBe("failed");
        expect(await emailStatus(email)).toBe("signup");

        h().setStandingFaults("google", {});
        expect(
          (
            await flow(browser(), "google", {
              email: { address: unique("trusted"), verified: true },
            })
          ).outcome,
        ).toBe("signed-up");
        h().setStandingFaults("google", { jwksFailing: { status: 503 } });
        expect(
          (
            await flow(browser(), "google", {
              email: { address: unique("cached"), verified: true },
            })
          ).outcome,
        ).toBe("signed-up");
      });

      it("userinfoSubjectMismatch: the relying party never takes identity from userinfo", async () => {
        h().setStandingFaults("google", { userinfoSubjectMismatch: true });
        const email = unique("userinfo");
        const b = browser();
        expect(
          (await flow(b, "google", { email: { address: email, verified: true } })).outcome,
        ).toBe("signed-up");
        const again = browser();
        expect(
          (await flow(again, "google", { email: { address: email, verified: true } })).outcome,
        ).toBe("signed-in");
        expect((await session(again)).account?.id).toBe((await session(b)).account?.id);
      });
    });

    // --- Email verification and password reset ---------------------------------------------

    describe("email verification and password reset (§4.3)", () => {
      it("verifies an address with its single-use link", async () => {
        const email = unique("verify");
        const b = await passwordAccount(email);
        expect((await session(b)).account?.emailVerified).toBe(false);
        const message = (await mailbox(email)).find((item) => item.template === "verify-email");
        const token = new URL(
          message?.links.find((link) => link.includes("#token=")) ?? "",
        ).hash.slice(7);
        expect(
          (await browser().json("POST", "/auth/email-verification/confirm", { token })).status,
        ).toBe(204);
        expect((await session(b)).account?.emailVerified).toBe(true);
        expect(
          (await browser().json("POST", "/auth/email-verification/confirm", { token })).body?.code,
        ).toBe("verification_token_invalid");
        // Verified: asking again sends nothing.
        expect((await b.json("POST", "/auth/email-verification")).status).toBe(204);
        expect(
          (await mailbox(email)).filter((item) => item.template === "verify-email"),
        ).toHaveLength(1);
      });

      it("answers a reset request identically whether or not the address has an account", async () => {
        const known = unique("known");
        await passwordAccount(known);
        const unknown = unique("unknown");
        const a = await browser().json("POST", "/auth/password-reset", { email: known });
        const b = await browser().json("POST", "/auth/password-reset", { email: unknown });
        expect(a).toEqual({ status: 204, body: null });
        expect(b).toEqual(a);
        expect((await mailbox(known)).map((item) => item.template)).toContain("reset-password");
        expect(await mailbox(unknown)).toEqual([]);
      });

      it("resets a password once, signs every device out, and alerts the owner", async () => {
        const email = unique("reset");
        const device = await passwordAccount(email);
        await browser().json("POST", "/auth/password-reset", { email });
        const message = (await mailbox(email)).find((item) => item.template === "reset-password");
        const token = new URL(
          message?.links.find((link) => link.includes("#token=")) ?? "",
        ).hash.slice(7);
        const done = await browser().json("POST", "/auth/password-reset/confirm", {
          token,
          newPassword: "a brand new passphrase",
        });
        expect(done.status).toBe(204);
        expect((await session(device)).authenticated).toBe(false);
        expect(
          (await browser().json("POST", "/auth/login", { email, password: PASSWORD })).status,
        ).toBe(401);
        expect(
          (
            await browser().json("POST", "/auth/login", {
              email,
              password: "a brand new passphrase",
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await browser().json("POST", "/auth/password-reset/confirm", {
              token,
              newPassword: "yet another passphrase",
            })
          ).body?.code,
        ).toBe("verification_token_invalid");
        expect((await mailbox(email)).map((item) => item.template)).toContain("security-change");
      });

      it("a reset drops an identity planted under another address before the owner proved theirs", async () => {
        // An attacker signs up with the victim's address, links an identity of their own.
        const victim = unique("pre-hijack");
        const attacker = await passwordAccount(victim);
        await becomeHolder(attacker);
        await elevate(attacker);
        const attackersGoogle = unique("attackers-google");
        expect(
          (
            await flow(
              attacker,
              "google",
              { email: { address: attackersGoogle, verified: true } },
              { intent: "link" },
            )
          ).outcome,
        ).toBe("linked");
        // The owner resets the password through their mailbox.
        await browser().json("POST", "/auth/password-reset", { email: victim });
        const message = (await mailbox(victim)).find((item) => item.template === "reset-password");
        const token = new URL(
          message?.links.find((link) => link.includes("#token=")) ?? "",
        ).hash.slice(7);
        expect(
          (
            await browser().json("POST", "/auth/password-reset/confirm", {
              token,
              newPassword: "the owner's passphrase",
            })
          ).status,
        ).toBe(204);
        // The attacker's session and identity are both gone.
        expect((await session(attacker)).authenticated).toBe(false);
        const comeback = browser();
        expect(
          (await flow(comeback, "google", { email: { address: attackersGoogle, verified: true } }))
            .outcome,
        ).not.toBe("signed-in");
        expect((await session(comeback)).account?.email).not.toBe(victim);
      });
    });
  });
}
