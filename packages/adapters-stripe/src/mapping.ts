import type {
  PaymentFailureCode,
  ProviderEvent,
  ProviderInvoice,
  ProviderPaymentMethod,
  ProviderSetup,
  ProviderSubscription,
  ProviderSubscriptionStatus,
} from "@webflix/core";
import { mapStripeError, type StripeObject } from "./client.ts";

/**
 * Stripe objects (API 2026-11-18.endive, docs/STRIPE.md §14) → the port's provider-neutral
 * shapes: ids and plain data only, so the result survives structured cloning (queue payloads,
 * Durable Object storage; the SDK's `Decimal` hazard cannot happen here: no SDK).
 */

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const obj = (value: unknown): StripeObject | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as StripeObject)
    : null;
/** Stripe times are whole seconds. */
export const ms = (seconds: unknown): number | null => {
  const value = num(seconds);
  return value === null ? null : value * 1000;
};
/** An expandable field: the id whether it came as a string or as an expanded object. */
export const idOf = (value: unknown): string | null => str(value) ?? str(obj(value)?.id);

export function list(value: unknown): StripeObject[] {
  const data = obj(value)?.data;
  return Array.isArray(data)
    ? data.flatMap((item) => (obj(item) ? [item as StripeObject] : []))
    : [];
}

const SUBSCRIPTION_STATUSES: readonly ProviderSubscriptionStatus[] = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "paused",
  "canceled",
];

export function toPaymentMethod(value: unknown): ProviderPaymentMethod | null {
  const method = obj(value);
  if (!method) return null;
  const card = obj(method.card);
  const id = str(method.id);
  if (!id || !card) return null;
  return {
    id,
    brand: str(card.brand) ?? "other",
    last4: str(card.last4) ?? "0000",
    expMonth: num(card.exp_month) ?? 1,
    expYear: num(card.exp_year) ?? 1970,
    fingerprint: str(card.fingerprint),
    wallet: str(obj(card.wallet)?.type),
  };
}

/**
 * A subscription. The period sits on its items since basil; the first payment's client secret
 * is the latest invoice's `confirmation_secret` (expanded), never `invoice.payment_intent`.
 */
export function toSubscription(value: StripeObject, clockNow: number | null): ProviderSubscription {
  const item = list(value.items)[0] ?? {};
  const price = obj(item.price);
  const status = str(value.status) as ProviderSubscriptionStatus;
  const invoice = obj(value.latest_invoice);
  const confirmation = obj(invoice?.confirmation_secret);
  const invoiceOpen = str(invoice?.status) === "open";
  return {
    id: str(value.id) ?? "",
    customerId: idOf(value.customer) ?? "",
    status: SUBSCRIPTION_STATUSES.includes(status) ? status : "incomplete",
    priceLookupKey: str(price?.lookup_key) ?? str(price?.id) ?? "",
    cancelAtPeriodEnd: value.cancel_at_period_end === true,
    trialEnd: ms(value.trial_end),
    currentPeriodStart: ms(item.current_period_start) ?? ms(value.current_period_start),
    currentPeriodEnd: ms(item.current_period_end) ?? ms(value.current_period_end),
    endedAt: ms(value.ended_at),
    latestInvoiceId: idOf(value.latest_invoice),
    defaultPaymentMethodId: idOf(value.default_payment_method),
    defaultPaymentMethod: toPaymentMethod(value.default_payment_method),
    paymentClientSecret: invoiceOpen ? str(confirmation?.client_secret) : null,
    clockNow,
  };
}

const BILLING_REASONS = ["subscription_create", "subscription_cycle", "subscription_update"];

/** An invoice's (or a preview's) discounts: the sum of `total_discount_amounts`. */
export function discountOf(value: StripeObject): number {
  return list(value.total_discount_amounts).reduce(
    (sum, entry) => sum + (num(entry.amount) ?? 0),
    0,
  );
}

/**
 * The customer credit an invoice (or a preview) uses: `total - amount_due`, bounded by the
 * credit the customer had (`starting_balance` < 0), so a total below Stripe's minimum charge
 * (also answered with `amount_due` 0) is never reported as credit.
 */
export function creditAppliedOf(value: StripeObject): number {
  const total = num(value.total) ?? 0;
  const due = num(value.amount_due) ?? total;
  const available = Math.max(0, -(num(value.starting_balance) ?? 0));
  return total > 0 ? Math.min(Math.max(0, total - due), available) : 0;
}

