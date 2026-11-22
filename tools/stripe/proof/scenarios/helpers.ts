import type Stripe from "stripe";
import { browserConfirm } from "../client.ts";
import { forCustomer, type Scenario } from "../context.ts";

export const CURRENCIES = ["usd", "eur"] as const;
export type Currency = (typeof CURRENCIES)[number];
export type PlanKey = "basic" | "standard" | "premium";

/**
 * The milestone 1 plans (packages/core/src/domain/plans.ts) with a EUR price added for the
 * proof. In Webflix these rows are admin-managed data (blueprint §5.4); here they are constants.
 */
export const PLANS: ReadonlyArray<{
  plan: PlanKey;
  name: string;
  amounts: Record<Currency, number>;
}> = [
  { plan: "basic", name: "Webflix Basic", amounts: { usd: 799, eur: 799 } },
  { plan: "standard", name: "Webflix Standard", amounts: { usd: 1299, eur: 1299 } },
  { plan: "premium", name: "Webflix Premium", amounts: { usd: 1899, eur: 1899 } },
];

export function lookupKey(plan: PlanKey, currency: Currency): string {
  return `webflix.${plan}.monthly.${currency}`;
}

export function productId(plan: PlanKey): string {
  return `webflix_${plan}`;
}

/** Resolve plan prices by lookup key (one list call). */
export async function priceIds(stripe: Stripe): Promise<Record<string, string>> {
  const keys = PLANS.flatMap((p) => CURRENCIES.map((c) => lookupKey(p.plan, c)));
  const prices = await stripe.prices.list({ lookup_keys: keys, limit: 100 });
  const out: Record<string, string> = {};
  for (const price of prices.data) if (price.lookup_key) out[price.lookup_key] = price.id;
  for (const key of keys)
    if (!out[key]) throw new Error(`Price ${key} missing: run the catalogue scenario first.`);
  return out;
}

export async function createCustomer(
  s: Scenario,
  timeline: { customerParams(): { test_clock?: string } } | null,
  label: string,
): Promise<Stripe.Customer> {
  const customer = await s.stripe.customers.create({
    email: `${s.name}-${label}@example.test`,
    description: `webflix proof ${s.runId} ${s.name} ${label}`,
    metadata: { webflix_proof_run: s.runId, scenario: s.name, member: label },
    ...(timeline?.customerParams() ?? {}),
  });
  s.own(customer.id);
  s.record(`customer created (${label})`, customer);
  return customer;
}

export function intentIdFromClientSecret(secret: string): string {
  const id = secret.split("_secret_")[0];
  if (!id) throw new Error("Malformed client secret");
  return id;
}

/** Subscribe with no trial and pay the first invoice the way the browser would. */
export async function subscribePaid(
  s: Scenario,
  customer: Stripe.Customer,
  price: string,
  paymentMethod: string,
  label: string,
): Promise<{
  subscription: Stripe.Subscription;
  confirm: { status: number; body: Record<string, unknown> };
}> {
  const subscription = await s.stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price }],
    payment_behavior: "default_incomplete",
    payment_settings: { save_default_payment_method: "on_subscription" },
    expand: ["latest_invoice.confirmation_secret", "pending_setup_intent"],
    metadata: { webflix_proof_run: s.runId },
  });
  s.own(subscription.id);
  s.record(`subscription created, default_incomplete (${label})`, subscription);
  const invoice = subscription.latest_invoice as Stripe.Invoice;
  s.own(invoice.id);
  const secret = invoice.confirmation_secret?.client_secret;
  if (!secret) throw new Error("First invoice has no confirmation_secret");
  const intentId = intentIdFromClientSecret(secret);
  s.own(intentId);
  const confirm = await browserConfirm(
    s.publishableKey,
    "payment_intents",
    intentId,
    secret,
    paymentMethod,
  );
  s.responses.push({
    step: s.currentStep,
    label: `browser confirms first payment with ${paymentMethod} (${label})`,
    at: new Date().toISOString(),
    status: confirm.status,
    body: confirm.body,
  });
  return { subscription, confirm };
}

/**
 * Subscribe with a trial (7 days on a test clock, seconds in real time: `Timeline.trialParams`);
 * the card is collected up front through `pending_setup_intent`, confirmed by the browser.
 */
