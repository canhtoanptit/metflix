import type Stripe from "stripe";
import { browserConfirm } from "../client.ts";
import { DAY, HOUR } from "../clock.ts";
import { forCustomer, type Scenario } from "../context.ts";
import { createTimeline } from "../timeline.ts";
import {
  createCustomer,
  intentIdFromClientSecret,
  lookupKey,
  priceIds,
  subscribePaid,
  summariseSubscription,
  waitActive,
} from "./helpers.ts";

function nextActionShape(body: Record<string, unknown>): Record<string, unknown> {
  const action = body.next_action as
    | { type?: string; redirect_to_url?: { url?: string } }
    | undefined;
  const url = action?.redirect_to_url?.url;
  return {
    status: body.status,
    next_action: action?.type ?? null,
    redirect_host: url ? new URL(url).host : null,
  };
}

/**
 * Cards that need a challenge (blueprint §5.1 step 4, §12). The challenge itself runs inside
 * Stripe.js (the page at hooks.stripe.com only loads Stripe.js), so completing one needs a real
 * browser: the Playwright lane's job. Here: what the API and webhooks show while a challenge is
 * pending, what happens when the member gives up, and the off-session renewal case.
 */
export async function threeDSecure(s: Scenario): Promise<void> {
  const prices = await priceIds(s.stripe);
  const price = prices[lookupKey("basic", "usd")] as string;
  const time = await createTimeline(s, s.timeMode, "3ds");
  const start = await time.now();

  await s.step("first payment needs a challenge; member switches card", async () => {
    const member = await createCustomer(s, time, "challenge-then-other-card");
    const { subscription, confirm } = await subscribePaid(
      s,
      member,
      price,
      "pm_card_authenticationRequired",
      "challenge",
    );
    s.observe("confirm with 4000 0027 6000 3184", nextActionShape(confirm.body));
    const sub = await s.stripe.subscriptions.retrieve(subscription.id, {
      expand: ["latest_invoice.confirmation_secret"],
    });
    s.expect("subscription while the challenge is pending", sub.status, "incomplete");
    await s
      .waitForEvent("payment_intent.requires_action", forCustomer(member.id), 60_000)
      .catch(() => null);
    const secret = (sub.latest_invoice as Stripe.Invoice).confirmation_secret
      ?.client_secret as string;
    const retry = await browserConfirm(
      s.publishableKey,
      "payment_intents",
      intentIdFromClientSecret(secret),
      secret,
      "pm_card_visa",
    );
    s.responses.push({
      step: s.currentStep,
      label: "browser confirms the same intent with another card",
      at: new Date().toISOString(),
      status: retry.status,
      body: retry.body,
    });
    s.expect("second confirm", retry.body.status, "succeeded");
    await waitActive(s, member, "after switching card");
  });

  const abandoned = await s.step("first payment challenge abandoned", async () => {
    const member = await createCustomer(s, time, "abandons");
    const { subscription, confirm } = await subscribePaid(
      s,
      member,
      price,
      "pm_card_authenticationRequired",
      "abandons",
    );
    s.observe("confirm", nextActionShape(confirm.body));
    return { member, subscription };
  });

  const offSession = await s.step(
    "trial with a card that always needs authentication",
    async () => {
      const member = await createCustomer(s, time, "off-session");
      // Attached server-side: Stripe creates a SetupIntent for the attach, which waits for a
      // challenge nobody completes, but the card is attached and usable for off-session attempts.
      const pm = await s.stripe.paymentMethods.attach("pm_card_authenticationRequired", {
        customer: member.id,
      });
      s.own(pm.id);
      const subscription = await s.stripe.subscriptions.create({
        customer: member.id,
        items: [{ price }],
        ...time.trialParams(),
        default_payment_method: pm.id,
        metadata: { webflix_proof_run: s.runId },
      });
      s.own(subscription.id);
      s.record("trial subscription with a card that needs authentication", subscription);
      return { member, subscription };
    },
  );

  await s.step("abandoned first payment expires after 23 hours", async () => {
    const sub = await s.stripe.subscriptions.retrieve(abandoned.subscription.id, {
      expand: ["latest_invoice"],
    });
    s.observe("abandoned subscription before expiry", {
      status: sub.status,
      invoice: (sub.latest_invoice as Stripe.Invoice).status,
    });
    if (
      !time.requireClock(
        "incomplete subscription expires 23 hours after creation (incomplete_expired, invoice void)",
      )
    )
      return;
    const mark = s.mark();
    await time.advance(start + DAY + HOUR, "creation plus 25 hours");
    await s.waitForEvent(
      "customer.subscription.updated",
      (o) => forCustomer(abandoned.member.id)(o) && o.status === "incomplete_expired",
      240_000,
      mark,
    );
    const expired = await s.stripe.subscriptions.retrieve(abandoned.subscription.id, {
      expand: ["latest_invoice"],
    });
    s.record("abandoned subscription", expired);
    s.expect("abandoned subscription", expired.status, "incomplete_expired");
    s.expect("its first invoice", (expired.latest_invoice as Stripe.Invoice).status, "void");
  });

  await s.step("off-session renewal needs authentication", async () => {
    const mark = s.mark();
    const invoice = await time.endTrialAndCollect(offSession.subscription, offSession.member);
    await s.waitForEvent(
      "invoice.payment_action_required",
      (o) => o.id === invoice.id,
      180_000,
      mark,
    );
    s.observe("renewal invoice that needs action", {
      status: invoice.status,
      attempt_count: invoice.attempt_count,
      next_payment_attempt: invoice.next_payment_attempt,
    });
    await s.settle(4000);
    const sub = await s.stripe.subscriptions.retrieve(offSession.subscription.id);
    s.observe("subscription while authentication is required", summariseSubscription(sub));
    const withSecret = await s.stripe.invoices.retrieve(invoice.id, {
      expand: ["confirmation_secret"],
    });
    const secret = withSecret.confirmation_secret?.client_secret;
    if (!secret) throw new Error("No confirmation secret on the invoice that needs action");
    const intent = await s.stripe.paymentIntents.retrieve(intentIdFromClientSecret(secret));
    s.own(intent.id);
    s.observe("its PaymentIntent", {
      status: intent.status,
      last_error: intent.last_payment_error?.code ?? null,
    });
    // Recovery on-session: the member returns and pays with a card that needs no challenge.
    const recoveryMark = s.mark();
    const retry = await browserConfirm(
      s.publishableKey,
      "payment_intents",
      intent.id,
      secret,
      "pm_card_visa",
    );
    s.responses.push({
      step: s.currentStep,
      label: "member pays the invoice on-session with another card",
      at: new Date().toISOString(),
      status: retry.status,
      body: retry.body,
    });
    await s.waitForEvent("invoice.paid", (o) => o.id === invoice.id, 120_000, recoveryMark);
    await waitActive(s, offSession.member, "off-session recovery", recoveryMark).catch(() =>
      s.observe("no customer.subscription.updated to active after recovery", true),
    );
    const recovered = await s.stripe.subscriptions.retrieve(offSession.subscription.id);
    s.expect("subscription after the on-session payment", recovered.status, "active");
  });
}
