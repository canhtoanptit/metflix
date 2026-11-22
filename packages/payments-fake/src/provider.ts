import {
  type CatalogueEntry,
  type CatalogueSyncResult,
  type Clock,
  hexEncode,
  type Logger,
  type PaymentFailureCode,
  type PaymentProvider,
  PaymentProviderError,
  type PromotionLookup,
  type ProrationPreview,
  type ProviderCall,
  type ProviderEvent,
  type ProviderInvoice,
  type ProviderPaymentMethod,
  type ProviderRefund,
  type ProviderSetup,
  type ProviderSubscription,
  type ProviderSubscriptionStatus,
  serializeError,
  systemClock,
  timingSafeEqual,
  utf8Decode,
  utf8Encode,
  WEBHOOK_TOLERANCE_SEC,
  type WebhookReceiver,
  WebhookSignatureError,
} from "@webflix/core";
import {
  cardFingerprint,
  FAKE_CARDS,
  type FakeCardChoice,
  type FakeTestCard,
  parseCardChoice,
} from "./cards.ts";
import {
  CUSTOMER_STATE_KINDS,
  type FakeDocument,
  type FakeDocumentKind,
  type FakeStore,
} from "./store.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Monthly plans: 30-day periods, like milestone 1's mock. */
export const FAKE_PERIOD_MS = 30 * DAY_MS;
/** Stripe collects a renewal about an hour after it drafts the invoice (docs/STRIPE.md §12). */
const COLLECTION_DELAY_MS = HOUR_MS;
/** An unconfirmed first payment expires after 23 hours (`incomplete_expired`). */
const INCOMPLETE_EXPIRY_MS = 23 * HOUR_MS;
/** The provider's own "trial ending" hint (a hint only: §5.4). */
const TRIAL_WILL_END_MS = 3 * DAY_MS;

/**
 * How webhooks reach Webflix. `orderly`: each event once, in order, right after the call that
 * caused it. `unruly`: what real delivery looks like (docs/STRIPE.md §11): any order, some events
 * twice, some late. `outage`: nothing is delivered (the events stay listable, so reconciliation
 * is the only way back, exactly as with Stripe's CLI listener).
 */
export type DeliveryPolicy =
  | { mode: "orderly" }
  | { mode: "unruly"; duplicateRate: number; maxDelayMs: number; seed?: number }
  | { mode: "outage" };

/** What happens when every retry of a renewal failed (Stripe's Dashboard-only setting, §5.2). */
export type RetriesExhausted = "cancel" | "unpaid";

export interface FakePaymentProviderOptions {
  store: FakeStore;
  /** Signs every webhook (`Stripe-Signature` format); `parseWebhook` verifies with it. */
  webhookSecret: string;
  /** Real time. Each customer's test clock runs in real time from its last advance. */
  clock?: Clock;
  logger?: Logger;
  /** Days after the first failed attempt when the provider retries (default 3, 5, 8). */
  retryDays?: readonly number[];
  retriesExhausted?: RetriesExhausted;
  /** Used until a policy is stored (`setDeliveryPolicy`). Default orderly. */
  delivery?: DeliveryPolicy;
  /**
   * Promo codes the deployment always has (a fake-provider deployment has no other way to get
   * one): never expiring, never exhausted, valid for every plan. Stored on first redemption.
   */
  promotions?: readonly FakePromotionSeed[];
}

/** A standing promo code: a percentage (1-100) or a fixed amount in minor units. */
export interface FakePromotionSeed {
  code: string;
  percentOff?: number;
  amountOffMinor?: number;
  currency?: string;
}

// --- Documents ------------------------------------------------------------------------------

interface CustomerData {
  id: string;
  accountId: string;
  email: string;
  defaultPaymentMethodId: string | null;
  /** Negative: credit owed to the customer (downgrades), applied to later invoices. */
  balanceMinor: number;
}

interface MethodData extends ProviderPaymentMethod {
  customerId: string;
  /** How it behaves (a labelled card behaves like its test card). */
  card: FakeTestCard;
}

interface SetupData {
  id: string;
  customerId: string;
  status: "requires_confirmation" | "requires_action" | "succeeded" | "failed";
  secret: string;
  paymentMethodId: string | null;
  /** The card whose challenge is in progress. */
  pendingCard: FakeCardChoice | null;
  failureCode: PaymentFailureCode | null;
}

interface SubscriptionData {
  id: string;
  customerId: string;
  status: ProviderSubscriptionStatus;
  priceLookupKey: string;
  cancelAtPeriodEnd: boolean;
  trialEnd: number | null;
  /** The provider's "trial ending" hint was sent for this trial end. */
  trialWillEndSentFor: number | null;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  endedAt: number | null;
  latestInvoiceId: string | null;
  defaultPaymentMethodId: string | null;
  createdAt: number;
}

interface InvoiceData {
  id: string;
  customerId: string;
  subscriptionId: string | null;
  number: string;
  status: ProviderInvoice["status"];
  currency: string;
  totalMinor: number;
  amountPaidMinor: number;
  amountDueMinor: number;
  amountRefundedMinor: number;
  billingReason: ProviderInvoice["billingReason"];
  periodStart: number | null;
  periodEnd: number | null;
  createdAt: number;
  paidAt: number | null;
  attemptCount: number;
  nextPaymentAttempt: number | null;
  firstFailureAt: number | null;
  /** Set while the browser can pay it on-session (a first payment, an action required). */
  secret: string | null;
  pendingCard: FakeCardChoice | null;
  lines: { description: string; amountMinor: number }[];
}

interface RefundData extends ProviderRefund {
  customerId: string;
}

interface PriceData {
  id: string;
  lookupKey: string;
  productId: string;
  productName: string;
  amountMinor: number;
  currency: string;
  active: boolean;
}

interface PromotionData {
  id: string;
  code: string;
  percentOff: number | null;
  amountOffMinor: number | null;
  currency: string | null;
  expiresAt: number | null;
  maxRedemptions: number | null;
  timesRedeemed: number;
  appliesTo: string[] | null;
}

interface DeliveryData {
  eventId: string;
  deliverAt: number;
  copies: number;
  attempts: number;
}

/** The browser's part: what a confirmation in the provider's form led to. */
export type FormOutcome =
  | { status: "succeeded" }
  | { status: "requires_action" }
  | { status: "failed"; code: PaymentFailureCode };

// --- The working set of one operation -------------------------------------------------------

/**
 * The documents one operation reads and writes: one customer's state plus the catalogue and
 * promotions, loaded once, changed in memory by synchronous code, then written in one batch
 * with the events the operation caused.
 */
class WorkingSet {
  readonly documents = new Map<string, FakeDocument>();
  readonly dirty = new Set<string>();
  readonly events: ProviderEvent[] = [];
  /** The provider time events are stamped with (moves while due transitions are settled). */
  at: number;

  readonly wall: number;
  /** The customer's clock reading; `wall` for global operations. */
  readonly now: number;

  constructor(wall: number, now: number, loaded: readonly FakeDocument[]) {
    this.wall = wall;
    this.now = now;
    this.at = now;
    for (const document of loaded) this.documents.set(`${document.kind}:${document.id}`, document);
  }

  get<T>(kind: FakeDocumentKind, id: string | null | undefined): T | null {
    if (!id) return null;
    const document = this.documents.get(`${kind}:${id}`);
    return document ? (document.data as T) : null;
  }

  require<T>(kind: FakeDocumentKind, id: string | null | undefined, what: string): T {
    const value = this.get<T>(kind, id);
    if (!value) throw new PaymentProviderError("not_found", `no such ${what}`);
    return value;
  }

  all<T>(kind: FakeDocumentKind): T[] {
    return [...this.documents.values()]
      .filter((document) => document.kind === kind)
      .map((document) => document.data as T);
  }

  put(kind: FakeDocumentKind, id: string, customerId: string | null, data: unknown): void {
    const key = `${kind}:${id}`;
    const existing = this.documents.get(key);
    this.documents.set(key, {
      kind,
      id,
      customerId,
      data,
      version: (existing?.version ?? 0) + 1,
      createdAt: existing?.createdAt ?? this.wall,
      updatedAt: this.wall,
    });
    this.dirty.add(key);
  }

  /** Marks a document already in the set as changed (its data was mutated in place). */
  touch(kind: FakeDocumentKind, id: string): void {
    const document = this.documents.get(`${kind}:${id}`);
    if (document) this.put(kind, id, document.customerId, document.data);
  }

  changed(): FakeDocument[] {
    return [...this.dirty].flatMap((key) => {
      const document = this.documents.get(key);
      return document ? [document] : [];
    });
  }
}