export async function subscribeTrial(
  s: Scenario,
  customer: Stripe.Customer,
  price: string,
  paymentMethod: string | null,
  label: string,
  trial: { trial_period_days: number } | { trial_end: number } = { trial_period_days: 7 },
): Promise<Stripe.Subscription> {
  const subscription = await s.stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price }],
    ...trial,
    payment_behavior: "default_incomplete",
    payment_settings: { save_default_payment_method: "on_subscription" },
    trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
    expand: ["latest_invoice.confirmation_secret", "pending_setup_intent"],
    metadata: { webflix_proof_run: s.runId },
  });
  s.own(subscription.id);
  s.record(`trial subscription created (${label})`, subscription);
  const setupIntent = subscription.pending_setup_intent as Stripe.SetupIntent | null;
  if (setupIntent) s.own(setupIntent.id);
  if (paymentMethod && setupIntent?.client_secret) {
    const confirm = await browserConfirm(
      s.publishableKey,
      "setup_intents",
      setupIntent.id,
      setupIntent.client_secret,
      paymentMethod,
    );
    s.responses.push({
      step: s.currentStep,
      label: `browser confirms pending_setup_intent with ${paymentMethod} (${label})`,
      at: new Date().toISOString(),
      status: confirm.status,
      body: confirm.body,
    });
  }
  return subscription;
}

/** Collect a new card through a SetupIntent confirmed by the browser; returns the PaymentMethod id. */
export async function collectCard(
  s: Scenario,
  customer: Stripe.Customer,
  paymentMethod: string,
  label: string,
): Promise<string> {
  const setupIntent = await s.stripe.setupIntents.create({
    customer: customer.id,
    usage: "off_session",
  });
  s.own(setupIntent.id);
  if (!setupIntent.client_secret) throw new Error("SetupIntent without client_secret");
  const confirm = await browserConfirm(
    s.publishableKey,
    "setup_intents",
    setupIntent.id,
    setupIntent.client_secret,
    paymentMethod,
  );
  s.responses.push({
    step: s.currentStep,
    label: `browser confirms SetupIntent with ${paymentMethod} (${label})`,
    at: new Date().toISOString(),
    status: confirm.status,
    body: confirm.body,
  });
  const done = await s.stripe.setupIntents.retrieve(setupIntent.id);
  const pm =
    typeof done.payment_method === "string" ? done.payment_method : done.payment_method?.id;
  if (done.status !== "succeeded" || !pm)
    throw new Error(`SetupIntent ${done.status} for ${paymentMethod}`);
  s.own(pm);
  return pm;
}

/** Wait for the subscription to become active, counting only deliveries from `since` on. */
export async function waitActive(
  s: Scenario,
  customer: Stripe.Customer,
  why: string,
  since?: number,
): Promise<void> {
  await s.waitForEvent(
    "customer.subscription.updated",
    (o) => forCustomer(customer.id)(o) && o.status === "active",
    120_000,
    since,
  );
  s.observe(`${why}: customer.subscription.updated with status active received`, true);
}

export function periodEnd(subscription: Stripe.Subscription): number {
  const end = subscription.items.data[0]?.current_period_end;
  if (!end) throw new Error("Subscription item without current_period_end");
  return end;
}

/** The PaymentIntent behind a paid invoice (API 2025-03-31+: through invoice payments). */
export async function invoicePaymentIntent(s: Scenario, invoiceId: string): Promise<string> {
  const payments = await s.stripe.invoicePayments.list({ invoice: invoiceId, limit: 10 });
  s.record(`invoice payments of ${invoiceId}`, payments);
  const paid = payments.data.find((p) => p.status === "paid") ?? payments.data[0];
  const pi = paid?.payment.payment_intent;
  const id = typeof pi === "string" ? pi : pi?.id;
  if (!id) throw new Error(`No PaymentIntent for invoice ${invoiceId}`);
  s.own(id);
  return id;
}

export function summariseSubscription(sub: Stripe.Subscription): Record<string, unknown> {
  return {
    status: sub.status,
    cancel_at_period_end: sub.cancel_at_period_end,
    cancel_at: sub.cancel_at,
    canceled_at: sub.canceled_at,
    ended_at: sub.ended_at,
    trial_end: sub.trial_end,
    current_period_end: sub.items.data[0]?.current_period_end ?? null,
    default_payment_method: sub.default_payment_method === null ? null : "set",
    billing_mode:
      (sub as unknown as { billing_mode?: { type?: string } }).billing_mode?.type ?? null,
  };
}
