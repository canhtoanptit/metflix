/**
 * Milestone 2 billing (docs/BLUEPRINT-M2.md §5) against the fake payment provider: checkout
 * with the provider's form, challenges, declines, promo codes, trials, plan changes invoiced as
 * previewed, cancel and resume, failed renewals through grace and suspension to recovery, and
 * provider events delivered twice, out of order or not at all. Time passes on the account's own
 * test clock (`POST /diagnostics/billing/clock`), never by sleeping.
 */
import type { Checkout, Invoice, MembershipState, PlanId, TitleCard } from "@webflix/contracts";
import type { Environment, TestAccount } from "../env.ts";
import { check, equal, fail, problem, rejects, status, succeeds } from "../expect.ts";
import { type Agent, isApiError } from "../http.ts";
import { admissible, profileIndependentSpec } from "../limits.ts";
import { awaitMail, mailboxNow } from "../mail.ts";
import { needs } from "../needs.ts";
import { federatedSignIn } from "../oidc.ts";
import {
  advancePast,
  awaitCheckout,
  type CardChoice,
  confirmAtProvider,
  confirmCard,
  convertTrial,
  deliverPending,
  deliveryPolicy,
  type FakeCard,
  labelledCard,
  paidMembership,
  playsOnce,
  RENEWAL_SETTLE_SEC,
  setDeliveryPolicy,
  startPlayback,
  subscribe,
} from "../payments.ts";
import { uuidv7 } from "../telemetry.ts";
import type { CheckContext, CheckDefinition } from "../types.ts";
import { API, CSRF } from "./util.ts";

/** The fake provider's standing promo code by default (WEBFLIX_PAYMENTS_FAKE_PROMOTIONS). */
const FAKE_STANDING_PROMOTION = "WEBFLIX50";

/**
 * Another agent on `agent`'s session (its cookies), not waiting out `rate_limited`: what a
 * budget check needs to see each 429, without spending a sign-in (which a run started right
 * after another's IP-exhausting checks may find throttled).
 */
function sameSession(ctx: CheckContext, agent: Agent, label: string): Agent {
  const raw = ctx.agent(label, { retryOn429: false });
  for (const [name, value] of agent.jar.snapshot()) raw.jar.set(name, value);
  return raw;
}

/** A movie every adult profile may play (the catalogue's first). */
async function movie(env: Environment): Promise<TitleCard> {
  const { cards } = await env.catalog();
  const card = cards.find((candidate) => candidate.type === "movie");
  check(card, "the catalogue has no movie");
  return card;
}

async function membership(agent: Agent, what: string): Promise<MembershipState> {
  const account = await succeeds(() => agent.api.getAccount(), `${what}: GET /account`);
  check(account.membership, `${what}: GET /account carries no membership`, {
    observed: JSON.stringify(account).slice(0, 300),
  });
  return account.membership;
}

async function entitlement(agent: Agent, what: string) {
  const account = await succeeds(() => agent.api.getAccount(), `${what}: GET /account`);
  check(account.entitlement, `${what}: GET /account carries no entitlement`);
  return account.entitlement;
}

async function invoices(agent: Agent, what: string): Promise<Invoice[]> {
  return (
    await succeeds(() => agent.api.listInvoices({ query: {} }), `${what}: GET /billing/invoices`)
  ).items;
}

async function price(agent: Agent, planId: PlanId): Promise<number> {
  const plans = await succeeds(() => agent.api.listPlans(), "GET /plans");
  const plan = plans.items.find((item) => item.id === planId);
  check(plan, `no plan ${planId}`);
  return plan.monthlyPrice.amountMinor;
}

/** Playback is refused with `subscription_required` naming the membership status. */
async function refusedPlayback(agent: Agent, titleId: string, status_: string, what: string) {
  const answer = problem(await startPlayback(agent, titleId), "subscription_required", what);
  equal(
    (answer as { membershipStatus?: string }).membershipStatus,
    status_,
    `${what}: membershipStatus`,
  );
}

/**
 * A running trial (§5.4: one per account and per card fingerprint, deployment-wide), with a
 * labelled card no run has used, so it is a first trial on every rerun against one database.
 */
async function trialMembership(
  ctx: CheckContext,
  account: TestAccount,
  base: FakeCard,
  purpose: string,
): Promise<{ card: CardChoice; checkout: Checkout; membership: MembershipState; planId: PlanId }> {
  const card = labelledCard(base, ctx.options.runId, purpose);
  const planId: PlanId = "standard";
  const started = await succeeds(
    () => account.agent.api.startCheckout({ body: { planId } }),
    `checkout (${planId}) for a trial`,
  );
  check(started.clientSecret, "a new checkout carries no client secret");
  await confirmCard(account.agent, started.clientSecret, card, `trial card ${card}`);
  const confirmed = await succeeds(
    () => account.agent.api.confirmCheckout({ params: { id: started.id } }),
    `confirm the checkout with ${card}`,
  );
  check(confirmed.trial, "a new account with a card that never had a trial got no trial", {
    expected: `trial: { days: 7 } (§5.4: one trial per account and per card; both are new)`,
    observed: JSON.stringify(confirmed),
  });
  const checkout =
    confirmed.status === "complete"
      ? confirmed
      : await awaitCheckout(ctx, account.agent, started.id, `trial with ${card}`);
  return { card, checkout, membership: await membership(account.agent, "trial"), planId };
}

/**
 * A card whose trial is spent, for this run: a labelled card whose one trial a throwaway account
 * took. Checkouts with it stop at the first payment, deterministically.
 */
export function spentCard(ctx: CheckContext): Promise<CardChoice> {
  return ctx.env.once("card:spent", async () => {
    const card = labelledCard("visa", ctx.options.runId, "spent");
    const account = await ctx.env.bareHolder("spend-trial");
    const subscribed = await subscribe(ctx, account.agent, { planId: "basic", card });
    check(subscribed.trial, "a card that never had a trial got none (spending its trial)", {
      observed: JSON.stringify(subscribed.checkout),
    });
    return card;
  });
}

/**
 * A new account whose checkout stopped at its first payment: its card's trial is spent, so the
 * account (eligible itself) gets none (§5.4: one trial per card as well as per account).
 */
async function firstPaymentPending(
  ctx: CheckContext,
  tag: string,
): Promise<{ account: TestAccount; checkout: Checkout }> {
  const card = await spentCard(ctx);
  const account = await ctx.env.bareHolder(tag);
  const agent = account.agent;
  const started = await succeeds(
    () => agent.api.startCheckout({ body: { planId: "basic" } }),
    "POST /billing/checkout (basic)",
  );
  check(started.clientSecret, "no client secret");
  await confirmCard(agent, started.clientSecret, card, `card ${card} (trial spent)`);
  const confirmed = await succeeds(
    () => agent.api.confirmCheckout({ params: { id: started.id } }),
    "confirm the checkout",
  );
  equal(confirmed.trial, null, "a trial on a card that already had one");
  equal(confirmed.status, "requires_payment", "a checkout without a trial");
  equal(
    (await membership(agent, "awaiting the first payment")).status,
    "incomplete",
    "status awaiting the first payment",
  );
  return { account, checkout: confirmed };
}

/** The account once its membership is no longer `incomplete` (it follows provider events). */
async function settled(ctx: CheckContext, agent: Agent, what: string) {
  const { value } = await ctx.eventually(what, async () => {
    const current = await succeeds(() => agent.api.getAccount(), "GET /account");
    return current.membership?.status === "incomplete"
      ? { done: false, observed: "still incomplete" }
      : { done: true, value: current };
  });
  return value;
}

