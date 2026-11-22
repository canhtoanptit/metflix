import type {
  INVOICE_STATUSES,
  PaymentProviderId,
  PROMOTION_FAILURE_REASONS,
} from "@webflix/contracts";

/**
 * Port: the payment provider (milestone 2 §3, §5), provider-neutral. Implemented by the Stripe
 * adapter (`packages/adapters-stripe`, docs/STRIPE.md is its reference) and the stateful fake
 * (`packages/payments-fake`); the same contract suite runs against both, which keeps the fake
 * honest. Amounts are integers in minor units with an ISO currency; times are epoch ms.
 *
 * Contract (`describePaymentProviderContract`), from what real Stripe does (docs/STRIPE.md):
 * - Every mutating call takes an idempotency key (`billingIdempotencyKey(operation, attempt)`):
 *   the same key and parameters replay the first outcome, a decline included; the same key with
 *   other parameters is `idempotency_conflict`. A new attempt (another card) needs a new key.
 * - The provider is the source of truth: `retrieveSubscription` and `retrieveInvoice` return
 *   its current state, and webhook processing always reads them, never an event's contents.
 * - A trial needs a confirmed payment method; the provider does not enforce one trial per card
 *   (Webflix does, with `fingerprint`), and the same card has the same fingerprint everywhere.
 * - A plan change applied with a preview's `prorationDate` is invoiced exactly as previewed.
 * - Refunds never change an invoice's status or the subscription.
 * - Promo codes are read before use (`validatePromotionCode`): the provider refuses exhausted
 *   and expired codes without saying which.
 * - `parseWebhook` verifies the signature over the exact raw bytes (Web Crypto) with a
 *   timestamp tolerance, and returns a normalised `ProviderEvent` that survives structured
 *   cloning (queue payloads never carry provider library objects).
 */
export interface PaymentProvider {
  readonly id: PaymentProviderId;

  createCustomer(
    input: { accountId: string; email: string },
    call: ProviderCall,
  ): Promise<{ id: string }>;

  /** A setup the browser confirms with the provider's form (card first: §5.4 two-step flow). */
  createSetup(input: { customerId: string }, call: ProviderCall): Promise<ProviderSetup>;
  retrieveSetup(setupId: string): Promise<ProviderSetup | null>;
  /** Makes a confirmed method the customer's (and subscription's) default. */
  setDefaultPaymentMethod(
    input: { customerId: string; paymentMethodId: string; subscriptionId: string | null },
    call: ProviderCall,
  ): Promise<void>;

  /**
   * With `trialDays`: `trialing`, nothing charged. Without: the first invoice is charged to
   * `paymentMethodId` if given; a decline or a required challenge leaves it `incomplete` with
   * `paymentClientSecret` for the browser to confirm.
   */
  createSubscription(
    input: {
      customerId: string;
      priceLookupKey: string;
      paymentMethodId: string | null;
      trialDays: number | null;
      promotionId: string | null;
    },
    call: ProviderCall,
  ): Promise<ProviderSubscription>;
  retrieveSubscription(subscriptionId: string): Promise<ProviderSubscription | null>;
  previewPlanChange(input: {
    subscriptionId: string;
    priceLookupKey: string;
    prorationDate: number;
  }): Promise<ProrationPreview>;
  /** Invoiced immediately (`always_invoice`); pass the preview's `prorationDate`. */
  changePlan(
    input: { subscriptionId: string; priceLookupKey: string; prorationDate: number },
    call: ProviderCall,
  ): Promise<ProviderSubscription>;
  setCancelAtPeriodEnd(
    input: { subscriptionId: string; cancelAtPeriodEnd: boolean },
    call: ProviderCall,
  ): Promise<ProviderSubscription>;
  cancelNow(input: { subscriptionId: string }, call: ProviderCall): Promise<ProviderSubscription>;

  retrieveInvoice(invoiceId: string): Promise<ProviderInvoice | null>;
  /** Newest first. */
  listInvoices(input: { customerId: string; limit: number }): Promise<ProviderInvoice[]>;
  /** An explicit attempt on an open invoice (a card change does not trigger one, §5.4). */
  payInvoice(input: { invoiceId: string }, call: ProviderCall): Promise<ProviderInvoice>;
  /** `amountMinor` null: what remains unrefunded. */
  refund(
    input: { invoiceId: string; amountMinor: number | null },
    call: ProviderCall,
  ): Promise<ProviderRefund>;

  validatePromotionCode(input: { code: string; priceLookupKey: string }): Promise<PromotionLookup>;

  /** Products and prices by lookup key, idempotently: a second pass writes nothing. */
  syncCatalogue(entries: readonly CatalogueEntry[]): Promise<CatalogueSyncResult>;

  /** Throws `WebhookSignatureError` unless the signature verifies over `rawBody`. */
  parseWebhook(rawBody: Uint8Array, signatureHeader: string | null): Promise<ProviderEvent>;
  /** Events created after `createdAfter`, oldest first (reconciliation after an outage). */
  listEvents(input: { createdAfter: number; limit: number }): Promise<ProviderEvent[]>;
}

export interface ProviderCall {
  /** ≤ 255 characters; derived from a Webflix operation id and its attempt number. */
  idempotencyKey: string;
}

export interface ProviderPaymentMethod {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  /** The same card has the same fingerprint for every customer; wallets may not (§5.4). */
  fingerprint: string | null;
  wallet: string | null;
}