export function toInvoice(value: StripeObject, amountRefundedMinor: number): ProviderInvoice {
  const parent = obj(value.parent);
  const details = obj(parent?.subscription_details);
  const line = list(value.lines)[0];
  const period = obj(line?.period);
  const transitions = obj(value.status_transitions);
  const reason = str(value.billing_reason) ?? "other";
  return {
    id: str(value.id) ?? "",
    customerId: idOf(value.customer) ?? "",
    subscriptionId: idOf(details?.subscription) ?? idOf(value.subscription),
    number: str(value.number),
    status: (str(value.status) ?? "draft") as ProviderInvoice["status"],
    currency: (str(value.currency) ?? "usd").toUpperCase(),
    totalMinor: num(value.total) ?? 0,
    amountPaidMinor: num(value.amount_paid) ?? 0,
    amountDueMinor: num(value.amount_remaining) ?? num(value.amount_due) ?? 0,
    amountRefundedMinor,
    billingReason: (BILLING_REASONS.includes(reason)
      ? reason
      : "other") as ProviderInvoice["billingReason"],
    periodStart: ms(period?.start) ?? ms(value.period_start),
    periodEnd: ms(period?.end) ?? ms(value.period_end),
    createdAt: ms(value.created) ?? 0,
    paidAt: ms(transitions?.paid_at),
    attemptCount: num(value.attempt_count) ?? 0,
    nextPaymentAttempt: ms(value.next_payment_attempt),
    hostedUrl: str(value.hosted_invoice_url),
    pdfUrl: str(value.invoice_pdf),
    discountMinor: discountOf(value),
    creditAppliedMinor: creditAppliedOf(value),
  };
}

/**
 * A SetupIntent. A declined card returns it to `requires_payment_method` with
 * `last_setup_error`: for the port that setup has failed (a new card means a new setup).
 */
export function toSetup(value: StripeObject): ProviderSetup {
  const status = str(value.status);
  const error = obj(value.last_setup_error);
  const failed = status === "canceled" || (status === "requires_payment_method" && error !== null);
  const failureCode: PaymentFailureCode | null = failed
    ? error
      ? mapStripeError(402, error)
      : "card_declined"
    : null;
  return {
    id: str(value.id) ?? "",
    customerId: idOf(value.customer) ?? "",
    status:
      status === "succeeded"
        ? "succeeded"
        : status === "processing"
          ? "processing"
          : failed
            ? "failed"
            : "requires_confirmation",
    clientSecret:
      status === "succeeded" || failed || status === "processing" ? null : str(value.client_secret),
    paymentMethod: status === "succeeded" ? toPaymentMethod(value.payment_method) : null,
    failureCode,
  };
}

/**
 * A verified event as the port's `ProviderEvent`: the ids its object refers to, by object type
 * (docs/STRIPE.md §10), and the idempotency key of the call that caused it. Nothing of the
 * object's state is carried: processing reads the current object again (§11).
 */
export function toEvent(value: unknown): ProviderEvent | null {
  const event = obj(value);
  const id = str(event?.id);
  const type = str(event?.type);
  if (!event || !id || !type) return null;
  const object = obj(obj(event.data)?.object) ?? {};
  const kind = str(object.object);
  const objectId = str(object.id);
  let customerId: string | null = idOf(object.customer);
  let subscriptionId: string | null = null;
  let invoiceId: string | null = null;
  let setupId: string | null = null;
  switch (kind) {
    case "customer":
      customerId = objectId;
      break;
    case "subscription":
      subscriptionId = objectId;
      break;
    case "invoice": {
      invoiceId = objectId;
      const details = obj(obj(object.parent)?.subscription_details);
      subscriptionId = idOf(details?.subscription) ?? idOf(object.subscription);
      break;
    }
    case "invoice_payment":
      invoiceId = idOf(object.invoice);
      break;
    case "setup_intent":
      setupId = objectId;
      break;
    default:
      break;
  }
  const created = ms(event.created) ?? 0;
  return {
    id,
    type,
    createdAt: created,
    // Real time here: test clocks (a full key only) are not verified (docs/STRIPE.md §12).
    occurredAt: created,
    customerId,
    subscriptionId,
    invoiceId,
    setupId,
    idempotencyKey: str(obj(event.request)?.idempotency_key),
  };
}
