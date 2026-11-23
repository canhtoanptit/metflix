import { hexEncode, timingSafeEqual, utf8Decode, utf8Encode } from "../encoding.ts";
import { type Clock, systemClock } from "../ports/clock.ts";
import {
  type AmountPreview,
  type CatalogueEntry,
  type CatalogueSyncResult,
  type NextInvoicePreview,
  type PaymentFailureCode,
  type PaymentProvider,
  PaymentProviderError,
  type PaymentTestCard,
  type PromotionLookup,
  type ProrationPreview,
  type ProviderCall,
  type ProviderEvent,
  type ProviderInvoice,
  type ProviderPaymentMethod,
  type ProviderRefund,
  type ProviderSetup,
  type ProviderSubscription,
  WEBHOOK_TOLERANCE_SEC,
  WebhookSignatureError,
} from "../ports/payment-provider.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_MS = 30 * DAY_MS;

interface Customer {
  id: string;
  accountId: string;
  email: string;
  defaultPaymentMethodId: string | null;
  /** Credit from downgrades, applied to later invoices (minor units, >= 0). */
  creditMinor: number;
}

interface Price {
  id: string;
  lookupKey: string;
  productId: string;
  amountMinor: number;
  currency: string;
}

interface Promotion {
  id: string;
  code: string;
  percentOff: number | null;
  amountOffMinor: number | null;
  expiresAt: number | null;
  maxRedemptions: number | null;
  timesRedeemed: number;
  appliesTo: string[] | null;
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: PaymentProviderError };

/** Failures a replay returns as they were (the provider caches them under the key). */
const CACHED_FAILURES: ReadonlySet<PaymentFailureCode> = new Set([
  "card_declined",
  "insufficient_funds",
  "expired_card",
  "incorrect_cvc",
  "processing_error",
  "authentication_required",
  "not_found",
]);

const LAST4: Record<PaymentTestCard, string> = {
  visa: "4242",
  mastercard: "4444",
  declined: "0002",
  "charge-declined": "0341",
  "authentication-required": "3184",
};

const FINGERPRINTS: Record<PaymentTestCard, string> = {
  visa: "fp_mem_visa",
  mastercard: "fp_mem_mastercard",
  declined: "fp_mem_declined",
  "charge-declined": "fp_mem_charge_declined",
  "authentication-required": "fp_mem_3ds",
};

/**
 * In-process `PaymentProvider`: the port's reference behaviour, small and stateful, nothing a
 * real provider does not also do. The browser's part (confirming a setup or a first payment
 * with the provider's form) is `confirmSetup` / `confirmPayment`, which take test cards.
 * No clock-driven billing: renewals, retries and expiry are the fake provider's test clock.
 */
export class MemoryPaymentProvider implements PaymentProvider {
  readonly id = "fake" as const;
  readonly webhookSecret: string;
  private readonly clock: Clock;
  private readonly customers = new Map<string, Customer>();
  private readonly methods = new Map<string, ProviderPaymentMethod & { card: PaymentTestCard }>();
  private readonly setups = new Map<string, ProviderSetup>();
  private readonly subscriptions = new Map<string, ProviderSubscription>();
  private readonly invoices = new Map<string, ProviderInvoice & { clientSecret: string | null }>();
  private readonly prices = new Map<string, Price>();
  private readonly promotions = new Map<string, Promotion>();
  private readonly idempotency = new Map<string, { fingerprint: string; outcome: Outcome }>();
  private readonly events: ProviderEvent[] = [];
  private sequence = 0;

  constructor(options: { clock?: Clock; webhookSecret?: string } = {}) {
    this.clock = options.clock ?? systemClock;
    this.webhookSecret = options.webhookSecret ?? "whsec_memory_development_only";
  }

  // --- Customers and payment methods ----------------------------------------------------------

  createCustomer(input: { accountId: string; email: string }, call: ProviderCall) {
    return this.idempotent("createCustomer", input, call, () => {
      const id = this.newId("cus");
      this.customers.set(id, { id, ...input, defaultPaymentMethodId: null, creditMinor: 0 });
      this.emit("customer.created", { customerId: id }, call);
      return { id };
    });
  }

