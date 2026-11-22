import type {
  CHECKOUT_STATUSES,
  INVOICE_STATUSES,
  MembershipStatus,
  PAYMENT_DECLINE_REASONS,
  PAYMENT_METHOD_SETUP_STATUSES,
  PaymentProviderId,
  PlanId,
  SUSPENDED_REASONS,
} from "@webflix/contracts";
import type { StoredCard } from "../../repositories/records.ts";

/** Times are epoch ms; money in minor units; ids from the provider are opaque strings. */

export type SuspendedReason = (typeof SUSPENDED_REASONS)[number];
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];
export type SetupStatus = (typeof PAYMENT_METHOD_SETUP_STATUSES)[number];
export type DeclineReason = (typeof PAYMENT_DECLINE_REASONS)[number];

/**
 * The membership projection (§5.2), one row per account that ever started a checkout with a
 * provider. Written only from what the provider says (a verified event's retrieval, or
 * reconciliation), behind a version guard: `saveMembership` with the version it read.
 */
export interface MembershipRecord {
  accountId: string;
  provider: PaymentProviderId;
  providerCustomerId: string;
  providerSubscriptionId: string | null;
  planId: PlanId | null;
  priceLookupKey: string | null;
  /**
   * As the provider's state maps (STRIPE.md §9). `past_due` stays `past_due` here; suspension
   * after grace is computed from time when read (`effectiveMembership`).
   */
  status: MembershipStatus;
  suspendedReason: SuspendedReason | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: number | null;
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  /** The first failed attempt of `graceInvoiceId` (the provider has no such field). */
  graceStartedAt: number | null;
  graceInvoiceId: string | null;
  endedAt: number | null;
  latestInvoiceId: string | null;
  /** Display only, as the provider reports the default card. */
  paymentMethod: StoredCard | null;
  /** One trial per account (§5.4), kept across subscriptions. */
  trialRedeemedAt: number | null;
  /** Provider time minus ours (a test clock); 0 in real time. */
  clockOffsetMs: number;
  /**
   * The next invoice as the provider previewed it at the last write (provider time); null when
   * there is none (cancelling, ended, not live) or it was not computed yet.
   */
  nextInvoice: { at: number; amountMinor: number; currency: string } | null;
  version: number;
  providerSyncedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface BillingCustomerRecord {
  accountId: string;
  provider: PaymentProviderId;
  customerId: string;
  createdAt: number;
}

export type BillingOperationKind =
  | "customer"
  | "setup"
  | "subscribe"
  | "plan_change"
  | "cancel"
  | "resume"
  | "default_card"
  | "pay_invoice"
  | "refund"
  | "trial_end"
  | "cancel_now";

/** §5.3: a money-moving request, safe to retry; its key is (operation, attempt). */
export interface BillingOperationRecord {
  /** This attempt's row: `<operation id>:<attempt>`. */
  id: string;
  accountId: string;
  kind: BillingOperationKind;
  attempt: number;
  idempotencyKey: string;
  status: "pending" | "succeeded" | "failed";
  provider: PaymentProviderId;
  providerRef: string | null;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ProviderEventStatus = "pending" | "processed" | "failed";

/** §5.3: recorded before the 2xx; processed by a job, idempotently by event id. */
export interface ProviderEventRecord {
  provider: PaymentProviderId;
  eventId: string;
  type: string;
  accountId: string | null;
  idempotencyKey: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  invoiceId: string | null;
  setupId: string | null;
  /** The provider's time of the event (its test clock's, if any). */
  eventCreatedAt: number;
  /** `webhook` (verified delivery) or `reconcile` (listed from the provider's API). */
  source: "webhook" | "reconcile";
  receivedAt: number;
  processedAt: number | null;
  status: ProviderEventStatus;
  attempts: number;
  lastError: string | null;
}

export interface InvoiceRecord {
  id: string;
  accountId: string;
  provider: PaymentProviderId;
  providerInvoiceId: string;
  providerSubscriptionId: string | null;
  number: string | null;
  status: (typeof INVOICE_STATUSES)[number];
  currency: string;
  totalMinor: number;
  amountPaidMinor: number;
  amountDueMinor: number;
  amountRefundedMinor: number;
  billingReason: string;
  periodStart: number | null;
  periodEnd: number | null;
  hostedUrl: string | null;
  pdfUrl: string | null;
  issuedAt: number;
  paidAt: number | null;
  updatedAt: number;
}

export interface RefundRecord {
  id: string;
  accountId: string;
  /** Webflix's invoice id. */
  invoiceId: string;
  provider: PaymentProviderId;
  providerRefundId: string | null;
  amountMinor: number;
  currency: string;
  status: "pending" | "succeeded" | "failed";
  reason: string | null;
  /** The staff member who asked for it (the audit log has the rest). */
  staffSubject: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PlanPriceRecord {
  planId: PlanId;
  currency: string;
  amountMinor: number;
  lookupKey: string;
  active: boolean;
  updatedAt: number;
}

export interface ProviderPriceRecord {
  provider: PaymentProviderId;
  lookupKey: string;
  providerPriceId: string;
  amountMinor: number;
  syncedAt: number;
}

/** A promo code as validated at the provider when the checkout took it. */
export interface CheckoutPromotion {
  code: string;
  percentOff: number | null;
  amountOffMinor: number | null;
  currency: string | null;
  duration: "once" | "repeating" | "forever";
  durationInMonths: number | null;
}

export interface CheckoutRecord {
  id: string;
  accountId: string;
  planId: PlanId;
  currency: string;
  status: CheckoutStatus;
  promotionCode: string | null;
  promotionId: string | null;
  promotion: CheckoutPromotion | null;
  provider: PaymentProviderId;
  providerCustomerId: string | null;
  providerSetupId: string | null;
  providerSubscriptionId: string | null;
  providerPaymentMethodId: string | null;
  trialDays: number | null;
  /** The card fingerprint this checkout claimed for its trial (released if it fails). */
  trialFingerprint: string | null;
  amountDueMinor: number | null;
  failureReason: DeclineReason | null;
  /** The Webflix operation behind the subscription call (idempotency key with `attempt`). */
  operationId: string;
  attempt: number;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
}

export interface PaymentMethodSetupRecord {
  id: string;
  accountId: string;
  provider: PaymentProviderId;
  providerSetupId: string;
  providerPaymentMethodId: string | null;
  status: SetupStatus;
  attempt: number;
  createdAt: number;
  updatedAt: number;
}

export type TrialClaim = "claimed" | "mine" | "taken";

/**
 * Repository port of the billing area: `memberships`, `billing_customers`, `billing_operations`,
 * `provider_events`, `trial_fingerprints`, `invoices`, `refunds`, `plan_prices`,
 * `provider_prices`, `checkouts` and `payment_method_setups` (the fake provider's
 * `payments_fake_*` tables belong to `packages/payments-fake`, which reads them itself).
 * Implemented in memory (`memory/areas/billing.ts`) and on every dialect
 * (`packages/db/src/repositories/areas/billing.ts`); both pass
 * `describeBillingRepositoryContract`. The D1 rules hold: one method per atomic write, at most
 * 100 bound parameters per statement, hot reads (`getMembership`) in one round trip.
 */
export interface BillingRepository {
  // --- Customers ------------------------------------------------------------------------------
  getCustomer(
    accountId: string,
    provider: PaymentProviderId,
  ): Promise<BillingCustomerRecord | null>;
  findCustomer(
    provider: PaymentProviderId,
    customerId: string,
  ): Promise<BillingCustomerRecord | null>;
  /** Keeps the first one stored for (account, provider); returns what is stored. */
  saveCustomer(record: BillingCustomerRecord): Promise<BillingCustomerRecord>;