export const billingChecks: CheckDefinition[] = [
  {
    id: "billing.provider-config",
    area: "billing",
    title:
      "GET /billing/config tells the truth: with no provider it says none, and every payment action answers payments_not_configured (no fake form or webhook served, memberships none); the fake is advertised only where its form is served",
    async run(ctx: CheckContext) {
      const visitor = ctx.agent("no-provider");
      const config = await succeeds(() => visitor.api.getBillingConfig(), "GET /billing/config");
      if (config.provider === "fake") {
        // Advertising the fake is a promise that its form serves the browser.
        const cards = await visitor.fetch("/_pay/api/cards");
        check(
          cards.status === 200 && (cards.headers.get("Content-Type") ?? "").includes("json"),
          "GET /billing/config advertises the fake provider, but its form is not served",
          {
            expected: `/_pay/api/cards answering 200 (the form at ${config.formUrl}), or provider none`,
            observed: `${cards.status} ${cards.headers.get("Content-Type") ?? ""}`,
            exchange: cards.exchange,
          },
        );
        ctx.note("provider fake: its form is served (the billing journeys drive it)");
        return;
      }
      if (config.provider === "stripe") {
        ctx.note("provider stripe: a publishable key (the Stripe lane is tools/stripe)");
        return;
      }
      equal(JSON.stringify(config), JSON.stringify({ provider: "none" }), "GET /billing/config");
      const account = await ctx.env.bareHolder("no-provider");
      const agent = account.agent;
      const before = await succeeds(() => agent.api.getAccount(), "GET /account");
      equal(before.membership?.status, "none", "membership without a provider");
      equal(before.entitlement?.reason, "no_membership", "entitlement.reason");
      const post = (path: string, body?: object) =>
        agent.fetch(`${API}${path}`, {
          method: "POST",
          headers: CSRF,
          ...(body === undefined ? {} : { body }),
        });
      problem(
        await post("/billing/checkout", { planId: "standard" }),
        "payments_not_configured",
        "POST /billing/checkout",
      );
      problem(
        await post(`/billing/checkout/${uuidv7()}/confirm`),
        "payments_not_configured",
        "POST /billing/checkout/:id/confirm",
      );
      problem(
        await post("/billing/promotions/validate", {
          code: FAKE_STANDING_PROMOTION,
          planId: "standard",
        }),
        "payments_not_configured",
        "POST /billing/promotions/validate",
      );
      problem(
        await post("/billing/payment-method/setup"),
        "payments_not_configured",
        "POST /billing/payment-method/setup",
      );
      for (const provider of ["fake", "stripe"]) {
        problem(
          await visitor.fetch(`${API}/webhooks/payments/${provider}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=00" },
            body: JSON.stringify({ id: "evt_smoke", type: "invoice.paid" }),
          }),
          "not_found",
          `POST /webhooks/payments/${provider} without a provider`,
        );
      }
      for (const path of ["/_pay/api/cards", "/_pay/form"]) {
        const served = await visitor.fetch(path);
        equal(served.status, 404, `GET ${path} without a provider`, served.exchange);
      }
      await refusedPlayback(
        agent,
        (await movie(ctx.env)).id,
        "none",
        "playback without a provider",
      );
      equal(
        (await membership(agent, "after the refusals")).status,
        "none",
        "membership after the refusals",
      );
    },
  },
  {
    id: "billing.checkout",
    area: "billing",
    title:
      "An account without a membership is refused playback, checks out through the provider's form, pays its first invoice (a card whose trial is spent), becomes entitled and plays",
    needs: [needs.fakePayments],
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareHolder("checkout");
      const agent = account.agent;
      const title = await movie(ctx.env);
      const before = await succeeds(() => agent.api.getAccount(), "GET /account");
      equal(before.membership?.status, "none", "membership of a new account");
      equal(before.entitlement?.entitled, false, "entitlement of a new account");
      equal(before.entitlement?.reason, "no_membership", "entitlement.reason");
      equal(before.entitlement?.maxStreams, 0, "entitlement.maxStreams");
      await refusedPlayback(agent, title.id, "none", "playback without a membership");
      // Only an unrestricted profile (or the profile gate) starts a membership.
      const kids = await ctx.env.createProfile(agent, { name: "Kid", isKids: true });
      const kidsDevice = await ctx.env.login(account, "checkout-kids");
      await ctx.env.selectProfile(kidsDevice, kids.id);
      await rejects(
        () => kidsDevice.api.startCheckout({ body: { planId: "standard" } }),
        "unrestricted_profile_required",
        "a checkout from a kids profile",
      );

      const config = await succeeds(() => agent.api.getBillingConfig(), "GET /billing/config");
      equal(config.provider, "fake", "billing config provider");
      const started = await succeeds(
        () => agent.api.startCheckout({ body: { planId: "standard" } }),
        "POST /billing/checkout",
      );
      equal(started.status, "requires_setup", "status of a new checkout");
      check(started.clientSecret, "a new checkout carries no client secret");
      check(Date.parse(started.expiresAt) > Date.now(), "a new checkout has already expired", {
        observed: started.expiresAt,
      });
      if (config.provider === "fake") {
        const form = await agent.fetch(
          `${config.formUrl}?secret=${encodeURIComponent(started.clientSecret)}`,
        );
        status(form, 200, "the provider's payment form for the checkout");
        check(/text\/html/.test(form.headers.get("Content-Type") ?? ""), "the form is not a page");
      }
      await rejects(
        () => agent.api.confirmCheckout({ params: { id: started.id } }),
        "checkout_state_conflict",
        "confirming before the card was confirmed at the provider",
      );
      const card = await spentCard(ctx);
      await confirmCard(agent, started.clientSecret, card, "card");
      const confirmed = await succeeds(
        () => agent.api.confirmCheckout({ params: { id: started.id } }),
        "POST /billing/checkout/:id/confirm",
      );
      const standard = await price(agent, "standard");
      equal(confirmed.trial, null, "a trial on a card that already had one");
      equal(confirmed.status, "requires_payment", "status without a trial");
      equal(confirmed.amountDue?.amountMinor, standard, "first payment amount");
      check(confirmed.clientSecret, "requires_payment without a client secret");
      equal(
        (await membership(agent, "awaiting the first payment")).status,
        "incomplete",
        "membership awaiting the first payment",
      );
      await refusedPlayback(agent, title.id, "incomplete", "playback before the first payment");
      await confirmCard(agent, confirmed.clientSecret, undefined, "first payment");
      await awaitCheckout(ctx, agent, started.id, "checkout");
      const after = await succeeds(() => agent.api.getAccount(), "GET /account after checkout");
      equal(after.membership?.status, "active", "membership.status");
      equal(after.membership?.planId, "standard", "membership.planId");
      equal(after.membership?.provider, "fake", "membership.provider");
      equal(after.entitlement?.entitled, true, "entitled after checkout");
      equal(after.entitlement?.maxStreams, 2, "Standard streams");
      equal(after.entitlement?.maxVideoHeight, 1080, "Standard quality");
      const session = await succeeds(() => agent.api.getSession(), "GET /session");
      equal(
        session.authenticated && session.membership?.status,
        after.membership?.status,
        "the session's membership",
      );
      const played = await playsOnce(agent, title.id, "playback after checkout");
      check(played.maxVideoHeight <= 1080, "playback above the plan's quality", {
        observed: String(played.maxVideoHeight),
      });

      const paid = (await invoices(agent, "after paying")).find(
        (invoice) => invoice.amountPaid.amountMinor > 0,
      );
      check(paid, "no paid invoice after checkout", { expected: `an invoice of ${standard} paid` });
      equal(paid.status, "paid", "invoice status");
      equal(paid.total.amountMinor, standard, "invoice total (the Standard price)");
      equal(paid.amountPaid.amountMinor, standard, "invoice amount paid");
      await rejects(
        () => agent.api.startCheckout({ body: { planId: "premium" } }),
        "checkout_state_conflict",
        "a second checkout while entitled",
      );
    },
  },
  {
    id: "billing.challenge",
    area: "billing",
    title:
      "A card that needs a challenge: nothing is confirmed until it is completed; a failed challenge declines and starts nothing; a completed one does",
    needs: [needs.fakePayments],
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareHolder("challenge");
      const agent = account.agent;
      const started = await succeeds(
        () => agent.api.startCheckout({ body: { planId: "premium" } }),
        "POST /billing/checkout",
      );
      check(started.clientSecret, "no client secret");
      const asked = await confirmAtProvider(agent, started.clientSecret, {
        card: "authentication-required",
      });
      equal(asked.status, "requires_action", "the card asks for a challenge");
      await rejects(
        () => agent.api.confirmCheckout({ params: { id: started.id } }),
        "checkout_state_conflict",
        "confirming while the challenge is open",
      );
      const failed = await confirmAtProvider(agent, started.clientSecret, { challenge: "fail" });
      equal(failed.status, "failed", "a failed challenge");
      const declined = await rejects(
        () => agent.api.confirmCheckout({ params: { id: started.id } }),
        "payment_declined",
        "confirming after a failed challenge",
      );
      ctx.note(`failed challenge declined as ${declined.problem.declineReason}`);
      const retry = await succeeds(
        () => agent.api.getCheckout({ params: { id: started.id } }),
        "GET /billing/checkout/:id after the decline",
      );
      equal(retry.status, "requires_setup", "the checkout waits for another card");
      check(
        retry.clientSecret && retry.clientSecret !== started.clientSecret,
        "the declined setup's secret is offered again",
        { observed: `${retry.clientSecret} (was ${started.clientSecret})` },
      );
      check(retry.failureReason, "the checkout does not say why the card failed");
      equal((await membership(agent, "after the failed challenge")).status, "none", "membership");

      const challenged = await confirmCard(
        agent,
        retry.clientSecret,
        "challenge",
        "challenge card",
      );
      check(challenged.challenged, "the challenge card was not challenged", {
        expected: "requires_action, then the challenge completed",
      });
      const confirmed = await succeeds(
        () => agent.api.confirmCheckout({ params: { id: started.id } }),
        "confirm after the completed challenge",
      );
      if (confirmed.status === "requires_payment") {
        check(confirmed.clientSecret, "requires_payment without a client secret");
        await confirmCard(agent, confirmed.clientSecret, undefined, "first payment");
      }
      await awaitCheckout(ctx, agent, started.id, "checkout after the challenge");
      const after = await entitlement(agent, "after the challenge");
      equal(after.entitled, true, "entitled after the completed challenge");
      equal(after.maxStreams, 4, "Premium streams");
    },
  },
  {
    id: "billing.declined",
    area: "billing",
    title:
      "Declined cards at checkout: each reason is reported, nothing starts, and the checkout takes another card",
    needs: [needs.fakePayments],
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareHolder("declined");
      const agent = account.agent;
      const started = await succeeds(
        () => agent.api.startCheckout({ body: { planId: "basic" } }),
        "POST /billing/checkout",
      );
      let secret = started.clientSecret;
      for (const [card, reason] of [
        ["declined", "card_declined"],
        ["insufficient-funds", "insufficient_funds"],
        ["expired-card", "expired_card"],
      ] as const) {
        check(secret, "no client secret to confirm");
        const outcome = await confirmAtProvider(agent, secret, { card });
        equal(outcome.status, "failed", `the provider's answer for ${card}`);
        const declined = await rejects(
          () => agent.api.confirmCheckout({ params: { id: started.id } }),
          "payment_declined",
          `confirm after ${card}`,
        );
        equal(declined.problem.declineReason, reason, `declineReason for ${card}`);
        const current = await succeeds(
          () => agent.api.getCheckout({ params: { id: started.id } }),
          `GET /billing/checkout/:id after ${card}`,
        );
        equal(current.status, "requires_setup", `checkout status after ${card}`);
        equal(current.failureReason, reason, `checkout failureReason after ${card}`);
        check(
          current.clientSecret && current.clientSecret !== secret,
          "no fresh setup after a decline",
        );
        secret = current.clientSecret;
        equal(
          (await membership(agent, `after ${card}`)).status,
          "none",
          `membership after ${card}`,
        );
      }
      check(secret, "no client secret");
      await confirmCard(agent, secret, "visa", "an approved card after the declines");
      const confirmed = await succeeds(
        () => agent.api.confirmCheckout({ params: { id: started.id } }),
        "confirm with an approved card",
      );
      if (confirmed.status === "requires_payment" && confirmed.clientSecret) {
        await confirmCard(agent, confirmed.clientSecret, undefined, "first payment");
      }
      await awaitCheckout(ctx, agent, started.id, "checkout after the declines");
      equal((await entitlement(agent, "after the declines")).entitled, true, "entitled");
    },
  },
  {
    id: "billing.checkout-abandoned",
    area: "billing",
    title:
      "A checkout abandoned before its first payment (another plan chosen) leaves the account without a membership, as an expired one does (§5.2)",
    needs: [needs.fakePayments],
    async run(ctx: CheckContext) {
      const { account, checkout } = await firstPaymentPending(ctx, "abandon");
      const agent = account.agent;
      // The member changes their mind: another plan abandons the unpaid subscription.
      const second = await succeeds(
        () => agent.api.startCheckout({ body: { planId: "standard" } }),
        "POST /billing/checkout (standard) instead",
      );
      equal(second.status, "requires_setup", "the new checkout");
      const first = await succeeds(
        () => agent.api.getCheckout({ params: { id: checkout.id } }),
        "the first checkout",
      );
      equal(first.status, "expired", "the abandoned checkout");
      const after = await settled(ctx, agent, "the abandoned subscription settles");
      equal(
        after.membership?.status,
        "none",
        "membership after an abandoned first payment (never subscribed)",
      );
      equal(
        after.entitlement?.reason,
        "no_membership",
        "entitlement.reason after an abandoned first payment",
      );
    },
  },
  {
    id: "billing.checkout-expired",
    area: "billing",
    title:
      "A first payment never confirmed expires at the provider (23 h on its clock): the account is back to no membership, with no plan, provider or period (§5.2)",
    needs: [needs.fakePayments],
    async run(ctx: CheckContext) {
      const { account, checkout } = await firstPaymentPending(ctx, "expire");
      const agent = account.agent;
      await succeeds(
        () => agent.api.advanceBillingClock({ body: { seconds: 24 * 3_600 } }),
        "24 hours on the test clock",
      );
      const after = await settled(ctx, agent, "the unconfirmed first payment expires");
      equal(after.membership?.status, "none", "membership after the first payment expired");
      equal(after.entitlement?.reason, "no_membership", "entitlement.reason");
      const expired = await succeeds(
        () => agent.api.getCheckout({ params: { id: checkout.id } }),
        "the checkout after expiry",
      );
      equal(expired.status, "expired", "the checkout after expiry");
      const open = (await invoices(agent, "after expiry")).filter(
        (invoice) => invoice.status === "open",
      );
      check(open.length === 0, "an expired first payment left an open invoice", {
        observed: JSON.stringify(open).slice(0, 300),
      });
      equal(after.membership?.planId, null, "membership.planId while none");
      equal(after.membership?.provider, null, "membership.provider while none");
      equal(after.membership?.currentPeriodEnd, null, "membership.currentPeriodEnd while none");
    },
  },
  {
    id: "billing.promo-code.refused",
    area: "billing",
    title: "Promo codes: an unknown code is refused with its reason, at validation and at checkout",
    needs: [needs.fakePayments],
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareHolder("promo-refused");
      const code = `SMOKE-NONE-${ctx.options.runId}`.toUpperCase();
      const refused = await rejects(
        () => account.agent.api.validatePromotion({ body: { code, planId: "standard" } }),
        "promotion_code_invalid",
        "an unknown promo code",
      );
      equal(refused.problem.promotionReason, "unknown", "promotionReason");
      await rejects(
        () =>
          account.agent.api.startCheckout({ body: { planId: "standard", promotionCode: code } }),
        "promotion_code_invalid",
        "a checkout with an unknown promo code",
      );
      equal((await membership(account.agent, "after the refusal")).status, "none", "membership");
    },
  },
  {
    id: "billing.promo-code.applied",
    area: "billing",
    title:
      "A promo code is quoted before it is applied, and the first payment charges exactly the quoted price (the fake provider's standing code, or --promo-code)",
    needs: [needs.fakePayments],
    async run(ctx: CheckContext) {
      // The fake provider's standing code (WEBFLIX_PAYMENTS_FAKE_PROMOTIONS, default WEBFLIX50).
      const code = ctx.options.promoCode ?? FAKE_STANDING_PROMOTION;
      const account = await ctx.env.bareHolder("promo");
      const agent = account.agent;
      let quote: Awaited<ReturnType<typeof agent.api.validatePromotion>>;
      try {
        quote = await agent.api.validatePromotion({ body: { code, planId: "standard" } });
      } catch (error) {
        if (!ctx.options.promoCode && isApiError(error, "promotion_code_invalid")) {
          ctx.skip(
            `the fake provider has no standing promo code ${code} (WEBFLIX_PAYMENTS_FAKE_PROMOTIONS is set otherwise, or none): pass --promo-code CODE (a code valid for the Standard plan)`,
          );
        }
        quote = await succeeds(() => Promise.reject(error), "POST /billing/promotions/validate");
      }
      const standard = await price(agent, "standard");
      equal(quote.price.amountMinor, standard, "quoted price");
      check(
        quote.discountedPrice.amountMinor < standard,
        "the quoted discount does not lower the price",
        { observed: JSON.stringify(quote) },
      );
      check(
        (quote.promotion.percentOff === null) !== (quote.promotion.amountOff === null),
        "exactly one of percentOff and amountOff must be set",
        { observed: JSON.stringify(quote.promotion) },
      );
      // A card whose trial is spent: the first invoice is charged now, with the discount.
      const card = await spentCard(ctx);
      const started = await succeeds(
        () => agent.api.startCheckout({ body: { planId: "standard", promotionCode: code } }),
        "POST /billing/checkout with the promo code",
      );
      equal(started.promotion?.code, quote.promotion.code, "the checkout's promotion");
      check(started.clientSecret, "no client secret");
      await confirmCard(agent, started.clientSecret, card, "card");
      const confirmed = await succeeds(
        () => agent.api.confirmCheckout({ params: { id: started.id } }),
        "confirm the checkout",
      );
      equal(confirmed.status, "requires_payment", "a checkout without a trial");
      equal(
        confirmed.amountDue?.amountMinor,
        quote.discountedPrice.amountMinor,
        "the first payment's amount (as quoted)",
      );
      check(confirmed.clientSecret, "requires_payment without a client secret");
      await confirmCard(agent, confirmed.clientSecret, undefined, "first payment");
      await awaitCheckout(ctx, agent, started.id, "checkout with the promo code");
      const charged = (await invoices(agent, "after the promo checkout")).find(
        (invoice) => invoice.amountPaid.amountMinor > 0,
      );
      check(charged, "no paid invoice");
      equal(charged.amountPaid.amountMinor, quote.discountedPrice.amountMinor, "charged as quoted");
      equal((await entitlement(agent, "after the promo checkout")).entitled, true, "entitled");
      ctx.note(`${quote.promotion.code}: ${standard} → ${quote.discountedPrice.amountMinor}`);
    },
  },
  {
    id: "billing.open-checkout",
    area: "billing",
    title:
      "The checkout in progress can be read back (plan, promotion and its outcome, state; never a client secret), and nothing once it completed",
    needs: [needs.fakePayments],
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareHolder("open-checkout");
      const agent = account.agent;
      const none = await succeeds(
        () => agent.api.getOpenCheckout(),
        "GET /billing/checkout (none yet)",
      );
      equal(none.checkout, null, "the open checkout of a new account");
      const started = await succeeds(
        () =>
          agent.api.startCheckout({
            body: { planId: "standard", promotionCode: FAKE_STANDING_PROMOTION },
          }),
        "POST /billing/checkout",
      );
      const open = (await succeeds(() => agent.api.getOpenCheckout(), "GET /billing/checkout"))
        .checkout;
      check(open, "no open checkout while one is in progress");
      equal(open.id, started.id, "the open checkout");
      equal(open.planId, "standard", "its plan");
      equal(open.status, "requires_setup", "its state");
      equal(open.clientSecret, null, "its client secret (never on the open checkout)");
      equal(open.promotion?.code, FAKE_STANDING_PROMOTION, "its promotion");
      equal(open.promotionOutcome, "pending", "its promotion outcome before the card is confirmed");
      const continuing = await succeeds(
        () => agent.api.getCheckout({ params: { id: started.id } }),
        "GET /billing/checkout/:id",
      );
      check(continuing.clientSecret, "the session continuing the checkout gets no client secret");
      await confirmCard(agent, continuing.clientSecret, await spentCard(ctx), "card");
      const confirmed = await succeeds(
        () => agent.api.confirmCheckout({ params: { id: started.id } }),
        "confirm",
      );
      const waiting = (await succeeds(() => agent.api.getOpenCheckout(), "GET /billing/checkout"))
        .checkout;
      equal(waiting?.status, confirmed.status, "the open checkout's state after confirming");
      equal(waiting?.clientSecret ?? null, null, "its client secret after confirming");
      equal(waiting?.promotionOutcome, "applied", "the promotion outcome without a trial");
      if (confirmed.status === "requires_payment" && confirmed.clientSecret) {
        await confirmCard(agent, confirmed.clientSecret, undefined, "first payment");
      }
      await awaitCheckout(ctx, agent, started.id, "the checkout");
      equal(
        (await succeeds(() => agent.api.getOpenCheckout(), "GET /billing/checkout after")).checkout,
        null,
        "the open checkout once complete",
      );
    },
  },
  {
    id: "billing.promo-on-trial",
    area: "billing",
    title:
      "A promo code is never spent on a trial: the checkout says not_applied_trial, the code stays valid for the account, and the first bill after the trial is the full price",
    needs: [needs.fakePayments],
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareHolder("promo-trial");
      const agent = account.agent;
      const code = ctx.options.promoCode ?? FAKE_STANDING_PROMOTION;
      const card = labelledCard("visa", ctx.options.runId, "promo-trial");
      const started = await succeeds(
        () => agent.api.startCheckout({ body: { planId: "standard", promotionCode: code } }),
        "POST /billing/checkout with a promo code",
      );
      check(started.clientSecret, "no client secret");
      await confirmCard(agent, started.clientSecret, card, "a card that never had a trial");
      const confirmed = await succeeds(
        () => agent.api.confirmCheckout({ params: { id: started.id } }),
        "confirm",
      );
      check(confirmed.trial, "no trial for a new account and a new card");
      const done =
        confirmed.status === "complete"
          ? confirmed
          : await awaitCheckout(ctx, agent, started.id, "trial");
      equal(done.promotionOutcome, "not_applied_trial", "the promotion outcome with a trial");
      equal(done.promotion?.code, code.toUpperCase(), "the checkout still names the code");
      equal(done.amountDue?.amountMinor, 0, "charged now");
      await succeeds(
        () => agent.api.validatePromotion({ body: { code, planId: "standard" } }),
        "the code is still valid for the account afterwards (it was not redeemed)",
      );
      const standard = await price(agent, "standard");
      const trialing = await membership(agent, "during the trial");
      equal(trialing.nextInvoice?.amount.amountMinor, standard, "the next bill (the full price)");
      check(trialing.trialEndsAt, "no trial end");
      await advancePast(agent, trialing.trialEndsAt, RENEWAL_SETTLE_SEC, "the trial end");
      const [first] = await invoices(agent, "after the trial");
      equal(
        first?.amountPaid.amountMinor,
        standard,
        "the first bill after the trial (no discount)",
      );
    },
  },
  {
    id: "billing.form-leads-back",
    area: "billing",
    title:
      "The provider's form always leads back: a declined card returns to the page with payment=failed, another card on the same form then succeeds with payment=succeeded, and the checkout completes",
    needs: [needs.fakePayments],
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareHolder("form-back");
      const agent = account.agent;
      const started = await succeeds(
        () => agent.api.startCheckout({ body: { planId: "basic" } }),
        "POST /billing/checkout",
      );
      check(started.clientSecret, "no client secret");
      const returnTo = "/account/checkout";
      const page = await agent.fetch(
        `/_pay/form?secret=${encodeURIComponent(started.clientSecret)}&return=${encodeURIComponent(returnTo)}`,
      );
      status(page, 200, "the provider's form");
      check(
        page.text().includes(`${returnTo}?payment=failed`),
        "the form offers no way back to Webflix",
        {
          expected: `a link to ${returnTo}?payment=failed`,
          exchange: page.exchange,
        },
      );
      const submit = (card: string) =>
        agent.fetch("/_pay/form", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            secret: started.clientSecret ?? "",
            return: returnTo,
            card,
          }).toString(),
          followRedirects: false,
        });
      const declined = await submit("declined");
      status(declined, 303, "a declined card on the form");
      equal(
        declined.headers.get("Location"),
        `${returnTo}?payment=failed`,
        "where a decline leads",
        declined.exchange,
      );
      const card = await spentCard(ctx);
      const approved = await submit(card);
      status(approved, 303, "another card on the same form");
      equal(
        approved.headers.get("Location"),
        `${returnTo}?payment=succeeded`,
        "where success leads",
        approved.exchange,
      );
      const again = await submit(card);
      equal(
        again.headers.get("Location"),
        `${returnTo}?payment=succeeded`,
        "a second submission of the confirmed card",
        again.exchange,
      );
      const confirmed = await succeeds(
        () => agent.api.confirmCheckout({ params: { id: started.id } }),
        "confirm after the form",
      );
      if (confirmed.status === "requires_payment" && confirmed.clientSecret) {
        await confirmCard(agent, confirmed.clientSecret, undefined, "first payment");
      }
      await awaitCheckout(ctx, agent, started.id, "the checkout after the form");
    },
  },
  {
    id: "billing.next-invoice",
    area: "billing",
    title:
      "The next bill: the plan's price at the trial's end; after a downgrade exactly the preview's renewal figure; none while cancelling, back after resuming",
    needs: [needs.fakePayments],
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareHolder("next-invoice");
      const agent = account.agent;
      const trial = await trialMembership(ctx, account, "mastercard", "next-invoice");
      const standard = await price(agent, "standard");
      equal(
        trial.membership.nextInvoice?.at,
        trial.membership.trialEndsAt,
        "the next bill's date during the trial",
      );
      equal(
        trial.membership.nextInvoice?.amount.amountMinor,
        standard,
        "the next bill during the trial",
      );
      check(trial.membership.trialEndsAt, "no trial end");
      await advancePast(agent, trial.membership.trialEndsAt, RENEWAL_SETTLE_SEC, "the trial end");
      const active = await membership(agent, "after the trial");
      equal(
        active.nextInvoice?.at,
        active.currentPeriodEnd,
        "the next bill's date (the period's end)",
      );
      equal(active.nextInvoice?.amount.amountMinor, standard, "the next bill of an active member");
      const preview = await succeeds(
        () => agent.api.previewPlanChange({ body: { planId: "basic" } }),
        "preview a downgrade",
      );
      await succeeds(
        () =>
          agent.api.changePlan({ body: { planId: "basic", previewToken: preview.previewToken } }),
        "apply the downgrade",
      );
      const downgraded = await membership(agent, "after the downgrade");
      equal(
        downgraded.nextInvoice?.amount.amountMinor,
        preview.nextRenewal?.amount.amountMinor,
        "the next bill vs the preview's renewal figure",
      );
      equal(
        downgraded.nextInvoice?.at,
        preview.nextRenewal?.at,
        "the next bill's date vs the preview's",
      );
      await succeeds(() => agent.api.cancelMembership(), "cancel");
      equal(
        (await membership(agent, "while cancelling")).nextInvoice ?? null,
        null,
        "the next bill while cancelling",
      );
      await succeeds(() => agent.api.resumeMembership(), "resume");
      check((await membership(agent, "after resuming")).nextInvoice, "no next bill after resuming");
    },
  },
  {
    id: "billing.amounts",
    area: "billing",
    title:
      "Amounts carry their reasons: trial eligibility is stated with no checkout open; a downgrade's preview, the renewal after it and the restart's checkout (known before the card) each add up as amount + creditApplied + discount = the price before them; a negative invoice is a credit with nothing paid",
    needs: [needs.fakePayments],
    timeoutMs: 180_000,
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareHolder("amounts");
      const agent = account.agent;
      const minor = (money: { amountMinor: number } | null | undefined) => money?.amountMinor ?? 0;
      const before = (money: { amountMinor: number }, credit?: unknown, discount?: unknown) =>
        money.amountMinor +
        minor(credit as { amountMinor: number } | null) +
        minor(discount as { amountMinor: number } | null);
      const fresh = await succeeds(() => agent.api.getOpenCheckout(), "GET /billing/checkout");
      equal(fresh.checkout, null, "the open checkout of a new account");
      equal(fresh.trialEligible, true, "trialEligible of a new account (no checkout open)");

      const premium = await price(agent, "premium");
      const basic = await price(agent, "basic");
      const standard = await price(agent, "standard");
      const subscribed = await subscribe(ctx, agent, {
        planId: "premium",
        card: labelledCard("visa", ctx.options.runId, "amounts"),
      });
      check(subscribed.trial, "a new account with a new card got no trial", {
        observed: JSON.stringify(subscribed.checkout),
      });
      const afterTrial = await succeeds(() => agent.api.getOpenCheckout(), "GET /billing/checkout");
      equal(afterTrial.checkout, null, "the open checkout once the trial started");
      equal(afterTrial.trialEligible, false, "trialEligible once the account had a trial");
      await convertTrial(agent, subscribed.membership);
      const active = await membership(agent, "after the trial");
      check(active.nextInvoice, "an active member has no next invoice", {
        observed: JSON.stringify(active),
      });
      equal(active.nextInvoice.creditApplied ?? null, null, "the renewal's credit (none)");
      equal(active.nextInvoice.discount ?? null, null, "the renewal's discount (none)");
      equal(active.nextInvoice.amount.amountMinor, premium, "the renewal (the plan's price)");

      // A downgrade right after a renewal: the unused time of the dearer plan is credited.
      const preview = await succeeds(
        () => agent.api.previewPlanChange({ body: { planId: "basic" } }),
        "preview a downgrade to Basic",
      );
      const remaining = preview.lines
        .filter((line) => line.amount.amountMinor > 0)
        .reduce((sum, line) => sum + line.amount.amountMinor, 0);
      check(
        minor(preview.creditApplied) > 0,
        "a downgrade's preview states no credit for the unused time",
        { observed: JSON.stringify(preview) },
      );
      equal(
        before(preview.amountDue, preview.creditApplied, preview.discount),
        remaining,
        "the preview: amountDue + creditApplied + discount vs the new plan's remaining time",
      );
      check(
        remaining > 0 && remaining <= basic,
        "the new plan's remaining time is not a part of its price",
        {
          observed: `${remaining} of ${basic}`,
        },
      );
      check(preview.nextRenewal, "the preview has no next renewal", {
        observed: JSON.stringify(preview),
      });
      equal(
        before(
          preview.nextRenewal.amount,
          preview.nextRenewal.creditApplied,
          preview.nextRenewal.discount,
        ),
        basic,
        "the preview's renewal: amount + creditApplied + discount vs Basic's price",
      );
      await succeeds(
        () =>
          agent.api.changePlan({ body: { planId: "basic", previewToken: preview.previewToken } }),
        "apply the downgrade",
      );
      const credited = (await invoices(agent, "after the downgrade")).find(
        (invoice) => invoice.total.amountMinor < 0,
      );
      check(credited, "a downgrade crediting unused time left no negative invoice", {
        observed: JSON.stringify(await invoices(agent, "after the downgrade")),
      });
      equal(credited.amountPaid.amountMinor, 0, "a negative invoice's amountPaid (a credit)");
      equal(credited.amountDue.amountMinor, 0, "a negative invoice's amountDue");
      const downgraded = await membership(agent, "after the downgrade");
      check(downgraded.nextInvoice, "no next invoice after the downgrade", {
        observed: JSON.stringify(downgraded),
      });
      check(
        minor(downgraded.nextInvoice.creditApplied) > 0,
        "the next invoice does not use the credit",
        { observed: JSON.stringify(downgraded.nextInvoice) },
      );
      equal(
        before(
          downgraded.nextInvoice.amount,
          downgraded.nextInvoice.creditApplied,
          downgraded.nextInvoice.discount,
        ),
        basic,
        "the next invoice: amount + creditApplied + discount vs Basic's price",
      );

      // The membership ends with credit left; a restart's checkout states its amount before the
      // card (the account can no longer have a trial), the credit and any code applied.
      await succeeds(() => agent.api.cancelMembership(), "cancel at the period's end");
      check(downgraded.currentPeriodEnd, "no period end");
      await advancePast(agent, downgraded.currentPeriodEnd, RENEWAL_SETTLE_SEC, "the period end");
      await ctx.eventually("the membership ends", async () => {
        const state = await membership(agent, "after the period end");
        return state.status === "canceled" || state.status === "none"
          ? { done: true, value: state }
          : { done: false, observed: state.status };
      });
      const code = ctx.options.promoCode ?? FAKE_STANDING_PROMOTION;
      const offered = await agent.api
        .validatePromotion({ body: { code, planId: "standard" } })
        .then(() => true)
        .catch(() => false);
      const restart = await succeeds(
        () =>
          agent.api.startCheckout({
            body: { planId: "standard", ...(offered ? { promotionCode: code } : {}) },
          }),
        "a restart's checkout",
      );
      equal(restart.status, "requires_setup", "the restart's checkout");
      check(restart.amountDue, "the restart's amount is not stated before the card", {
        expected: "amountDue known at requires_setup (trialEligible false)",
        observed: JSON.stringify(restart),
      });
      check(minor(restart.creditApplied) > 0, "the restart's checkout does not use the credit", {
        observed: JSON.stringify(restart),
      });
      if (offered) {
        check(
          minor(restart.discount) > 0,
          "the restart's checkout states no discount for the code",
          {
            observed: JSON.stringify(restart),
          },
        );
      }
      equal(
        before(restart.amountDue, restart.creditApplied, restart.discount),
        standard,
        "the restart: amountDue + creditApplied + discount vs Standard's price",
      );
      ctx.note(
        `downgrade credit ${minor(preview.creditApplied)}, invoice ${credited.total.amountMinor}; restart ${restart.amountDue.amountMinor} + credit ${minor(restart.creditApplied)} + discount ${minor(restart.discount)} = ${standard}`,
      );
    },
  },
  {
    id: "billing.promo-budget",
    area: "billing",
    title:
      "One promo-code budget per account, whichever route looks a code up: after ten lookups (validations and checkouts with a code) both answer 429 with Retry-After; the open checkout's own code and a checkout without a code still start; another account is unaffected",
    needs: [needs.fakePayments],
    async run(ctx: CheckContext) {
      const env = ctx.env;
      const spec = profileIndependentSpec(env, "promotion");
      const code = ctx.options.promoCode ?? FAKE_STANDING_PROMOTION;
      const account = await env.bareSignup("promo-budget");
      // The account's own session, in a browser that shows the 429s instead of waiting them out.
      const agent = sameSession(ctx, account.agent, "promo-budget-raw");
      const guess = (index: number) =>
        `SMOKE-GUESS-${ctx.options.runId}-${index}`.toUpperCase().slice(0, 40);
      const post = (path: string, body: object) =>
        agent.fetch(`${API}${path}`, { method: "POST", headers: CSRF, body });
      const validations = Math.floor(spec.limit / 2);
      const started = Date.now();
      for (let index = 0; index < validations; index += 1) {
        problem(
          await post("/billing/promotions/validate", { code: guess(index), planId: "basic" }),
          "promotion_code_invalid",
          `validation ${index + 1} (a guessed code)`,
        );
      }
      for (let index = validations; index < spec.limit - 1; index += 1) {
        problem(
          await post("/billing/checkout", { planId: "basic", promotionCode: guess(index) }),
          "promotion_code_invalid",
          `lookup ${index + 1}: a checkout with a guessed code`,
        );
      }
      const withCode = await post("/billing/checkout", { planId: "basic", promotionCode: code });
      if (withCode.status === 422 && !ctx.options.promoCode) {
        ctx.skip(
          `the fake provider has no standing promo code ${code} (WEBFLIX_PAYMENTS_FAKE_PROMOTIONS is set otherwise, or none): pass --promo-code CODE`,
        );
      }
      status(withCode, 201, `lookup ${spec.limit}: a checkout with a valid code`);
      const open = withCode.json<Checkout>();
      // The budget is spent: the next lookup by either route is refused before the provider.
      const refill = admissible(spec, Date.now() - started).max - spec.limit;
      const refused = [
        [
          "a validation",
          await post("/billing/promotions/validate", { code: guess(90), planId: "basic" }),
        ],
        [
          "a checkout with another code",
          await post("/billing/checkout", { planId: "basic", promotionCode: guess(91) }),
        ],
      ] as const;
      let admittedLate = 0;
      for (const [what, answer] of refused) {
        if (answer.status !== 429 && refill > admittedLate) {
          admittedLate += 1;
          ctx.note(`${what} admitted: the run was slow enough for the budget to refill one lookup`);
          continue;
        }
        problem(answer, "rate_limited", `${what} after ${spec.limit} lookups`);
        const after = Number(answer.headers.get("Retry-After"));
        check(
          Number.isFinite(after) && after > 0 && after <= spec.windowSec,
          `${what}: no usable Retry-After`,
          { observed: answer.headers.get("Retry-After") ?? "(absent)", exchange: answer.exchange },
        );
      }
      // Picking up the open checkout with its own code is not another lookup.
      const again = await post("/billing/checkout", { planId: "basic", promotionCode: code });
      status(again, 201, "the open checkout's own code again (budget spent)");
      equal(again.json<Checkout>().id, open.id, "the checkout answered (the open one)");
      const plain = await post("/billing/checkout", { planId: "basic" });
      status(plain, 201, "a checkout without a code (budget spent)");
      equal(plain.json<Checkout>().promotion, null, "the promotion of a checkout without a code");
      // The budget is the account's: another one looks a code up as usual.
      const other = await env.bareSignup("promo-budget-other");
      await rejects(
        () => other.agent.api.validatePromotion({ body: { code: guess(92), planId: "basic" } }),
        "promotion_code_invalid",
        "another account's validation",
      );
    },
  },
  {
    id: "billing.provider-budget",
    area: "billing",
    title:
      "Member routes that call the provider share one budget per account (checkout start, card setup, plan-change preview): spent, a preview and a card setup answer 429 with Retry-After while another account starts a checkout; polls of a checkout and a card change are never refused",
    needs: [needs.fakePayments],
    timeoutMs: 180_000,
    async run(ctx: CheckContext) {
      const env = ctx.env;
      const spec = profileIndependentSpec(env, "billing");
      const account = await env.bareSignup("provider-budget");
      await env.holder(account);
      const agent = sameSession(ctx, account.agent, "provider-budget-raw");
      const post = (path: string, body?: object) =>
        agent.fetch(`${API}${path}`, {
          method: "POST",
          headers: CSRF,
          ...(body === undefined ? {} : { body }),
        });
      const tally = (results: readonly { status: number }[]) =>
        JSON.stringify(
          results.reduce<Record<number, number>>((counts, result) => {
            counts[result.status] = (counts[result.status] ?? 0) + 1;
            return counts;
          }, {}),
        );
      const first = Date.now();
      // One checkout start (the first call on the budget).
      await subscribe(ctx, agent, {
        planId: "standard",
        card: labelledCard("visa", ctx.options.runId, "provider-budget"),
      });
      const setup = await post("/billing/payment-method/setup");
      status(setup, 201, "POST /billing/payment-method/setup");
      const setupId = setup.json<{ id: string }>().id;
      const setupPolls = await Promise.all(
        Array.from({ length: 50 }, () =>
          agent.fetch(`${API}/billing/payment-method/setup/${setupId}`),
        ),
      );
      check(
        setupPolls.every((result) => result.status === 200),
        "parallel polls of a card change were refused",
        { expected: "50 × 200", observed: tally(setupPolls) },
      );
      let previews = 0;
      let limited: Awaited<ReturnType<typeof post>> | undefined;
      for (let index = 0; index < spec.limit + 5; index += 1) {
        const answer = await post("/billing/subscription/preview", {
          planId: index % 2 === 0 ? "premium" : "basic",
        });
        if (answer.status === 429) {
          limited = answer;
          break;
        }
        status(answer, 200, `preview ${index + 1}`);
        previews += 1;
      }
      const admitted = 2 + previews; // the checkout start and the card setup, then the previews
      const range = admissible(spec, Date.now() - first);
      check(limited, "the budget never ran out", {
        expected: `429 after ${spec.limit} calls (checkout start, card setup, previews)`,
        observed: `${admitted} admitted`,
      });
      check(
        admitted >= range.min && admitted <= range.max,
        "the per-account provider budget is not the documented one",
        {
          expected: `${spec.limit} per ${spec.windowSec} s (up to ${range.max} with the refill meanwhile)`,
          observed: `${admitted} admitted (1 checkout start, 1 card setup, ${previews} previews)`,
        },
      );
      for (const [what, answer] of [
        ["a preview", limited],
        ["a card setup", await post("/billing/payment-method/setup")],
      ] as const) {
        problem(answer, "rate_limited", `${what} once the budget is spent`);
        const after = Number(answer.headers.get("Retry-After"));
        check(
          Number.isFinite(after) && after > 0 && after <= spec.windowSec,
          `${what}: no usable Retry-After`,
          { observed: answer.headers.get("Retry-After") ?? "(absent)", exchange: answer.exchange },
        );
      }
      // The budget is the account's own; polls are never refused.
      const other = await env.bareSignup("provider-budget-other");
      const started = await succeeds(
        () => other.agent.api.startCheckout({ body: { planId: "basic" } }),
        "another account starts a checkout",
      );
      const polls = await Promise.all(
        Array.from({ length: 50 }, () =>
          other.agent.fetch(`${API}/billing/checkout/${started.id}`),
        ),
      );
      check(
        polls.every((result) => result.status === 200),
        "parallel polls of a checkout were refused",
        { expected: "50 × 200", observed: tally(polls) },
      );
      ctx.note(
        `${admitted} provider calls admitted, then 429 (Retry-After ${limited.headers.get("Retry-After")} s)`,
      );
    },
  },
  {
    id: "billing.trial-converts",
    area: "billing",
    title:
      "A trial: entitled at once with nothing charged; when it ends the plan's price is charged and the membership is active",
    needs: [needs.fakePayments],
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareHolder("trial-converts");
      const agent = account.agent;
      const trial = await trialMembership(ctx, account, "mastercard", "converts");
      equal(trial.membership.status, "trialing", "membership.status");
      check(trial.membership.trialEndsAt, "trialing without trialEndsAt");
      const days = (Date.parse(trial.membership.trialEndsAt) - Date.now()) / 86_400_000;
      check(days > 6 && days <= 7.1, "the trial does not last 7 days", {
        observed: trial.membership.trialEndsAt,
      });
      const during = await entitlement(agent, "during the trial");
      equal(during.entitled, true, "entitled during the trial");
      equal(trial.checkout.amountDue?.amountMinor, 0, "charged at the start of a trial");
      check(
        (await invoices(agent, "during the trial")).every(
          (invoice) => invoice.amountPaid.amountMinor === 0,
        ),
        "money was taken during the trial",
      );
      await playsOnce(agent, (await movie(ctx.env)).id, "playback during the trial");
      await advancePast(agent, trial.membership.trialEndsAt, RENEWAL_SETTLE_SEC, "trial end");
      const after = await membership(agent, "after the trial");
      equal(after.status, "active", "membership after the trial");
      equal(after.trialEndsAt, null, "trialEndsAt after the trial");
      const planPrice = await price(agent, trial.planId);
      const [newest] = await invoices(agent, "after the trial");
      check(newest, "no invoice after the trial");
      equal(newest.status, "paid", "the conversion invoice");
      equal(newest.amountPaid.amountMinor, planPrice, `charged the ${trial.planId} price`);
      await playsOnce(agent, (await movie(ctx.env)).id, "playback after the trial");
      ctx.note(`trial with ${trial.card} on ${trial.planId}`);
    },
  },
  {
    id: "billing.trial-cancelled",
    area: "billing",
    title:
      "A trial cancelled (and resumed, and cancelled again) stays entitled until it ends, then ends without charging anything",
    needs: [needs.fakePayments],
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareHolder("trial-cancelled");
      const agent = account.agent;
      const title = await movie(ctx.env);
      // A card that declines whenever it is charged: a cancelled trial must never be charged.
      const trial = await trialMembership(ctx, account, "charge-declined", "cancelled");
      check(trial.membership.trialEndsAt, "trialing without trialEndsAt");
      await succeeds(() => agent.api.cancelMembership(), "DELETE /account/subscription");
      const cancelling = await membership(agent, "after cancelling");
      equal(
        cancelling.status,
        "trialing",
        "status of a cancelled trial (cancelling is not a state)",
      );
      equal(cancelling.cancelAtPeriodEnd, true, "cancelAtPeriodEnd");
      const until = await entitlement(agent, "cancelled trial");
      equal(until.entitled, true, "entitled until the trial ends");
      equal(until.until, trial.membership.trialEndsAt, "entitlement.until");
      await playsOnce(agent, title.id, "playback during a cancelled trial");
      await succeeds(() => agent.api.resumeMembership(), "POST /account/subscription/resume");
      equal((await membership(agent, "after resuming")).cancelAtPeriodEnd, false, "resumed");
      await succeeds(() => agent.api.cancelMembership(), "cancel again");
      await advancePast(agent, trial.membership.trialEndsAt, RENEWAL_SETTLE_SEC, "trial end");
      const ended = await succeeds(() => agent.api.getAccount(), "GET /account after the trial");
      equal(ended.membership?.status, "canceled", "membership after a cancelled trial");
      equal(ended.entitlement?.entitled, false, "entitled after a cancelled trial");
      equal(ended.entitlement?.reason, "ended", "entitlement.reason");
      await refusedPlayback(agent, title.id, "canceled", "playback after a cancelled trial");
      const charged = (await invoices(agent, "after a cancelled trial")).filter(
        (invoice) => invoice.amountPaid.amountMinor > 0,
      );
      check(charged.length === 0, "a cancelled trial was charged", {
        observed: JSON.stringify(charged).slice(0, 400),
      });
      // First invoices of checkouts abandoned while finding a card with a trial are voided by
      // the provider; Webflix's copies follow its events.
      await ctx.eventually("no invoice left open (nothing owed)", async () => {
        const open = (await invoices(agent, "open invoices")).filter(
          (invoice) => invoice.status === "open" && invoice.amountDue.amountMinor > 0,
        );
        return open.length === 0
          ? { done: true, value: null }
          : {
              done: false,
              observed: `${open.length} open: ${open.map((invoice) => invoice.description).join(", ")}`,
            };
      });
      await rejects(
        () => agent.api.resumeMembership(),
        "checkout_state_conflict",
        "resuming a membership that has ended",
      );
      ctx.note(`trial with ${trial.card}`);
    },
  },
  {
    id: "billing.plan-change",
    area: "billing",
    title:
      "Plan changes are invoiced exactly as previewed: an upgrade charges the preview, a downgrade credits it, and the next renewal bills what the preview said",
    needs: [needs.fakePayments],
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareHolder("plan-change");
      const agent = account.agent;
      await paidMembership(ctx, agent, { planId: "standard", card: await spentCard(ctx) });
      const up = await succeeds(
        () => agent.api.previewPlanChange({ body: { planId: "premium" } }),
        "POST /billing/subscription/preview (premium)",
      );
      check(up.amountDue.amountMinor > 0, "an upgrade previews nothing to pay", {
        observed: JSON.stringify(up),
      });
      equal(
        up.lines.reduce((sum, line) => sum + line.amount.amountMinor, 0),
        up.amountDue.amountMinor - up.credit.amountMinor,
        "preview lines add up to the amount due",
      );
      const count = (await invoices(agent, "before the upgrade")).length;
      const mismatched = await agent.fetch(`${API}/account/subscription`, {
        method: "PUT",
        headers: CSRF,
        body: { planId: "basic", previewToken: up.previewToken },
      });
      problem(mismatched, "checkout_state_conflict", "a preview of one plan applied to another");
      const upgraded = await succeeds(
        () => agent.api.changePlan({ body: { planId: "premium", previewToken: up.previewToken } }),
        "PUT /account/subscription with the preview",
      );
      equal(upgraded.plan.id, "premium", "plan after the upgrade");
      equal((await entitlement(agent, "after the upgrade")).maxStreams, 4, "Premium streams");
      const afterUp = await invoices(agent, "after the upgrade");
      equal(afterUp.length, count + 1, "invoices added by the upgrade");
      const [proration] = afterUp;
      check(proration, "no proration invoice");
      equal(
        proration.total.amountMinor,
        up.amountDue.amountMinor,
        "proration invoice total vs preview",
      );
      equal(proration.amountPaid.amountMinor, up.amountDue.amountMinor, "charged as previewed");
      await rejects(
        () => agent.api.changePlan({ body: { planId: "premium", previewToken: up.previewToken } }),
        "checkout_state_conflict",
        "applying the same preview again",
      );
      equal((await invoices(agent, "after the replay")).length, count + 1, "nothing charged twice");

      const down = await succeeds(
        () => agent.api.previewPlanChange({ body: { planId: "basic" } }),
        "POST /billing/subscription/preview (basic)",
      );
      equal(down.amountDue.amountMinor, 0, "a downgrade charges nothing now");
      check(down.credit.amountMinor > 0, "a downgrade previews no credit", {
        observed: JSON.stringify(down),
      });
      await succeeds(
        () => agent.api.changePlan({ body: { planId: "basic", previewToken: down.previewToken } }),
        "apply the downgrade",
      );
      const basic = await entitlement(agent, "after the downgrade");
      equal(basic.maxStreams, 1, "Basic streams");
      equal(basic.maxVideoHeight, 720, "Basic quality");
      const known = new Set(afterUp.map((invoice) => invoice.id));
      const charged = (await invoices(agent, "after the downgrade")).filter(
        (invoice) => !known.has(invoice.id) && invoice.amountPaid.amountMinor > 0,
      );
      check(charged.length === 0, "the downgrade charged money", {
        observed: JSON.stringify(charged).slice(0, 300),
      });
      check(down.nextRenewal, "the downgrade preview has no next renewal");
      const current = await membership(agent, "before the renewal");
      check(current.currentPeriodEnd, "no period end");
      await advancePast(agent, current.currentPeriodEnd, RENEWAL_SETTLE_SEC, "the renewal");
      const [renewal] = await invoices(agent, "after the renewal");
      check(
        renewal && renewal.periodStart === down.nextRenewal.at,
        "no renewal invoice for the previewed date",
        {
          expected: `an invoice for the period starting ${down.nextRenewal.at}`,
          observed: JSON.stringify(renewal ?? null).slice(0, 300),
        },
      );
      equal(
        renewal.amountPaid.amountMinor + renewal.amountDue.amountMinor,
        down.nextRenewal.amount.amountMinor,
        "the renewal bills what the preview said (after the credit)",
      );
      equal(
        (await membership(agent, "after the renewal")).status,
        "active",
        "status after renewal",
      );
    },
  },
  {
    id: "billing.member-journey",
    area: "billing",
    title:
      "Sign up with Google, pay, watch, cancel (entitled until the period ends), resume, cancel, end, resubscribe without a second trial, watch",
    needs: [needs.fakePayments, needs.googleIssuer],
    timeoutMs: 180_000,
    async run(ctx: CheckContext) {
      const env = ctx.env;
      const agent = ctx.agent("member-journey");
      const email = env.email("journey");
      await env.issuerSlot();
      const signedUp = await federatedSignIn(agent, "google", { email: { address: email } });
      equal(signedUp.outcome, "signed-up", "Google sign-up outcome");
      const session = await succeeds(() => agent.api.getSession(), "GET /session");
      check(session.authenticated, "not signed in after the Google sign-up");
      const account: TestAccount = { tag: "journey", email, password: "", agent, session };
      await env.holder(account);
      const title = await movie(env);
      // A first trial on a card that never had one, paid when it converts.
      const paid = await paidMembership(ctx, agent, {
        planId: "standard",
        card: labelledCard("visa", ctx.options.runId, "journey"),
      });
      equal(paid.trialConverted, true, "a new member's first checkout with a new card is a trial");
      await playsOnce(agent, title.id, "watch after paying");

      await succeeds(() => agent.api.cancelMembership(), "DELETE /account/subscription");
      const cancelling = await membership(agent, "after cancelling");
      equal(cancelling.status, "active", "status while cancelling");
      equal(cancelling.cancelAtPeriodEnd, true, "cancelAtPeriodEnd");
      equal(
        (await entitlement(agent, "cancelling")).until,
        cancelling.currentPeriodEnd,
        "entitled until",
      );
      await playsOnce(agent, title.id, "watch while cancelling");
      await succeeds(() => agent.api.resumeMembership(), "resume");
      equal((await membership(agent, "after resuming")).cancelAtPeriodEnd, false, "resumed");
      await succeeds(() => agent.api.cancelMembership(), "cancel again");
      check(paid.membership.currentPeriodEnd, "no period end");
      await advancePast(
        agent,
        cancelling.currentPeriodEnd ?? paid.membership.currentPeriodEnd,
        60,
        "period end",
      );
      equal(
        (await membership(agent, "after the period")).status,
        "canceled",
        "status after the period",
      );
      await refusedPlayback(agent, title.id, "canceled", "watch after the membership ended");
      await rejects(
        () => agent.api.resumeMembership(),
        "checkout_state_conflict",
        "resuming an ended membership",
      );
      // Another card that never had a trial: the account has had its one (§5.4).
      const restarted = await subscribe(ctx, agent, {
        planId: "standard",
        card: labelledCard("mastercard", ctx.options.runId, "journey-restart"),
      });
      equal(restarted.trial, false, "a second trial for the same account (on a new card)");
      equal(restarted.membership.status, "active", "status after resubscribing");
      await playsOnce(agent, title.id, "watch after resubscribing");
    },
  },
  {
    id: "billing.dunning",
    area: "billing",
    title:
      "A renewal that fails is retried and enters grace (still playing), suspends when grace runs out (playback refused), and recovers with a new card (playback returns)",
    needs: [needs.fakePayments],
    timeoutMs: 180_000,
    async run(ctx: CheckContext) {
      const account = await ctx.env.bareHolder("dunning");
      const agent = account.agent;
      const title = await movie(ctx.env);
      // Saved fine, declined whenever it is charged later (packages/payments-fake).
      const subscribed = await subscribe(ctx, agent, {
        planId: "basic",
        card: labelledCard("charge-declined", ctx.options.runId, "dunning"),
      });
      const renewalAt = subscribed.membership.trialEndsAt ?? subscribed.membership.currentPeriodEnd;
      check(renewalAt, "no renewal date");
      await advancePast(agent, renewalAt, RENEWAL_SETTLE_SEC, "the renewal");
      const failing = await succeeds(
        () => agent.api.getAccount(),
        "GET /account after the renewal",
      );
      equal(failing.membership?.status, "past_due", "membership after a failed renewal");
      const graceEndsAt = failing.membership?.graceEndsAt ?? null;
      check(graceEndsAt, "past_due without graceEndsAt");
      equal(failing.entitlement?.entitled, true, "entitled during grace");
      equal(failing.entitlement?.until, graceEndsAt, "entitled until grace ends");
      const graceSec = (Date.parse(graceEndsAt) - Date.parse(renewalAt)) / 1000;
      ctx.note(`grace: ${Math.round(graceSec)} s after the renewal (WEBFLIX_BILLING_GRACE_SEC)`);
      await playsOnce(agent, title.id, "playback during grace");
      const [open] = await invoices(agent, "after the failed renewal");
      equal(open?.status, "open", "the renewal invoice stays open");
      check((open?.amountDue.amountMinor ?? 0) > 0, "the open invoice owes nothing");
      if ((await ctx.env.mailbox()).available) {
        await awaitMail(ctx, agent, account.email, "payment-failed");
      }
      // The provider retries (3, 5 and 8 days after the first failure); one retry fails again.
      if (graceSec > 3 * 86_400 + 7_200) {
        await succeeds(
          () => agent.api.advanceBillingClock({ body: { seconds: 3 * 86_400 + 3_600 } }),
          "the first retry",
        );
        equal(
          (await membership(agent, "after a failed retry")).status,
          "past_due",
          "after a retry",
        );
      }
      await advancePast(agent, graceEndsAt, 60, "the end of grace");
      const suspended = await succeeds(() => agent.api.getAccount(), "GET /account after grace");
      equal(suspended.membership?.status, "suspended", "membership after grace");
      equal(suspended.membership?.suspendedReason, "grace_expired", "suspendedReason");
      equal(suspended.entitlement?.reason, "suspended", "entitlement.reason");
      await refusedPlayback(agent, title.id, "suspended", "playback while suspended");
      await rejects(
        () => agent.api.startCheckout({ body: { planId: "basic" } }),
        "checkout_state_conflict",
        "a new checkout while suspended (it recovers with a new card)",
      );

      const setup = await succeeds(
        () => agent.api.setupPaymentMethod(),
        "POST /billing/payment-method/setup",
      );
      check(setup.clientSecret, "the card setup carries no client secret");
      await confirmCard(agent, setup.clientSecret, "visa", "the new card");
      await ctx.eventually("the card replacement completes", async () => {
        const current = await succeeds(
          () => agent.api.getPaymentMethodSetup({ params: { id: setup.id } }),
          "GET /billing/payment-method/setup/:id",
        );
        return current.status === "succeeded"
          ? { done: true, value: current }
          : { done: false, observed: current.status };
      });
      const recovered = await ctx.eventually("the membership recovers", async () => {
        const current = await succeeds(() => agent.api.getAccount(), "GET /account");
        return current.membership?.status === "active"
          ? { done: true, value: current }
          : { done: false, observed: JSON.stringify(current.membership) };
      });
      equal(recovered.value.entitlement?.entitled, true, "entitled after recovery");
      equal(recovered.value.paymentMethod?.last4, "4242", "the new card is the default");
      const [settled] = await invoices(agent, "after recovery");
      equal(settled?.status, "paid", "the open invoice was paid");
      await playsOnce(agent, title.id, "playback after recovery");
    },
  },
  {
    id: "billing.provider-events",
    area: "billing",
    title:
      "Provider events: unsigned ones are refused; delivered twice and out of order they leave the membership the provider has and send each email once; during an outage the journey still completes",
    needs: [needs.fakePayments],
    tags: ["exclusive"],
    timeoutMs: 180_000,
    async run(ctx: CheckContext) {
      const env = ctx.env;
      const anonymous = ctx.agent("webhooks");
      const forged = await anonymous.fetch(`${API}/webhooks/payments/fake`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=00" },
        body: JSON.stringify({ id: `evt_smoke_${ctx.options.runId}`, type: "invoice.paid" }),
      });
      problem(forged, "webhook_signature_invalid", "an event with a forged signature");
      const unsigned = await anonymous.fetch(`${API}/webhooks/payments/fake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: `evt_smoke_${ctx.options.runId}`, type: "invoice.paid" }),
      });
      problem(unsigned, "webhook_signature_invalid", "an unsigned event");

      // The delivery policy is the deployment's: restore it whatever happens (exclusive check).
      const original = await deliveryPolicy(anonymous);
      env.onDispose(() => setDeliveryPolicy(env.agent("webhooks-restore"), original));
      try {
        await setDeliveryPolicy(anonymous, {
          mode: "unruly",
          duplicateRate: 1,
          maxDelayMs: 1_500,
          seed: 4_826,
        });
        const unruly = await env.bareHolder("webhooks-unruly");
        const agent = unruly.agent;
        await paidMembership(ctx, agent, { planId: "standard", card: await spentCard(ctx) });
        const preview = await succeeds(
          () => agent.api.previewPlanChange({ body: { planId: "premium" } }),
          "preview the upgrade",
        );
        await succeeds(
          () =>
            agent.api.changePlan({
              body: { planId: "premium", previewToken: preview.previewToken },
            }),
          "upgrade",
        );
        await succeeds(() => agent.api.cancelMembership(), "cancel");
        await succeeds(() => agent.api.resumeMembership(), "resume");
        await ctx.eventually("every delayed and duplicated delivery is made", async () => {
          const pump = await deliverPending(anonymous);
          return pump.pending === 0
            ? { done: true, value: pump }
            : { done: false, observed: `${pump.pending} pending` };
        });
        // Late and repeated events must not roll the projection back to an earlier state.
        const settled = await membership(agent, "after unruly delivery");
        equal(settled.status, "active", "status after unruly delivery");
        equal(settled.planId, "premium", "plan after unruly delivery");
        equal(settled.cancelAtPeriodEnd, false, "cancelAtPeriodEnd after cancel and resume");
        if ((await env.mailbox()).available) {
          const paidInvoices = (await invoices(agent, "after unruly delivery")).filter(
            (invoice) => invoice.amountPaid.amountMinor > 0,
          );
          await awaitMail(ctx, agent, unruly.email, "receipt", { count: paidInvoices.length });
          await awaitMail(ctx, agent, unruly.email, "plan-changed");
          const box = await mailboxNow(agent, unruly.email);
          const receipts = box.filter((message) => message.template === "receipt").length;
          const planChanged = box.filter((message) => message.template === "plan-changed").length;
          equal(
            receipts,
            paidInvoices.length,
            "receipts (one per paid invoice, events delivered twice)",
          );
          equal(planChanged, 1, "plan-changed emails (events delivered twice)");
        }

        await setDeliveryPolicy(anonymous, { mode: "outage" });
        const outage = await env.bareHolder("webhooks-outage");
        const subscribed = await subscribe(ctx, outage.agent, { planId: "basic", card: "visa" });
        check(
          ["trialing", "active"].includes(subscribed.membership.status),
          "the checkout did not complete during an outage (the projection waits on webhooks)",
          { observed: JSON.stringify(subscribed.membership) },
        );
        await playsOnce(outage.agent, (await movie(env)).id, "playback during an outage");
        const setup = await succeeds(
          () => outage.agent.api.setupPaymentMethod(),
          "replace the card during an outage",
        );
        check(setup.clientSecret, "no client secret");
        await confirmCard(outage.agent, setup.clientSecret, "mastercard", "the new card");
        await ctx.eventually("the card replacement completes without its event", async () => {
          const current = await succeeds(
            () => outage.agent.api.getPaymentMethodSetup({ params: { id: setup.id } }),
            "GET /billing/payment-method/setup/:id",
          );
          return current.status === "succeeded"
            ? { done: true, value: current }
            : { done: false, observed: current.status };
        });
        const during = await succeeds(() => outage.agent.api.getAccount(), "GET /account");
        equal(during.paymentMethod?.last4, "4444", "the replaced card during the outage");
        await setDeliveryPolicy(
          anonymous,
          original.mode === "outage" ? { mode: "orderly" } : original,
        );
        const after = await deliverPending(anonymous);
        equal(after.pending, 0, "deliveries queued by the outage (none: it delivers nothing)");
        const recovered = await membership(outage.agent, "after the outage");
        equal(recovered.status, subscribed.membership.status, "membership after the outage");
        equal(recovered.planId, "basic", "plan after the outage");
      } finally {
        await setDeliveryPolicy(env.agent("webhooks-restore"), original).catch(() => undefined);
      }
    },
  },
];

/** Exported for the staff checks: a member with a paid invoice. */
export async function memberWithPaidInvoice(
  ctx: CheckContext,
  tag: string,
): Promise<{ account: TestAccount; invoice: Invoice }> {
  const account = await ctx.env.bareHolder(tag);
  await paidMembership(ctx, account.agent, { planId: "standard", card: await spentCard(ctx) });
  const paid = (await invoices(account.agent, "paid invoices")).find(
    (invoice) => invoice.amountPaid.amountMinor > 0 && invoice.amountRefunded.amountMinor === 0,
  );
  if (!paid) fail("the member has no paid invoice");
  return { account, invoice: paid };
}