  deleteCustomer(input: { customerId: string }, call: ProviderCall): Promise<void> {
    return this.idempotent("deleteCustomer", input, call, () => {
      for (const subscription of this.subscriptions.values()) {
        if (subscription.customerId === input.customerId && subscription.status !== "canceled") {
          subscription.status = "canceled";
          subscription.endedAt = this.clock.now();
          this.emit("customer.subscription.deleted", { subscription }, call);
        }
      }
      if (this.customers.delete(input.customerId)) {
        this.emit("customer.deleted", { customerId: input.customerId }, call);
      }
      return undefined;
    });
  }

  createSetup(input: { customerId: string }, call: ProviderCall): Promise<ProviderSetup> {
    return this.idempotent("createSetup", input, call, () => {
      this.customer(input.customerId);
      const id = this.newId("seti");
      const setup: ProviderSetup = {
        id,
        customerId: input.customerId,
        status: "requires_confirmation",
        clientSecret: `${id}_secret_${this.sequence}`,
        paymentMethod: null,
        failureCode: null,
      };
      this.setups.set(id, setup);
      return setup;
    });
  }

  async retrieveSetup(setupId: string): Promise<ProviderSetup | null> {
    const setup = this.setups.get(setupId);
    return setup ? structuredClone(setup) : null;
  }

  setDefaultPaymentMethod(
    input: { customerId: string; paymentMethodId: string; subscriptionId: string | null },
    call: ProviderCall,
  ): Promise<void> {
    return this.idempotent("setDefaultPaymentMethod", input, call, () => {
      const customer = this.customer(input.customerId);
      if (!this.methods.has(input.paymentMethodId)) throw new PaymentProviderError("not_found");
      customer.defaultPaymentMethodId = input.paymentMethodId;
      if (input.subscriptionId) {
        const subscription = this.subscription(input.subscriptionId);
        subscription.defaultPaymentMethodId = input.paymentMethodId;
        this.emit("customer.subscription.updated", { subscription }, call);
      }
      return undefined;
    });
  }

  // --- Subscriptions --------------------------------------------------------------------------

  createSubscription(
    input: {
      customerId: string;
      priceLookupKey: string;
      paymentMethodId: string | null;
      trialDays: number | null;
      promotionId: string | null;
    },
    call: ProviderCall,
  ): Promise<ProviderSubscription> {
    return this.idempotent("createSubscription", input, call, () => {
      const customer = this.customer(input.customerId);
      const price = this.price(input.priceLookupKey);
      if (input.paymentMethodId && !this.methods.has(input.paymentMethodId)) {
        throw new PaymentProviderError("not_found", "unknown payment method");
      }
      const promotion = input.promotionId ? this.promotionById(input.promotionId) : null;
      if (promotion) promotion.timesRedeemed += 1;
      const now = this.clock.now();
      const id = this.newId("sub");
      const trial = input.trialDays !== null && input.trialDays > 0;
      const subscription: ProviderSubscription = {
        id,
        customerId: customer.id,
        status: trial ? "trialing" : "incomplete",
        priceLookupKey: price.lookupKey,
        cancelAtPeriodEnd: false,
        trialEnd: trial ? now + (input.trialDays ?? 0) * DAY_MS : null,
        currentPeriodStart: now,
        currentPeriodEnd: trial ? now + (input.trialDays ?? 0) * DAY_MS : now + PERIOD_MS,
        endedAt: null,
        latestInvoiceId: null,
        defaultPaymentMethodId: input.paymentMethodId,
        defaultPaymentMethod: null,
        paymentClientSecret: null,
        clockNow: null,
      };
      // Like Stripe's `default_incomplete`: a trial invoices nothing; otherwise the browser
      // confirms the first payment (where a challenge happens), whatever card is on file.
      const total = trial ? 0 : this.discounted(price.amountMinor, promotion);
      // The customer's credit (a downgrade's) pays first, as at the provider.
      const credit = Math.min(total, customer.creditMinor);
      customer.creditMinor -= credit;
      const amount = total - credit;
      const invoice = this.newInvoice(subscription, {
        totalMinor: total,
        currency: price.currency,
        billingReason: "subscription_create",
        periodStart: subscription.currentPeriodStart,
        periodEnd: subscription.currentPeriodEnd,
        discountMinor: trial ? 0 : price.amountMinor - total,
        creditAppliedMinor: credit,
      });
      if (amount === 0) {
        this.markPaid(invoice, 0);
      } else {
        invoice.clientSecret = `${invoice.id}_secret_${this.sequence}`;
        subscription.paymentClientSecret = invoice.clientSecret;
      }
      subscription.latestInvoiceId = invoice.id;
      this.subscriptions.set(id, subscription);
      this.emit("customer.subscription.created", { subscription, invoiceId: invoice.id }, call);
      if (invoice.status === "paid")
        this.emit("invoice.paid", { subscription, invoiceId: invoice.id }, call);
      return subscription;
    });
  }