  // --- The projection -------------------------------------------------------------------------
  getMembership(accountId: string): Promise<MembershipRecord | null>;
  /**
   * Compare-and-set: inserts when `expectedVersion` is null and no row exists, else updates the
   * row only if its version is still `expectedVersion`. False when another writer won.
   */
  saveMembership(record: MembershipRecord, expectedVersion: number | null): Promise<boolean>;
  /**
   * Memberships reconciliation should look at: not yet synced since `syncedBefore`, in a state
   * that can still change on its own (incomplete, trialing, active, past_due, suspended).
   */
  listMembershipsToReconcile(syncedBefore: number, limit: number): Promise<MembershipRecord[]>;
  /** Memberships in a trial, soonest trial end first (the "trial ending" email). */
  listTrialing(limit: number): Promise<MembershipRecord[]>;

  // --- Operations (§5.3) ----------------------------------------------------------------------
  /** Inserts the attempt; returns the stored row when its key already exists. */
  startOperation(record: BillingOperationRecord): Promise<BillingOperationRecord>;
  finishOperation(
    id: string,
    attempt: number,
    outcome: {
      status: "succeeded" | "failed";
      providerRef: string | null;
      errorCode: string | null;
    },
    now: number,
  ): Promise<void>;
  findOperationByKey(idempotencyKey: string): Promise<BillingOperationRecord | null>;

