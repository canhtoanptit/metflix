import {
  type AdminPlan,
  type AdminPlanList,
  type BillingClock,
  type BillingConfig,
  type Checkout,
  type Invoice,
  type InvoicePage,
  type JsonValue,
  type Membership,
  type MembershipState,
  type Money,
  type PaymentMethodSetup,
  PLAN_IDS,
  type PlanChangePreview,
  type PlanId,
  type PlanList,
  type PlanSyncResult,
  type PromotionQuote,
  type Refund,
  TRIAL_DAYS,
  type WebhookAck,
} from "@webflix/contracts";
import * as z from "zod";
import { decodeCursor, encodeCursor, invalidCursor } from "../../domain/cursor.ts";
import { getPlan, PLAN_CATALOG } from "../../domain/plans.ts";
import { AppError } from "../../errors.ts";
import { toIsoString } from "../../ports/clock.ts";
import { defineJob, handleJob } from "../../ports/job-queue.ts";
import { serializeError } from "../../ports/logger.ts";
import {
  type CatalogueEntry,
  PaymentProviderError,
  type ProviderSubscription,
  WebhookSignatureError,
} from "../../ports/payment-provider.ts";
import type { SubscriptionRecord } from "../../repositories/records.ts";
import type { AuthContext, ServiceDependencies } from "../../services/context.ts";
import { isDemoAccount, standingOf } from "../../services/privileges.ts";
import type { AreaModule, AreaSeams } from "../module.ts";
import { readAccount } from "./accounts.ts";
import {
  createBillingContext,
  declineReason,
  nextAttempt,
  providerCall,
  providerProblem,
} from "./context.ts";
import {
  isProviderMembership,
  type MembershipSnapshot,
  readMembership,
  snapshotMembership,
} from "./membership.ts";
import {
  presentCheckout,
  presentInvoice,
  presentPromotion,
  presentRefund,
  presentSetup,
} from "./presenters.ts";
import { priceLookupKey } from "./projection.ts";
import type {
  CheckoutPromotion,
  CheckoutRecord,
  MembershipRecord,
  PaymentMethodSetupRecord,
  PlanPriceRecord,
} from "./repository.ts";
import {
  PROVIDER_EVENT_JOB,
  processProviderEvent,
  RECONCILE_JOB,
  reconcile,
  recordProviderEvent,
  storeInvoice,
  syncSubscription,
} from "./sync.ts";

/** Checkouts expire after a day: the provider expires an unconfirmed first payment after 23 h. */
const CHECKOUT_TTL_MS = 24 * 3_600_000;
/** A plan-change preview can be applied for this long (its proration date is fixed). */
const PREVIEW_TTL_SEC = 15 * 60;
const PREVIEW_PURPOSE = "billing.plan-change";
/** Every plan's price is in this currency until per-currency checkout exists. */
export const BILLING_CURRENCY = "USD";
const ENTITLED_STATUSES = new Set(["trialing", "active", "past_due"]);

export const providerEventJob = defineJob(
  PROVIDER_EVENT_JOB,
  z.object({ provider: z.string(), eventId: z.string().min(1).max(255) }),
);
export const reconcileJob = defineJob(RECONCILE_JOB, z.object({}));

/**
 * The billing area (milestone 2 §5, docs/STRIPE.md): checkout, the membership projection
 * driven by verified provider events (a job per event that retrieves the current subscription),
 * reconciliation, `billing_operations` idempotency, trials, promotions, plan changes with
 * previews, card replacement, invoices, refunds and catalogue sync. Owns entitlement: playback
 * asks `playbackEntitlement` (services/subscriptions.ts), which reads the same projection.
 *
 * Money is never decided by the client or by an optimistic write (principle 3): no method here
 * writes the projection from a request; `syncSubscription` writes it from the provider's state.
 */
export interface BillingService extends AreaModule {
  /** Whether the account's membership is the provider's (else milestone 1's mock, or none). */
  usesProvider(accountId: string): Promise<boolean>;
  /** The plan the account holds and may play on now; null without an entitled membership. */
  currentPlan(accountId: string): Promise<PlanId | null>;
  /** Staff member lists: each account's membership status and plan (unknown accounts left out). */
  membershipSummaries(
    accountIds: readonly string[],
  ): Promise<Map<string, { membershipStatus: MembershipState["status"]; planId: PlanId | null }>>;
  membership(accountId: string, legacy: SubscriptionRecord | null): Promise<MembershipSnapshot>;
  config(): BillingConfig;
  plans(): Promise<PlanList>;

  startCheckout(
    auth: AuthContext,
    input: { planId: PlanId; promotionCode?: string | undefined },
  ): Promise<Checkout>;
  getCheckout(accountId: string, checkoutId: string): Promise<Checkout>;
  confirmCheckout(accountId: string, checkoutId: string): Promise<Checkout>;

  previewPlanChange(accountId: string, planId: PlanId): Promise<PlanChangePreview>;
  changePlan(
    accountId: string,
    input: { planId: PlanId; previewToken?: string | undefined },
  ): Promise<Membership>;
  cancel(accountId: string): Promise<Membership>;
  resume(accountId: string): Promise<Membership>;
  setupPaymentMethod(accountId: string): Promise<PaymentMethodSetup>;
  getPaymentMethodSetup(accountId: string, setupId: string): Promise<PaymentMethodSetup>;
  listInvoices(accountId: string, page: { cursor?: string; limit?: number }): Promise<InvoicePage>;
  validatePromotion(input: { code: string; planId: PlanId }): Promise<PromotionQuote>;

  /** `POST /webhooks/payments/:provider`: verify over the raw bytes, record once, queue. */
  receiveWebhook(provider: string, body: Uint8Array, signature: string | null): Promise<WebhookAck>;
  /** Reads the account's subscription from the provider and writes the projection. */
  syncAccount(accountId: string): Promise<MembershipSnapshot | null>;
  reconcile(): Promise<{ listed: number; recorded: number; requeued: number; resynced: number }>;
  /** The fake provider's test clock for this account's customer (not in production). */
  advanceClock(accountId: string, seconds: number): Promise<BillingClock>;

