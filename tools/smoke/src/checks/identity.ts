import { API_BASE_PATH } from "@webflix/contracts";
import { isSessionCookieName, type SetCookie } from "../cookies.ts";
import { check, equal, fail, header, problem, rejects, status, succeeds } from "../expect.ts";
import type { Agent, HttpResult } from "../http.ts";
import { needs } from "../needs.ts";
import type { CheckContext, CheckDefinition } from "../types.ts";
import { API, CSRF, fanOut, tallyStatuses } from "./util.ts";

function sessionCookie(agent: Agent): SetCookie | undefined {
  return agent.jar.lastSetCookie(isSessionCookieName);
}

/** HttpOnly, SameSite=Lax, Path=/; Secure and `__Host-` on https (blueprint §2.3, D9). */
function assertSessionCookie(agent: Agent, what: string): SetCookie {
  const cookie = sessionCookie(agent);
  check(cookie, `${what}: no session cookie was set`, {
    expected: "Set-Cookie: webflix_session=…",
  });
  const attributes = cookie.attributes;
  const describe = `${cookie.name}; ${Object.entries(attributes)
    .map(([key, value]) => (value === "" ? key : `${key}=${value}`))
    .join("; ")}`;
  check("httponly" in attributes, `${what}: session cookie is not HttpOnly`, {
    observed: describe,
  });
  check(
    attributes.samesite?.toLowerCase() === "lax",
    `${what}: session cookie is not SameSite=Lax`,
    {
      observed: describe,
    },
  );
  check(attributes.path === "/", `${what}: session cookie Path is not /`, { observed: describe });
  if (agent.origin.startsWith("https:")) {
    check(
      "secure" in attributes && cookie.name.startsWith("__Host-"),
      `${what}: https needs a Secure __Host- cookie`,
      {
        observed: describe,
      },
    );
  }
  return cookie;
}

function hasLiveSessionCookie(agent: Agent): boolean {
  return agent.jar.names().some(isSessionCookieName);
}

async function anonymous(agent: Agent, what: string): Promise<void> {
  const state = await succeeds(() => agent.api.getSession(), `${what}: GET /session`);
  equal(state.authenticated, false, `${what}: session.authenticated`);
}

