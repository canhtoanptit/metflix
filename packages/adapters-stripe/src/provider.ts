import {
  type CatalogueEntry,
  type CatalogueSyncResult,
  type Clock,
  type Logger,
  type NextInvoicePreview,
  type PaymentProvider,
  PaymentProviderError,
  type PromotionLookup,
  type ProrationPreview,
  type ProviderCall,
  type ProviderEvent,
  type ProviderInvoice,
  type ProviderRefund,
  type ProviderSetup,
  type ProviderSubscription,
  systemClock,
} from "@webflix/core";
import { StripeApiError, StripeClient, type StripeObject } from "./client.ts";
import { idOf, list, ms, toEvent, toInvoice, toSetup, toSubscription } from "./mapping.ts";
import { verifyStripeSignature } from "./webhook.ts";

export interface StripePaymentProviderOptions {
  /** A secret or restricted key (`sk_…`/`rk_…`); never logged. */
  secretKey: string;
  /** The endpoint's (or `stripe listen`'s) signing secret, `whsec_…`; never logged. */
  webhookSecret: string;
  fetch?: typeof fetch;
  clock?: Clock;
  logger?: Logger;
  apiBase?: string;
  maxNetworkRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const SUBSCRIPTION_EXPAND = ["latest_invoice.confirmation_secret", "default_payment_method"];
/** Most events a reconciliation reads in one call (pages of 100, newest first at Stripe). */
const EVENT_PAGES = 20;

/**
 * The `PaymentProvider` port on Stripe (docs/STRIPE.md is the reference: §7 the API shapes,
 * §9 the states, §11 delivery, §14 the version). Portable: `fetch` and Web Crypto only, so the
 * same adapter serves the Node API and the Worker. Every mutating call sends the caller's
 * idempotency key; calls that take two Stripe requests derive one key per request from it.
 *
 * Choices beyond the port (each verified against the sandbox unless marked):
 * - First payments use `payment_behavior: default_incomplete` and the latest invoice's
 *   `confirmation_secret`; trials use `trial_period_days` with the card collected up front.
 * - Plan changes are invoiced at once (`always_invoice`) with the preview's `proration_date`;
 *   `payment_behavior: error_if_incomplete` makes a declined proration a 402 that leaves the
 *   plan unchanged, which is the port's contract.
 * - Refunds go through the invoice's payment (`invoice_payments` → PaymentIntent).
 * - Promotion codes are read with their coupon before use (exhausted and expired are told
 *   apart by `times_redeemed`/`max_redemptions` and `expires_at`, never by Stripe's message).
 * - SetupIntents and subscriptions set no `payment_method_types`, so Stripe's Payment Element
 *   offers whatever the account enables (cards, Link, Apple Pay, Google Pay).
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly id = "stripe" as const;
  private readonly client: StripeClient;
  private readonly webhookSecret: string;
  private readonly clock: Clock;
  private readonly prices = new Map<string, { id: string; amount: number; currency: string }>();

  constructor(options: StripePaymentProviderOptions) {
    this.client = new StripeClient({
      secretKey: options.secretKey,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.apiBase ? { apiBase: options.apiBase } : {}),
      ...(options.maxNetworkRetries !== undefined
        ? { maxNetworkRetries: options.maxNetworkRetries }
        : {}),
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
    this.webhookSecret = options.webhookSecret;
    this.clock = options.clock ?? systemClock;
  }

  // --- Customers and cards --------------------------------------------------------------------

  async createCustomer(input: { accountId: string; email: string }, call: ProviderCall) {
    const customer = await this.client.post(
      "/v1/customers",
      { email: input.email, metadata: { webflix_account_id: input.accountId } },
      call.idempotencyKey,
    );
    return { id: idOf(customer) ?? "" };
  }

  async deleteCustomer(input: { customerId: string }, _call: ProviderCall): Promise<void> {
    // DELETE is idempotent at Stripe (a gone customer answers 404, which is success here).
    // Deleting a customer cancels its subscriptions and removes its cards; invoices remain.
    try {
      await this.client.delete(`/v1/customers/${encodeURIComponent(input.customerId)}`);
    } catch (error) {
      if (!(error instanceof PaymentProviderError && error.code === "not_found")) throw error;
    }
  }

  async createSetup(input: { customerId: string }, call: ProviderCall): Promise<ProviderSetup> {
    const setup = await this.client.post(
      "/v1/setup_intents",
      { customer: input.customerId, usage: "off_session" },
      call.idempotencyKey,
    );
    return toSetup(setup);
  }

  async retrieveSetup(setupId: string): Promise<ProviderSetup | null> {
    const setup = await this.client.find(`/v1/setup_intents/${encodeURIComponent(setupId)}`, {
      expand: ["payment_method"],
    });
    return setup ? toSetup(setup) : null;
  }

  async setDefaultPaymentMethod(
    input: { customerId: string; paymentMethodId: string; subscriptionId: string | null },
    call: ProviderCall,
  ): Promise<void> {
    await this.client.post(
      `/v1/customers/${encodeURIComponent(input.customerId)}`,
      { invoice_settings: { default_payment_method: input.paymentMethodId } },
      `${call.idempotencyKey}-customer`,
    );
    if (input.subscriptionId) {
      await this.client.post(
        `/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
        { default_payment_method: input.paymentMethodId },
        `${call.idempotencyKey}-subscription`,
      );
    }
  }

  // --- Subscriptions --------------------------------------------------------------------------

  async createSubscription(
    input: {
      customerId: string;
      priceLookupKey: string;
      paymentMethodId: string | null;
      trialDays: number | null;
      promotionId: string | null;
    },
    call: ProviderCall,
  ): Promise<ProviderSubscription> {
    const price = await this.price(input.priceLookupKey);
    const trial = input.trialDays !== null && input.trialDays > 0;
    const subscription = await this.client.post(
      "/v1/subscriptions",
      {
        customer: input.customerId,
        items: [{ price: price.id }],
        payment_behavior: "default_incomplete",
        payment_settings: { save_default_payment_method: "on_subscription" },
        default_payment_method: input.paymentMethodId ?? undefined,
        trial_period_days: trial ? input.trialDays : undefined,
        trial_settings: trial ? { end_behavior: { missing_payment_method: "cancel" } } : undefined,
        discounts: input.promotionId ? [{ promotion_code: input.promotionId }] : undefined,
        expand: SUBSCRIPTION_EXPAND,
      },
      call.idempotencyKey,
    );
    return this.subscription(subscription);
  }

  async retrieveSubscription(subscriptionId: string): Promise<ProviderSubscription | null> {
    const subscription = await this.client.find(
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      { expand: SUBSCRIPTION_EXPAND },
    );
    return subscription ? this.subscription(subscription) : null;
  }

  /**
   * `POST /v1/invoices/create_preview` for the subscription as it stands: Stripe's own amount
   * (live discounts and the customer's credit balance applied), due at the trial's end or the
   * item's period end. None for a subscription that will not invoice again.
   */
  async previewNextInvoice(subscriptionId: string): Promise<NextInvoicePreview | null> {
    const current = await this.client.find(
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
    );
    if (!current) return null;
    const status = typeof current.status === "string" ? current.status : "";
    if (
      current.cancel_at_period_end === true ||
      typeof current.cancel_at === "number" ||
      !["trialing", "active", "past_due"].includes(status)
    ) {
      return null;
    }
    let preview: StripeObject;
    try {
      preview = await this.client.post(
        "/v1/invoices/create_preview",
        { customer: idOf(current.customer), subscription: subscriptionId },
        // A preview changes nothing; a fresh key, so no cached answer is ever replayed.
        `webflix-next-invoice-${subscriptionId}-${crypto.randomUUID()}`,
      );
    } catch (error) {
      if (error instanceof StripeApiError && error.stripeCode === "invoice_upcoming_none") {
        return null;
      }
      throw error;
    }
    const item = list(current.items)[0];
    const at = status === "trialing" ? ms(current.trial_end) : ms(item?.current_period_end);
    if (at === null || typeof preview.amount_due !== "number") return null;
    return {
      at,
      amountMinor: preview.amount_due,
      currency: String(preview.currency ?? "usd").toUpperCase(),
    };
  }