  // --- Staff (the admin area's handlers call these; role checks and audit are theirs) -------
  memberBilling(accountId: string): Promise<{
    membership: MembershipState;
    entitlement: MembershipSnapshot["entitlement"];
    recentInvoices: Invoice[];
  }>;
  refundInvoice(input: {
    accountId: string;
    invoiceId: string;
    amount?: Money | undefined;
    reason: string;
    staffSubject: string;
  }): Promise<Refund>;
  cancelForStaff(input: {
    accountId: string;
    when: "now" | "period_end";
    refundUnused?: boolean | undefined;
    reason: string;
    staffSubject: string;
  }): Promise<MembershipState>;
  extendTrial(input: { accountId: string; days: number }): Promise<MembershipState>;
  grantComplimentaryPeriod(input: { accountId: string; days: number }): Promise<MembershipState>;
  listAdminPlans(): Promise<AdminPlanList>;
  setPlanPrice(input: {
    planId: PlanId;
    currency: string;
    amountMinor: number;
  }): Promise<AdminPlan>;
  syncPlans(): Promise<PlanSyncResult>;
}

export function createBillingService(deps: ServiceDependencies, seams: AreaSeams): BillingService {
  const context = createBillingContext(deps, seams);
  const { repos, payments, ids, logger } = deps;
  const provider = context.provider;
  let catalogue: Promise<void> | undefined;

  // The fake delivers its webhooks in process; they are verified like any other delivery.
  payments.attachWebhookReceiver?.(async ({ body, signature }) => {
    await service.receiveWebhook(provider, body, signature);
  });

  // --- Catalogue --------------------------------------------------------------------------------

  async function planPrices(): Promise<PlanPriceRecord[]> {
    const stored = await repos.billing.listPlanPrices();
    const now = context.now();
    // Webflix is the source of the catalogue: seeded from the plans the first time.
    const missing = PLAN_CATALOG.filter(
      (plan) =>
        !stored.some(
          (price) => price.planId === plan.id && price.currency === plan.monthlyPrice.currency,
        ),
    );
    for (const plan of missing) {
      const record: PlanPriceRecord = {
        planId: plan.id,
        currency: plan.monthlyPrice.currency,
        amountMinor: plan.monthlyPrice.amountMinor,
        lookupKey: priceLookupKey(plan.id, plan.monthlyPrice.currency),
        active: true,
        updatedAt: now,
      };
      await repos.billing.savePlanPrice(record);
      stored.push(record);
    }
    return stored;
  }

  function catalogueEntries(prices: readonly PlanPriceRecord[]): CatalogueEntry[] {
    return prices
      .filter((price) => price.active)
      .map((price) => ({
        lookupKey: price.lookupKey,
        productId: `webflix_${price.planId}`,
        productName: `Webflix ${getPlan(price.planId).name}`,
        amountMinor: price.amountMinor,
        currency: price.currency,
      }));
  }

  async function syncCatalogue(): Promise<PlanSyncResult> {
    const prices = await planPrices();
    const entries = catalogueEntries(prices);
    const result = await payments.syncCatalogue(entries);
    const now = context.now();
    await repos.billing.saveProviderPrices(
      entries.map((entry) => ({
        provider,
        lookupKey: entry.lookupKey,
        providerPriceId: entry.lookupKey,
        amountMinor: entry.amountMinor,
        syncedAt: now,
      })),
    );
    return { provider, ...result, syncedAt: toIsoString(now) };
  }

  /** Prices exist at the provider before the first subscription (idempotent, once per process). */
  function ensureCatalogue(): Promise<void> {
    catalogue ??= syncCatalogue().then(
      () => undefined,
      (error: unknown) => {
        catalogue = undefined;
        throw providerProblem(error);
      },
    );
    return catalogue;
  }

  // --- Reading ----------------------------------------------------------------------------------

  async function snapshot(accountId: string): Promise<MembershipSnapshot> {
    const loaded = await readAccount(deps, accountId);
    if (!loaded) throw new AppError("unauthenticated");
    return readMembership(
      deps,
      accountId,
      loaded.subscription,
      context.now(),
      loaded.account.createdAt,
    );
  }

  /** The account's provider membership, for changes that need one (`subscription_required`). */
  async function requireProviderMembership(accountId: string): Promise<MembershipRecord> {
    const record = await repos.billing.getMembership(accountId);
    if (!isProviderMembership(record)) {
      throw new AppError("subscription_required", {
        subscriptionStatus: "ended",
        membershipStatus: "none",
      });
    }
    return record;
  }

  async function customerFor(accountId: string): Promise<string> {
    const existing = await repos.billing.getCustomer(accountId, provider);
    if (existing) return existing.customerId;
    const account = await readAccount(deps, accountId);
    if (!account) throw new AppError("unauthenticated");
    // One customer per account and provider: the key is derived from the account, so a retry
    // (or a race) gets the same customer back.
    const created = await providerCall(
      context,
      { id: `customer-${accountId}`, attempt: 1, kind: "customer", accountId },
      (call) => payments.createCustomer({ accountId, email: account.account.email }, call),
      (customer) => customer.id,
    ).catch((error: unknown) => {
      throw providerProblem(error);
    });
    const stored = await repos.billing.saveCustomer({
      accountId,
      provider,
      customerId: created.id,
      createdAt: context.now(),
    });
    return stored.customerId;
  }

  async function promotionFor(
    code: string | undefined,
    planId: PlanId,
  ): Promise<{ id: string; promotion: CheckoutPromotion } | null> {
    if (!code) return null;
    const lookup = await payments
      .validatePromotionCode({ code, priceLookupKey: priceLookupKey(planId, BILLING_CURRENCY) })
      .catch((error: unknown) => {
        throw providerProblem(error);
      });
    if (!lookup.valid) {
      throw new AppError("promotion_code_invalid", { promotionReason: lookup.reason });
    }
    return {
      id: lookup.promotionId,
      promotion: {
        code: lookup.code,
        percentOff: lookup.percentOff,
        amountOffMinor: lookup.amountOffMinor,
        currency: lookup.currency,
        duration: lookup.duration,
        durationInMonths: lookup.durationInMonths,
      },
    };
  }

  async function checkoutView(checkout: CheckoutRecord): Promise<Checkout> {
    let clientSecret: string | null = null;
    if (checkout.status === "requires_setup" && checkout.providerSetupId) {
      clientSecret = (await payments.retrieveSetup(checkout.providerSetupId))?.clientSecret ?? null;
    } else if (checkout.status === "requires_payment" && checkout.providerSubscriptionId) {
      clientSecret =
        (await payments.retrieveSubscription(checkout.providerSubscriptionId))
          ?.paymentClientSecret ?? null;
    }
    const membership =
      checkout.trialDays !== null ? await repos.billing.getMembership(checkout.accountId) : null;
    return presentCheckout(checkout, {
      clientSecret,
      trialEndsAt:
        membership?.providerSubscriptionId === checkout.providerSubscriptionId
          ? (membership?.trialEndsAt ?? null)
          : null,
    });
  }

  async function newSetup(
    accountId: string,
    customerId: string,
    operationId: string,
  ): Promise<string> {
    const setup = await providerCall(
      context,
      {
        id: operationId,
        attempt: await nextAttempt(context, operationId),
        kind: "setup",
        accountId,
      },
      (call) => payments.createSetup({ customerId }, call),
      (created) => created.id,
    ).catch((error: unknown) => {
      throw providerProblem(error);
    });
    return setup.id;
  }

  // --- Card replacement completion (from the provider's event, §5.4) ----------------------------

  async function completeSetup(providerSetupId: string): Promise<void> {
    const setup = await repos.billing.findSetupByProviderId(provider, providerSetupId);
    if (!setup || setup.status === "succeeded") return;
    const confirmed = await payments.retrieveSetup(providerSetupId);
    if (!confirmed) return;
    const now = context.now();
    if (confirmed.status === "failed") {
      await repos.billing.saveSetup({ ...setup, status: "failed", updatedAt: now });
      return;
    }
    if (confirmed.status !== "succeeded" || !confirmed.paymentMethod) return;
    const membership = await repos.billing.getMembership(setup.accountId);
    // The browser decides nothing: the confirmed card becomes the default here, server-side.
    await providerCall(
      context,
      {
        id: `default-card-${setup.id}`,
        attempt: 1,
        kind: "default_card",
        accountId: setup.accountId,
      },
      (call) =>
        payments.setDefaultPaymentMethod(
          {
            customerId: confirmed.customerId,
            paymentMethodId: confirmed.paymentMethod?.id ?? "",
            subscriptionId: membership?.providerSubscriptionId ?? null,
          },
          call,
        ),
    );
    await repos.billing.saveSetup({
      ...setup,
      status: "succeeded",
      providerPaymentMethodId: confirmed.paymentMethod.id,
      updatedAt: now,
    });
    // A card change does not make the provider attempt an open invoice (§5.4): ask it to.
    if (membership?.providerSubscriptionId) {
      const subscription = await payments.retrieveSubscription(membership.providerSubscriptionId);
      if (
        subscription &&
        ["past_due", "unpaid"].includes(subscription.status) &&
        subscription.latestInvoiceId
      ) {
        const invoiceId = subscription.latestInvoiceId;
        const invoice = await payments.retrieveInvoice(invoiceId);
        if (invoice?.status === "open") {
          await providerCall(
            context,
            {
              id: `pay-${invoiceId}-${setup.id}`,
              attempt: 1,
              kind: "pay_invoice",
              accountId: setup.accountId,
            },
            (call) => payments.payInvoice({ invoiceId }, call),
            (paid) => paid.id,
          ).catch((error: unknown) => {
            // A decline is the provider's answer (recorded, evented); the projection follows it.
            if (!(error instanceof PaymentProviderError) || error.retryable) throw error;
            logger.info("billing.recovery_declined", {
              accountId: setup.accountId,
              code: error.code,
            });
          });
        }
      }
      await syncSubscription(context, membership.providerSubscriptionId, setup.accountId);
    }
  }

  // --- Plan changes ---------------------------------------------------------------------------

  async function changeTarget(accountId: string, planId: PlanId) {
    const record = await requireProviderMembership(accountId);
    const subscriptionId = record.providerSubscriptionId;
    if (!subscriptionId || !ENTITLED_STATUSES.has(record.status)) {
      throw new AppError("checkout_state_conflict", {
        detail: "Only a running membership can change plan.",
      });
    }
    if (record.planId === planId) {
      throw new AppError("checkout_state_conflict", { detail: "That is already the plan." });
    }
    return { record, subscriptionId };
  }

  async function membershipAfter(accountId: string, subscription: ProviderSubscription | null) {
    if (subscription) await syncSubscription(context, subscription.id, accountId);
    return (await snapshot(accountId)).legacy;
  }

  const service: BillingService = {
    // --- Jobs -----------------------------------------------------------------------------------
    jobs: [
      handleJob(providerEventJob, async ({ provider: eventProvider, eventId }) => {
        if (eventProvider !== provider) return;
        await processProviderEvent(context, eventId, { completeSetup });
      }),
      handleJob(reconcileJob, async () => {
        await reconcile(context);
      }),
    ],
    scheduled: () => [{ type: RECONCILE_JOB, payload: {} }],

    async exportAccountData(accountId): Promise<JsonValue> {
      const record = await repos.billing.getMembership(accountId);
      const invoices = await repos.billing.listInvoices(accountId, { limit: 100, before: null });
      return {
        membership: record
          ? {
              status: record.status,
              planId: record.planId,
              provider: record.provider,
              trialEndsAt: record.trialEndsAt,
              currentPeriodEnd: record.currentPeriodEnd,
              cancelAtPeriodEnd: record.cancelAtPeriodEnd,
            }
          : null,
        invoices: invoices.map((invoice) => presentInvoice(invoice)) as unknown as JsonValue,
      };
    },

    async eraseAccountData(accountId): Promise<void> {
      // §6.3: the provider forgets the member (subscription ended, customer and cards deleted:
      // a deleted account is never charged again); Webflix keeps what the law requires
      // (invoices, refunds, operations, provider events, the customer link: no foreign key to
      // the account, D-M2-6). The projection, checkouts and card changes cascade with the account.
      const customer = await repos.billing.getCustomer(accountId, provider);
      if (!customer) return;
      await providerCall(
        context,
        { id: `erase-${accountId}`, attempt: 1, kind: "cancel_now", accountId },
        (call) => payments.deleteCustomer({ customerId: customer.customerId }, call),
      );
      logger.info("billing.customer_erased", { accountId });
    },

    // --- Reading --------------------------------------------------------------------------------
    async currentPlan(accountId) {
      const current = await snapshot(accountId);
      return current.entitlement.entitled ? current.effective.planId : null;
    },

    async membershipSummaries(accountIds) {
      const summaries = new Map<
        string,
        { membershipStatus: MembershipState["status"]; planId: PlanId | null }
      >();
      for (const accountId of accountIds) {
        const loaded = await readAccount(deps, accountId);
        if (!loaded) continue;
        const current = await readMembership(
          deps,
          accountId,
          loaded.subscription,
          context.now(),
          loaded.account.createdAt,
        );
        summaries.set(accountId, {
          membershipStatus: current.state.status,
          planId: current.state.planId,
        });
      }
      return summaries;
    },

    async usesProvider(accountId) {
      return isProviderMembership(await repos.billing.getMembership(accountId));
    },

    async membership(accountId, legacy) {
      return readMembership(deps, accountId, legacy, context.now());
    },

    config() {
      if (provider === "stripe") {
        const key = deps.config.billing.stripe?.publishableKey ?? "";
        return { provider: "stripe", publishableKey: key };
      }
      return { provider: "fake", formUrl: "/_pay/form" };
    },

    async plans() {
      const prices = await planPrices();
      return {
        items: PLAN_CATALOG.map((plan) => {
          const price = prices.find(
            (candidate) =>
              candidate.planId === plan.id &&
              candidate.currency === plan.monthlyPrice.currency &&
              candidate.active,
          );
          return {
            ...plan,
            monthlyPrice: price
              ? { amountMinor: price.amountMinor, currency: price.currency }
              : plan.monthlyPrice,
            trial: { days: TRIAL_DAYS },
          };
        }),
      };
    },

    // --- Checkout (§5.1, §5.4) ------------------------------------------------------------------
    async startCheckout(auth, input) {
      const accountId = auth.session.accountId;
      const standing = standingOf(auth.profile);
      if (standing === "kids" || standing === "restricted") {
        throw new AppError("unrestricted_profile_required");
      }
      if (isDemoAccount(accountId)) throw new AppError("demo_account_protected");
      const current = await snapshot(accountId);
      if (current.entitlement.entitled) {
        throw new AppError("checkout_state_conflict", {
          detail: "This account already has a membership.",
        });
      }
      // An unpaid membership still exists at the provider: it recovers with a new card (the
      // setup flow pays the open invoice), never with a second subscription.
      if (current.record && ["past_due", "suspended"].includes(current.record.status)) {
        throw new AppError("checkout_state_conflict", {
          detail: "Replace the card to restore this membership.",
        });
      }
      const now = context.now();
      const promotion = await promotionFor(input.promotionCode, input.planId);
      const open = await repos.billing.findOpenCheckout(accountId, now);
      // A member who stopped half-way resumes the same checkout (§5.1).
      if (open && open.status === "requires_setup") {
        const resumed: CheckoutRecord = {
          ...open,
          planId: input.planId,
          promotionCode: promotion?.promotion.code ?? null,
          promotionId: promotion?.id ?? null,
          promotion: promotion?.promotion ?? null,
          updatedAt: now,
        };
        await repos.billing.saveCheckout(resumed);
        return checkoutView(resumed);
      }
      if (open && (open.status === "requires_payment" || open.status === "processing")) {
        if (
          open.planId === input.planId &&
          open.promotionCode === (promotion?.promotion.code ?? null)
        ) {
          return checkoutView(open);
        }
        if (open.status === "processing") {
          throw new AppError("checkout_state_conflict", {
            detail: "A payment is being confirmed for this account.",
          });
        }
        // Another plan while a first payment is unpaid: end that subscription, start afresh.
        if (open.providerSubscriptionId) {
          const subscriptionId = open.providerSubscriptionId;
          await providerCall(
            context,
            { id: `abandon-${open.id}`, attempt: 1, kind: "cancel_now", accountId },
            (call) => payments.cancelNow({ subscriptionId }, call),
          ).catch((error: unknown) => {
            throw providerProblem(error);
          });
        }
        await repos.billing.saveCheckout({ ...open, status: "expired", updatedAt: now });
      }
      await ensureCatalogue();
      const customerId = await customerFor(accountId);
      const id = ids.next();
      const setupId = await newSetup(accountId, customerId, `setup-${id}`);
      const checkout: CheckoutRecord = {
        id,
        accountId,
        planId: input.planId,
        currency: BILLING_CURRENCY,
        status: "requires_setup",
        promotionCode: promotion?.promotion.code ?? null,
        promotionId: promotion?.id ?? null,
        promotion: promotion?.promotion ?? null,
        provider,
        providerCustomerId: customerId,
        providerSetupId: setupId,
        providerSubscriptionId: null,
        providerPaymentMethodId: null,
        trialDays: null,
        trialFingerprint: null,
        amountDueMinor: null,
        failureReason: null,
        operationId: `subscribe-${id}`,
        attempt: 1,
        createdAt: now,
        expiresAt: now + CHECKOUT_TTL_MS,
        updatedAt: now,
      };
      await repos.billing.saveCheckout(checkout);
      logger.info("billing.checkout_started", { accountId, checkoutId: id, planId: input.planId });
      return checkoutView(checkout);
    },

    async getCheckout(accountId, checkoutId) {
      let checkout = await repos.billing.getCheckout(accountId, checkoutId);
      if (!checkout) throw new AppError("not_found", { detail: "No such checkout" });
      const now = context.now();
      if (
        checkout.expiresAt <= now &&
        (checkout.status === "requires_setup" || checkout.status === "requires_payment")
      ) {
        checkout = { ...checkout, status: "expired", updatedAt: now };
        await repos.billing.saveCheckout(checkout);
      }
      // Polling a checkout that waits on the provider reads the provider (reconciliation):
      // the membership activates when the provider says so, with or without a webhook.
      if (
        (checkout.status === "processing" || checkout.status === "requires_payment") &&
        checkout.providerSubscriptionId
      ) {
        await syncSubscription(context, checkout.providerSubscriptionId, accountId);
        checkout = (await repos.billing.getCheckout(accountId, checkoutId)) ?? checkout;
      }
      return checkoutView(checkout);
    },

    async confirmCheckout(accountId, checkoutId) {
      const found = await repos.billing.getCheckout(accountId, checkoutId);
      if (!found) throw new AppError("not_found", { detail: "No such checkout" });
      let checkout: CheckoutRecord = found;
      if (checkout.status !== "requires_setup") {
        if (checkout.status === "failed" || checkout.status === "expired") {
          throw new AppError("checkout_state_conflict", { detail: "Start a new checkout." });
        }
        // Already confirmed: answering again is harmless (a retried request).
        return service.getCheckout(accountId, checkoutId);
      }
      if (!checkout.providerSetupId || !checkout.providerCustomerId) {
        throw new AppError("checkout_state_conflict", { detail: "Start a new checkout." });
      }
      const setup = await payments.retrieveSetup(checkout.providerSetupId);
      if (!setup)
        throw new AppError("checkout_state_conflict", { detail: "Start a new checkout." });
      const now = context.now();
      if (setup.status === "failed" || (setup.status === "succeeded" && !setup.paymentMethod)) {
        // The card was refused at setup: a fresh setup for the next card, and say why.
        const reason = declineReason(setup.failureCode);
        // A new operation: the old key would replay the refused setup.
        const setupId = await newSetup(
          accountId,
          checkout.providerCustomerId,
          `setup-${ids.next()}`,
        );
        await repos.billing.saveCheckout({
          ...checkout,
          providerSetupId: setupId,
          failureReason: reason,
          updatedAt: now,
        });
        throw new AppError("payment_declined", { declineReason: reason });
      }
      if (setup.status !== "succeeded" || !setup.paymentMethod) {
        throw new AppError("checkout_state_conflict", {
          detail: "Confirm the card with the payment form first.",
        });
      }
      const method = setup.paymentMethod;

      // §5.4: one trial per account and per card. Webflix enforces both (Stripe enforces
      // neither); the card's fingerprint is claimed before the subscription is created, so two
      // accounts racing with one card cannot both get a trial. Wallets may hide the card's
      // fingerprint: then only the account rule applies.
      let trialDays: number | null = checkout.trialDays;
      let claimed = checkout.trialFingerprint;
      if (checkout.attempt === 1 && claimed === null) {
        const membership = await repos.billing.getMembership(accountId);
        const accountHadTrial =
          membership?.trialRedeemedAt != null ||
          (await repos.billing.hasTrialFingerprint(accountId));
        trialDays = null;
        if (!accountHadTrial) {
          const accountClaim = await repos.billing.claimTrialFingerprint({
            provider,
            fingerprint: `account:${accountId}`,
            accountId,
            now,
          });
          const cardClaim = method.fingerprint
            ? await repos.billing.claimTrialFingerprint({
                provider,
                fingerprint: method.fingerprint,
                accountId,
                now,
              })
            : "claimed";
          if (accountClaim !== "taken" && cardClaim !== "taken") {
            trialDays = TRIAL_DAYS;
            claimed = method.fingerprint ?? `account:${accountId}`;
          } else if (accountClaim === "claimed") {
            await repos.billing.releaseTrialFingerprint(
              provider,
              `account:${accountId}`,
              accountId,
            );
          }
        }
        checkout = {
          ...checkout,
          trialDays,
          trialFingerprint: claimed,
          providerPaymentMethodId: method.id,
          updatedAt: now,
        };
        // Saved before the provider call: a retry after a crash re-sends the same request
        // (same operation, same attempt, same key) and gets the same subscription back.
        await repos.billing.saveCheckout(checkout);
      }
      const subscribe = checkout;
      let subscription: ProviderSubscription;
      try {
        subscription = await providerCall(
          context,
          {
            id: subscribe.operationId,
            attempt: subscribe.attempt,
            kind: "subscribe",
            accountId,
          },
          (call) =>
            payments.createSubscription(
              {
                customerId: subscribe.providerCustomerId ?? "",
                priceLookupKey: priceLookupKey(subscribe.planId, subscribe.currency),
                paymentMethodId: method.id,
                trialDays: subscribe.trialDays,
                promotionId: subscribe.promotionId,
              },
              call,
            ),
          (created) => created.id,
        );
      } catch (error) {
        if (error instanceof PaymentProviderError && !error.retryable) {
          // Refused outright: give the trial claim back and let the member start again.
          if (subscribe.trialFingerprint) {
            await repos.billing.releaseTrialFingerprint(
              provider,
              subscribe.trialFingerprint,
              accountId,
            );
            await repos.billing.releaseTrialFingerprint(
              provider,
              `account:${accountId}`,
              accountId,
            );
          }
          await repos.billing.saveCheckout({
            ...subscribe,
            status: "failed",
            failureReason: declineReason(error.code),
            updatedAt: context.now(),
          });
        }
        throw providerProblem(error);
      }
      const invoice = subscription.latestInvoiceId
        ? await payments.retrieveInvoice(subscription.latestInvoiceId)
        : null;
      const confirmed: CheckoutRecord = {
        ...subscribe,
        providerSubscriptionId: subscription.id,
        status:
          subscription.status === "incomplete" && subscription.paymentClientSecret
            ? "requires_payment"
            : "processing",
        amountDueMinor: invoice?.amountDueMinor ?? (subscribe.trialDays ? 0 : null),
        failureReason: null,
        updatedAt: context.now(),
      };
      await repos.billing.saveCheckout(confirmed);
      logger.info("billing.checkout_confirmed", {
        accountId,
        checkoutId,
        trial: confirmed.trialDays !== null,
        status: confirmed.status,
      });
      // The projection is the provider's to decide: read it now (reconciliation) as well as on
      // its events, so the member sees `trialing` as soon as the provider has it.
      await syncSubscription(context, subscription.id, accountId);
      return checkoutView((await repos.billing.getCheckout(accountId, checkoutId)) ?? confirmed);
    },

    // --- Plan changes (§12: upgrade and downgrade with the previewed proration) -----------------
    async previewPlanChange(accountId, planId) {
      if (isDemoAccount(accountId)) throw new AppError("demo_account_protected");
      const { record, subscriptionId } = await changeTarget(accountId, planId);
      const providerNow = context.now() + record.clockOffsetMs;
      const prorationDate = Math.floor(providerNow / 1000) * 1000;
      const preview = await payments
        .previewPlanChange({
          subscriptionId,
          priceLookupKey: priceLookupKey(planId, BILLING_CURRENCY),
          prorationDate,
        })
        .catch((error: unknown) => {
          throw providerProblem(error);
        });
      const exp = Math.floor(context.now() / 1000) + PREVIEW_TTL_SEC;
      const previewToken = await context.signer.sign({
        purpose: PREVIEW_PURPOSE,
        exp,
        a: accountId,
        s: subscriptionId,
        p: planId,
        d: prorationDate,
        o: ids.next(),
      });
      const currency = preview.currency.toUpperCase();
      return {
        planId,
        amountDue: { amountMinor: preview.amountDueMinor, currency },
        credit: { amountMinor: preview.creditMinor, currency },
        lines: preview.lines.map((line) => ({
          description: line.description,
          amount: { amountMinor: line.amountMinor, currency },
        })),
        effectiveAt: toIsoString(prorationDate),
        nextRenewal: preview.nextRenewal
          ? {
              at: toIsoString(preview.nextRenewal.at),
              amount: { amountMinor: preview.nextRenewal.amountMinor, currency },
            }
          : null,
        previewToken,
        expiresAt: toIsoString(exp * 1000),
      };
    },

    async changePlan(accountId, input) {
      if (isDemoAccount(accountId)) throw new AppError("demo_account_protected");
      const { record, subscriptionId } = await changeTarget(accountId, input.planId);
      // Applied exactly as previewed: same proration date, and the preview's own operation id,
      // so a retried request never charges the proration twice. Without a token, a change is
      // previewed and applied at once (milestone 1's clients).
      let prorationDate = Math.floor((context.now() + record.clockOffsetMs) / 1000) * 1000;
      let operationId = `plan-change-${ids.next()}`;
      if (input.previewToken) {
        const verified = await context.signer.verify(input.previewToken, PREVIEW_PURPOSE);
        const claims = verified.valid ? verified.claims : null;
        if (
          !claims ||
          claims.a !== accountId ||
          claims.s !== subscriptionId ||
          claims.p !== input.planId ||
          typeof claims.d !== "number" ||
          typeof claims.o !== "string"
        ) {
          throw new AppError("checkout_state_conflict", {
            detail: "This preview no longer applies. Preview the change again.",
          });
        }
        prorationDate = claims.d;
        operationId = `plan-change-${claims.o}`;
      }
      const subscription = await providerCall(
        context,
        {
          id: operationId,
          attempt: await nextAttempt(context, operationId),
          kind: "plan_change",
          accountId,
        },
        (call) =>
          payments.changePlan(
            {
              subscriptionId,
              priceLookupKey: priceLookupKey(input.planId, BILLING_CURRENCY),
              prorationDate,
            },
            call,
          ),
        (changed) => changed.id,
      ).catch((error: unknown) => {
        throw providerProblem(error);
      });
      const current = getPlan(record.planId ?? input.planId);
      const next = getPlan(input.planId);
      if (next.maxStreams < current.maxStreams) {
        for (const lease of (await deps.streamGate.list(accountId)).slice(next.maxStreams)) {
          await deps.streamGate.release(accountId, lease.playbackSessionId);
        }
      }
      logger.info("billing.plan_changed", { accountId, from: current.id, to: next.id });
      return membershipAfter(accountId, subscription);
    },

    async cancel(accountId) {
      if (isDemoAccount(accountId)) throw new AppError("demo_account_protected");
      const record = await requireProviderMembership(accountId);
      const subscriptionId = record.providerSubscriptionId;
      if (!subscriptionId || !ENTITLED_STATUSES.has(record.status) || record.cancelAtPeriodEnd) {
        return (await snapshot(accountId)).legacy;
      }
      const subscription = await providerCall(
        context,
        { id: `cancel-${ids.next()}`, attempt: 1, kind: "cancel", accountId },
        (call) => payments.setCancelAtPeriodEnd({ subscriptionId, cancelAtPeriodEnd: true }, call),
      ).catch((error: unknown) => {
        throw providerProblem(error);
      });
      return membershipAfter(accountId, subscription);
    },

    async resume(accountId) {
      const record = await requireProviderMembership(accountId);
      const subscriptionId = record.providerSubscriptionId;
      if (subscriptionId && record.cancelAtPeriodEnd && ENTITLED_STATUSES.has(record.status)) {
        const subscription = await providerCall(
          context,
          { id: `resume-${ids.next()}`, attempt: 1, kind: "resume", accountId },
          (call) =>
            payments.setCancelAtPeriodEnd({ subscriptionId, cancelAtPeriodEnd: false }, call),
        ).catch((error: unknown) => {
          throw providerProblem(error);
        });
        return membershipAfter(accountId, subscription);
      }
      const current = await snapshot(accountId);
      if (current.entitlement.entitled) return current.legacy;
      // An ended membership restarts through a new checkout (no second trial).
      throw new AppError("checkout_state_conflict", {
        detail: "This membership has ended. Start a new checkout to restart it.",
      });
    },

    // --- Card replacement (§5.4) ----------------------------------------------------------------
    async setupPaymentMethod(accountId) {
      if (isDemoAccount(accountId)) throw new AppError("demo_account_protected");
      await requireProviderMembership(accountId);
      const customerId = await customerFor(accountId);
      const id = ids.next();
      const setupId = await newSetup(accountId, customerId, `card-${id}`);
      const now = context.now();
      const record: PaymentMethodSetupRecord = {
        id,
        accountId,
        provider,
        providerSetupId: setupId,
        providerPaymentMethodId: null,
        status: "requires_confirmation",
        attempt: 1,
        createdAt: now,
        updatedAt: now,
      };
      await repos.billing.saveSetup(record);
      const setup = await payments.retrieveSetup(setupId);
      return presentSetup(record, setup?.clientSecret ?? null);
    },

    async getPaymentMethodSetup(accountId, setupId) {
      const record = await repos.billing.getSetup(accountId, setupId);
      if (!record) throw new AppError("not_found", { detail: "No such card change" });
      // Polling reads the provider (the event may not have arrived yet).
      if (record.status === "requires_confirmation" || record.status === "processing") {
        await completeSetup(record.providerSetupId);
      }
      const current = (await repos.billing.getSetup(accountId, setupId)) ?? record;
      const setup =
        current.status === "requires_confirmation"
          ? await payments.retrieveSetup(current.providerSetupId)
          : null;
      return presentSetup(current, setup?.clientSecret ?? null);
    },

    async listInvoices(accountId, page) {
      const limit = Math.min(Math.max(page.limit ?? 20, 1), 100);
      let cursor: { t: number; i: string } | null = null;
      if (page.cursor) {
        cursor = decodeCursor(page.cursor, z.object({ t: z.number().int(), i: z.string() }));
        if (!cursor) throw invalidCursor();
      }
      const rows = await repos.billing.listInvoices(accountId, {
        limit: limit + 1,
        before: cursor ? { issuedAt: cursor.t, id: cursor.i } : null,
      });
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      return {
        items: items.map(presentInvoice),
        nextCursor:
          rows.length > limit && last ? encodeCursor({ t: last.issuedAt, i: last.id }) : null,
      };
    },

    async validatePromotion(input) {
      const found = await promotionFor(input.code, input.planId);
      const promotion = found?.promotion;
      if (!promotion) throw new AppError("promotion_code_invalid", { promotionReason: "unknown" });
      const price = getPlan(input.planId).monthlyPrice;
      const discounted =
        promotion.percentOff !== null
          ? price.amountMinor - Math.round((price.amountMinor * promotion.percentOff) / 100)
          : Math.max(0, price.amountMinor - (promotion.amountOffMinor ?? 0));
      const applied = presentPromotion(promotion);
      if (!applied) throw new AppError("promotion_code_invalid", { promotionReason: "unknown" });
      return {
        promotion: applied,
        price,
        discountedPrice: { amountMinor: discounted, currency: price.currency },
      };
    },

    // --- Provider events (§5.3) -----------------------------------------------------------------
    async receiveWebhook(webhookProvider, body, signature) {
      if (webhookProvider !== provider) {
        throw new AppError("not_found", { detail: "No such payment provider" });
      }
      let event: Awaited<ReturnType<typeof payments.parseWebhook>>;
      try {
        event = await payments.parseWebhook(body, signature);
      } catch (error) {
        if (error instanceof WebhookSignatureError) {
          // Never logged: the body. Unverified input stops here, before anything is stored.
          logger.warn("billing.webhook_rejected", { provider, reason: error.message });
          throw new AppError("webhook_signature_invalid");
        }
        throw error;
      }
      const { duplicate } = await recordProviderEvent(context, event, "webhook");
      return { received: true, duplicate };
    },

    async syncAccount(accountId) {
      const record = await repos.billing.getMembership(accountId);
      const subscriptionId =
        record?.providerSubscriptionId ??
        (await repos.billing.findOpenCheckout(accountId, context.now()))?.providerSubscriptionId;
      if (!subscriptionId) return null;
      await syncSubscription(context, subscriptionId, accountId);
      return snapshot(accountId);
    },

    reconcile: () => reconcile(context),

    async advanceClock(accountId, seconds) {
      if (deps.config.environment === "production" || !payments.advanceTestClock) {
        throw new AppError("not_found", { detail: "No test clock here" });
      }
      const customer = await repos.billing.getCustomer(accountId, provider);
      if (!customer) {
        throw new AppError("not_found", { detail: "This account has no customer at the provider" });
      }
      const now = await payments.advanceTestClock(customer.customerId, seconds);
      await service.syncAccount(accountId);
      return { now: toIsoString(now) };
    },

    // --- Staff ----------------------------------------------------------------------------------
    async memberBilling(accountId) {
      const current = await snapshot(accountId);
      const invoices = await repos.billing.listInvoices(accountId, { limit: 10, before: null });
      return {
        membership: current.state,
        entitlement: current.entitlement,
        recentInvoices: invoices.map(presentInvoice),
      };
    },

    async refundInvoice(input) {
      const invoice = await repos.billing.getInvoice(input.accountId, input.invoiceId);
      if (!invoice) throw new AppError("not_found", { detail: "No such invoice" });
      const remaining = invoice.amountPaidMinor - invoice.amountRefundedMinor;
      const amountMinor = input.amount?.amountMinor ?? remaining;
      if (
        remaining <= 0 ||
        amountMinor <= 0 ||
        amountMinor > remaining ||
        (input.amount && input.amount.currency.toUpperCase() !== invoice.currency.toUpperCase())
      ) {
        throw new AppError("checkout_state_conflict", {
          detail: "Nothing to refund for that amount on this invoice.",
        });
      }
      const id = ids.next();
      const now = context.now();
      const base = {
        id,
        accountId: input.accountId,
        invoiceId: invoice.id,
        provider,
        providerRefundId: null,
        amountMinor,
        currency: invoice.currency,
        status: "pending" as const,
        reason: input.reason,
        staffSubject: input.staffSubject,
        createdAt: now,
        updatedAt: now,
      };
      await repos.billing.saveRefund(base);
      const refund = await providerCall(
        context,
        { id: `refund-${id}`, attempt: 1, kind: "refund", accountId: input.accountId },
        (call) =>
          payments.refund(
            {
              invoiceId: invoice.providerInvoiceId,
              amountMinor: input.amount ? amountMinor : null,
            },
            call,
          ),
        (created) => created.id,
      ).catch(async (error: unknown) => {
        await repos.billing.saveRefund({ ...base, status: "failed", updatedAt: context.now() });
        throw providerProblem(error);
      });
      const stored = {
        ...base,
        providerRefundId: refund.id,
        amountMinor: refund.amountMinor,
        status: refund.status,
        updatedAt: context.now(),
      };
      await repos.billing.saveRefund(stored);
      const updated = await payments.retrieveInvoice(invoice.providerInvoiceId);
      if (updated) await storeInvoice(context, updated);
      logger.info("billing.refunded", {
        accountId: input.accountId,
        invoiceId: invoice.id,
        amountMinor,
      });
      return presentRefund(stored);
    },

    async cancelForStaff(input) {
      if (isDemoAccount(input.accountId)) throw new AppError("demo_account_protected");
      const record = await requireProviderMembership(input.accountId);
      const subscriptionId = record.providerSubscriptionId;
      if (!subscriptionId)
        throw new AppError("subscription_required", { subscriptionStatus: "ended" });
      if (input.when === "period_end") {
        await providerCall(
          context,
          {
            id: `staff-cancel-${ids.next()}`,
            attempt: 1,
            kind: "cancel",
            accountId: input.accountId,
          },
          (call) =>
            payments.setCancelAtPeriodEnd({ subscriptionId, cancelAtPeriodEnd: true }, call),
        ).catch((error: unknown) => {
          throw providerProblem(error);
        });
      } else {
        await providerCall(
          context,
          {
            id: `staff-cancel-now-${ids.next()}`,
            attempt: 1,
            kind: "cancel_now",
            accountId: input.accountId,
          },
          (call) => payments.cancelNow({ subscriptionId }, call),
        ).catch((error: unknown) => {
          throw providerProblem(error);
        });
        if (
          input.refundUnused &&
          record.latestInvoiceId &&
          record.currentPeriodEnd &&
          record.currentPeriodStart
        ) {
          const invoice = await payments.retrieveInvoice(record.latestInvoiceId);
          const providerNow = context.now() + record.clockOffsetMs;
          const span = record.currentPeriodEnd - record.currentPeriodStart;
          const unused = span > 0 ? Math.max(0, record.currentPeriodEnd - providerNow) / span : 0;
          const amount = invoice
            ? Math.floor((invoice.amountPaidMinor - invoice.amountRefundedMinor) * unused)
            : 0;
          const stored = invoice
            ? await repos.billing.listInvoices(input.accountId, { limit: 50, before: null })
            : [];
          const local = stored.find((candidate) => candidate.providerInvoiceId === invoice?.id);
          if (local && amount > 0) {
            await service.refundInvoice({
              accountId: input.accountId,
              invoiceId: local.id,
              amount: { amountMinor: amount, currency: local.currency },
              reason: input.reason,
              staffSubject: input.staffSubject,
            });
          }
        }
      }
      await syncSubscription(context, subscriptionId, input.accountId);
      return (await snapshot(input.accountId)).state;
    },

    async extendTrial(input) {
      const record = await requireProviderMembership(input.accountId);
      const subscriptionId = record.providerSubscriptionId;
      if (!subscriptionId || record.status !== "trialing" || record.trialEndsAt === null) {
        throw new AppError("checkout_state_conflict", { detail: "There is no running trial." });
      }
      const trialEnd = record.trialEndsAt + input.days * 24 * 3_600_000;
      await providerCall(
        context,
        {
          id: `extend-trial-${ids.next()}`,
          attempt: 1,
          kind: "trial_end",
          accountId: input.accountId,
        },
        (call) => payments.setTrialEnd({ subscriptionId, trialEnd }, call),
      ).catch((error: unknown) => {
        throw providerProblem(error);
      });
      await syncSubscription(context, subscriptionId, input.accountId);
      return (await snapshot(input.accountId)).state;
    },

    async grantComplimentaryPeriod(input) {
      const record = await requireProviderMembership(input.accountId);
      const subscriptionId = record.providerSubscriptionId;
      if (!subscriptionId || !ENTITLED_STATUSES.has(record.status)) {
        throw new AppError("subscription_required", {
          subscriptionStatus: "ended",
          membershipStatus: record.status,
        });
      }
      // Nothing is charged until the free period ends (the provider's trial mechanism).
      const providerNow = context.now() + record.clockOffsetMs;
      const from = Math.max(
        providerNow,
        record.currentPeriodEnd ?? providerNow,
        record.trialEndsAt ?? 0,
      );
      const trialEnd = from + input.days * 24 * 3_600_000;
      await providerCall(
        context,
        {
          id: `complimentary-${ids.next()}`,
          attempt: 1,
          kind: "trial_end",
          accountId: input.accountId,
        },
        (call) => payments.setTrialEnd({ subscriptionId, trialEnd }, call),
      ).catch((error: unknown) => {
        throw providerProblem(error);
      });
      await syncSubscription(context, subscriptionId, input.accountId);
      return (await snapshot(input.accountId)).state;
    },

    async listAdminPlans() {
      const prices = await planPrices();
      const synced = new Map(
        (await repos.billing.listProviderPrices(provider)).map((price) => [price.lookupKey, price]),
      );
      return {
        items: PLAN_CATALOG.map((plan) => ({
          id: plan.id,
          name: plan.name,
          maxStreams: plan.maxStreams,
          maxQuality: plan.maxQuality,
          trialDays: TRIAL_DAYS,
          prices: prices
            .filter((price) => price.planId === plan.id)
            .map((price) => {
              const atProvider = synced.get(price.lookupKey);
              return {
                currency: price.currency,
                amountMinor: price.amountMinor,
                lookupKey: price.lookupKey,
                active: price.active,
                syncedAt:
                  atProvider && atProvider.amountMinor === price.amountMinor
                    ? toIsoString(atProvider.syncedAt)
                    : null,
              };
            }),
        })),
      };
    },

    async setPlanPrice(input) {
      if (!(PLAN_IDS as readonly string[]).includes(input.planId)) {
        throw new AppError("not_found", { detail: "No such plan" });
      }
      const currency = input.currency.toUpperCase();
      await repos.billing.savePlanPrice({
        planId: input.planId,
        currency,
        amountMinor: input.amountMinor,
        lookupKey: priceLookupKey(input.planId, currency),
        active: true,
        updatedAt: context.now(),
      });
      const plans = await service.listAdminPlans();
      const plan = plans.items.find((candidate) => candidate.id === input.planId);
      if (!plan) throw new AppError("not_found", { detail: "No such plan" });
      return plan;
    },

    async syncPlans() {
      try {
        const result = await syncCatalogue();
        catalogue = Promise.resolve();
        return result;
      } catch (error) {
        logger.warn("billing.catalogue_sync_failed", { error: serializeError(error) });
        throw new AppError("service_unavailable", {
          detail: "The payment provider could not be reached. Try again.",
        });
      }
    },
  };

  return service;
}

/** The membership a snapshot reads (for playback's entitlement check). */
export { snapshotMembership };