export const identityChecks: CheckDefinition[] = [
  {
    id: "identity.email-status",
    area: "identity",
    title: "Email status routes new addresses to sign-up and known ones to sign-in",
    async run(ctx: CheckContext) {
      const agent = ctx.agent("email");
      const account = await ctx.env.sharedAccount("identity", { member: false });
      const fresh = await succeeds(
        () => agent.api.getEmailStatus({ query: { email: ctx.env.email("unregistered") } }),
        "unregistered email",
      );
      equal(fresh.next, "signup", "next for an unregistered email");
      const known = await succeeds(
        () => agent.api.getEmailStatus({ query: { email: account.email } }),
        "known email",
      );
      equal(known.next, "login", "next for a registered email");
      const shouted = await succeeds(
        () => agent.api.getEmailStatus({ query: { email: `  ${account.email.toUpperCase()}  ` } }),
        "known email, upper case with spaces",
      );
      equal(shouted.next, "login", "next for a registered email typed in upper case");
    },
  },
  {
    id: "identity.signup",
    area: "identity",
    title:
      "Sign-up creates an account without a membership (no subscription, no plan, no card) and sets the session cookie; with no profile yet it manages itself, once one exists the gate asks for it",
    async run(ctx: CheckContext) {
      const agent = ctx.agent("signup");
      const email = ctx.env.email("signup");
      const typed = email.replace("smoke-", "Smoke-");
      const state = await succeeds(
        () => agent.api.signup({ body: { email: typed, password: ctx.env.password } }),
        "POST /auth/signup",
      );
      equal(state.account.email, email, "account email (lower-cased)");
      // No membership is exactly that (§5.1): nothing stands in for it.
      equal(state.subscription, null, "subscription after sign-up");
      equal(state.plan, null, "plan after sign-up");
      equal(state.membership?.status ?? "absent", "none", "membership.status after sign-up");
      equal(state.entitlement?.entitled ?? "absent", false, "entitlement after sign-up");
      equal(state.profiles.length, 0, "profiles after sign-up (the first is created afterwards)");
      equal(state.activeProfile, null, "activeProfile after sign-up");
      const cookie = assertSessionCookie(agent, "sign-up");
      const maxAge = Number(cookie.attributes["max-age"]);
      check(
        Number.isFinite(maxAge) && maxAge > 7 * 86_400,
        "sign-up session cookie is not persistent",
        {
          expected: 'Max-Age of days ("remember me" lifetime)',
          observed: JSON.stringify(cookie.attributes),
        },
      );
      const session = await succeeds(() => agent.api.getSession(), "GET /session");
      check(
        session.authenticated && session.account.id === state.account.id,
        "GET /session does not show the new account",
        {
          observed: JSON.stringify(session).slice(0, 300),
        },
      );
      // An account with no profile yet is its own account holder at the gate.
      const account = await succeeds(
        () => agent.api.getAccount(),
        "GET /account before any profile exists",
      );
      equal(account.subscription, null, "GET /account subscription without a membership");
      equal(account.plan, null, "GET /account plan without a membership");
      equal(account.paymentMethod, null, "GET /account payment method without a membership");
      // Once a profile exists, account management needs it chosen (without parental controls).
      const created = {
        tag: "signup",
        email,
        password: ctx.env.password,
        agent,
        session: state,
      };
      await ctx.env.holder(created);
      await succeeds(() => agent.api.getAccount(), "GET /account as the holder");
      const gate = await ctx.env.login(created, "signup-gate");
      await rejects(
        () => gate.api.getAccount(),
        "profile_required",
        "GET /account at the gate once a profile exists",
      );
      const again = ctx.agent("signup-duplicate");
      await rejects(
        () => again.api.signup({ body: { email, password: ctx.env.password } }),
        "email_already_registered",
        "second sign-up with the same email",
      );
      check(!hasLiveSessionCookie(again), "a rejected sign-up set a session cookie");
    },
  },
  {
    id: "identity.signup.card-data-refused",
    area: "identity",
    title:
      "Card data never reaches Webflix: sign-up and a plan change carrying a card are refused by validation and create nothing; milestone 1's card replacement route is gone",
    async run(ctx: CheckContext) {
      // Milestone 1's body: what a client that still sends a card would send.
      const card = {
        method: "card",
        cardNumber: "4242 4242 4242 4242",
        expMonth: 12,
        expYear: new Date().getUTCFullYear() + 3,
        cvc: "123",
        nameOnCard: "Smoke Test",
      };
      const digits = /4242\s?4242/;
      const agent = ctx.agent("card-refused");
      const email = ctx.env.email("card-refused");
      const signup = await agent.fetch(`${API}/auth/signup`, {
        method: "POST",
        headers: CSRF,
        body: { email, password: ctx.env.password, planId: "basic", payment: card },
      });
      const refused = problem(signup, "validation_failed", "sign-up with a card");
      check(
        refused.issues.some((issue) => /payment|planId|^$/.test(issue.path)),
        "the refusal does not name the card fields",
        { observed: JSON.stringify(refused.issues) },
      );
      check(!digits.test(signup.exchange.responseBody ?? ""), "the refusal echoes the card", {
        observed: signup.exchange.responseBody ?? "",
      });
      check(!hasLiveSessionCookie(agent), "a sign-up with a card set a session cookie");
      const lookup = await succeeds(
        () => agent.api.getEmailStatus({ query: { email } }),
        "email status after the refused sign-up",
      );
      equal(lookup.next, "signup", "the account after a sign-up with a card (nothing created)");

      // An account holder (no membership needed: the body is refused before anything else).
      const account = await ctx.env.bareHolder("card-refused-holder");
      const change = await account.agent.fetch(`${API}/account/subscription`, {
        method: "PUT",
        headers: CSRF,
        body: { planId: "premium", payment: card },
      });
      problem(change, "validation_failed", "a plan change with a card");
      check(!digits.test(change.exchange.responseBody ?? ""), "the refusal echoes the card", {
        observed: change.exchange.responseBody ?? "",
      });
      const replace = await account.agent.fetch(`${API}/account/payment-method`, {
        method: "PUT",
        headers: CSRF,
        body: { payment: card },
      });
      check(
        replace.status === 404 || replace.status === 405,
        "PUT /account/payment-method still answers: a card is replaced through the provider's setup (POST /billing/payment-method/setup)",
        { expected: "404 or 405", observed: `${replace.status}`, exchange: replace.exchange },
      );
      check(!digits.test(replace.exchange.responseBody ?? ""), "the answer echoes the card", {
        observed: replace.exchange.responseBody ?? "",
      });
      const details = await succeeds(() => account.agent.api.getAccount(), "GET /account");
      equal(details.paymentMethod, null, "payment method after the refused requests");
      equal(details.subscription, null, "subscription after the refused requests");
    },
  },
  {
    id: "identity.signin",
    area: "identity",
    title: "Sign-in sets a persistent cookie, or a browser-session cookie without remember-me",
    async run(ctx: CheckContext) {
      const account = await ctx.env.sharedAccount("identity", { member: false });
      const agent = ctx.agent("signin");
      const state = await succeeds(
        () =>
          agent.api.login({
            body: { email: account.email.toUpperCase(), password: account.password },
          }),
        "POST /auth/login",
      );
      equal(state.account.id, account.session.account.id, "signed-in account");
      const persistent = assertSessionCookie(agent, "sign-in");
      check(
        Number(persistent.attributes["max-age"]) > 86_400,
        "remember-me sign-in cookie is not persistent",
        {
          observed: JSON.stringify(persistent.attributes),
        },
      );
      const session = await succeeds(() => agent.api.getSession(), "GET /session");
      equal(session.authenticated, true, "authenticated after sign-in");
      const shortLived = ctx.agent("signin-no-remember");
      await succeeds(
        () =>
          shortLived.api.login({
            body: { email: account.email, password: account.password, rememberMe: false },
          }),
        "sign-in without remember-me",
      );
      const cookie = assertSessionCookie(shortLived, "sign-in without remember-me");
      check(
        cookie.attributes["max-age"] === undefined && cookie.attributes.expires === undefined,
        "sign-in without remember-me must set a browser-session cookie",
        { expected: "no Max-Age / Expires", observed: JSON.stringify(cookie.attributes) },
      );
    },
  },
  {
    id: "identity.signin.wrong-password",
    area: "identity",
    title: "Wrong password and unknown email both answer invalid_credentials",
    async run(ctx: CheckContext) {
      const account = await ctx.env.sharedAccount("identity", { member: false });
      const agent = ctx.agent("wrong-password");
      await rejects(
        () =>
          agent.api.login({
            body: { email: account.email, password: `${account.password}-wrong` },
          }),
        "invalid_credentials",
        "wrong password",
      );
      check(!hasLiveSessionCookie(agent), "a failed sign-in set a session cookie");
      await rejects(
        () =>
          agent.api.login({ body: { email: ctx.env.email("nobody"), password: account.password } }),
        "invalid_credentials",
        "unknown email (must not reveal that the account does not exist)",
      );
      await anonymous(agent, "after failed sign-ins");
    },
  },
  {
    id: "identity.session-bootstrap",
    area: "identity",
    title: "Session bootstrap: anonymous, signed in, profile required, profile bound per session",
    async run(ctx: CheckContext) {
      const anonymousAgent = ctx.agent("anonymous");
      await anonymous(anonymousAgent, "no cookie");
      await rejects(
        () => anonymousAgent.api.getAccount(),
        "unauthenticated",
        "GET /account without a session",
      );
      await rejects(
        () => anonymousAgent.api.getBrowse(),
        "unauthenticated",
        "GET /browse without a session",
      );

      const account = await ctx.env.bareSignup("bootstrap");
      const agent = account.agent;
      const state = await succeeds(() => agent.api.getSession(), "GET /session");
      check(
        state.authenticated && state.activeProfile === null,
        "signed-in session without a profile",
        {
          observed: JSON.stringify(state).slice(0, 300),
        },
      );
      await rejects(
        () => agent.api.getBrowse(),
        "profile_required",
        "GET /browse before choosing a profile",
      );
      const profile = await ctx.env.createProfile(agent, { name: "Bootstrap" });
      const selected = await ctx.env.selectProfile(agent, profile.id);
      equal(selected.activeProfile?.id, profile.id, "activeProfile after selection");
      const again = await succeeds(() => agent.api.getSession(), "GET /session after selection");
      equal(
        again.authenticated && again.activeProfile?.id,
        profile.id,
        "GET /session activeProfile",
      );
      await succeeds(() => agent.api.getBrowse(), "GET /browse with a profile");

      // The active profile belongs to the session, not the account.
      const other = await ctx.env.login(account, "bootstrap-second-device");
      const otherState = await succeeds(() => other.api.getSession(), "second device GET /session");
      equal(
        otherState.authenticated && otherState.activeProfile,
        null,
        "second device's activeProfile",
      );
      await rejects(() => other.api.getBrowse(), "profile_required", "second device GET /browse");

      const cleared = await succeeds(() => agent.api.clearProfile(), "DELETE /session/profile");
      equal(cleared.activeProfile, null, "activeProfile after leaving the profile");
      await rejects(
        () => agent.api.getBrowse(),
        "profile_required",
        "GET /browse after leaving the profile",
      );

      // A cookie that maps to no session is anonymous, and the server clears it.
      const forged = ctx.agent("forged-cookie");
      const name = sessionCookie(agent)?.name ?? "webflix_session";
      forged.jar.set(name, "A".repeat(43));
      await anonymous(forged, "unknown session token");
      check(
        !forged.jar.names().includes(name),
        "a dead session cookie is not cleared by the server",
        {
          expected: `Set-Cookie: ${name}=; Max-Age=0`,
        },
      );
    },
  },
  {
    id: "identity.signout",
    area: "identity",
    title: "Sign-out revokes the session server-side, not just the cookie",
    async run(ctx: CheckContext) {
      const account = await ctx.env.sharedAccount("identity", { member: false });
      const agent = await ctx.env.holder(account, await ctx.env.login(account, "signout"));
      const replay = agent.jar.snapshot();
      await succeeds(() => agent.api.getAccount(), "GET /account before sign-out");
      await succeeds(() => agent.api.getSession(), "GET /session before sign-out");
      await succeeds(() => agent.api.logout(), "POST /auth/logout");
      check(!hasLiveSessionCookie(agent), "sign-out did not clear the session cookie");
      await anonymous(agent, "after sign-out");
      const replayed = ctx.agent("signout-replay");
      for (const [name, value] of replay) replayed.jar.set(name, value);
      await anonymous(replayed, "replaying the signed-out cookie");
      await rejects(
        () => replayed.api.getAccount(),
        "unauthenticated",
        "replayed cookie on GET /account",
      );
      await succeeds(() => agent.api.logout(), "a second sign-out (idempotent)");
    },
  },
  {
    id: "identity.signout-everywhere",
    area: "identity",
    title: "Sign out of all devices invalidates every other session immediately",
    tags: ["consistency"],
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareSignup("everywhere");
      await ctx.env.holder(account);
      const second = await ctx.env.holder(account, await ctx.env.login(account, "everywhere-2"));
      const third = await ctx.env.holder(account, await ctx.env.login(account, "everywhere-3"));
      const devices = await succeeds(() => second.api.listDevices(), "GET /account/sessions");
      check(devices.items.length >= 3, "devices list misses sessions", {
        expected: "≥ 3 sessions",
        observed: String(devices.items.length),
      });
      equal(devices.items.filter((device) => device.current).length, 1, "devices flagged current");
      // Every device is in use (as a browser would be) before the revocation.
      for (const agent of [account.agent, second, third]) {
        await succeeds(
          () => agent.api.getAccount(),
          `${agent.label} GET /account before sign-out everywhere`,
        );
        await succeeds(
          () => agent.api.getSession(),
          `${agent.label} GET /session before sign-out everywhere`,
        );
      }
      await succeeds(() => second.api.logoutAll(), "POST /auth/logout-all");
      // No polling: revocation must be visible on the very next request, on any instance.
      const reads = ctx.options.parallelism;
      const results = await fanOut(reads, (index) =>
        (index % 2 === 0 ? account.agent : third).fetch(`${API_BASE_PATH}/account`),
      );
      const leaked = results.filter((result) => result.status !== 401);
      check(leaked.length === 0, "a revoked session still works right after sign-out everywhere", {
        expected: `${reads}× 401 unauthenticated`,
        observed: results.map((result) => result.status).join(", "),
        exchange: leaked[0]?.exchange,
      });
      await anonymous(second, "the device that signed out everywhere");
      await anonymous(account.agent, "another device after sign-out everywhere");
    },
  },
  {
    id: "identity.devices",
    area: "identity",
    title: "Devices list marks the current one; revoking a device signs it out at once",
    async run(ctx: CheckContext) {
      const account = await ctx.env.sharedAccount("identity", { member: false });
      const keeper = await ctx.env.holder(account, await ctx.env.login(account, "devices-keeper"));
      const victim = await ctx.env.holder(account, await ctx.env.login(account, "devices-victim"));
      const victimSession = await succeeds(
        () => victim.api.listDevices(),
        "victim GET /account/sessions",
      );
      const victimId = victimSession.items.find((device) => device.current)?.id;
      check(victimId, "no device is flagged current", {
        observed: JSON.stringify(victimSession.items),
      });
      const list = await succeeds(() => keeper.api.listDevices(), "GET /account/sessions");
      const entry = list.items.find((device) => device.id === victimId);
      check(entry && !entry.current, "the other device is missing or flagged current", {
        observed: JSON.stringify(list.items),
      });
      check(
        /Chrome on macOS/.test(entry.label),
        "device label is not derived from the user agent",
        {
          expected: "Chrome on macOS",
          observed: entry.label,
        },
      );
      await succeeds(() => victim.api.getAccount(), "victim GET /account before the revocation");
      await succeeds(
        () => keeper.api.revokeDevice({ params: { id: victimId } }),
        "DELETE /account/sessions/:id",
      );
      await rejects(
        () => victim.api.getAccount(),
        "unauthenticated",
        "revoked device's next request",
      );
      await rejects(
        () => keeper.api.revokeDevice({ params: { id: victimId } }),
        "not_found",
        "revoking an already revoked device",
      );
      await succeeds(() => keeper.api.getAccount(), "the keeper stays signed in");
    },
  },
  {
    id: "identity.csrf",
    area: "identity",
    title: "Mutations without X-Webflix-Client are refused and change nothing",
    async run(ctx: CheckContext) {
      const viewer = await ctx.env.isolatedViewer("csrf", { member: false });
      const card = (await ctx.env.catalog()).cards[0];
      check(card, "no title to test with");
      const path = `${API}/my-list/${card.id}`;
      const missing = await viewer.agent.fetch(path, { method: "PUT" });
      problem(missing, "csrf_check_failed", "PUT /my-list without the client header");
      const wrong = await viewer.agent.fetch(path, {
        method: "PUT",
        headers: { "X-Webflix-Client": "evil" },
      });
      problem(wrong, "csrf_check_failed", "PUT /my-list with a wrong client header");
      const list = await succeeds(() => viewer.agent.api.getMyList(), "GET /my-list");
      check(!list.items.some((item) => item.id === card.id), "a refused mutation changed My List", {
        observed: list.items.map((item) => item.id).join(", "),
      });
      problem(
        await viewer.agent.fetch(`${API}/auth/logout`, { method: "POST" }),
        "csrf_check_failed",
        "POST /auth/logout without the header",
      );
      await succeeds(() => viewer.agent.api.getSession(), "session after a refused sign-out");
      const stillIn = await succeeds(() => viewer.agent.api.getSession(), "GET /session");
      equal(stillIn.authenticated, true, "still signed in after a refused sign-out");
      problem(
        await ctx.agent("csrf-anon").fetch(`${API}/auth/login`, {
          method: "POST",
          body: { email: viewer.account.email, password: viewer.account.password },
        }),
        "csrf_check_failed",
        "POST /auth/login without the header",
      );
      const accepted = await viewer.agent.fetch(path, { method: "PUT", headers: CSRF });
      status(accepted, 204, "PUT /my-list with the client header");
      header(accepted, "Cache-Control", /no-store/, "mutation response");
      await succeeds(
        () => viewer.agent.api.removeFromMyList({ params: { titleId: card.id } }),
        "cleanup",
      );
    },
  },
];