  async retrieveSubscription(subscriptionId: string): Promise<ProviderSubscription | null> {
    const subscription = this.subscriptions.get(subscriptionId);
    return subscription ? this.publicSubscription(subscription) : null;
  }

  async previewPlanChange(input: {
    subscriptionId: string;
    priceLookupKey: string;
    prorationDate: number;
  }): Promise<ProrationPreview> {
    return structuredClone(this.prorate(input));
  }

  async previewNextInvoice(subscriptionId: string): Promise<NextInvoicePreview | null> {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription || subscription.cancelAtPeriodEnd) return null;
    if (!["trialing", "active", "past_due"].includes(subscription.status)) return null;
    const at =
      subscription.status === "trialing" ? subscription.trialEnd : subscription.currentPeriodEnd;
    if (at === null) return null;
    const price = this.price(subscription.priceLookupKey);
    const customer = this.customer(subscription.customerId);
    const credit = Math.min(price.amountMinor, customer.creditMinor);
    return {
      at,
      amountMinor: price.amountMinor - credit,
      currency: price.currency,
      creditAppliedMinor: credit,
      discountMinor: 0,
    };
  }

  async previewFirstInvoice(input: {
    customerId: string;
    priceLookupKey: string;
    promotionId: string | null;
  }): Promise<AmountPreview> {
    const customer = this.customer(input.customerId);
    const price = this.price(input.priceLookupKey);
    const promotion = input.promotionId
      ? ([...this.promotions.values()].find((entry) => entry.id === input.promotionId) ?? null)
      : null;
    const total = this.discounted(price.amountMinor, promotion);
    const credit = Math.min(total, customer.creditMinor);
    return {
      amountMinor: total - credit,
      currency: price.currency,
      creditAppliedMinor: credit,
      discountMinor: price.amountMinor - total,
    };
  }

  changePlan(
    input: { subscriptionId: string; priceLookupKey: string; prorationDate: number },
    call: ProviderCall,
  ): Promise<ProviderSubscription> {
    return this.idempotent("changePlan", input, call, () => {
      const subscription = this.subscription(input.subscriptionId);
      const customer = this.customer(subscription.customerId);
      const preview = this.prorate(input);
      const invoice = this.newInvoice(subscription, {
        totalMinor: preview.lines.reduce((sum, line) => sum + line.amountMinor, 0),
        currency: preview.currency,
        billingReason: "subscription_update",
        periodStart: input.prorationDate,
        periodEnd: subscription.currentPeriodEnd,
      });
      if (preview.amountDueMinor > 0) {
        // Like `pending_if_incomplete`: the plan changes only once the proration is paid.
        try {
          this.charge(subscription.defaultPaymentMethodId ?? customer.defaultPaymentMethodId);
        } catch (error) {
          this.invoices.delete(invoice.id);
          throw error;
        }
        this.markPaid(invoice, preview.amountDueMinor);
      } else {
        customer.creditMinor += preview.creditMinor;
        this.markPaid(invoice, 0);
      }
      subscription.priceLookupKey = input.priceLookupKey;
      subscription.latestInvoiceId = invoice.id;
      this.emit("invoice.paid", { subscription, invoiceId: invoice.id }, call);
      this.emit("customer.subscription.updated", { subscription }, call);
      return subscription;
    });
  }

  setCancelAtPeriodEnd(
    input: { subscriptionId: string; cancelAtPeriodEnd: boolean },
    call: ProviderCall,
  ): Promise<ProviderSubscription> {
    return this.idempotent("setCancelAtPeriodEnd", input, call, () => {
      const subscription = this.subscription(input.subscriptionId);
      if (subscription.status === "canceled") throw new PaymentProviderError("invalid_request");
      subscription.cancelAtPeriodEnd = input.cancelAtPeriodEnd;
      this.emit("customer.subscription.updated", { subscription }, call);
      return subscription;
    });
  }

  setTrialEnd(
    input: { subscriptionId: string; trialEnd: number },
    call: ProviderCall,
  ): Promise<ProviderSubscription> {
    return this.idempotent("setTrialEnd", input, call, () => {
      const subscription = this.subscription(input.subscriptionId);
      if (subscription.status === "canceled" || input.trialEnd <= this.clock.now()) {
        throw new PaymentProviderError("invalid_request", "cannot move that trial end");
      }
      subscription.status = "trialing";
      subscription.trialEnd = input.trialEnd;
      subscription.currentPeriodEnd = input.trialEnd;
      this.emit("customer.subscription.updated", { subscription }, call);
      return subscription;
    });
  }

  cancelNow(input: { subscriptionId: string }, call: ProviderCall): Promise<ProviderSubscription> {
    return this.idempotent("cancelNow", input, call, () => {
      const subscription = this.subscription(input.subscriptionId);
      subscription.status = "canceled";
      subscription.cancelAtPeriodEnd = false;
      subscription.endedAt = this.clock.now();
      subscription.paymentClientSecret = null;
      this.emit("customer.subscription.deleted", { subscription }, call);
      return subscription;
    });
  }

  // --- Invoices and refunds -------------------------------------------------------------------

  async retrieveInvoice(invoiceId: string): Promise<ProviderInvoice | null> {
    const invoice = this.invoices.get(invoiceId);
    return invoice ? this.publicInvoice(invoice) : null;
  }

  async listInvoices(input: { customerId: string; limit: number }): Promise<ProviderInvoice[]> {
    return [...this.invoices.values()]
      .filter((invoice) => invoice.customerId === input.customerId)
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
      .slice(0, input.limit)
      .map((invoice) => this.publicInvoice(invoice));
  }

  payInvoice(input: { invoiceId: string }, call: ProviderCall): Promise<ProviderInvoice> {
    return this.idempotent("payInvoice", input, call, () => {
      const invoice = this.invoice(input.invoiceId);
      if (invoice.status !== "open")
        throw new PaymentProviderError("invalid_request", "invoice is not open");
      const customer = this.customer(invoice.customerId);
      const subscription = invoice.subscriptionId
        ? this.subscriptions.get(invoice.subscriptionId)
        : undefined;
      invoice.attemptCount += 1;
      try {
        this.charge(subscription?.defaultPaymentMethodId ?? customer.defaultPaymentMethodId);
      } catch (error) {
        if (subscription && subscription.status === "active") subscription.status = "past_due";
        this.emit("invoice.payment_failed", { subscription, invoiceId: invoice.id }, call);
        throw error;
      }
      this.markPaid(invoice, invoice.amountDueMinor);
      if (
        subscription &&
        (subscription.status === "past_due" || subscription.status === "incomplete")
      ) {
        subscription.status = "active";
        subscription.paymentClientSecret = null;
      }
      this.emit("invoice.paid", { subscription, invoiceId: invoice.id }, call);
      return this.publicInvoice(invoice);
    });
  }

  refund(
    input: { invoiceId: string; amountMinor: number | null },
    call: ProviderCall,
  ): Promise<ProviderRefund> {
    return this.idempotent("refund", input, call, () => {
      const invoice = this.invoice(input.invoiceId);
      const remaining = invoice.amountPaidMinor - invoice.amountRefundedMinor;
      const amount = input.amountMinor ?? remaining;
      if (
        invoice.status !== "paid" ||
        amount <= 0 ||
        amount > remaining ||
        !Number.isInteger(amount)
      ) {
        throw new PaymentProviderError("invalid_request", "nothing to refund for that amount");
      }
      invoice.amountRefundedMinor += amount;
      const refund: ProviderRefund = {
        id: this.newId("re"),
        invoiceId: invoice.id,
        amountMinor: amount,
        currency: invoice.currency,
        status: "succeeded",
      };
      this.emit("charge.refunded", { invoiceId: invoice.id, customerId: invoice.customerId }, call);
      return refund;
    });
  }

  // --- Promotions and catalogue ---------------------------------------------------------------

  async validatePromotionCode(input: {
    code: string;
    priceLookupKey: string;
  }): Promise<PromotionLookup> {
    const promotion = this.promotions.get(input.code.toUpperCase());
    if (!promotion) return { valid: false, reason: "unknown" };
    if (promotion.expiresAt !== null && promotion.expiresAt <= this.clock.now()) {
      return { valid: false, reason: "expired" };
    }
    if (promotion.maxRedemptions !== null && promotion.timesRedeemed >= promotion.maxRedemptions) {
      return { valid: false, reason: "exhausted" };
    }
    if (promotion.appliesTo && !promotion.appliesTo.includes(input.priceLookupKey)) {
      return { valid: false, reason: "not_applicable" };
    }
    return {
      valid: true,
      promotionId: promotion.id,
      code: promotion.code,
      percentOff: promotion.percentOff,
      amountOffMinor: promotion.amountOffMinor,
      currency: promotion.amountOffMinor === null ? null : "USD",
      duration: "once",
      durationInMonths: null,
    };
  }

  async syncCatalogue(entries: readonly CatalogueEntry[]): Promise<CatalogueSyncResult> {
    const result: CatalogueSyncResult = { created: 0, updated: 0, archived: 0, unchanged: 0 };
    for (const entry of entries) {
      const existing = this.prices.get(entry.lookupKey);
      if (
        existing &&
        existing.amountMinor === entry.amountMinor &&
        existing.currency === entry.currency
      ) {
        result.unchanged += 1;
        continue;
      }
      // A changed amount is a new price that takes over the lookup key; the old one is archived.
      if (existing) result.archived += 1;
      this.prices.set(entry.lookupKey, {
        id: this.newId("price"),
        lookupKey: entry.lookupKey,
        productId: entry.productId,
        amountMinor: entry.amountMinor,
        currency: entry.currency,
      });
      result.created += 1;
    }
    return result;
  }

  // --- Webhooks and events --------------------------------------------------------------------

  async parseWebhook(rawBody: Uint8Array, signatureHeader: string | null): Promise<ProviderEvent> {
    const parts = new Map<string, string[]>();
    for (const item of (signatureHeader ?? "").split(",")) {
      const [key = "", value = ""] = item.split("=", 2);
      parts.set(key.trim(), [...(parts.get(key.trim()) ?? []), value.trim()]);
    }
    const timestamp = Number(parts.get("t")?.[0]);
    if (!Number.isInteger(timestamp)) throw new WebhookSignatureError("no timestamp");
    if (Math.abs(this.clock.now() / 1000 - timestamp) > WEBHOOK_TOLERANCE_SEC) {
      throw new WebhookSignatureError("timestamp outside the tolerance");
    }
    const expected = utf8Encode(await this.signature(timestamp, rawBody));
    const valid = (parts.get("v1") ?? []).some((candidate) =>
      timingSafeEqual(utf8Encode(candidate), expected),
    );
    if (!valid) throw new WebhookSignatureError("signature mismatch");
    const event = JSON.parse(utf8Decode(rawBody)) as ProviderEvent;
    return { ...event };
  }

  async listEvents(input: { createdAfter: number; limit: number }): Promise<ProviderEvent[]> {
    return this.events
      .filter((event) => event.createdAt > input.createdAfter)
      .slice(0, input.limit)
      .map((event) => ({ ...event }));
  }

  // --- The browser's part and test helpers ----------------------------------------------------

  /** The provider's form confirming a setup with a test card. */
  async confirmSetup(clientSecret: string, card: PaymentTestCard): Promise<ProviderSetup> {
    const setup = [...this.setups.values()].find(
      (candidate) => candidate.clientSecret === clientSecret,
    );
    if (setup?.status !== "requires_confirmation") throw new PaymentProviderError("not_found");
    if (card === "declined") {
      setup.status = "failed";
      setup.failureCode = "card_declined";
      return structuredClone(setup);
    }
    const method: ProviderPaymentMethod = {
      id: this.newId("pm"),
      brand: card === "mastercard" ? "mastercard" : "visa",
      last4: LAST4[card],
      expMonth: 12,
      expYear: new Date(this.clock.now()).getUTCFullYear() + 3,
      fingerprint: FINGERPRINTS[card],
      wallet: null,
    };
    this.methods.set(method.id, { ...method, card });
    setup.status = "succeeded";
    setup.clientSecret = null;
    setup.paymentMethod = method;
    this.emit("setup_intent.succeeded", { customerId: setup.customerId, setupId: setup.id }, null);
    return structuredClone(setup);
  }

  /** The provider's form paying a first invoice on-session (a challenge is completed there). */
  async confirmPayment(clientSecret: string, card: PaymentTestCard): Promise<ProviderInvoice> {
    const invoice = [...this.invoices.values()].find(
      (candidate) => candidate.clientSecret === clientSecret,
    );
    if (invoice?.status !== "open") throw new PaymentProviderError("not_found");
    if (card === "declined" || card === "charge-declined") {
      invoice.attemptCount += 1;
      throw new PaymentProviderError("card_declined");
    }
    this.markPaid(invoice, invoice.amountDueMinor);
    invoice.clientSecret = null;
    const subscription = invoice.subscriptionId
      ? this.subscriptions.get(invoice.subscriptionId)
      : undefined;
    if (subscription) {
      subscription.status = "active";
      subscription.paymentClientSecret = null;
    }
    this.emit("invoice.paid", { subscription, invoiceId: invoice.id }, null);
    return this.publicInvoice(invoice);
  }

  definePromotion(input: {
    code: string;
    percentOff?: number;
    amountOffMinor?: number;
    expiresAt?: number;
    maxRedemptions?: number;
    appliesTo?: string[];
  }): void {
    this.promotions.set(input.code.toUpperCase(), {
      id: this.newId("promo"),
      code: input.code.toUpperCase(),
      percentOff: input.percentOff ?? null,
      amountOffMinor: input.amountOffMinor ?? null,
      expiresAt: input.expiresAt ?? null,
      maxRedemptions: input.maxRedemptions ?? null,
      timesRedeemed: 0,
      appliesTo: input.appliesTo ?? null,
    });
  }

  /** A signed delivery of `event` as the provider would send it (`Stripe-Signature` format). */
  async signedDelivery(
    event: ProviderEvent,
    options: { ageSec?: number } = {},
  ): Promise<{ body: Uint8Array; signature: string }> {
    const body = utf8Encode(JSON.stringify(event));
    const timestamp = Math.floor(this.clock.now() / 1000) - (options.ageSec ?? 0);
    return { body, signature: `t=${timestamp},v1=${await this.signature(timestamp, body)}` };
  }

  // --- Internals ------------------------------------------------------------------------------

  private async idempotent<T>(
    method: string,
    params: unknown,
    call: ProviderCall,
    run: () => T,
  ): Promise<T> {
    if (call.idempotencyKey.length === 0 || call.idempotencyKey.length > 255) {
      throw new PaymentProviderError("invalid_request", "idempotency key must be 1-255 characters");
    }
    const fingerprint = `${method}:${JSON.stringify(params)}`;
    const previous = this.idempotency.get(call.idempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new PaymentProviderError("idempotency_conflict", "key reused with other parameters");
      }
      if (!previous.outcome.ok) throw previous.outcome.error;
      return structuredClone(previous.outcome.value) as T;
    }
    try {
      const value = run();
      this.idempotency.set(call.idempotencyKey, {
        fingerprint,
        outcome: { ok: true, value: structuredClone(value) },
      });
      return structuredClone(value);
    } catch (error) {
      if (error instanceof PaymentProviderError && CACHED_FAILURES.has(error.code)) {
        this.idempotency.set(call.idempotencyKey, { fingerprint, outcome: { ok: false, error } });
      }
      throw error;
    }
  }

  /** An off-session charge (renewals, prorations, explicit attempts) with a stored card. */
  private charge(paymentMethodId: string | null): void {
    const method = paymentMethodId ? this.methods.get(paymentMethodId) : undefined;
    if (!method) throw new PaymentProviderError("card_declined", "no payment method");
    if (method.card === "declined" || method.card === "charge-declined") {
      throw new PaymentProviderError("card_declined");
    }
    if (method.card === "authentication-required") {
      throw new PaymentProviderError("authentication_required");
    }
  }

  private prorate(input: {
    subscriptionId: string;
    priceLookupKey: string;
    prorationDate: number;
  }): ProrationPreview {
    const subscription = this.subscription(input.subscriptionId);
    const customer = this.customer(subscription.customerId);
    const current = this.price(subscription.priceLookupKey);
    const next = this.price(input.priceLookupKey);
    const start = subscription.currentPeriodStart ?? input.prorationDate;
    const end = subscription.currentPeriodEnd ?? input.prorationDate;
    const lines: { description: string; amountMinor: number }[] = [];
    if (subscription.status === "active" || subscription.status === "past_due") {
      const fraction =
        end > start ? Math.min(1, Math.max(0, (end - input.prorationDate) / (end - start))) : 0;
      lines.push(
        {
          description: `Unused time on ${current.lookupKey}`,
          amountMinor: -Math.round(current.amountMinor * fraction),
        },
        {
          description: `Remaining time on ${next.lookupKey}`,
          amountMinor: Math.round(next.amountMinor * fraction),
        },
      );
    }
    const total = lines.reduce((sum, line) => sum + line.amountMinor, 0);
    const charged = lines.reduce((sum, line) => sum + Math.max(0, line.amountMinor), 0);
    const credit = Math.max(0, -total);
    const amountDue = Math.max(0, total);
    const renewal = Math.max(0, next.amountMinor - customer.creditMinor - credit);
    return {
      currency: next.currency,
      amountDueMinor: amountDue,
      creditAppliedMinor: charged - amountDue,
      discountMinor: 0,
      creditMinor: credit,
      lines,
      prorationDate: input.prorationDate,
      nextRenewal:
        subscription.currentPeriodEnd === null
          ? null
          : {
              at: subscription.currentPeriodEnd,
              amountMinor: renewal,
              creditAppliedMinor: next.amountMinor - renewal,
              discountMinor: 0,
            },
    };
  }

  private discounted(amountMinor: number, promotion: Promotion | null): number {
    if (!promotion) return amountMinor;
    if (promotion.percentOff !== null)
      // Stripe rounds the discount, not the total (docs/STRIPE.md §7: 50% off 799 is 399).
      return amountMinor - Math.round((amountMinor * promotion.percentOff) / 100);
    return Math.max(0, amountMinor - (promotion.amountOffMinor ?? 0));
  }

  private newInvoice(
    subscription: ProviderSubscription,
    input: {
      totalMinor: number;
      currency: string;
      billingReason: ProviderInvoice["billingReason"];
      periodStart: number | null;
      periodEnd: number | null;
      discountMinor?: number;
      creditAppliedMinor?: number;
    },
  ): ProviderInvoice & { clientSecret: string | null } {
    const invoice = {
      id: this.newId("in"),
      customerId: subscription.customerId,
      subscriptionId: subscription.id,
      number: `MEM-${String(this.sequence).padStart(6, "0")}`,
      status: "open" as const,
      currency: input.currency,
      totalMinor: input.totalMinor,
      amountPaidMinor: 0,
      amountDueMinor: Math.max(0, input.totalMinor - (input.creditAppliedMinor ?? 0)),
      amountRefundedMinor: 0,
      billingReason: input.billingReason,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      createdAt: this.clock.now(),
      paidAt: null,
      attemptCount: 0,
      nextPaymentAttempt: null,
      hostedUrl: null,
      pdfUrl: null,
      discountMinor: input.discountMinor ?? 0,
      creditAppliedMinor: input.creditAppliedMinor ?? 0,
      clientSecret: null,
    };
    this.invoices.set(invoice.id, invoice);
    return invoice;
  }

  private markPaid(invoice: ProviderInvoice, amountMinor: number): void {
    (invoice as { status: ProviderInvoice["status"] }).status = "paid";
    invoice.amountPaidMinor = amountMinor;
    invoice.amountDueMinor = 0;
    invoice.paidAt = this.clock.now();
  }

  private publicSubscription(subscription: ProviderSubscription): ProviderSubscription {
    const method = subscription.defaultPaymentMethodId
      ? this.methods.get(subscription.defaultPaymentMethodId)
      : undefined;
    const { card: _card, ...display } = method ?? { card: null };
    return structuredClone({
      ...subscription,
      defaultPaymentMethod: method ? (display as ProviderPaymentMethod) : null,
    });
  }

  private publicInvoice(
    invoice: ProviderInvoice & { clientSecret: string | null },
  ): ProviderInvoice {
    const { clientSecret: _secret, ...rest } = invoice;
    return structuredClone(rest);
  }

  private emit(
    type: string,
    refs: {
      subscription?: ProviderSubscription | undefined;
      invoiceId?: string;
      customerId?: string;
      setupId?: string;
    },
    call: ProviderCall | null,
  ): void {
    this.events.push({
      id: this.newId("evt"),
      type,
      createdAt: this.clock.now(),
      occurredAt: this.clock.now(),
      customerId: refs.customerId ?? refs.subscription?.customerId ?? null,
      subscriptionId: refs.subscription?.id ?? null,
      invoiceId: refs.invoiceId ?? null,
      setupId: refs.setupId ?? null,
      idempotencyKey: call?.idempotencyKey ?? null,
    });
  }

  private async signature(timestamp: number, body: Uint8Array): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      utf8Encode(this.webhookSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signed = new Uint8Array([...utf8Encode(`${timestamp}.`), ...body]);
    return hexEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, signed)));
  }

  private newId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_mem${String(this.sequence).padStart(8, "0")}`;
  }

  private customer(id: string): Customer {
    const customer = this.customers.get(id);
    if (!customer) throw new PaymentProviderError("not_found", "no such customer");
    return customer;
  }

  private subscription(id: string): ProviderSubscription {
    const subscription = this.subscriptions.get(id);
    if (!subscription) throw new PaymentProviderError("not_found", "no such subscription");
    return subscription;
  }

  private invoice(id: string): ProviderInvoice & { clientSecret: string | null } {
    const invoice = this.invoices.get(id);
    if (!invoice) throw new PaymentProviderError("not_found", "no such invoice");
    return invoice;
  }

  private price(lookupKey: string): Price {
    const price = this.prices.get(lookupKey);
    if (!price)
      throw new PaymentProviderError("invalid_request", `no price with lookup key ${lookupKey}`);
    return price;
  }

  private promotionById(id: string): Promotion {
    const promotion = [...this.promotions.values()].find((candidate) => candidate.id === id);
    if (!promotion) throw new PaymentProviderError("not_found", "no such promotion");
    return promotion;
  }
}