/**
 * The stateful fake payment provider (milestone 2 §5.5, the hermetic lane): the
 * `PaymentProvider` port with nothing a real provider does not also do. What it adds for tests
 * and local modes:
 *
 * - **A test clock per customer** (`advanceClock`): renewals, retries, grace, expiry and trial
 *   ends happen as the customer's clock passes them; parallel suites never move each other's
 *   time. Clocks run in real time between advances.
 * - **Every decline** a real provider produces, a **challenge step** (3-D Secure), and a card
 *   that is saved fine but declines when charged later (`FAKE_CARDS`).
 * - **Dunning** like Stripe's: a failed renewal is retried on a schedule; when retries run out
 *   the subscription is canceled or marked unpaid (`retriesExhausted`).
 * - **Webhooks** signed like Stripe's, delivered in process to the receiver Webflix attaches,
 *   orderly or as unruly as real delivery (`setDeliveryPolicy`); every event stays listable
 *   (`listEvents`) for reconciliation after an outage.
 * - **State in the database** (`FakeStore`), so it works on every dialect and survives
 *   restarts. Operations on one customer are serialised in process; across processes the last
 *   write wins (good enough for a test double).
 * - **Its own payment form** (form.ts, `/_pay/*`): card data in local modes goes to the fake,
 *   never to the API.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly id = "fake" as const;
  private readonly store: FakeStore;
  private readonly webhookSecret: string;
  private readonly clock: Clock;
  private readonly logger: Logger | undefined;
  private readonly retryDays: readonly number[];
  private readonly retriesExhausted: RetriesExhausted;
  private readonly defaultDelivery: DeliveryPolicy;
  private readonly seededPromotions: ReadonlyMap<string, PromotionData>;
  private readonly locks = new Map<string, Promise<void>>();
  private receiver: WebhookReceiver | undefined;
  private pumping: Promise<unknown> | undefined;
  private sequence = 0;
  private random: () => number = Math.random;

  constructor(options: FakePaymentProviderOptions) {
    this.store = options.store;
    this.webhookSecret = options.webhookSecret;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger;
    this.retryDays = options.retryDays ?? [3, 5, 8];
    this.retriesExhausted = options.retriesExhausted ?? "cancel";
    this.defaultDelivery = options.delivery ?? { mode: "orderly" };
    this.seededPromotions = new Map(
      (options.promotions ?? []).map((seed) => {
        const code = seed.code.toUpperCase();
        return [
          code,
          {
            // Stable across processes and isolates: every instance names it the same.
            id: `promo_fake_${code.toLowerCase().replaceAll(/[^a-z0-9]/g, "")}`,
            code,
            percentOff: seed.percentOff ?? null,
            amountOffMinor: seed.amountOffMinor ?? null,
            currency: seed.amountOffMinor === undefined ? null : (seed.currency ?? "USD"),
            expiresAt: null,
            maxRedemptions: null,
            timesRedeemed: 0,
            appliesTo: null,
          } satisfies PromotionData,
        ];
      }),
    );
  }

  attachWebhookReceiver(receiver: WebhookReceiver): void {
    this.receiver = receiver;
  }

  // --- Customers and cards --------------------------------------------------------------------

  async createCustomer(
    input: { accountId: string; email: string },
    call: ProviderCall,
  ): Promise<{ id: string }> {
    return this.idempotent("createCustomer", input, call, async () => {
      const id = this.newId("cus");
      const wall = this.clock.now();
      await this.store.setClock(id, { nowMs: wall, updatedAt: wall });
      return this.mutate(id, (set) => {
        set.put("customer", id, id, {
          id,
          accountId: input.accountId,
          email: input.email,
          defaultPaymentMethodId: null,
          balanceMinor: 0,
        } satisfies CustomerData);
        this.emit(set, "customer.created", { customerId: id }, call);
        return { id };
      });
    });
  }

  async deleteCustomer(input: { customerId: string }, call: ProviderCall): Promise<void> {
    return this.idempotent("deleteCustomer", input, call, () =>
      this.mutate(input.customerId, (set) => {
        const customer = set.get<CustomerData & { deleted?: boolean }>(
          "customer",
          input.customerId,
        );
        if (!customer || customer.deleted) return undefined;
        for (const subscription of set.all<SubscriptionData>("subscription")) {
          if (!["canceled", "incomplete_expired"].includes(subscription.status)) {
            this.end(set, subscription, call);
          }
        }
        // The cards go; the invoices stay (billing records are kept).
        for (const method of set.all<MethodData>("payment_method")) {
          set.put("payment_method", method.id, null, { ...method, customerId: "deleted" });
        }
        customer.deleted = true;
        customer.defaultPaymentMethodId = null;
        customer.email = "";
        set.touch("customer", customer.id);
        this.emit(set, "customer.deleted", { customerId: customer.id }, call);
        return undefined;
      }),
    );
  }

  async createSetup(input: { customerId: string }, call: ProviderCall): Promise<ProviderSetup> {
    return this.idempotent("createSetup", input, call, () =>
      this.mutate(input.customerId, (set) => {
        set.require<CustomerData>("customer", input.customerId, "customer");
        const id = this.newId("seti");
        const setup: SetupData = {
          id,
          customerId: input.customerId,
          status: "requires_confirmation",
          secret: `${id}_secret_${this.randomToken(12)}`,
          paymentMethodId: null,
          pendingCard: null,
          failureCode: null,
        };
        set.put("setup", id, input.customerId, setup);
        this.emit(set, "setup_intent.created", { customerId: input.customerId, setupId: id }, call);
        return this.publicSetup(set, setup);
      }),
    );
  }

  async retrieveSetup(setupId: string): Promise<ProviderSetup | null> {
    const customerId = await this.customerOf("setup", setupId);
    if (!customerId) return null;
    return this.mutate(customerId, (set) => {
      const setup = set.get<SetupData>("setup", setupId);
      return setup ? this.publicSetup(set, setup) : null;
    });
  }

  async setDefaultPaymentMethod(
    input: { customerId: string; paymentMethodId: string; subscriptionId: string | null },
    call: ProviderCall,
  ): Promise<void> {
    return this.idempotent("setDefaultPaymentMethod", input, call, () =>
      this.mutate(input.customerId, (set) => {
        const customer = set.require<CustomerData>("customer", input.customerId, "customer");
        const method = set.require<MethodData>("payment_method", input.paymentMethodId, "card");
        customer.defaultPaymentMethodId = method.id;
        set.touch("customer", customer.id);
        this.emit(set, "customer.updated", { customerId: customer.id }, call);
        if (input.subscriptionId) {
          const subscription = set.require<SubscriptionData>(
            "subscription",
            input.subscriptionId,
            "subscription",
          );
          subscription.defaultPaymentMethodId = method.id;
          set.touch("subscription", subscription.id);
          this.emit(set, "customer.subscription.updated", { subscription }, call);
        }
        return undefined;
      }),
    );
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
    return this.idempotent("createSubscription", input, call, () =>
      this.mutate(input.customerId, (set) => {
        const customer = set.require<CustomerData>("customer", input.customerId, "customer");
        const price = this.activePrice(set, input.priceLookupKey);
        if (input.paymentMethodId) {
          set.require<MethodData>("payment_method", input.paymentMethodId, "card");
        }
        let promotion: PromotionData | null = null;
        if (input.promotionId) {
          promotion =
            set.all<PromotionData>("promotion").find((p) => p.id === input.promotionId) ?? null;
          const lookup = promotion
            ? this.promotionLookup(promotion, price.lookupKey, set.wall)
            : null;
          // Like Stripe: an exhausted or expired code is a plain 400, without saying which.
          if (!promotion || !lookup?.valid) {
            throw new PaymentProviderError("invalid_request", "promotion code cannot be used");
          }
          promotion.timesRedeemed += 1;
          set.touch("promotion", promotion.code);
        }
        const now = set.now;
        const trial = input.trialDays !== null && input.trialDays > 0;
        const id = this.newId("sub");
        const end = trial ? now + (input.trialDays ?? 0) * DAY_MS : now + FAKE_PERIOD_MS;
        const subscription: SubscriptionData = {
          id,
          customerId: customer.id,
          status: trial ? "trialing" : "incomplete",
          priceLookupKey: price.lookupKey,
          cancelAtPeriodEnd: false,
          trialEnd: trial ? end : null,
          trialWillEndSentFor: null,
          currentPeriodStart: now,
          currentPeriodEnd: end,
          endedAt: null,
          latestInvoiceId: null,
          defaultPaymentMethodId: input.paymentMethodId,
          createdAt: now,
        };
        const amount = trial ? 0 : this.discounted(price.amountMinor, promotion);
        const invoice = this.newInvoice(set, subscription, {
          totalMinor: amount,
          currency: price.currency,
          billingReason: "subscription_create",
          periodStart: now,
          periodEnd: end,
          lines: [
            { description: `${price.productName} (${price.lookupKey})`, amountMinor: amount },
          ],
        });
        subscription.latestInvoiceId = invoice.id;
        set.put("subscription", id, customer.id, subscription);
        this.emit(set, "customer.subscription.created", { subscription }, call);
        this.emit(set, "invoice.created", { subscription, invoiceId: invoice.id }, call);
        this.emit(set, "invoice.finalized", { subscription, invoiceId: invoice.id }, call);
        if (invoice.amountDueMinor === 0) {
          // A trial (or a code that covers everything) needs no payment: paid at once.
          this.markPaid(set, invoice, call);
          if (!trial) this.setStatus(set, subscription, "active", call);
        } else {
          // `default_incomplete`: the browser confirms the first payment, where a challenge
          // happens, whatever card is already on file (docs/STRIPE.md §7).
          invoice.secret = `${invoice.id}_secret_${this.randomToken(12)}`;
          set.touch("invoice", invoice.id);
        }
        return this.publicSubscription(set, subscription);
      }),
    );
  }

  async retrieveSubscription(subscriptionId: string): Promise<ProviderSubscription | null> {
    const customerId = await this.customerOf("subscription", subscriptionId);
    if (!customerId) return null;
    return this.mutate(customerId, (set) => {
      const subscription = set.get<SubscriptionData>("subscription", subscriptionId);
      return subscription ? this.publicSubscription(set, subscription) : null;
    });
  }

  async previewPlanChange(input: {
    subscriptionId: string;
    priceLookupKey: string;
    prorationDate: number;
  }): Promise<ProrationPreview> {
    const customerId = await this.requireCustomerOf("subscription", input.subscriptionId);
    return this.mutate(customerId, (set) => this.prorate(set, input));
  }

  async changePlan(
    input: { subscriptionId: string; priceLookupKey: string; prorationDate: number },
    call: ProviderCall,
  ): Promise<ProviderSubscription> {
    const customerId = await this.requireCustomerOf("subscription", input.subscriptionId);
    return this.idempotent("changePlan", input, call, () =>
      this.mutate(customerId, (set) => {
        const subscription = set.require<SubscriptionData>(
          "subscription",
          input.subscriptionId,
          "subscription",
        );
        if (!["active", "past_due", "trialing"].includes(subscription.status)) {
          throw new PaymentProviderError("invalid_request", "the subscription cannot change plan");
        }
        const customer = set.require<CustomerData>("customer", customerId, "customer");
        const preview = this.prorate(set, input);
        const total = preview.lines.reduce((sum, line) => sum + line.amountMinor, 0);
        if (preview.amountDueMinor > 0) {
          // `pending_if_incomplete`: the plan changes only once the proration is paid.
          const failure = this.offSessionFailure(
            set,
            subscription.defaultPaymentMethodId ?? customer.defaultPaymentMethodId,
          );
          if (failure) throw new PaymentProviderError(failure);
        }
        const invoice = this.newInvoice(set, subscription, {
          totalMinor: total,
          currency: preview.currency,
          billingReason: "subscription_update",
          periodStart: input.prorationDate,
          periodEnd: subscription.currentPeriodEnd,
          lines: preview.lines,
        });
        this.emit(set, "invoice.created", { subscription, invoiceId: invoice.id }, call);
        this.emit(set, "invoice.finalized", { subscription, invoiceId: invoice.id }, call);
        // What the preview showed is what is charged or credited, to the unit.
        customer.balanceMinor = preview.balanceAfterMinor;
        set.touch("customer", customer.id);
        invoice.amountDueMinor = preview.amountDueMinor;
        this.markPaid(set, invoice, call);
        subscription.priceLookupKey = input.priceLookupKey;
        subscription.latestInvoiceId = invoice.id;
        set.touch("subscription", subscription.id);
        this.emit(set, "customer.subscription.updated", { subscription }, call);
        return this.publicSubscription(set, subscription);
      }),
    );
  }

  async setCancelAtPeriodEnd(
    input: { subscriptionId: string; cancelAtPeriodEnd: boolean },
    call: ProviderCall,
  ): Promise<ProviderSubscription> {
    const customerId = await this.requireCustomerOf("subscription", input.subscriptionId);
    return this.idempotent("setCancelAtPeriodEnd", input, call, () =>
      this.mutate(customerId, (set) => {
        const subscription = set.require<SubscriptionData>(
          "subscription",
          input.subscriptionId,
          "subscription",
        );
        if (["canceled", "incomplete_expired", "incomplete"].includes(subscription.status)) {
          throw new PaymentProviderError("invalid_request", "the subscription has ended");
        }
        subscription.cancelAtPeriodEnd = input.cancelAtPeriodEnd;
        set.touch("subscription", subscription.id);
        this.emit(set, "customer.subscription.updated", { subscription }, call);
        return this.publicSubscription(set, subscription);
      }),
    );
  }

  async cancelNow(
    input: { subscriptionId: string },
    call: ProviderCall,
  ): Promise<ProviderSubscription> {
    const customerId = await this.requireCustomerOf("subscription", input.subscriptionId);
    return this.idempotent("cancelNow", input, call, () =>
      this.mutate(customerId, (set) => {
        const subscription = set.require<SubscriptionData>(
          "subscription",
          input.subscriptionId,
          "subscription",
        );
        if (subscription.status !== "canceled") this.end(set, subscription, call);
        return this.publicSubscription(set, subscription);
      }),
    );
  }

  async setTrialEnd(
    input: { subscriptionId: string; trialEnd: number },
    call: ProviderCall,
  ): Promise<ProviderSubscription> {
    const customerId = await this.requireCustomerOf("subscription", input.subscriptionId);
    return this.idempotent("setTrialEnd", input, call, () =>
      this.mutate(customerId, (set) => {
        const subscription = set.require<SubscriptionData>(
          "subscription",
          input.subscriptionId,
          "subscription",
        );
        if (
          !["trialing", "active", "past_due"].includes(subscription.status) ||
          input.trialEnd <= set.now
        ) {
          throw new PaymentProviderError("invalid_request", "cannot move that trial end");
        }
        subscription.status = "trialing";
        subscription.trialEnd = input.trialEnd;
        subscription.trialWillEndSentFor = null;
        subscription.currentPeriodStart = set.now;
        subscription.currentPeriodEnd = input.trialEnd;
        set.touch("subscription", subscription.id);
        this.emit(set, "customer.subscription.updated", { subscription }, call);
        return this.publicSubscription(set, subscription);
      }),
    );
  }

  // --- Invoices and refunds -------------------------------------------------------------------

  async retrieveInvoice(invoiceId: string): Promise<ProviderInvoice | null> {
    const customerId = await this.customerOf("invoice", invoiceId);
    if (!customerId) return null;
    return this.mutate(customerId, (set) => {
      const invoice = set.get<InvoiceData>("invoice", invoiceId);
      return invoice ? publicInvoice(invoice) : null;
    });
  }

  async listInvoices(input: { customerId: string; limit: number }): Promise<ProviderInvoice[]> {
    return this.mutate(input.customerId, (set) =>
      set
        .all<InvoiceData>("invoice")
        .sort((a, b) => b.createdAt - a.createdAt || (a.number < b.number ? 1 : -1))
        .slice(0, input.limit)
        .map(publicInvoice),
    );
  }

  async payInvoice(input: { invoiceId: string }, call: ProviderCall): Promise<ProviderInvoice> {
    const customerId = await this.requireCustomerOf("invoice", input.invoiceId);
    return this.idempotent("payInvoice", input, call, () =>
      this.mutate(customerId, (set) => {
        const invoice = set.require<InvoiceData>("invoice", input.invoiceId, "invoice");
        if (invoice.status !== "open") {
          throw new PaymentProviderError("invalid_request", "invoice is not open");
        }
        const failure = this.attempt(set, invoice, { scheduleRetry: false, call });
        if (failure) throw new PaymentProviderError(failure);
        return publicInvoice(invoice);
      }),
    );
  }

  async refund(
    input: { invoiceId: string; amountMinor: number | null },
    call: ProviderCall,
  ): Promise<ProviderRefund> {
    const customerId = await this.requireCustomerOf("invoice", input.invoiceId);
    return this.idempotent("refund", input, call, () =>
      this.mutate(customerId, (set) => {
        const invoice = set.require<InvoiceData>("invoice", input.invoiceId, "invoice");
        const remaining = invoice.amountPaidMinor - invoice.amountRefundedMinor;
        const amount = input.amountMinor ?? remaining;
        if (
          invoice.status !== "paid" ||
          !Number.isInteger(amount) ||
          amount <= 0 ||
          amount > remaining
        ) {
          throw new PaymentProviderError("invalid_request", "nothing to refund for that amount");
        }
        invoice.amountRefundedMinor += amount;
        set.touch("invoice", invoice.id);
        const refund: RefundData = {
          id: this.newId("re"),
          customerId,
          invoiceId: invoice.id,
          amountMinor: amount,
          currency: invoice.currency,
          status: "succeeded",
        };
        set.put("refund", refund.id, customerId, refund);
        this.emit(set, "refund.created", { customerId, invoiceId: invoice.id }, call);
        this.emit(set, "charge.refunded", { customerId, invoiceId: invoice.id }, call);
        const { customerId: _customer, ...rest } = refund;
        return rest;
      }),
    );
  }

  // --- Promotions and catalogue ---------------------------------------------------------------

  async validatePromotionCode(input: {
    code: string;
    priceLookupKey: string;
  }): Promise<PromotionLookup> {
    const code = input.code.toUpperCase();
    const stored = (await this.store.get("promotion", code))?.data as PromotionData | undefined;
    const promotion = stored ?? this.seededPromotions.get(code);
    if (!promotion) return { valid: false, reason: "unknown" };
    return this.promotionLookup(promotion, input.priceLookupKey, this.clock.now());
  }

  async syncCatalogue(entries: readonly CatalogueEntry[]): Promise<CatalogueSyncResult> {
    return this.withLock("catalogue", async () => {
      const wall = this.clock.now();
      const set = new WorkingSet(wall, wall, await this.store.byKind("price"));
      const result: CatalogueSyncResult = { created: 0, updated: 0, archived: 0, unchanged: 0 };
      for (const entry of entries) {
        const existing = set.get<PriceData>("price", entry.lookupKey);
        if (
          existing?.active &&
          existing.amountMinor === entry.amountMinor &&
          existing.currency === entry.currency
        ) {
          result.unchanged += 1;
          continue;
        }
        // A changed amount is a new price that takes over the lookup key; the old one is
        // archived under its own id (docs/STRIPE.md §7, `transfer_lookup_key`).
        if (existing) {
          set.put("price", `${existing.lookupKey}@${existing.id}`, null, {
            ...existing,
            active: false,
          });
          result.archived += 1;
        }
        set.put("price", entry.lookupKey, null, {
          id: this.newId("price"),
          lookupKey: entry.lookupKey,
          productId: entry.productId,
          productName: entry.productName,
          amountMinor: entry.amountMinor,
          currency: entry.currency,
          active: true,
        } satisfies PriceData);
        result.created += 1;
      }
      await this.store.write(set.changed());
      return result;
    });
  }

  // --- Webhooks and events --------------------------------------------------------------------

  async parseWebhook(rawBody: Uint8Array, signatureHeader: string | null): Promise<ProviderEvent> {
    const parts = new Map<string, string[]>();
    for (const item of (signatureHeader ?? "").split(",")) {
      const index = item.indexOf("=");
      if (index < 0) continue;
      const key = item.slice(0, index).trim();
      parts.set(key, [...(parts.get(key) ?? []), item.slice(index + 1).trim()]);
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
    let event: unknown;
    try {
      event = JSON.parse(utf8Decode(rawBody));
    } catch {
      throw new WebhookSignatureError("the signed body is not JSON");
    }
    return normaliseEvent(event);
  }

  async listEvents(input: { createdAfter: number; limit: number }): Promise<ProviderEvent[]> {
    const documents = await this.store.byKind("event", {
      createdAfter: input.createdAfter,
      limit: input.limit,
    });
    return documents.map((document) => normaliseEvent(document.data));
  }

  /** A signed delivery of `event` as it would be sent (`Stripe-Signature` format). */
  async signedDelivery(
    event: ProviderEvent,
    options: { ageSec?: number } = {},
  ): Promise<{ body: Uint8Array; signature: string }> {
    const body = utf8Encode(JSON.stringify(event));
    const timestamp = Math.floor(this.clock.now() / 1000) - (options.ageSec ?? 0);
    return { body, signature: `t=${timestamp},v1=${await this.signature(timestamp, body)}` };
  }

  async deliveryPolicy(): Promise<DeliveryPolicy> {
    const stored = await this.store.get("settings", "delivery");
    return stored ? (stored.data as DeliveryPolicy) : this.defaultDelivery;
  }

  /** Stored, so every process (and isolate) of the deployment delivers the same way. */
  async setDeliveryPolicy(policy: DeliveryPolicy): Promise<void> {
    const wall = this.clock.now();
    const existing = await this.store.get("settings", "delivery");
    await this.store.write([
      {
        kind: "settings",
        id: "delivery",
        customerId: null,
        data: policy,
        version: (existing?.version ?? 0) + 1,
        createdAt: existing?.createdAt ?? wall,
        updatedAt: wall,
      },
    ]);
    if (policy.mode === "unruly" && policy.seed !== undefined) {
      this.random = seededRandom(policy.seed);
    }
  }

  /**
   * Delivers what is due to the attached receiver (oldest first, or shuffled when unruly).
   * Called after every operation and clock advance; call it to flush delayed deliveries. A
   * delivery the receiver refuses stays pending and is retried on the next pump.
   */
  async deliverPending(): Promise<{ delivered: number; pending: number }> {
    // One pump at a time in this process, in call order: orderly delivery stays in order.
    const run = (this.pumping ?? Promise.resolve()).then(() => this.pump());
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.pumping = settled;
    try {
      return await run;
    } finally {
      if (this.pumping === settled) this.pumping = undefined;
    }
  }

  // --- Test clocks ----------------------------------------------------------------------------

  /** The customer's clock reading (real time if it was never advanced). */
  async clockNow(customerId: string): Promise<number> {
    return this.customerNow(customerId, this.clock.now());
  }

  /**
   * Moves the customer's clock forward and settles everything that falls due on the way, in
   * order: trial ends, renewals, collection attempts, retries, expiry, cancellations at the
   * period end. Events carry the simulated time they happened at.
   */
  advanceTestClock(customerId: string, seconds: number): Promise<number> {
    return this.advanceClock(customerId, seconds);
  }

  async advanceClock(customerId: string, seconds: number): Promise<number> {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new PaymentProviderError("invalid_request", "clocks only move forward");
    }
    const target = await this.withLock(customerId, async () => {
      const wall = this.clock.now();
      const now = await this.customerNow(customerId, wall);
      const goal = now + seconds * 1000;
      const set = await this.load(customerId, wall, now);
      set.require<CustomerData>("customer", customerId, "customer");
      this.settle(set, goal);
      await this.store.setClock(customerId, { nowMs: goal, updatedAt: wall });
      await this.commit(set);
      return goal;
    });
    await this.deliverPending();
    return target;
  }

  // --- The browser's part (the payment form, and harnesses) ----------------------------------

  /**
   * The form confirming a setup with a test card. A card that asks for a challenge answers
   * `requires_action` until `challenge` is `complete` (or `fail`).
   */
  async confirmSetup(
    clientSecret: string,
    card: FakeCardChoice | null,
    options: { challenge?: "complete" | "fail" } = {},
  ): Promise<FormOutcome> {
    const setupId = idFromSecret(clientSecret);
    const customerId = setupId ? await this.customerOf("setup", setupId) : null;
    if (!setupId || !customerId) throw new PaymentProviderError("not_found");
    const outcome = await this.mutate(customerId, (set): FormOutcome => {
      const setup = set.get<SetupData>("setup", setupId);
      if (!setup || !secretMatches(setup.secret, clientSecret)) {
        throw new PaymentProviderError("not_found");
      }
      const chosen = card ?? setup.pendingCard;
      if (!chosen) throw new PaymentProviderError("invalid_request", "choose a card");
      if (setup.status === "requires_action" && card !== null && card !== setup.pendingCard) {
        setup.status = "requires_confirmation";
      }
      if (setup.status !== "requires_confirmation" && setup.status !== "requires_action") {
        throw new PaymentProviderError("invalid_request", "this setup is complete");
      }
      const spec = FAKE_CARDS[behaviourOf(chosen)];
      const fail = (code: PaymentFailureCode): FormOutcome => {
        setup.status = "failed";
        setup.failureCode = code;
        setup.pendingCard = null;
        set.touch("setup", setup.id);
        this.emit(set, "setup_intent.setup_failed", { customerId, setupId: setup.id }, null);
        return { status: "failed", code };
      };
      if (spec.declineAtConfirm) return fail(spec.declineAtConfirm);
      if (spec.challenge && options.challenge !== "complete") {
        if (options.challenge === "fail") return fail("authentication_required");
        setup.status = "requires_action";
        setup.pendingCard = chosen;
        set.touch("setup", setup.id);
        this.emit(set, "setup_intent.requires_action", { customerId, setupId: setup.id }, null);
        return { status: "requires_action" };
      }
      const method = this.attachCard(set, customerId, chosen);
      setup.status = "succeeded";
      setup.paymentMethodId = method.id;
      setup.pendingCard = null;
      setup.failureCode = null;
      set.touch("setup", setup.id);
      this.emit(set, "setup_intent.succeeded", { customerId, setupId: setup.id }, null);
      return { status: "succeeded" };
    });
    return outcome;
  }

  /**
   * The form paying an open invoice on-session (a first payment, or a renewal that needs the
   * member): with a new test card, or with the card on file (`card` null). The card used
   * becomes the subscription's default, like `save_default_payment_method: on_subscription`.
   */
  async confirmPayment(
    clientSecret: string,
    card: FakeCardChoice | null,
    options: { challenge?: "complete" | "fail" } = {},
  ): Promise<FormOutcome> {
    const invoiceId = idFromSecret(clientSecret);
    const customerId = invoiceId ? await this.customerOf("invoice", invoiceId) : null;
    if (!invoiceId || !customerId) throw new PaymentProviderError("not_found");
    const outcome = await this.mutate(customerId, (set): FormOutcome => {
      const invoice = set.get<InvoiceData>("invoice", invoiceId);
      if (!invoice?.secret || !secretMatches(invoice.secret, clientSecret)) {
        throw new PaymentProviderError("not_found");
      }
      if (invoice.status !== "open") {
        throw new PaymentProviderError("invalid_request", "this invoice is not open");
      }
      const customer = set.require<CustomerData>("customer", customerId, "customer");
      const subscription = set.get<SubscriptionData>("subscription", invoice.subscriptionId);
      const onFile = set.get<MethodData>(
        "payment_method",
        subscription?.defaultPaymentMethodId ?? customer.defaultPaymentMethodId,
      );
      const chosen = card ?? invoice.pendingCard ?? onFile?.card ?? null;
      if (!chosen) throw new PaymentProviderError("invalid_request", "choose a card");
      const spec = FAKE_CARDS[behaviourOf(chosen)];
      const fail = (code: PaymentFailureCode): FormOutcome => {
        invoice.attemptCount += 1;
        invoice.firstFailureAt ??= set.now;
        invoice.pendingCard = null;
        set.touch("invoice", invoice.id);
        this.emit(
          set,
          "invoice.payment_failed",
          { subscription: subscription ?? undefined, invoiceId: invoice.id },
          null,
        );
        return { status: "failed", code };
      };
      if (spec.declineAtConfirm) return fail(spec.declineAtConfirm);
      if (spec.challenge && options.challenge !== "complete") {
        if (options.challenge === "fail") return fail("authentication_required");
        invoice.pendingCard = chosen;
        set.touch("invoice", invoice.id);
        this.emit(
          set,
          "invoice.payment_action_required",
          { subscription: subscription ?? undefined, invoiceId: invoice.id },
          null,
        );
        return { status: "requires_action" };
      }
      const method =
        card === null && invoice.pendingCard === null && onFile
          ? onFile
          : this.attachCard(set, customerId, chosen);
      invoice.attemptCount += 1;
      invoice.pendingCard = null;
      this.markPaid(set, invoice, null);
      if (subscription) {
        subscription.defaultPaymentMethodId = method.id;
        set.touch("subscription", subscription.id);
        if (["incomplete", "past_due", "unpaid"].includes(subscription.status)) {
          this.setStatus(set, subscription, "active", null);
        }
      }
      customer.defaultPaymentMethodId ??= method.id;
      set.touch("customer", customer.id);
      return { status: "succeeded" };
    });
    return outcome;
  }

  /** What the form shows for a client secret: a setup to confirm or an invoice to pay. */
  async describeSecret(clientSecret: string): Promise<
    | {
        kind: "setup";
        status: SetupData["status"];
        pendingChallenge: boolean;
      }
    | {
        kind: "payment";
        status: ProviderInvoice["status"];
        amountMinor: number;
        currency: string;
        cardOnFile: { brand: string; last4: string } | null;
        pendingChallenge: boolean;
      }
    | null
  > {
    const id = idFromSecret(clientSecret);
    if (!id) return null;
    const kind: FakeDocumentKind = id.startsWith("seti_") ? "setup" : "invoice";
    const customerId = await this.customerOf(kind, id);
    if (!customerId) return null;
    return this.mutate(customerId, (set) => {
      if (kind === "setup") {
        const setup = set.get<SetupData>("setup", id);
        if (!setup || !secretMatches(setup.secret, clientSecret)) return null;
        return {
          kind: "setup" as const,
          status: setup.status,
          pendingChallenge: setup.pendingCard !== null,
        };
      }
      const invoice = set.get<InvoiceData>("invoice", id);
      if (!invoice?.secret || !secretMatches(invoice.secret, clientSecret)) return null;
      const customer = set.get<CustomerData>("customer", customerId);
      const subscription = set.get<SubscriptionData>("subscription", invoice.subscriptionId);
      const method = set.get<MethodData>(
        "payment_method",
        subscription?.defaultPaymentMethodId ?? customer?.defaultPaymentMethodId,
      );
      return {
        kind: "payment" as const,
        status: invoice.status,
        amountMinor: invoice.amountDueMinor,
        currency: invoice.currency,
        cardOnFile: method ? { brand: method.brand, last4: method.last4 } : null,
        pendingChallenge: invoice.pendingCard !== null,
      };
    });
  }

  /** A promo code (fixed amounts in the price's currency), optionally capped or expiring. */
  async definePromotion(input: {
    code: string;
    percentOff?: number;
    amountOffMinor?: number;
    currency?: string;
    expiresAt?: number;
    maxRedemptions?: number;
    appliesTo?: string[];
  }): Promise<void> {
    const wall = this.clock.now();
    const code = input.code.toUpperCase();
    await this.store.write([
      {
        kind: "promotion",
        id: code,
        customerId: null,
        data: {
          id: this.newId("promo"),
          code,
          percentOff: input.percentOff ?? null,
          amountOffMinor: input.amountOffMinor ?? null,
          currency: input.amountOffMinor === undefined ? null : (input.currency ?? "USD"),
          expiresAt: input.expiresAt ?? null,
          maxRedemptions: input.maxRedemptions ?? null,
          timesRedeemed: 0,
          appliesTo: input.appliesTo ?? null,
        } satisfies PromotionData,
        version: 1,
        createdAt: wall,
        updatedAt: wall,
      },
    ]);
  }

  // --- Internals: operations ------------------------------------------------------------------

  /**
   * Runs `run` once per idempotency key: the same key and parameters replay the first outcome
   * (a decline included), other parameters are `idempotency_conflict`, a key in flight elsewhere
   * is `unavailable` (retryable), like Stripe's 409.
   */
  private async idempotent<T>(
    method: string,
    params: unknown,
    call: ProviderCall,
    run: () => Promise<T>,
  ): Promise<T> {
    if (call.idempotencyKey.length === 0 || call.idempotencyKey.length > 255) {
      throw new PaymentProviderError("invalid_request", "idempotency key must be 1-255 characters");
    }
    const fingerprint = `${method}:${JSON.stringify(params)}`;
    const reservation = await this.store.reserveKey(
      call.idempotencyKey,
      fingerprint,
      this.clock.now(),
    );
    if (!reservation.reserved) {
      if (reservation.fingerprint !== fingerprint) {
        throw new PaymentProviderError("idempotency_conflict", "key reused with other parameters");
      }
      if (reservation.outcome === null) {
        throw new PaymentProviderError("unavailable", "a request with this key is in flight");
      }
      const outcome = JSON.parse(reservation.outcome) as
        | { ok: true; value: T }
        | { ok: false; code: PaymentFailureCode };
      if (!outcome.ok) throw new PaymentProviderError(outcome.code);
      return outcome.value;
    }
    try {
      const value = await run();
      await this.store.settleKey(
        call.idempotencyKey,
        JSON.stringify({ ok: true, value: value ?? null }),
      );
      return value;
    } catch (error) {
      if (error instanceof PaymentProviderError && CACHED_FAILURES.has(error.code)) {
        await this.store.settleKey(
          call.idempotencyKey,
          JSON.stringify({ ok: false, code: error.code }),
        );
      } else {
        await this.store.releaseKey(call.idempotencyKey);
      }
      throw error;
    }
  }

  /** Loads a customer's working set, settles what fell due, runs `run`, writes the result. */
  private async mutate<T>(customerId: string, run: (set: WorkingSet) => T): Promise<T> {
    let emitted = 0;
    try {
      return await this.withLock(customerId, async () => {
        const wall = this.clock.now();
        const now = await this.customerNow(customerId, wall);
        const set = await this.load(customerId, wall, now);
        this.settle(set, now);
        set.at = now;
        try {
          const result = run(set);
          emitted = set.events.length;
          await this.commit(set);
          return result;
        } catch (error) {
          // Failed attempts (declines) still leave their trace, as at a real provider.
          if (error instanceof PaymentProviderError) {
            emitted = set.events.length;
            await this.commit(set);
          }
          throw error;
        }
      });
    } finally {
      // Outside the lock: the receiver may read this customer back at once.
      if (emitted > 0) await this.deliverPending();
    }
  }

  private async load(customerId: string, wall: number, now: number): Promise<WorkingSet> {
    const [state, prices, promotions] = await Promise.all([
      this.store.byCustomer(customerId, CUSTOMER_STATE_KINDS),
      this.store.byKind("price"),
      this.store.byKind("promotion"),
    ]);
    // Standing codes not redeemed yet join as unsaved documents (written once touched).
    const seeds: FakeDocument[] = [...this.seededPromotions.values()]
      .filter((seed) => !promotions.some((document) => document.id === seed.code))
      .map((seed) => ({
        kind: "promotion",
        id: seed.code,
        customerId: null,
        data: structuredClone(seed),
        version: 0,
        createdAt: wall,
        updatedAt: wall,
      }));
    return new WorkingSet(wall, now, [...state, ...prices, ...promotions, ...seeds]);
  }

  private async commit(set: WorkingSet): Promise<void> {
    const policy = set.events.length > 0 ? await this.deliveryPolicy() : this.defaultDelivery;
    const documents = set.changed();
    for (const event of set.events) {
      documents.push({
        kind: "event",
        id: event.id,
        customerId: event.customerId,
        data: event,
        version: 1,
        createdAt: set.wall,
        updatedAt: set.wall,
      });
      if (policy.mode === "outage") continue;
      const delayed = policy.mode === "unruly" ? Math.floor(this.random() * policy.maxDelayMs) : 0;
      const copies = policy.mode === "unruly" && this.random() < policy.duplicateRate ? 2 : 1;
      documents.push({
        kind: "delivery",
        id: event.id,
        customerId: event.customerId,
        data: {
          eventId: event.id,
          deliverAt: set.wall + delayed,
          copies,
          attempts: 0,
        } satisfies DeliveryData,
        version: 1,
        createdAt: set.wall,
        updatedAt: set.wall,
      });
    }
    await this.store.write(documents);
    set.dirty.clear();
    set.events.length = 0;
  }

  private async pump(): Promise<{ delivered: number; pending: number }> {
    const receiver = this.receiver;
    const due = await this.store.byKind("delivery");
    if (!receiver || due.length === 0) return { delivered: 0, pending: due.length };
    const wall = this.clock.now();
    const policy = await this.deliveryPolicy();
    let ready = due.filter((document) => (document.data as DeliveryData).deliverAt <= wall);
    if (policy.mode === "outage") return { delivered: 0, pending: due.length };
    if (policy.mode === "unruly") ready = shuffle(ready, this.random);
    let delivered = 0;
    for (const document of ready) {
      const delivery = document.data as DeliveryData;
      const event = await this.store.get("event", delivery.eventId);
      if (!event) continue;
      try {
        for (let copy = 0; copy < delivery.copies; copy += 1) {
          await receiver(await this.signedDelivery(normaliseEvent(event.data)));
        }
        await this.store.delete([{ kind: "delivery", id: document.id }]);
        delivered += 1;
      } catch (error) {
        // Like a webhook endpoint answering 500: kept, retried on a later pump.
        this.logger?.warn("payments_fake.delivery_failed", {
          eventId: delivery.eventId,
          error: serializeError(error),
        });
        await this.store.write([
          {
            ...document,
            data: { ...delivery, attempts: delivery.attempts + 1 },
            version: document.version + 1,
            updatedAt: wall,
          },
        ]);
      }
    }
    return { delivered, pending: due.length - delivered };
  }

  private async withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.locks.set(key, chained);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    }
  }

  private async customerNow(customerId: string, wall: number): Promise<number> {
    const clock = await this.store.clock(customerId);
    return clock ? clock.nowMs + Math.max(0, wall - clock.updatedAt) : wall;
  }

  private async customerOf(kind: FakeDocumentKind, id: string): Promise<string | null> {
    return (await this.store.get(kind, id))?.customerId ?? null;
  }

  private async requireCustomerOf(kind: FakeDocumentKind, id: string): Promise<string> {
    const customerId = await this.customerOf(kind, id);
    if (!customerId) throw new PaymentProviderError("not_found", `no such ${kind}`);
    return customerId;
  }

  // --- Internals: the billing engine ----------------------------------------------------------

  /** Applies every transition due up to `until`, earliest first. */
  private settle(set: WorkingSet, until: number): void {
    for (let guard = 0; guard < 10_000; guard += 1) {
      const next = this.nextTransition(set);
      if (!next || next.at > until) return;
      set.at = Math.max(set.at, next.at);
      next.apply();
    }
    throw new Error("payments-fake: too many transitions in one settle");
  }

  private nextTransition(set: WorkingSet): { at: number; apply: () => void } | null {
    let best: { at: number; apply: () => void } | null = null;
    const consider = (at: number | null, apply: () => void) => {
      if (at !== null && (best === null || at < best.at)) best = { at, apply };
    };
    for (const subscription of set.all<SubscriptionData>("subscription")) {
      const { status } = subscription;
      if (status === "trialing" && subscription.trialEnd !== null) {
        const hint = subscription.trialEnd - TRIAL_WILL_END_MS;
        if (
          subscription.trialWillEndSentFor !== subscription.trialEnd &&
          hint > subscription.createdAt
        ) {
          consider(hint, () => {
            subscription.trialWillEndSentFor = subscription.trialEnd;
            set.touch("subscription", subscription.id);
            this.emit(set, "customer.subscription.trial_will_end", { subscription }, null);
          });
        }
        consider(subscription.trialEnd, () => this.endTrial(set, subscription));
      } else if (status === "active" || status === "past_due") {
        consider(subscription.currentPeriodEnd, () => this.periodEnds(set, subscription));
      } else if (status === "incomplete") {
        consider(subscription.createdAt + INCOMPLETE_EXPIRY_MS, () =>
          this.expireIncomplete(set, subscription),
        );
      }
    }
    for (const invoice of set.all<InvoiceData>("invoice")) {
      if (invoice.status === "open" && invoice.nextPaymentAttempt !== null) {
        consider(invoice.nextPaymentAttempt, () => {
          this.attempt(set, invoice, { scheduleRetry: true, call: null });
        });
      }
    }
    return best;
  }

  private endTrial(set: WorkingSet, subscription: SubscriptionData): void {
    const customer = set.require<CustomerData>("customer", subscription.customerId, "customer");
    const hasCard =
      (subscription.defaultPaymentMethodId ?? customer.defaultPaymentMethodId) !== null;
    // A trial set to end, or one without a card (`missing_payment_method: cancel`), ends with
    // nothing charged (observed: docs/STRIPE.md §8, cancel-refund).
    if (subscription.cancelAtPeriodEnd || !hasCard) {
      this.end(set, subscription, null);
      return;
    }
    this.renew(set, subscription);
  }

  private periodEnds(set: WorkingSet, subscription: SubscriptionData): void {
    if (subscription.cancelAtPeriodEnd) {
      this.end(set, subscription, null);
      return;
    }
    this.renew(set, subscription);
  }

  /** A new period: the subscription reads active at once; the invoice is collected later. */
  private renew(set: WorkingSet, subscription: SubscriptionData): void {
    const at = set.at;
    const price = this.activePrice(set, subscription.priceLookupKey);
    subscription.currentPeriodStart = at;
    subscription.currentPeriodEnd = at + FAKE_PERIOD_MS;
    if (subscription.status === "trialing") subscription.status = "active";
    const invoice = this.newInvoice(set, subscription, {
      totalMinor: price.amountMinor,
      currency: price.currency,
      billingReason: "subscription_cycle",
      periodStart: at,
      periodEnd: at + FAKE_PERIOD_MS,
      lines: [
        {
          description: `${price.productName} (${price.lookupKey})`,
          amountMinor: price.amountMinor,
        },
      ],
    });
    subscription.latestInvoiceId = invoice.id;
    set.touch("subscription", subscription.id);
    this.emit(set, "customer.subscription.updated", { subscription }, null);
    this.emit(set, "invoice.created", { subscription, invoiceId: invoice.id }, null);
    this.emit(set, "invoice.finalized", { subscription, invoiceId: invoice.id }, null);
    if (invoice.amountDueMinor === 0) {
      this.markPaid(set, invoice, null);
    } else {
      invoice.nextPaymentAttempt = at + COLLECTION_DELAY_MS;
      set.touch("invoice", invoice.id);
    }
  }

  /**
   * One collection attempt with the card on file. Returns the failure, if any. Off-session
   * attempts that need a challenge are not retried (observed at Stripe: no next attempt).
   */
  private attempt(
    set: WorkingSet,
    invoice: InvoiceData,
    options: { scheduleRetry: boolean; call: ProviderCall | null },
  ): PaymentFailureCode | null {
    const customer = set.require<CustomerData>("customer", invoice.customerId, "customer");
    const subscription = set.get<SubscriptionData>("subscription", invoice.subscriptionId);
    const failure = this.offSessionFailure(
      set,
      subscription?.defaultPaymentMethodId ?? customer.defaultPaymentMethodId,
    );
    invoice.attemptCount += 1;
    if (!failure) {
      this.markPaid(set, invoice, options.call);
      if (subscription && ["past_due", "unpaid", "incomplete"].includes(subscription.status)) {
        this.setStatus(set, subscription, "active", options.call);
      }
      return null;
    }
    invoice.firstFailureAt ??= set.at;
    const refs = { subscription: subscription ?? undefined, invoiceId: invoice.id };
    this.emit(set, "invoice.payment_failed", refs, options.call);
    let exhausted = false;
    if (failure === "authentication_required") {
      // Only the member can complete a challenge: no retry, a way to pay on-session instead.
      invoice.nextPaymentAttempt = null;
      invoice.secret ??= `${invoice.id}_secret_${this.randomToken(12)}`;
      this.emit(set, "invoice.payment_action_required", refs, options.call);
    } else if (options.scheduleRetry) {
      // An automatic attempt schedules the next retry, or ends dunning. A manual one
      // (`payInvoice`) leaves the schedule as it was.
      const retryDay = this.retryDays[invoice.attemptCount - 1];
      invoice.nextPaymentAttempt =
        retryDay === undefined ? null : invoice.firstFailureAt + retryDay * DAY_MS;
      exhausted = retryDay === undefined;
    }
    set.touch("invoice", invoice.id);
    if (subscription?.status === "active") {
      this.setStatus(set, subscription, "past_due", options.call);
    }
    if (exhausted && subscription) this.retriesRanOut(set, subscription);
    return failure;
  }

  private retriesRanOut(set: WorkingSet, subscription: SubscriptionData): void {
    if (this.retriesExhausted === "unpaid") {
      this.setStatus(set, subscription, "unpaid", null);
    } else {
      this.end(set, subscription, null);
    }
  }

  private expireIncomplete(set: WorkingSet, subscription: SubscriptionData): void {
    subscription.status = "incomplete_expired";
    subscription.endedAt = set.at;
    set.touch("subscription", subscription.id);
    this.voidOpenInvoices(set, subscription);
    this.emit(set, "customer.subscription.updated", { subscription }, null);
  }

  private end(set: WorkingSet, subscription: SubscriptionData, call: ProviderCall | null): void {
    subscription.status = "canceled";
    subscription.cancelAtPeriodEnd = false;
    subscription.endedAt = set.at;
    set.touch("subscription", subscription.id);
    this.voidOpenInvoices(set, subscription);
    this.emit(set, "customer.subscription.deleted", { subscription }, call);
  }

  private voidOpenInvoices(set: WorkingSet, subscription: SubscriptionData): void {
    for (const invoice of set.all<InvoiceData>("invoice")) {
      if (invoice.subscriptionId === subscription.id && invoice.status === "open") {
        invoice.status = "void";
        invoice.nextPaymentAttempt = null;
        invoice.secret = null;
        set.touch("invoice", invoice.id);
        this.emit(set, "invoice.voided", { subscription, invoiceId: invoice.id }, null);
      }
    }
  }

  private setStatus(
    set: WorkingSet,
    subscription: SubscriptionData,
    status: ProviderSubscriptionStatus,
    call: ProviderCall | null,
  ): void {
    if (subscription.status === status) return;
    subscription.status = status;
    set.touch("subscription", subscription.id);
    this.emit(set, "customer.subscription.updated", { subscription }, call);
  }

  private offSessionFailure(
    set: WorkingSet,
    paymentMethodId: string | null,
  ): PaymentFailureCode | null {
    const method = set.get<MethodData>("payment_method", paymentMethodId);
    if (!method) return "card_declined";
    return FAKE_CARDS[method.card].declineOffSession;
  }

  private attachCard(set: WorkingSet, customerId: string, choice: FakeCardChoice): MethodData {
    const parsed = parseCardChoice(choice);
    if (!parsed) throw new PaymentProviderError("invalid_request", "not a test card");
    const { card, label } = parsed;
    const spec = FAKE_CARDS[card];
    const method: MethodData = {
      id: this.newId("pm"),
      customerId,
      card,
      brand: spec.brand,
      last4: spec.number.slice(-4),
      expMonth: 12,
      expYear: new Date(set.now).getUTCFullYear() + 3,
      fingerprint: cardFingerprint(card, label),
      wallet: null,
    };
    set.put("payment_method", method.id, customerId, method);
    this.emit(set, "payment_method.attached", { customerId }, null);
    return method;
  }

  private prorate(
    set: WorkingSet,
    input: { subscriptionId: string; priceLookupKey: string; prorationDate: number },
  ): ProrationPreview & { balanceAfterMinor: number } {
    const subscription = set.require<SubscriptionData>(
      "subscription",
      input.subscriptionId,
      "subscription",
    );
    const customer = set.require<CustomerData>("customer", subscription.customerId, "customer");
    const current = this.activePrice(set, subscription.priceLookupKey);
    const next = this.activePrice(set, input.priceLookupKey);
    const lines: { description: string; amountMinor: number }[] = [];
    // A trial changes plan for free; a paid period is prorated to the millisecond.
    if (subscription.status === "active" || subscription.status === "past_due") {
      const start = subscription.currentPeriodStart;
      const end = subscription.currentPeriodEnd;
      const fraction =
        end > start ? Math.min(1, Math.max(0, (end - input.prorationDate) / (end - start))) : 0;
      lines.push(
        {
          description: `Unused time on ${current.productName}`,
          amountMinor: -Math.round(current.amountMinor * fraction),
        },
        {
          description: `Remaining time on ${next.productName}`,
          amountMinor: Math.round(next.amountMinor * fraction),
        },
      );
    }
    const total = lines.reduce((sum, line) => sum + line.amountMinor, 0);
    // The customer's credit pays first; a negative total becomes credit.
    const combined = total + customer.balanceMinor;
    const amountDue = Math.max(0, combined);
    const balanceAfter = Math.min(0, combined);
    return {
      currency: next.currency,
      amountDueMinor: amountDue,
      creditMinor: Math.max(0, -total),
      lines,
      prorationDate: input.prorationDate,
      nextRenewal: {
        at: subscription.currentPeriodEnd,
        amountMinor: Math.max(0, next.amountMinor + balanceAfter),
      },
      balanceAfterMinor: balanceAfter,
    };
  }

  private discounted(amountMinor: number, promotion: PromotionData | null): number {
    if (!promotion) return amountMinor;
    if (promotion.percentOff !== null) {
      // Stripe rounds the discount, not the total (docs/STRIPE.md §7: 50% off 799 is 399).
      return amountMinor - Math.round((amountMinor * promotion.percentOff) / 100);
    }
    return Math.max(0, amountMinor - (promotion.amountOffMinor ?? 0));
  }

  private promotionLookup(
    promotion: PromotionData,
    priceLookupKey: string,
    now: number,
  ): PromotionLookup {
    if (promotion.expiresAt !== null && promotion.expiresAt <= now) {
      return { valid: false, reason: "expired" };
    }
    if (promotion.maxRedemptions !== null && promotion.timesRedeemed >= promotion.maxRedemptions) {
      return { valid: false, reason: "exhausted" };
    }
    if (promotion.appliesTo && !promotion.appliesTo.includes(priceLookupKey)) {
      return { valid: false, reason: "not_applicable" };
    }
    return {
      valid: true,
      promotionId: promotion.id,
      code: promotion.code,
      percentOff: promotion.percentOff,
      amountOffMinor: promotion.amountOffMinor,
      currency: promotion.currency,
      duration: "once",
      durationInMonths: null,
    };
  }

  private newInvoice(
    set: WorkingSet,
    subscription: SubscriptionData,
    input: {
      totalMinor: number;
      currency: string;
      billingReason: ProviderInvoice["billingReason"];
      periodStart: number | null;
      periodEnd: number | null;
      lines: { description: string; amountMinor: number }[];
    },
  ): InvoiceData {
    const customer = set.require<CustomerData>("customer", subscription.customerId, "customer");
    let due = Math.max(0, input.totalMinor);
    if (input.billingReason !== "subscription_update" && due > 0 && customer.balanceMinor < 0) {
      // Credit from a downgrade pays (part of) the next invoice.
      const used = Math.min(due, -customer.balanceMinor);
      customer.balanceMinor += used;
      due -= used;
      set.touch("customer", customer.id);
    }
    const invoice: InvoiceData = {
      id: this.newId("in"),
      customerId: customer.id,
      subscriptionId: subscription.id,
      number: `FAKE-${String(this.nextSequence()).padStart(6, "0")}`,
      status: "open",
      currency: input.currency,
      totalMinor: input.totalMinor,
      amountPaidMinor: 0,
      amountDueMinor: due,
      amountRefundedMinor: 0,
      billingReason: input.billingReason,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      createdAt: set.at,
      paidAt: null,
      attemptCount: 0,
      nextPaymentAttempt: null,
      firstFailureAt: null,
      secret: null,
      pendingCard: null,
      lines: input.lines,
    };
    set.put("invoice", invoice.id, customer.id, invoice);
    return invoice;
  }

  private markPaid(set: WorkingSet, invoice: InvoiceData, call: ProviderCall | null): void {
    invoice.status = "paid";
    invoice.amountPaidMinor = invoice.amountDueMinor;
    invoice.amountDueMinor = 0;
    invoice.paidAt = set.at;
    invoice.nextPaymentAttempt = null;
    invoice.secret = null;
    set.touch("invoice", invoice.id);
    const subscription = set.get<SubscriptionData>("subscription", invoice.subscriptionId);
    this.emit(
      set,
      "invoice.paid",
      { subscription: subscription ?? undefined, invoiceId: invoice.id },
      call,
    );
  }

  private activePrice(set: WorkingSet, lookupKey: string): PriceData {
    const price = set.get<PriceData>("price", lookupKey);
    if (!price?.active) {
      throw new PaymentProviderError("invalid_request", `no price with lookup key ${lookupKey}`);
    }
    return price;
  }

  private publicSetup(set: WorkingSet, setup: SetupData): ProviderSetup {
    const method = set.get<MethodData>("payment_method", setup.paymentMethodId);
    const waiting = setup.status === "requires_confirmation" || setup.status === "requires_action";
    return {
      id: setup.id,
      customerId: setup.customerId,
      status: setup.status === "requires_action" ? "requires_confirmation" : setup.status,
      clientSecret: waiting ? setup.secret : null,
      paymentMethod: method ? displayMethod(method) : null,
      failureCode: setup.failureCode,
    };
  }

  private publicSubscription(
    set: WorkingSet,
    subscription: SubscriptionData,
  ): ProviderSubscription {
    const invoice = set.get<InvoiceData>("invoice", subscription.latestInvoiceId);
    const method = set.get<MethodData>("payment_method", subscription.defaultPaymentMethodId);
    return {
      id: subscription.id,
      customerId: subscription.customerId,
      status: subscription.status,
      priceLookupKey: subscription.priceLookupKey,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      trialEnd: subscription.trialEnd,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      endedAt: subscription.endedAt,
      latestInvoiceId: subscription.latestInvoiceId,
      defaultPaymentMethodId: subscription.defaultPaymentMethodId,
      defaultPaymentMethod: method ? displayMethod(method) : null,
      // A first payment, or a renewal that needs the member (a challenge), can be paid
      // on-session with this.
      paymentClientSecret: invoice?.status === "open" ? invoice.secret : null,
      clockNow: set.now,
    };
  }

  private emit(
    set: WorkingSet,
    type: string,
    refs: {
      subscription?: SubscriptionData | undefined;
      invoiceId?: string;
      customerId?: string;
      setupId?: string;
    },
    call: ProviderCall | null,
  ): void {
    set.events.push({
      // Sortable: events logged in the same millisecond list in the order they happened.
      id: `evt_fake${set.wall.toString(36).padStart(9, "0")}${this.nextSequence().toString(36).padStart(3, "0")}${this.randomToken(6)}`,
      type,
      createdAt: set.wall,
      occurredAt: set.at,
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
    const signed = new Uint8Array(utf8Encode(`${timestamp}.`).byteLength + body.byteLength);
    signed.set(utf8Encode(`${timestamp}.`), 0);
    signed.set(body, utf8Encode(`${timestamp}.`).byteLength);
    return hexEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, signed)));
  }

  private nextSequence(): number {
    this.sequence = (this.sequence + 1) % 46_656;
    return this.sequence;
  }

  private newId(prefix: string): string {
    return `${prefix}_fake${this.randomToken(14)}`;
  }

  private randomToken(length: number): string {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
  }
}

