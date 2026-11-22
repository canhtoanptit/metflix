/**
 * Milestone 2 sign-in (docs/BLUEPRINT-M2.md §4): federated sign-up and sign-in with Google and
 * Apple through the development issuer, linking and unlinking, the account-holder proof
 * without a password, email verification and password reset. Driven over HTTP only: the
 * issuer's pages are answered as a browser would (packages/dev-idp).
 */
import { type AuthenticatedSession, ELEVATION_TTL_SEC, type OidcOutcome } from "@webflix/contracts";
import { isSessionCookieName, parseSetCookie, type SetCookie } from "../cookies.ts";
import type { Environment, TestAccount } from "../env.ts";
import { check, equal, fail, problem, rejects, status, succeeds } from "../expect.ts";
import type { Agent, HttpResult } from "../http.ts";
import { awaitMail, linkToken } from "../mail.ts";
import { needs } from "../needs.ts";
import {
  type FederatedResult,
  federatedSignIn,
  type IssuerChoice,
  issuerLocation,
  issuerRealm,
  type MemberIssuer,
  type OidcIntent,
  outcomeOf,
  replayDelivery,
  startFederated,
} from "../oidc.ts";
import type { CheckContext, CheckDefinition } from "../types.ts";
import { API, CSRF } from "./util.ts";

/** One federated sign-in, paced within the run's `oidc` budget. */
async function signIn(
  env: Environment,
  agent: Agent,
  provider: MemberIssuer,
  choice: IssuerChoice,
  query: { intent?: OidcIntent; returnTo?: string } = {},
): Promise<FederatedResult> {
  await env.issuerSlot();
  return federatedSignIn(agent, provider, choice, query);
}

function expectOutcome(result: FederatedResult, expected: OidcOutcome, what: string): void {
  if (result.outcome !== expected) {
    fail(`${what}: the callback ended "${result.outcome ?? "(no outcome)"}"`, {
      expected: `303 to returnTo?oidc=${expected}`,
      observed: `${result.callback.status} Location: ${result.location}`,
      exchange: result.callback.exchange,
      details: ["the server logs identity.oidc_failed with the reason (grep the request id)"],
    });
  }
}

async function signedIn(agent: Agent, what: string): Promise<AuthenticatedSession> {
  const state = await succeeds(() => agent.api.getSession(), `${what}: GET /session`);
  if (!state.authenticated) {
    fail(`${what}: the browser is not signed in`, {
      expected: "authenticated: true",
      observed: JSON.stringify(state),
    });
  }
  return state;
}

async function signedOut(agent: Agent, what: string): Promise<void> {
  const state = await succeeds(() => agent.api.getSession(), `${what}: GET /session`);
  equal(state.authenticated, false, `${what}: session.authenticated`);
}

/** The transaction cookie the start redirect set (the callback deletes it afterwards). */
function transactionCookie(result: FederatedResult, provider: MemberIssuer): SetCookie | undefined {
  return result.start.headers
    .getSetCookie()
    .map(parseSetCookie)
    .find(
      (cookie): cookie is SetCookie => cookie?.name.endsWith(`webflix_oidc_${provider}`) ?? false,
    );
}

/** A test account for an agent signed in through an issuer (no password). */
function issuerAccount(tag: string, email: string, agent: Agent, session: AuthenticatedSession) {
  return { tag, email, password: "", agent, session } satisfies TestAccount;
}

function unlink(agent: Agent, provider: MemberIssuer): Promise<HttpResult> {
  return agent.fetch(`${API}/account/identities/${provider}`, { method: "DELETE", headers: CSRF });
}

/** The proof lasts ELEVATION_TTL_SEC from now (a little clock skew allowed either way). */
function assertFreshProof(elevatedUntil: string | null, what: string): void {
  check(elevatedUntil, `${what}: no account-holder proof was recorded`, {
    expected: `elevatedUntil about ${ELEVATION_TTL_SEC} s from now`,
    observed: "null",
  });
  const remaining = (Date.parse(elevatedUntil) - Date.now()) / 1000;
  check(
    remaining > ELEVATION_TTL_SEC - 120 && remaining <= ELEVATION_TTL_SEC + 60,
    `${what}: the proof does not last ${ELEVATION_TTL_SEC} s`,
    { expected: `elevatedUntil ≈ now + ${ELEVATION_TTL_SEC} s`, observed: elevatedUntil },
  );
}

