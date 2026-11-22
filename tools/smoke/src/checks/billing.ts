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
import type { Agent } from "../http.ts";
import { awaitMail, mailboxNow } from "../mail.ts";
import { needs } from "../needs.ts";
import { federatedSignIn } from "../oidc.ts";
import {
  advancePast,
  awaitCheckout,
  confirmAtProvider,
  confirmCard,
  convertTrial,
  deliverPending,
  deliveryPolicy,
  type FakeCard,
  paidMembership,
  playsOnce,
  RENEWAL_SETTLE_SEC,
  setDeliveryPolicy,
  startPlayback,
  subscribe,
} from "../payments.ts";
import type { CheckContext, CheckDefinition } from "../types.ts";
import { API, CSRF } from "./util.ts";

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

const TRIAL_CARDS_CONVERTS: FakeCard[] = ["mastercard", "visa", "challenge"];
const TRIAL_CARDS_CANCELLED: FakeCard[] = [
  "charge-declined",
  "mastercard",
  "visa",
  "challenge",
  "authentication-required",
];

/**
 * A running trial (§5.4: one per account and per card fingerprint, deployment-wide). Cards are
 * tried in turn on one account: a card whose trial is spent leaves an unpaid first invoice,
 * which a checkout for another plan abandons, so the account stays eligible for the next.
 */
async function trialMembership(
  ctx: CheckContext,
  account: TestAccount,
  cards: readonly FakeCard[],
): Promise<{ card: FakeCard; checkout: Checkout; membership: MembershipState; planId: PlanId }> {
  const plans: PlanId[] = ["standard", "basic"];
  const spent: string[] = [];
  for (const [index, card] of cards.entries()) {
    const planId = plans[index % 2] ?? "standard";
    const started = await succeeds(
      () => account.agent.api.startCheckout({ body: { planId } }),
      `checkout (${planId}) for a trial with ${card}`,
    );
    check(started.clientSecret, "a new checkout carries no client secret");
    await confirmCard(account.agent, started.clientSecret, card, `trial card ${card}`);
    const confirmed = await succeeds(
      () => account.agent.api.confirmCheckout({ params: { id: started.id } }),
      `confirm the checkout with ${card}`,
    );
    if (confirmed.trial) {
      const checkout =
        confirmed.status === "complete"
          ? confirmed
          : await awaitCheckout(ctx, account.agent, started.id, `trial with ${card}`);
      if (spent.length > 0)
        ctx.note(`test cards whose trial was already spent: ${spent.join(", ")}`);
      return { card, checkout, membership: await membership(account.agent, "trial"), planId };
    }
    equal(confirmed.status, "requires_payment", `a checkout with ${card} and no trial`);
    spent.push(card);
  }
  ctx.skip(
    `no trial left on this deployment for the test cards ${cards.join(", ")}: one trial per card fingerprint (§5.4) and the fake provider gives every customer the same fingerprint per test card, so each card grants one trial per deployment (finding M2-F2). Trial journeys need a deployment whose cards have not had one (a fresh database)`,
  );
}

/**
 * A new account whose checkout stopped at its first payment (no trial: the checkout's card had
 * spent its trial on this deployment). Each card is tried on a fresh account, because a granted
 * trial is a membership.
 */