// --- Helpers --------------------------------------------------------------------------------

/** Failures a replay returns as they were (the provider caches them under the key). */
const CACHED_FAILURES: ReadonlySet<PaymentFailureCode> = new Set([
  "card_declined",
  "insufficient_funds",
  "expired_card",
  "incorrect_cvc",
  "processing_error",
  "authentication_required",
  "not_found",
  "invalid_request",
]);

function publicInvoice(invoice: InvoiceData): ProviderInvoice {
  return {
    id: invoice.id,
    customerId: invoice.customerId,
    subscriptionId: invoice.subscriptionId,
    number: invoice.number,
    status: invoice.status,
    currency: invoice.currency,
    totalMinor: invoice.totalMinor,
    amountPaidMinor: invoice.amountPaidMinor,
    amountDueMinor: invoice.amountDueMinor,
    amountRefundedMinor: invoice.amountRefundedMinor,
    billingReason: invoice.billingReason,
    periodStart: invoice.periodStart,
    periodEnd: invoice.periodEnd,
    createdAt: invoice.createdAt,
    paidAt: invoice.paidAt,
    attemptCount: invoice.attemptCount,
    nextPaymentAttempt: invoice.nextPaymentAttempt,
    hostedUrl: null,
    pdfUrl: null,
  };
}