  async previewPlanChange(input: {
    subscriptionId: string;
    priceLookupKey: string;
    prorationDate: number;
  }): Promise<ProrationPreview> {
    const current = await this.client.get(
      `/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
    );
    const item = list(current.items)[0];
    const price = await this.price(input.priceLookupKey);
    const preview = await this.client.post(
      "/v1/invoices/create_preview",
      {
        customer: idOf(current.customer),
        subscription: input.subscriptionId,
        subscription_details: {
          items: [{ id: idOf(item), price: price.id }],
          proration_date: Math.floor(input.prorationDate / 1000),
          proration_behavior: "always_invoice",
        },
      },
      // A preview changes nothing; Stripe ignores repeated keys on it, but every POST gets one.
      `webflix-preview-${input.subscriptionId}-${price.id}-${input.prorationDate}`,
    );
    const lines = list(preview.lines).map((line) => ({
      description: typeof line.description === "string" ? line.description : "",
      amountMinor: typeof line.amount === "number" ? line.amount : 0,
    }));
    const total = typeof preview.total === "number" ? preview.total : 0;
    const amountDue = typeof preview.amount_due === "number" ? preview.amount_due : 0;
    const credit = Math.max(0, -total);
    const periodEnd = ms(item?.current_period_end);
    return {
      currency: String(preview.currency ?? price.currency).toUpperCase(),
      amountDueMinor: amountDue,
      creditMinor: credit,
      lines,
      prorationDate: Math.floor(input.prorationDate / 1000) * 1000,
      nextRenewal:
        periodEnd === null
          ? null
          : { at: periodEnd, amountMinor: Math.max(0, price.amount - credit) },
    };
  }

  async changePlan(
    input: { subscriptionId: string; priceLookupKey: string; prorationDate: number },
    call: ProviderCall,
  ): Promise<ProviderSubscription> {
    const current = await this.client.get(
      `/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
    );
    const item = list(current.items)[0];
    const price = await this.price(input.priceLookupKey);
    const subscription = await this.client.post(
      `/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
      {
        items: [{ id: idOf(item), price: price.id }],
        proration_date: Math.floor(input.prorationDate / 1000),
        proration_behavior: "always_invoice",
        payment_behavior: "error_if_incomplete",
        expand: SUBSCRIPTION_EXPAND,
      },
      call.idempotencyKey,
    );
    return this.subscription(subscription);
  }

  async setCancelAtPeriodEnd(
    input: { subscriptionId: string; cancelAtPeriodEnd: boolean },
    call: ProviderCall,
  ): Promise<ProviderSubscription> {
    const subscription = await this.client.post(
      `/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
      { cancel_at_period_end: input.cancelAtPeriodEnd, expand: SUBSCRIPTION_EXPAND },
      call.idempotencyKey,
    );
    return this.subscription(subscription);
  }