export interface ProviderSetup {
  id: string;
  customerId: string;
  status: "requires_confirmation" | "processing" | "succeeded" | "failed";
  /** For the browser while `requires_confirmation`. */
  clientSecret: string | null;
  paymentMethod: ProviderPaymentMethod | null;
  failureCode: PaymentFailureCode | null;
}

export type ProviderSubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "unpaid"
  | "paused"
  | "canceled";

export interface ProviderSubscription {
  id: string;
  customerId: string;
  status: ProviderSubscriptionStatus;
  priceLookupKey: string;
  cancelAtPeriodEnd: boolean;
  trialEnd: number | null;
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  endedAt: number | null;
  latestInvoiceId: string | null;
  defaultPaymentMethodId: string | null;
  /** While the first payment awaits the browser's confirmation (or a challenge). */
  paymentClientSecret: string | null;
}

export type ProviderInvoiceStatus = (typeof INVOICE_STATUSES)[number];

export interface ProviderInvoice {
  id: string;
  customerId: string;
  subscriptionId: string | null;
  number: string | null;
  status: ProviderInvoiceStatus;
  currency: string;
  /** Negative for a credit (a downgrade). */
  totalMinor: number;
  amountPaidMinor: number;
  amountDueMinor: number;
  amountRefundedMinor: number;
  billingReason: "subscription_create" | "subscription_cycle" | "subscription_update" | "other";
  periodStart: number | null;
  periodEnd: number | null;
  createdAt: number;
  paidAt: number | null;
  attemptCount: number;
  /** When the provider will try again on its own; null: it will not (§5.2 grace). */
  nextPaymentAttempt: number | null;
  hostedUrl: string | null;
  pdfUrl: string | null;
}

export interface ProviderRefund {
  id: string;
  invoiceId: string;
  amountMinor: number;
  currency: string;
  status: "pending" | "succeeded" | "failed";
}

export interface ProrationPreview {
  currency: string;
  /** Charged when applied (0 when the change is a credit). */
  amountDueMinor: number;
  /** Credited to the customer when the change is a downgrade (0 otherwise). */
  creditMinor: number;
  lines: { description: string; amountMinor: number }[];
  prorationDate: number;
  nextRenewal: { at: number; amountMinor: number } | null;
}

export type PromotionFailureReason = (typeof PROMOTION_FAILURE_REASONS)[number];

export type PromotionLookup =
  | {
      valid: true;
      promotionId: string;
      code: string;
      percentOff: number | null;
      amountOffMinor: number | null;
      currency: string | null;
      duration: "once" | "repeating" | "forever";
      durationInMonths: number | null;
    }
  | { valid: false; reason: PromotionFailureReason };

export interface CatalogueEntry {
  /** `webflix.<plan>.monthly.<currency>`. */
  lookupKey: string;
  /** The provider product's id (`webflix_<plan>`): retrieving it is the idempotency check. */
  productId: string;
  productName: string;
  amountMinor: number;
  currency: string;
}

export interface CatalogueSyncResult {
  created: number;
  updated: number;
  archived: number;
  unchanged: number;
}

/** A provider event, normalised: ids and Webflix data only (§5.3). */
export interface ProviderEvent {
  id: string;
  /** The provider's type, e.g. `invoice.paid` (processing never infers state from it). */
  type: string;
  createdAt: number;
  customerId: string | null;
  subscriptionId: string | null;
  invoiceId: string | null;
  setupId: string | null;
  /** The idempotency key of the call that caused it; null for provider-initiated events. */
  idempotencyKey: string | null;
}

export const PAYMENT_FAILURE_CODES = [
  "card_declined",
  "insufficient_funds",
  "expired_card",
  "incorrect_cvc",
  "processing_error",
  "authentication_required",
  "idempotency_conflict",
  "not_found",
  "invalid_request",
  "rate_limited",
  "unavailable",
] as const;
export type PaymentFailureCode = (typeof PAYMENT_FAILURE_CODES)[number];

/** A refused provider call, mapped from the provider's own error (never its message). */
export class PaymentProviderError extends Error {
  override readonly name = "PaymentProviderError";
  readonly code: PaymentFailureCode;

  constructor(code: PaymentFailureCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? code, options);
    this.code = code;
  }

  /** Whether retrying the same call (same key) can succeed. */
  get retryable(): boolean {
    return this.code === "rate_limited" || this.code === "unavailable";
  }
}

export class WebhookSignatureError extends Error {
  override readonly name = "WebhookSignatureError";
}

/**
 * The idempotency key of attempt `attempt` of a Webflix billing operation (§5.3,
 * `billing_operations`): a declined charge is replayed under its key, so a retry after the
 * member changes card is a new attempt with a new key.
 */
export function billingIdempotencyKey(operationId: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError("attempt starts at 1");
  return `webflix-${operationId}-${attempt}`;
}

/**
 * Test cards the contract suite pays with (the fake's tokens; the Stripe harness maps them to
 * `pm_card_*` ids, docs/STRIPE.md §6): two good cards with different fingerprints, a card the
 * provider declines at setup, one it accepts at setup but declines when charged (…0341), and
 * one that always requires authentication (…3184).
 */
export const PAYMENT_TEST_CARDS = [
  "visa",
  "mastercard",
  "declined",
  "charge-declined",
  "authentication-required",
] as const;
export type PaymentTestCard = (typeof PAYMENT_TEST_CARDS)[number];

/** Webhook signature tolerance (Stripe's default). */
export const WEBHOOK_TOLERANCE_SEC = 300;