export const signinChecks: CheckDefinition[] = [
  {
    id: "identity.oidc.google-signup",
    area: "identity",
    title:
      "Sign up with Google through the development issuer: code flow with PKCE, a new account with no password and no membership; the next sign-in finds it",
    needs: [needs.googleIssuer],
    async run(ctx: CheckContext) {
      const agent = ctx.agent("google-signup");
      const offered = await agent.fetch(`${API}/auth/providers`);
      status(offered, 200, "GET /auth/providers");
      check(
        /public/.test(offered.headers.get("Cache-Control") ?? ""),
        "GET /auth/providers is not publicly cacheable",
        {
          expected: "Cache-Control: public",
          observed: offered.headers.get("Cache-Control") ?? "(absent)",
          exchange: offered.exchange,
        },
      );
      const email = ctx.env.email("google");
      const result = await signIn(
        ctx.env,
        agent,
        "google",
        { email: { address: email, name: "Smoke Google" } },
        { returnTo: "/browse" },
      );

      // The authorisation request (§4.1): code flow, S256 PKCE, state and nonce, exact callback.
      const params = result.authorizeUrl.searchParams;
      equal(params.get("response_type"), "code", "response_type", result.start.exchange);
      equal(params.get("code_challenge_method"), "S256", "PKCE method", result.start.exchange);
      for (const name of ["state", "nonce", "code_challenge"]) {
        check(
          (params.get(name) ?? "").length >= 22,
          `the authorisation request's ${name} is weak or absent`,
          {
            expected: `${name}: at least 128 bits, base64url`,
            observed: params.get(name) ?? "(absent)",
            exchange: result.start.exchange,
          },
        );
      }
      equal(
        new URL(params.get("redirect_uri") ?? "/", agent.origin).pathname,
        `${API}/auth/oidc/google/callback`,
        "redirect_uri path",
        result.start.exchange,
      );
      const transaction = transactionCookie(result, "google");
      check(
        transaction && "httponly" in transaction.attributes,
        "the transaction cookie is not HttpOnly",
        {
          expected: "Set-Cookie: webflix_oidc_google=…; HttpOnly",
          observed: transaction ? JSON.stringify(transaction.attributes) : "(not set)",
          exchange: result.start.exchange,
        },
      );
      if (agent.origin.startsWith("https:")) {
        check(
          transaction.name.startsWith("__Host-") && "secure" in transaction.attributes,
          "on https the transaction cookie must be __Host- and Secure",
          { observed: `${transaction.name} ${JSON.stringify(transaction.attributes)}` },
        );
      }

      expectOutcome(result, "signed-up", "a new Google member");
      check(result.location.startsWith("/browse?"), "the callback did not return to returnTo", {
        expected: "/browse?oidc=signed-up",
        observed: result.location,
      });
      check(
        agent.jar.names().some(isSessionCookieName),
        "the sign-up callback set no session cookie",
        { exchange: result.callback.exchange },
      );
      const session = await signedIn(agent, "after the Google sign-up");
      equal(session.account.email, email, "account email");
      equal(session.account.hasPassword, false, "account.hasPassword (created through an issuer)");
      equal(session.account.emailVerified, true, "account.emailVerified (the issuer verified it)");
      equal(session.profiles.length, 0, "profiles of a new account");
      equal(session.membership?.status, "none", "membership.status of a new account");
      equal(session.entitlement?.entitled, false, "entitlement.entitled of a new account");
      equal(session.entitlement?.reason, "no_membership", "entitlement.reason");

      // The response is bound to the browser that started it: replayed elsewhere it fails.
      const thief = ctx.agent("google-replay");
      const replayed = await replayDelivery(thief, result.delivery);
      equal(
        outcomeOf(thief, replayed),
        "failed",
        "a replayed callback's outcome",
        replayed.exchange,
      );
      await signedOut(thief, "the replaying browser");

      // No password signs in to an account that has none.
      await rejects(
        () =>
          ctx.agent("google-password").api.login({ body: { email, password: ctx.env.password } }),
        "invalid_credentials",
        "password sign-in to an account created through Google",
      );

      // A new browser signs in to the same account.
      const again = ctx.agent("google-again");
      const second = await signIn(ctx.env, again, "google", { email: { address: email } });
      expectOutcome(second, "signed-in", "the next Google sign-in");
      const later = await signedIn(again, "the next Google sign-in");
      equal(later.account.id, session.account.id, "account of the next sign-in");
      const status_ = await succeeds(
        () => agent.api.getEmailStatus({ query: { email } }),
        "GET /auth/email-status",
      );
      equal(status_.next, "login", "email status of the new member");
    },
  },
  {
    id: "identity.oidc.apple-form-post",
    area: "identity",
    title:
      "Sign up with Apple: its form-post callback without the client header, email_verified sent as a string, the unsigned user field never the identity, a tampered state refused",
    needs: [needs.appleIssuer],
    async run(ctx: CheckContext) {
      const agent = ctx.agent("apple-signup");
      const email = ctx.env.email("apple");
      const result = await signIn(
        ctx.env,
        agent,
        "apple",
        { email: { address: email, name: "Smoke Apple" }, firstAuthorisation: true },
        { returnTo: "/profiles" },
      );
      equal(result.mode, "form_post", "how Apple returned the authorisation response");
      check(
        !("x-webflix-client" in result.callback.exchange.requestHeaders),
        "the form post must work without the client header (a cross-site POST cannot send it)",
        { exchange: result.callback.exchange },
      );
      expectOutcome(result, "signed-up", "a new Apple member (form post)");
      const session = await signedIn(agent, "after the Apple sign-up");
      equal(session.account.email, email, "account email");
      // Apple sends email_verified as the string "true" (packages/dev-idp profiles).
      equal(session.account.emailVerified, true, 'account.emailVerified (Apple\'s string "true")');
      equal(session.account.hasPassword, false, "account.hasPassword");
      const transaction = transactionCookie(result, "apple");
      if (agent.origin.startsWith("https:")) {
        // The real Apple posts cross-site: a Lax cookie would not arrive (§4.1).
        check(
          transaction?.attributes.samesite?.toLowerCase() === "none" &&
            "secure" in (transaction?.attributes ?? {}),
          "on https Apple's transaction cookie must be SameSite=None; Secure",
          { observed: JSON.stringify(transaction?.attributes ?? null) },
        );
      } else {
        ctx.note(
          `plain http: Apple's transaction cookie is SameSite=${transaction?.attributes.samesite ?? "?"} (None needs Secure; the development issuer is same-site here). On https it must be None; Secure`,
        );
      }

      // Apple's `user` field is unsigned: a name at most, never the identity or the address.
      const forger = ctx.agent("apple-user-field");
      const genuine = ctx.env.email("apple-genuine");
      const claimed = ctx.env.email("apple-claimed");
      const forgedUser = await signIn(ctx.env, forger, "apple", {
        email: { address: genuine },
        firstAuthorisation: true,
        tamper: (fields) => {
          fields.set(
            "user",
            JSON.stringify({ name: { firstName: "Mallory", lastName: "Forged" }, email: claimed }),
          );
        },
      });
      expectOutcome(forgedUser, "signed-up", "an Apple sign-up whose user field was rewritten");
      equal(
        (await signedIn(forger, "after the rewritten user field")).account.email,
        genuine,
        "the account's address (from the signed ID token, not the user field)",
      );
      equal(
        (
          await succeeds(
            () => forger.api.getEmailStatus({ query: { email: claimed } }),
            "email status",
          )
        ).next,
        "signup",
        "an account for the address in the unsigned user field",
      );

      // A response whose state was swapped is refused before the code is redeemed.
      const forged = ctx.agent("apple-tampered");
      const tampered = await signIn(ctx.env, forged, "apple", {
        email: { address: ctx.env.email("apple-tampered") },
        faults: ["tamperedState"],
      });
      expectOutcome(tampered, "failed", "a form post with a tampered state");
      await signedOut(forged, "after the tampered form post");

      const again = ctx.agent("apple-again");
      const second = await signIn(ctx.env, again, "apple", { email: { address: email } });
      expectOutcome(second, "signed-in", "the next Apple sign-in");
      equal(
        (await signedIn(again, "next Apple sign-in")).account.id,
        session.account.id,
        "account",
      );
    },
  },
  {
    id: "identity.oidc.linking",
    area: "identity",
    title:
      "Linking: never automatic without verified addresses on both sides (nor for the demo account); linking needs a fresh proof; one identity per account; unlinking keeps a way to sign in",
    needs: [needs.googleIssuer],
    timeoutMs: 180_000,
    async run(ctx: CheckContext) {
      const env = ctx.env;
      const account = await env.bareHolder("link");
      const accountId = account.session.account.id;
      equal(account.session.account.emailVerified, false, "a new password account's emailVerified");

      // §4.1: the issuer verified the address, the account did not: no silent takeover.
      const outsider = ctx.agent("link-outsider");
      const takeover = await signIn(env, outsider, "google", { email: { address: account.email } });
      expectOutcome(takeover, "link-required", "Google with the address of an unverified account");
      await signedOut(outsider, "after link-required");
      // Nor the demo account (its persona at the issuer has a verified address).
      const demo = ctx.agent("link-demo");
      const demoTry = await signIn(env, demo, "google", { persona: "demo-verified" });
      expectOutcome(demoTry, "link-required", "Google with the demo account's verified address");
      await signedOut(demo, "after the demo persona");

      // Linking from Account needs a fresh account-holder proof.
      const noProof = await startFederated(account.agent, "google", {
        intent: "link",
        returnTo: "/account",
      });
      problem(noProof, "reauthentication_required", "intent=link without a fresh proof");
      await rejects(
        () => account.agent.api.elevate({ body: { password: `${account.password}-wrong` } }),
        "current_password_invalid",
        "POST /session/elevation with a wrong password",
      );
      const proof = await succeeds(
        () => account.agent.api.elevate({ body: { password: account.password } }),
        "POST /session/elevation",
      );
      assertFreshProof(proof.elevatedUntil, "the password proof");
      check(proof.methods.includes("password"), "elevation methods lack the password", {
        observed: JSON.stringify(proof.methods),
      });

      // Linked under another address the issuer verified: the identity, not the address, is
      // what signs in from then on (keyed by issuer and subject, §4.1).
      const alias = env.email("link-alias");
      const linked = await signIn(
        env,
        account.agent,
        "google",
        { email: { address: alias } },
        { intent: "link", returnTo: "/account" },
      );
      expectOutcome(linked, "linked", "intent=link with a fresh proof");
      check(linked.location.startsWith("/account?"), "the link did not return to returnTo", {
        observed: linked.location,
      });
      const identities = await succeeds(
        () => account.agent.api.listIdentities(),
        "GET /account/identities",
      );
      equal(identities.items.map((item) => item.provider).join(","), "google", "linked issuers");
      equal(identities.items[0]?.emailAtLink, alias, "emailAtLink");
      equal(identities.hasPassword, true, "identities.hasPassword");

      const fresh = ctx.agent("link-signin");
      const viaGoogle = await signIn(env, fresh, "google", { email: { address: alias } });
      expectOutcome(viaGoogle, "signed-in", "Google sign-in with the linked identity");
      equal((await signedIn(fresh, "Google after linking")).account.id, accountId, "account");

      // One identity belongs to one account.
      const other = await env.bareHolder("link-other");
      await succeeds(
        () => other.agent.api.elevate({ body: { password: other.password } }),
        "elevate the other account",
      );
      const stolen = await signIn(
        env,
        other.agent,
        "google",
        { email: { address: alias } },
        { intent: "link", returnTo: "/account" },
      );
      expectOutcome(stolen, "identity-in-use", "linking an identity another account holds");
      const otherIdentities = await succeeds(
        () => other.agent.api.listIdentities(),
        "GET /account/identities (other account)",
      );
      equal(otherIdentities.items.length, 0, "identities of the other account");

      // Unlinking (the proof is still fresh); the password remains. The identity then signs
      // in to nothing of this account's: with no account at its address it signs up anew.
      status(await unlink(account.agent, "google"), 204, "DELETE /account/identities/google");
      const after = await succeeds(
        () => account.agent.api.listIdentities(),
        "GET /account/identities after unlinking",
      );
      equal(after.items.length, 0, "linked issuers after unlinking");
      const unlinked = ctx.agent("link-unlinked");
      const notAnymore = await signIn(env, unlinked, "google", { email: { address: alias } });
      expectOutcome(notAnymore, "signed-up", "the unlinked identity's next sign-in");
      check(
        (await signedIn(unlinked, "after unlinking")).account.id !== accountId,
        "the unlinked identity still signs in to the account",
      );
      await succeeds(
        () =>
          env
            .knownDevice(account, ctx.agent("link-password"))
            .api.login({ body: { email: account.email, password: account.password } }),
        "the password still signs in after unlinking",
      );

      // An account created through Google cannot unlink its only way in.
      const lone = ctx.agent("link-lone");
      const loneEmail = env.email("link-lone");
      const created = await signIn(env, lone, "google", { email: { address: loneEmail } });
      expectOutcome(created, "signed-up", "a Google-only account");
      await env.holder(issuerAccount("link-lone", loneEmail, lone, await signedIn(lone, "lone")));
      const reauth = await signIn(
        env,
        lone,
        "google",
        { email: { address: loneEmail } },
        { intent: "reauth", returnTo: "/account" },
      );
      expectOutcome(reauth, "reauthenticated", "the Google-only account's fresh sign-in");
      problem(
        await unlink(lone, "google"),
        "identity_last_sign_in_method",
        "unlinking the only way to sign in",
      );
      const kept = await succeeds(
        () => lone.api.listIdentities(),
        "identities of the lone account",
      );
      equal(kept.items.length, 1, "identities after the refused unlink");
    },
  },
  {
    id: "identity.oidc.unlink-sticks",
    area: "identity",
    title:
      "An unlinked identity stays removed: with the addresses verified on both sides its next sign-in is link-required, never a silent relink; only a deliberate link by the proven account holder brings it back",
    needs: [needs.googleIssuer],
    async run(ctx: CheckContext) {
      const env = ctx.env;
      const account = await env.bareHolder("unlink-sticks");
      const accountId = account.session.account.id;
      await succeeds(
        () => account.agent.api.elevate({ body: { password: account.password } }),
        "POST /session/elevation",
      );
      const linked = await signIn(
        env,
        account.agent,
        "google",
        { email: { address: account.email } },
        { intent: "link", returnTo: "/account" },
      );
      expectOutcome(linked, "linked", "linking Google under the account's own address");
      // Signing in with the linked identity verifies the shared address (both sides verified).
      const used = ctx.agent("unlink-sticks-used");
      expectOutcome(
        await signIn(env, used, "google", { email: { address: account.email } }),
        "signed-in",
        "the linked identity signs in",
      );
      equal(
        (await signedIn(account.agent, "after the linked sign-in")).account.emailVerified,
        true,
        "the shared address is verified",
      );
      status(await unlink(account.agent, "google"), 204, "DELETE /account/identities/google");
      const after = ctx.agent("unlink-sticks-after");
      const again = await signIn(env, after, "google", { email: { address: account.email } });
      expectOutcome(
        again,
        "link-required",
        "the unlinked identity's next sign-in (both addresses verified)",
      );
      await signedOut(after, "after the removed identity's sign-in");
      equal(
        (await succeeds(() => account.agent.api.listIdentities(), "GET /account/identities")).items
          .length,
        0,
        "identities after the removed identity's sign-in (no silent relink)",
      );
      // The account holder links it again, on purpose (the proof is still fresh).
      const relinked = await signIn(
        env,
        account.agent,
        "google",
        { email: { address: account.email } },
        { intent: "link", returnTo: "/account" },
      );
      expectOutcome(relinked, "linked", "a deliberate link by the account holder");
      const back = ctx.agent("unlink-sticks-back");
      expectOutcome(
        await signIn(env, back, "google", { email: { address: account.email } }),
        "signed-in",
        "the identity linked again signs in",
      );
      equal((await signedIn(back, "relinked")).account.id, accountId, "account signed in to");
    },
  },
  {
    id: "identity.oidc.refused-start",
    area: "identity",
    title:
      "A refused sign-in start sends a browser back to its returnTo with ?oidc=failed&oidcError=<code> (a script still gets the problem document); an unsafe returnTo goes home",
    needs: [needs.googleIssuer],
    async run(ctx: CheckContext) {
      const env = ctx.env;
      const start = (query: string) => `${API}/auth/oidc/google/start?${query}`;
      const expectBack = (result: HttpResult, path: string, code: string, what: string) => {
        status(result, 303, `${what} (a navigation)`);
        const location = new URL(result.headers.get("Location") ?? "", visitor.origin);
        check(
          visitor.sameDeployment(location.href),
          `${what}: the redirect leaves the deployment`,
          {
            observed: location.href,
            exchange: result.exchange,
          },
        );
        equal(location.pathname, path, `${what}: where the browser is sent`, result.exchange);
        equal(location.searchParams.get("oidc"), "failed", `${what}: oidc`, result.exchange);
        equal(location.searchParams.get("oidcError"), code, `${what}: oidcError`, result.exchange);
        check(
          result.bytes.byteLength === 0 ||
            !/problem/.test(result.headers.get("Content-Type") ?? ""),
          `${what}: a problem document was rendered to the browser`,
          { exchange: result.exchange },
        );
      };

      // Signed out, a link needs a session.
      const visitor = ctx.agent("refused-start");
      await env.issuerSlot();
      expectBack(
        await visitor.navigate(start("intent=link&returnTo=/account")),
        "/account",
        "unauthenticated",
        "intent=link signed out",
      );
      await env.issuerSlot();
      problem(
        await visitor.fetch(start("intent=link&returnTo=/account")),
        "unauthenticated",
        "intent=link signed out (a script)",
      );

      // An account holder without a fresh proof.
      const account = await env.bareHolder("refused-start");
      await env.issuerSlot();
      expectBack(
        await account.agent.navigate(start("intent=link&returnTo=/account/security")),
        "/account/security",
        "reauthentication_required",
        "intent=link without a fresh proof",
      );
      await env.issuerSlot();
      problem(
        await account.agent.fetch(start("intent=link&returnTo=/account/security")),
        "reauthentication_required",
        "intent=link without a fresh proof (a script)",
      );

      // An unsafe returnTo is never followed: the browser goes home.
      await env.issuerSlot();
      expectBack(
        await visitor.navigate(start("intent=link&returnTo=//evil.example/x")),
        "/",
        "validation_failed",
        "an off-site returnTo",
      );

      // A start that is not refused still goes to the issuer.
      await env.issuerSlot();
      const accepted = await visitor.navigate(start("returnTo=/browse"));
      status(accepted, 302, "a sign-in start (a navigation)");
      check(
        new URL(accepted.headers.get("Location") ?? "", visitor.origin).pathname.startsWith(
          `${issuerRealm("google")}/`,
        ),
        "an accepted start does not go to the issuer",
        { observed: accepted.headers.get("Location") ?? "", exchange: accepted.exchange },
      );
    },
  },
  {
    id: "identity.oidc.reauth",
    area: "identity",
    title:
      "Confirm it's you without a password: a fresh Google sign-in (max_age=0, judged by auth_time) is the proof; a stale or missing auth_time or another identity is refused",
    needs: [needs.googleIssuer],
    async run(ctx: CheckContext) {
      const env = ctx.env;
      const agent = ctx.agent("reauth");
      const email = env.email("reauth");
      const created = await signIn(env, agent, "google", { email: { address: email } });
      expectOutcome(created, "signed-up", "a Google-only account");
      const member = issuerAccount("reauth", email, agent, await signedIn(agent, "reauth"));
      await env.holder(member);

      const before = await succeeds(() => agent.api.getElevation(), "GET /session/elevation");
      equal(before.elevatedUntil, null, "elevatedUntil before any proof");
      check(before.methods.includes("google"), "a Google-only account is offered no proof", {
        expected: 'methods include "google" (the development issuer reports auth_time)',
        observed: JSON.stringify(before.methods),
      });
      check(
        !before.methods.includes("password"),
        "a passwordless account is offered the password",
        {
          observed: JSON.stringify(before.methods),
        },
      );
      // No password proves anything for an account that has none.
      await rejects(
        () => agent.api.elevate({ body: { password: "no password exists here" } }),
        "password_required",
        "POST /session/elevation on an account without a password",
      );
      await rejects(
        () => agent.api.updateAccount({ body: { newPassword: `${env.password}-first` } }),
        "password_required",
        "PATCH /account without a password or a proof",
      );

      const start = await startFederated(agent, "google", {
        intent: "reauth",
        returnTo: "/account",
      });
      const authorize = issuerLocation(agent, start, "google");
      if ("unsupported" in authorize) ctx.skip(authorize.unsupported);
      equal(
        authorize.searchParams.get("max_age"),
        "0",
        "max_age of the reauthentication request",
        start.exchange,
      );

      for (const [fault, why] of [
        ["staleAuthTime", "an auth_time a day old"],
        ["missingAuthTime", "no auth_time"],
      ] as const) {
        const refused = await signIn(
          env,
          agent,
          "google",
          { email: { address: email }, faults: [fault] },
          { intent: "reauth", returnTo: "/account" },
        );
        expectOutcome(refused, "failed", `a reauthentication with ${why}`);
        const still = await succeeds(() => agent.api.getElevation(), "GET /session/elevation");
        equal(still.elevatedUntil, null, `elevatedUntil after ${why}`);
      }
      const otherIdentity = await signIn(
        env,
        agent,
        "google",
        { email: { address: env.email("reauth-other") } },
        { intent: "reauth", returnTo: "/account" },
      );
      expectOutcome(otherIdentity, "failed", "a reauthentication as another Google identity");
      equal(
        (await succeeds(() => agent.api.getElevation(), "GET /session/elevation")).elevatedUntil,
        null,
        "elevatedUntil after another identity",
      );

      const reauthenticated = await signIn(
        env,
        agent,
        "google",
        { email: { address: email } },
        { intent: "reauth", returnTo: "/account" },
      );
      expectOutcome(reauthenticated, "reauthenticated", "a fresh Google sign-in");
      check(
        reauthenticated.interactive,
        "max_age=0 must make the issuer sign in again, not reuse its session",
        {
          expected: "the issuer's sign-in page",
          observed: "single sign-on redirect",
        },
      );
      const elevation = await succeeds(() => agent.api.getElevation(), "GET /session/elevation");
      assertFreshProof(elevation.elevatedUntil, "the fresh sign-in proof");

      // The proof stands in for the password: the member sets a first one.
      const newPassword = `${env.password}-first`;
      await succeeds(
        () => agent.api.updateAccount({ body: { newPassword } }),
        "PATCH /account {newPassword} with the proof",
      );
      equal(
        (await signedIn(agent, "after setting a password")).account.hasPassword,
        true,
        "hasPassword",
      );
      const device = env.knownDevice(member, ctx.agent("reauth-password"));
      await succeeds(
        () => device.api.login({ body: { email, password: newPassword } }),
        "sign in with the password set through the proof",
      );
    },
  },
  {
    id: "identity.oidc.faults",
    area: "identity",
    title:
      "The relying party refuses what the development issuer's fault catalogue sends (signature, claims, response), creating nothing; Cancel is cancelled",
    needs: [needs.googleIssuer],
    timeoutMs: 180_000,
    async run(ctx: CheckContext) {
      const env = ctx.env;
      const faults = [
        "algNone",
        "hmacKeyConfusion",
        "embeddedJwk",
        "wrongIssuer",
        "wrongAudience",
        "expired",
        "wrongNonce",
        "tamperedState",
        "pkceMismatch",
        "codeForAnotherClient",
        "emailUnverified",
      ];
      const refused: string[] = [];
      for (const fault of faults) {
        const agent = ctx.agent(`fault-${fault}`);
        const email = env.email(`fault-${fault.toLowerCase()}`);
        const result = await signIn(env, agent, "google", {
          email: { address: email },
          faults: [fault],
        });
        expectOutcome(result, "failed", `fault ${fault}`);
        await signedOut(agent, `after fault ${fault}`);
        const lookup = await succeeds(
          () => agent.api.getEmailStatus({ query: { email } }),
          `email status after fault ${fault}`,
        );
        equal(lookup.next, "signup", `an account was created despite fault ${fault}`);
        refused.push(fault);
      }
      ctx.note(`refused: ${refused.join(", ")}`);
      const unverified = ctx.agent("fault-unverified-address");
      const typed = await signIn(env, unverified, "google", {
        email: { address: env.email("unverified"), verified: false },
      });
      expectOutcome(typed, "failed", "a new address the issuer did not verify");
      const cancelled = await signIn(env, ctx.agent("fault-cancel"), "google", {
        email: { address: env.email("cancel") },
        cancel: true,
      });
      expectOutcome(cancelled, "cancelled", "Cancel at the issuer");
    },
  },
  {
    id: "identity.verify-email",
    area: "identity",
    title:
      "Verify email: the emailed link carries a single-use token in its fragment; following it verifies the address",
    needs: [needs.mailbox],
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareSignup("verify");
      equal(account.session.account.emailVerified, false, "emailVerified after sign-up");
      const [message] = await awaitMail(ctx, account.agent, account.email, "verify-email");
      check(message, "no verification email");
      const token = linkToken(message, "/verify-email");
      await rejects(
        () => account.agent.api.confirmEmailVerification({ body: { token: "A".repeat(43) } }),
        "verification_token_invalid",
        "a token the server never issued",
      );
      await succeeds(
        () => ctx.agent("verify-link").api.confirmEmailVerification({ body: { token } }),
        "POST /auth/email-verification/confirm (from the link, any browser)",
      );
      equal(
        (await signedIn(account.agent, "after verifying")).account.emailVerified,
        true,
        "emailVerified after following the link",
      );
      await rejects(
        () => account.agent.api.confirmEmailVerification({ body: { token } }),
        "verification_token_invalid",
        "the same link a second time",
      );
    },
  },
  {
    id: "identity.oidc.auto-link",
    area: "identity",
    title:
      "With the address verified on both sides, a Google sign-in links itself to the existing account (§4.1)",
    needs: [needs.mailbox, needs.googleIssuer],
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareSignup("autolink");
      const [message] = await awaitMail(ctx, account.agent, account.email, "verify-email");
      check(message, "no verification email");
      await succeeds(
        () =>
          account.agent.api.confirmEmailVerification({
            body: { token: linkToken(message, "/verify-email") },
          }),
        "verify the address",
      );
      const agent = ctx.agent("autolink-google");
      const result = await signIn(ctx.env, agent, "google", { email: { address: account.email } });
      expectOutcome(result, "signed-in", "Google with the verified address of a verified account");
      equal(
        (await signedIn(agent, "after the automatic link")).account.id,
        account.session.account.id,
        "account signed in to",
      );
    },
  },
  {
    id: "identity.password-reset",
    area: "identity",
    title:
      "Reset a password: the same answer for unknown addresses, a single-use emailed link, every device signed out, the old password refused, a security alert",
    needs: [needs.mailbox],
    async run(ctx: CheckContext) {
      const env = ctx.env;
      const account = await env.bareSignup("reset");
      const other = await env.login(account, "reset-other-device");
      const anonymous = ctx.agent("reset-request");
      const request = (email: string) =>
        anonymous.fetch(`${API}/auth/password-reset`, {
          method: "POST",
          headers: CSRF,
          body: { email },
        });
      const known = await request(account.email);
      const unknown = await request(env.email("reset-nobody"));
      status(known, 204, "POST /auth/password-reset (an account)");
      status(unknown, 204, "POST /auth/password-reset (no account)");
      equal(unknown.text(), known.text(), "body for an unknown address vs a known one");

      const [message] = await awaitMail(ctx, anonymous, account.email, "reset-password");
      check(message, "no reset email");
      const token = linkToken(message, "/reset-password");
      const newPassword = `${env.password}-reset`;
      await succeeds(
        () => anonymous.api.confirmPasswordReset({ body: { token, newPassword } }),
        "POST /auth/password-reset/confirm",
      );
      await signedOut(account.agent, "the sign-up device after the reset");
      await signedOut(other, "another device after the reset");
      await rejects(
        () =>
          anonymous.api.confirmPasswordReset({ body: { token, newPassword: `${newPassword}-2` } }),
        "verification_token_invalid",
        "the reset link a second time",
      );
      const device = env.knownDevice(account, ctx.agent("reset-signin"));
      await rejects(
        () => device.api.login({ body: { email: account.email, password: account.password } }),
        "invalid_credentials",
        "sign-in with the old password",
      );
      const session = await succeeds(
        () => device.api.login({ body: { email: account.email, password: newPassword } }),
        "sign-in with the new password",
      );
      equal(session.account.emailVerified, true, "emailVerified after a reset through the email");
      await awaitMail(ctx, anonymous, account.email, "security-change");
    },
  },
  {
    id: "identity.password-reset.drops-identities",
    area: "identity",
    title:
      "Account recovery evicts what an intruder linked: a completed reset drops identities linked under another address, and a dropped identity never links itself again (only a deliberate link brings it back)",
    needs: [needs.mailbox, needs.googleIssuer],
    async run(ctx: CheckContext) {
      const env = ctx.env;
      const account = await env.bareHolder("recover");
      await succeeds(
        () => account.agent.api.elevate({ body: { password: account.password } }),
        "POST /session/elevation",
      );
      const intruder = env.email("recover-intruder");
      const linked = await signIn(
        env,
        account.agent,
        "google",
        { email: { address: intruder } },
        { intent: "link", returnTo: "/account" },
      );
      expectOutcome(linked, "linked", "linking an identity under another address");
      const anonymous = ctx.agent("recover-request");
      status(
        await anonymous.fetch(`${API}/auth/password-reset`, {
          method: "POST",
          headers: CSRF,
          body: { email: account.email },
        }),
        204,
        "POST /auth/password-reset",
      );
      const [message] = await awaitMail(ctx, anonymous, account.email, "reset-password");
      check(message, "no reset email");
      const newPassword = `${env.password}-recovered`;
      await succeeds(
        () =>
          anonymous.api.confirmPasswordReset({
            body: { token: linkToken(message, "/reset-password"), newPassword },
          }),
        "POST /auth/password-reset/confirm",
      );
      const device = env.knownDevice(account, ctx.agent("recover-signin"));
      await succeeds(
        () => device.api.login({ body: { email: account.email, password: newPassword } }),
        "sign in after the reset",
      );
      await env.holder(account, device);
      const identities = await succeeds(
        () => device.api.listIdentities(),
        "GET /account/identities",
      );
      equal(identities.items.length, 0, "identities linked under another address after the reset");
      // A dropped identity never links itself again, even once the account's verified address is
      // its own: the member moves the account to that address and verifies it.
      await succeeds(
        () => device.api.updateAccount({ body: { email: intruder, currentPassword: newPassword } }),
        "PATCH /account {email} (the dropped identity's address)",
      );
      const [verify] = await awaitMail(ctx, anonymous, intruder, "verify-email");
      check(verify, "no verification email for the new address");
      await succeeds(
        () =>
          anonymous.api.confirmEmailVerification({
            body: { token: linkToken(verify, "/verify-email") },
          }),
        "verify the new address",
      );
      const evicted = ctx.agent("recover-intruder");
      const after = await signIn(env, evicted, "google", { email: { address: intruder } });
      expectOutcome(
        after,
        "link-required",
        "the identity a reset dropped (addresses now match, both verified)",
      );
      await signedOut(evicted, "the dropped identity's browser");
      equal(
        (await succeeds(() => device.api.listIdentities(), "GET /account/identities")).items.length,
        0,
        "identities after the dropped identity's sign-in (no silent relink)",
      );
      // Only the account holder, proving it, links it back.
      await succeeds(
        () => device.api.elevate({ body: { password: newPassword } }),
        "POST /session/elevation",
      );
      expectOutcome(
        await signIn(
          env,
          device,
          "google",
          { email: { address: intruder } },
          { intent: "link", returnTo: "/account" },
        ),
        "linked",
        "a deliberate link by the account holder",
      );
    },
  },
];