/**
 * Exhausts the client's sign-in budget, so it runs last (exclusive) and after
 * `ratelimit.strict-defaults`, which measures that same budget.
 */
export const signinFloodCheck: CheckDefinition = {
  id: "identity.signin-rate-limit",
  area: "identity",
  title: "Sign-in attempts are rate limited per client and recover after Retry-After",
  tags: ["exclusive", "ip-limit"],
  timeoutMs: 240_000,
  needs: [needs.ipExhaustion],
  async run(ctx: CheckContext) {
    const account = await ctx.env.sharedAccount("identity", { member: false });
    // A browser the account knows: this check measures the per-client limit, not the
    // per-email one (ratelimit.auth-email), which would otherwise outlast its Retry-After.
    const agent = ctx.env.knownDevice(account, ctx.agent("signin-flood", { retryOn429: false }));
    // Above dev's 60/min with room for a few replicas counting separately.
    const cap = Math.max(ctx.options.burst * 2, 200);
    let attempts = 0;
    let limited: Awaited<ReturnType<Agent["fetch"]>> | null = null;
    const started = performance.now();
    while (attempts < cap) {
      attempts += 1;
      const result = await agent.fetch(`${API}/auth/login`, {
        method: "POST",
        headers: CSRF,
        body: { email: account.email, password: "definitely-wrong-password" },
      });
      if (result.status === 429) {
        limited = result;
        break;
      }
      problem(result, "invalid_credentials", `wrong-password attempt ${attempts}`);
    }
    if (!limited) {
      fail("sign-in is not rate limited (or each of several instances counts separately)", {
        expected: "429 rate_limited within the documented budget (10/min strict, 60/min dev)",
        observed: `${attempts} wrong-password attempts in ${Math.round((performance.now() - started) / 1000)} s, none limited`,
      });
    }
    const body = problem(limited, "rate_limited", "sign-in flood");
    header(limited, "Retry-After", String(body.retryAfterSec), "Retry-After matches retryAfterSec");
    ctx.note(`limited after ${attempts} attempts; Retry-After ${body.retryAfterSec}s`);
    // Still limited, even with the right password: the limit is per client, not per failure.
    // A shared limiter cannot admit anything for (Retry-After − 1) s after a 429.
    const followUps: HttpResult[] = [];
    for (let index = 0; index < 3; index += 1) {
      followUps.push(
        await agent.fetch(`${API}/auth/login`, {
          method: "POST",
          headers: CSRF,
          body: { email: account.email, password: account.password },
        }),
      );
    }
    const admitted = followUps.filter((result) => result.status !== 429);
    if (admitted.length > 0) {
      if (body.retryAfterSec >= 2) {
        fail("sign-in was admitted right after a 429 that said to retry later", {
          expected: `429 for ${body.retryAfterSec - 1}s after Retry-After: ${body.retryAfterSec}`,
          observed: `${tallyStatuses(followUps)} immediately after the 429: per-instance counting behind a balancer`,
          exchange: admitted[0]?.exchange,
        });
      }
      ctx.note(
        `a follow-up was admitted right after the 429 (Retry-After ${body.retryAfterSec}s: a refill is possible)`,
      );
    }
    await ctx.sleep(body.retryAfterSec * 1000 + 250);
    const recovered = await agent.fetch(`${API}/auth/login`, {
      method: "POST",
      headers: CSRF,
      body: { email: account.email, password: account.password },
    });
    status(recovered, 200, `sign-in ${body.retryAfterSec}s after the 429 (Retry-After)`);
  },
};