/** The test card a choice behaves like (`visa:run-42` behaves like `visa`). */
function behaviourOf(choice: FakeCardChoice): FakeTestCard {
  const parsed = parseCardChoice(choice);
  if (!parsed) throw new PaymentProviderError("invalid_request", "not a test card");
  return parsed.card;
}

function displayMethod(method: MethodData): ProviderPaymentMethod {
  return {
    id: method.id,
    brand: method.brand,
    last4: method.last4,
    expMonth: method.expMonth,
    expYear: method.expYear,
    fingerprint: method.fingerprint,
    wallet: method.wallet,
  };
}

/** `seti_…_secret_…` / `in_…_secret_…` → the object id. */
function idFromSecret(secret: string): string | null {
  const match = /^((?:seti|in)_fake[a-z0-9]+)_secret_[a-z0-9]+$/.exec(secret);
  return match?.[1] ?? null;
}

function secretMatches(expected: string, given: string): boolean {
  return timingSafeEqual(utf8Encode(expected), utf8Encode(given));
}

const nullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/** A signed body as a `ProviderEvent`: only the known fields, typed, nothing else carried. */
function normaliseEvent(value: unknown): ProviderEvent {
  const event = (value ?? {}) as Record<string, unknown>;
  if (typeof event.id !== "string" || typeof event.type !== "string") {
    throw new WebhookSignatureError("the signed body is not an event");
  }
  return {
    id: event.id,
    type: event.type,
    createdAt: typeof event.createdAt === "number" ? event.createdAt : 0,
    occurredAt:
      typeof event.occurredAt === "number"
        ? event.occurredAt
        : typeof event.createdAt === "number"
          ? event.createdAt
          : 0,
    customerId: nullableString(event.customerId),
    subscriptionId: nullableString(event.subscriptionId),
    invoiceId: nullableString(event.invoiceId),
    setupId: nullableString(event.setupId),
    idempotencyKey: nullableString(event.idempotencyKey),
  };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

/** Mulberry32: deterministic unruly delivery for reproducible tests. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