async function firstPaymentPending(
  ctx: CheckContext,
  tag: string,
): Promise<{ account: TestAccount; checkout: Checkout }> {
  for (const card of ["visa", "mastercard", "challenge"] as const) {
    const account = await ctx.env.bareHolder(`${tag}-${card}`);
    const agent = account.agent;
    const started = await succeeds(
      () => agent.api.startCheckout({ body: { planId: "basic" } }),
      "POST /billing/checkout (basic)",
    );
    check(started.clientSecret, "no client secret");
    await confirmCard(agent, started.clientSecret, card, `card ${card}`);
    const confirmed = await succeeds(
      () => agent.api.confirmCheckout({ params: { id: started.id } }),
      "confirm the checkout",
    );
    if (confirmed.trial) continue;
    equal(confirmed.status, "requires_payment", "a checkout without a trial");
    equal(
      (await membership(agent, "awaiting the first payment")).status,
      "incomplete",
      "status awaiting the first payment",
    );
    return { account, checkout: confirmed };
  }
  ctx.skip(
    "every card tried (visa, mastercard, challenge) still had its trial on this deployment, so no checkout stopped at a first payment (one trial per card, finding M2-F2); this runs once those trials are spent",
  );
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
    id: "billing.checkout",
    area: "billing",
    title:
      "An account without a membership is refused playback, checks out through the provider's form, pays (at once, or when its trial converts), becomes entitled and plays",
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
      await confirmCard(agent, started.clientSecret, "visa", "card");
      const confirmed = await succeeds(
        () => agent.api.confirmCheckout({ params: { id: started.id } }),
        "POST /billing/checkout/:id/confirm",
      );
      const standard = await price(agent, "standard");
      if (confirmed.trial) {
        equal(confirmed.trial.days, 7, "trial days");
        equal(confirmed.amountDue?.amountMinor, 0, "amount due with a trial");
      } else {
        equal(confirmed.status, "requires_payment", "status without a trial");
        equal(confirmed.amountDue?.amountMinor, standard, "first payment amount");
        check(confirmed.clientSecret, "requires_payment without a client secret");
        await confirmCard(agent, confirmed.clientSecret, undefined, "first payment");
      }
      const checkout = await awaitCheckout(ctx, agent, started.id, "checkout");
      const after = await succeeds(() => agent.api.getAccount(), "GET /account after checkout");
      equal(after.membership?.status, checkout.trial ? "trialing" : "active", "membership.status");
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

      if (checkout.trial && after.membership) {
        ctx.note("the checkout granted the trial: paid when it converts");
        await convertTrial(agent, after.membership);
        equal(
          (await membership(agent, "after the trial")).status,
          "active",
          "status after the trial",
        );
      }
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
    knownFinding: {
      id: "M2-F3",
      owner: "billing",
      summary:
        "an abandoned unpaid first subscription projects to `canceled` (entitlement `ended`) instead of `none` (`no_membership`)",
    },
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
    knownFinding: {
      id: "M2-F4",
      owner: "billing",
      summary:
        "after an expired first payment the membership is `none` but keeps `planId`, `provider` and `currentPeriodEnd` (the contract: null while `none`)",
    },
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
      "A promo code is quoted before it is applied, and the first invoice charges the discounted price",
    needs: [
      needs.fakePayments,
      {
        id: "promo-code",
        async evaluate(env) {
          return env.options.promoCode
            ? null
            : "no promo code known to the suite (pass --promo-code CODE: a code valid for the Standard plan). A deployment with the fake provider has none: codes exist only in process (FakePaymentProvider.definePromotion) and no route, seed or setting creates one (finding M2-F1)";
        },
      },
    ],
    async run(ctx: CheckContext) {
      const code = ctx.options.promoCode ?? "";
      const account = await ctx.env.bareHolder("promo");
      const agent = account.agent;
      const quote = await succeeds(
        () => agent.api.validatePromotion({ body: { code, planId: "standard" } }),
        "POST /billing/promotions/validate",
      );
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
      const subscribed = await subscribe(ctx, agent, {
        planId: "standard",
        card: "visa",
        promotionCode: code,
      });
      equal(subscribed.checkout.promotion?.code, quote.promotion.code, "checkout promotion");
      if (subscribed.trial) await convertTrial(agent, subscribed.membership);
      const charged = (await invoices(agent, "after the promo checkout")).find(
        (invoice) => invoice.amountPaid.amountMinor > 0,
      );
      check(charged, "no paid invoice");
      equal(charged.amountPaid.amountMinor, quote.discountedPrice.amountMinor, "charged as quoted");
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
      const trial = await trialMembership(ctx, account, TRIAL_CARDS_CONVERTS);
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
      const trial = await trialMembership(ctx, account, TRIAL_CARDS_CANCELLED);
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
      await paidMembership(ctx, agent, { planId: "standard", card: "visa" });
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
      const paid = await paidMembership(ctx, agent, { planId: "standard", card: "visa" });
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
      const restarted = await subscribe(ctx, agent, { planId: "standard", card: "visa" });
      equal(restarted.trial, false, "a second trial for the same account");
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
      const subscribed = await subscribe(ctx, agent, { planId: "basic", card: "charge-declined" });
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
        await paidMembership(ctx, agent, { planId: "standard", card: "visa" });
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
  await paidMembership(ctx, account.agent, { planId: "standard", card: "visa" });
  const paid = (await invoices(account.agent, "paid invoices")).find(
    (invoice) => invoice.amountPaid.amountMinor > 0 && invoice.amountRefunded.amountMinor === 0,
  );
  if (!paid) fail("the member has no paid invoice");
  return { account, invoice: paid };
}