  // --- Provider events (§5.3) -----------------------------------------------------------------
  /** Records the event id once; `inserted` false on a redelivery (then `record` is the stored one). */
  recordProviderEvent(
    record: ProviderEventRecord,
  ): Promise<{ inserted: boolean; record: ProviderEventRecord }>;
  getProviderEvent(
    provider: PaymentProviderId,
    eventId: string,
  ): Promise<ProviderEventRecord | null>;
  updateProviderEvent(
    provider: PaymentProviderId,
    eventId: string,
    patch: Pick<ProviderEventRecord, "status" | "attempts" | "lastError" | "processedAt"> & {
      accountId?: string | null;
    },
  ): Promise<void>;
  /** The newest `receivedAt` of a reconciled or delivered event (the reconciliation cursor). */
  latestEventReceivedAt(provider: PaymentProviderId): Promise<number | null>;
  /** The earliest `invoice.payment_failed` time recorded for that invoice (grace starts there). */
  firstFailureAt(provider: PaymentProviderId, invoiceId: string): Promise<number | null>;
  listPendingProviderEvents(receivedBefore: number, limit: number): Promise<ProviderEventRecord[]>;

  // --- Trials (§5.4) --------------------------------------------------------------------------
  /** `claimed` now, already `mine`, or `taken` by another account. */
  claimTrialFingerprint(input: {
    provider: PaymentProviderId;
    fingerprint: string;
    accountId: string;
    now: number;
  }): Promise<TrialClaim>;
  releaseTrialFingerprint(
    provider: PaymentProviderId,
    fingerprint: string,
    accountId: string,
  ): Promise<void>;
  /** Whether the account ever claimed a trial with any card. */
  hasTrialFingerprint(accountId: string): Promise<boolean>;

  // --- Invoices and refunds -------------------------------------------------------------------
  /** By (provider, provider invoice id); the Webflix id of an existing row is kept. */
  upsertInvoice(record: InvoiceRecord): Promise<InvoiceRecord>;
  getInvoice(accountId: string, id: string): Promise<InvoiceRecord | null>;
  /** Newest first; `before` is the (issuedAt, id) of the last row of the previous page. */
  listInvoices(
    accountId: string,
    page: { limit: number; before: { issuedAt: number; id: string } | null },
  ): Promise<InvoiceRecord[]>;
  saveRefund(record: RefundRecord): Promise<void>;
  listRefunds(invoiceId: string): Promise<RefundRecord[]>;

  // --- Catalogue (§5.4) -----------------------------------------------------------------------
  listPlanPrices(): Promise<PlanPriceRecord[]>;
  savePlanPrice(record: PlanPriceRecord): Promise<void>;
  listProviderPrices(provider: PaymentProviderId): Promise<ProviderPriceRecord[]>;
  saveProviderPrices(records: readonly ProviderPriceRecord[]): Promise<void>;

  // --- Checkouts and card replacement ---------------------------------------------------------
  saveCheckout(record: CheckoutRecord): Promise<void>;
  getCheckout(accountId: string, id: string): Promise<CheckoutRecord | null>;
  /** The newest checkout of the account that is still open (not complete, failed or expired). */
  findOpenCheckout(accountId: string, now: number): Promise<CheckoutRecord | null>;
  listCheckoutsForSubscription(
    provider: PaymentProviderId,
    subscriptionId: string,
  ): Promise<CheckoutRecord[]>;
  saveSetup(record: PaymentMethodSetupRecord): Promise<void>;
  getSetup(accountId: string, id: string): Promise<PaymentMethodSetupRecord | null>;
  findSetupByProviderId(
    provider: PaymentProviderId,
    providerSetupId: string,
  ): Promise<PaymentMethodSetupRecord | null>;
}