  async cancelNow(
    input: { subscriptionId: string },
    _call: ProviderCall,
  ): Promise<ProviderSubscription> {
    // DELETE is idempotent at Stripe (keys apply to POST only): a second cancel is a 404-free
    // no-op on an already canceled subscription, read back below.
    const existing = await this.retrieveSubscription(input.subscriptionId);
    if (!existing) throw new PaymentProviderError("not_found", "no such subscription");
    if (existing.status === "canceled" || existing.status === "incomplete_expired") return existing;
    await this.client.delete(`/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`);
    const ended = await this.retrieveSubscription(input.subscriptionId);
    if (!ended) throw new PaymentProviderError("not_found", "no such subscription");
    return ended;
  }

  async setTrialEnd(
    input: { subscriptionId: string; trialEnd: number },
    call: ProviderCall,
  ): Promise<ProviderSubscription> {
    const subscription = await this.client.post(
      `/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
      {
        trial_end: Math.floor(input.trialEnd / 1000),
        proration_behavior: "none",
        expand: SUBSCRIPTION_EXPAND,
      },
      call.idempotencyKey,
    );
    return this.subscription(subscription);
  }

  // --- Invoices and refunds -------------------------------------------------------------------

  async retrieveInvoice(invoiceId: string): Promise<ProviderInvoice | null> {
    const invoice = await this.client.find(`/v1/invoices/${encodeURIComponent(invoiceId)}`);
    return invoice ? toInvoice(invoice, await this.refunded(invoice)) : null;
  }

  async listInvoices(input: { customerId: string; limit: number }): Promise<ProviderInvoice[]> {
    const page = await this.client.get("/v1/invoices", {
      customer: input.customerId,
      limit: Math.min(Math.max(input.limit, 1), 100),
    });
    return Promise.all(
      list(page).map(async (invoice) => toInvoice(invoice, await this.refunded(invoice))),
    );
  }

  async payInvoice(input: { invoiceId: string }, call: ProviderCall): Promise<ProviderInvoice> {
    const path = `/v1/invoices/${encodeURIComponent(input.invoiceId)}`;
    const current = await this.client.get(path);
    // A renewal is drafted first and collected about an hour later (docs/STRIPE.md §12):
    // finalising early does not attempt payment, so it is finalised, then paid.
    if (current.status === "draft") {
      await this.client.post(`${path}/finalize`, {}, `${call.idempotencyKey}-finalize`);
    }
    const paid = await this.client.post(`${path}/pay`, {}, call.idempotencyKey);
    return toInvoice(paid, await this.refunded(paid));
  }

  async refund(
    input: { invoiceId: string; amountMinor: number | null },
    call: ProviderCall,
  ): Promise<ProviderRefund> {
    const paymentIntent = await this.paymentIntentOf(input.invoiceId);
    if (!paymentIntent) {
      throw new PaymentProviderError("invalid_request", "the invoice has no payment to refund");
    }
    const refund = await this.client.post(
      "/v1/refunds",
      { payment_intent: paymentIntent, amount: input.amountMinor ?? undefined },
      call.idempotencyKey,
    );
    const status = typeof refund.status === "string" ? refund.status : "pending";
    return {
      id: idOf(refund) ?? "",
      invoiceId: input.invoiceId,
      amountMinor: typeof refund.amount === "number" ? refund.amount : 0,
      currency: String(refund.currency ?? "usd").toUpperCase(),
      status:
        status === "succeeded"
          ? "succeeded"
          : status === "failed" || status === "canceled"
            ? "failed"
            : "pending",
    };
  }

  // --- Promotions and catalogue ---------------------------------------------------------------

  async validatePromotionCode(input: {
    code: string;
    priceLookupKey: string;
  }): Promise<PromotionLookup> {
    const page = await this.client.get("/v1/promotion_codes", {
      code: input.code,
      limit: 1,
      expand: ["data.promotion.coupon"],
    });
    const promotion = list(page)[0];
    if (!promotion) return { valid: false, reason: "unknown" };
    const nowSec = this.clock.now() / 1000;
    const expiresAt = typeof promotion.expires_at === "number" ? promotion.expires_at : null;
    const max = typeof promotion.max_redemptions === "number" ? promotion.max_redemptions : null;
    const redeemed = typeof promotion.times_redeemed === "number" ? promotion.times_redeemed : 0;
    if (expiresAt !== null && expiresAt <= nowSec) return { valid: false, reason: "expired" };
    if (max !== null && redeemed >= max) return { valid: false, reason: "exhausted" };
    const coupon = couponOf(promotion);
    if (promotion.active !== true || !coupon || coupon.valid === false) {
      return { valid: false, reason: "expired" };
    }
    const products = (coupon.applies_to as { products?: unknown } | undefined)?.products;
    if (Array.isArray(products) && products.length > 0) {
      const price = await this.price(input.priceLookupKey);
      const product = await this.productOf(price.id);
      if (!products.includes(product)) return { valid: false, reason: "not_applicable" };
    }
    const duration =
      coupon.duration === "repeating" || coupon.duration === "forever" ? coupon.duration : "once";
    return {
      valid: true,
      promotionId: idOf(promotion) ?? "",
      code: typeof promotion.code === "string" ? promotion.code : input.code,
      percentOff: typeof coupon.percent_off === "number" ? coupon.percent_off : null,
      amountOffMinor: typeof coupon.amount_off === "number" ? coupon.amount_off : null,
      currency: typeof coupon.currency === "string" ? coupon.currency.toUpperCase() : null,
      duration,
      durationInMonths:
        typeof coupon.duration_in_months === "number" ? coupon.duration_in_months : null,
    };
  }

  /**
   * Products by custom id (`webflix_<plan>`: retrieving it is the idempotency check) and one
   * price per lookup key. A changed amount is a new price that takes the lookup key over
   * (`transfer_lookup_key`), and the old price is archived; a second pass writes nothing.
   */
  async syncCatalogue(entries: readonly CatalogueEntry[]): Promise<CatalogueSyncResult> {
    const result: CatalogueSyncResult = { created: 0, updated: 0, archived: 0, unchanged: 0 };
    const existing = new Map<string, StripeObject>();
    for (let i = 0; i < entries.length; i += 10) {
      const keys = entries.slice(i, i + 10).map((entry) => entry.lookupKey);
      const page = await this.client.get("/v1/prices", { lookup_keys: keys, limit: 100 });
      for (const price of list(page)) {
        if (typeof price.lookup_key === "string") existing.set(price.lookup_key, price);
      }
    }
    for (const entry of entries) {
      const product = await this.client.find(`/v1/products/${encodeURIComponent(entry.productId)}`);
      if (!product) {
        await this.client.post(
          "/v1/products",
          { id: entry.productId, name: entry.productName },
          `webflix-catalogue-product-${entry.productId}`,
        );
      }
      const current = existing.get(entry.lookupKey);
      const currency = entry.currency.toLowerCase();
      if (
        current &&
        current.active === true &&
        current.unit_amount === entry.amountMinor &&
        current.currency === currency
      ) {
        result.unchanged += 1;
        this.prices.set(entry.lookupKey, {
          id: idOf(current) ?? "",
          amount: entry.amountMinor,
          currency,
        });
        continue;
      }
      const created = await this.client.post(
        "/v1/prices",
        {
          product: entry.productId,
          unit_amount: entry.amountMinor,
          currency,
          recurring: { interval: "month" },
          lookup_key: entry.lookupKey,
          transfer_lookup_key: true,
          nickname: entry.productName,
        },
        `webflix-catalogue-${entry.lookupKey}-${entry.amountMinor}-${currency}`,
      );
      result.created += 1;
      this.prices.set(entry.lookupKey, {
        id: idOf(created) ?? "",
        amount: entry.amountMinor,
        currency,
      });
      const old = idOf(current);
      if (current && old && old !== idOf(created) && current.active === true) {
        await this.client.post(
          `/v1/prices/${encodeURIComponent(old)}`,
          { active: false },
          `webflix-catalogue-archive-${old}`,
        );
        result.archived += 1;
      }
    }
    return result;
  }

  // --- Webhooks and events --------------------------------------------------------------------

  parseWebhook(rawBody: Uint8Array, signatureHeader: string | null): Promise<ProviderEvent> {
    return verifyStripeSignature(rawBody, signatureHeader, this.webhookSecret, this.clock.now());
  }

  /**
   * Events Stripe logged after `createdAfter`, oldest first. Stripe lists newest first, so the
   * window is read page by page back to `createdAfter` (bounded), then reversed.
   */
  async listEvents(input: { createdAfter: number; limit: number }): Promise<ProviderEvent[]> {
    const collected: StripeObject[] = [];
    let startingAfter: string | null = null;
    for (let page = 0; page < EVENT_PAGES; page += 1) {
      const response: StripeObject = await this.client.get("/v1/events", {
        created: { gt: Math.floor(input.createdAfter / 1000) },
        limit: 100,
        starting_after: startingAfter ?? undefined,
      });
      const events = list(response);
      collected.push(...events);
      const last = events[events.length - 1];
      if (response.has_more !== true || !last) break;
      startingAfter = idOf(last);
    }
    return collected
      .reverse()
      .flatMap((event) => {
        const normalised = toEvent(event);
        return normalised && normalised.createdAt > input.createdAfter ? [normalised] : [];
      })
      .slice(0, input.limit);
  }

  // --- Internals ------------------------------------------------------------------------------

  /** A price id by lookup key (the catalogue is Webflix's; prices are found, never assumed). */
  private async price(
    lookupKey: string,
  ): Promise<{ id: string; amount: number; currency: string }> {
    const cached = this.prices.get(lookupKey);
    if (cached) return cached;
    const page = await this.client.get("/v1/prices", {
      lookup_keys: [lookupKey],
      active: true,
      limit: 1,
    });
    const price = list(page)[0];
    const id = idOf(price);
    if (!price || !id) {
      throw new PaymentProviderError("invalid_request", `no price with lookup key ${lookupKey}`);
    }
    const found = {
      id,
      amount: typeof price.unit_amount === "number" ? price.unit_amount : 0,
      currency: typeof price.currency === "string" ? price.currency : "usd",
    };
    this.prices.set(lookupKey, found);
    return found;
  }

  private async productOf(priceId: string): Promise<string | null> {
    const price = await this.client.get(`/v1/prices/${encodeURIComponent(priceId)}`);
    return idOf(price.product);
  }

  private async subscription(value: StripeObject): Promise<ProviderSubscription> {
    // A customer on a test clock (a full key only) reads time from it.
    const clockId = idOf(value.test_clock);
    let clockNow: number | null = null;
    if (clockId) {
      const clock = await this.client.find(
        `/v1/test_helpers/test_clocks/${encodeURIComponent(clockId)}`,
      );
      clockNow = ms(clock?.frozen_time);
    }
    return toSubscription(value, clockNow);
  }

  private async paymentIntentOf(invoiceId: string): Promise<string | null> {
    const page = await this.client.get("/v1/invoice_payments", { invoice: invoiceId, limit: 10 });
    for (const payment of list(page)) {
      const details = payment.payment as { payment_intent?: unknown } | undefined;
      const intent = idOf(details?.payment_intent);
      if (intent && payment.status === "paid") return intent;
    }
    return null;
  }

  /** What has been refunded of a paid invoice (Stripe keeps it on the charge, not the invoice). */
  private async refunded(invoice: StripeObject): Promise<number> {
    if (typeof invoice.amount_paid !== "number" || invoice.amount_paid <= 0) return 0;
    const intent = await this.paymentIntentOf(String(invoice.id));
    if (!intent) return 0;
    const paymentIntent = await this.client.get(
      `/v1/payment_intents/${encodeURIComponent(intent)}`,
      {
        expand: ["latest_charge"],
      },
    );
    const charge = paymentIntent.latest_charge as { amount_refunded?: unknown } | null | undefined;
    return typeof charge?.amount_refunded === "number" ? charge.amount_refunded : 0;
  }
}

function couponOf(promotion: StripeObject): StripeObject | null {
  const nested = promotion.promotion as { coupon?: unknown } | undefined;
  const coupon = nested?.coupon ?? promotion.coupon;
  return typeof coupon === "object" && coupon !== null ? (coupon as StripeObject) : null;
}

/** Composition helper: the adapter from the area's configuration. */
export function createStripePaymentProvider(
  options: StripePaymentProviderOptions,
): StripePaymentProvider {
  return new StripePaymentProvider(options);
}
