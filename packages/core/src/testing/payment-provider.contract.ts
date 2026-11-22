import { describe, expect, it } from "vitest";
import {
  billingIdempotencyKey,
  type CatalogueEntry,
  type PaymentFailureCode,
  type PaymentProvider,
  PaymentProviderError,
  type PaymentTestCard,
  type ProviderSetup,
  type ProviderSubscription,
  WebhookSignatureError,
} from "../ports/payment-provider.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "./harness.ts";

export interface PaymentProviderHarness extends HarnessBase {
  provider: PaymentProvider;
  /**
   * Two prices of one currency, already synced (`syncCatalogue`): the cheaper `basic` and the
   * dearer `premium`. Stripe: the sandbox's catalogue; the fake: synced by the factory.
   */
  prices: { basic: CatalogueEntry; premium: CatalogueEntry };
  /** The browser confirming a setup with the provider's form and a test card. */
  confirmSetup(setup: ProviderSetup, card: PaymentTestCard): Promise<void>;
  /** The browser paying an incomplete first invoice on-session (a challenge is completed). */
  confirmPayment(subscription: ProviderSubscription, card: PaymentTestCard): Promise<void>;
  /** Creates a percentage promo code (applies to every price), optionally capped or expiring. */
  createPromotion(input: {
    code: string;
    percentOff: number;
    maxRedemptions?: number;
  }): Promise<void>;
  /** A delivery of some event of this provider, signed now or `ageSec` ago. */
  webhook(options?: {
    ageSec?: number;
  }): Promise<{ body: Uint8Array; signature: string; id: string }>;
  /**
   * The provider's real time (epoch ms), so event listing can look back a few minutes instead
   * of over the whole account (a real sandbox holds thousands of events). Absent: list from 0.
   */
  now?(): number;
}

/** Contract every `PaymentProvider` adapter must pass (the Stripe sandbox lane and the fake). */
export function describePaymentProviderContract(
  name: string,
  factory: HarnessFactory<PaymentProviderHarness>,
): void {
  describe(`PaymentProvider contract: ${name}`, () => {
    const h = useHarness(factory);
    const operation = () => crypto.randomUUID();
    const key = (attempt = 1) => ({ idempotencyKey: billingIdempotencyKey(operation(), attempt) });

    async function failure(promise: Promise<unknown>): Promise<PaymentFailureCode> {
      const error = await promise.then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error, "expected the provider to refuse").toBeInstanceOf(PaymentProviderError);
      return (error as PaymentProviderError).code;
    }

    async function customerWithCard(card: PaymentTestCard = "visa") {
      const { provider } = h();
      const customer = await provider.createCustomer(
        { accountId: `acct-${operation()}`, email: `member-${operation()}@example.test` },
        key(),
      );
      const setup = await provider.createSetup({ customerId: customer.id }, key());
      expect(setup.status).toBe("requires_confirmation");
      expect(setup.clientSecret).toBeTruthy();
      await h().confirmSetup(setup, card);
      const confirmed = await provider.retrieveSetup(setup.id);
      return { customer, setup: confirmed };
    }

    async function activeSubscription(lookupKey = h().prices.basic.lookupKey) {
      const { customer, setup } = await customerWithCard("visa");
      const paymentMethodId = setup?.paymentMethod?.id ?? null;
      const created = await h().provider.createSubscription(
        {
          customerId: customer.id,
          priceLookupKey: lookupKey,
          paymentMethodId,
          trialDays: null,
          promotionId: null,
        },
        key(),
      );
      if (created.status === "incomplete") await h().confirmPayment(created, "visa");
      const subscription = await h().provider.retrieveSubscription(created.id);
      expect(subscription?.status).toBe("active");
      return { customer, subscription: subscription as ProviderSubscription, paymentMethodId };
    }

    it("syncs the catalogue by lookup key: a second pass writes nothing", async () => {
      const { provider, prices } = h();
      const again = await provider.syncCatalogue([prices.basic, prices.premium]);
      expect(again).toMatchObject({ created: 0, archived: 0, unchanged: 2 });
    });

    it("confirms a card at setup and fingerprints it the same for every customer", async () => {
      const first = await customerWithCard("visa");
      const second = await customerWithCard("visa");
      const other = await customerWithCard("mastercard");
      expect(first.setup?.status).toBe("succeeded");
      expect(first.setup?.paymentMethod).toMatchObject({ brand: "visa" });
      expect(first.setup?.paymentMethod?.last4).toMatch(/^\d{4}$/);
      expect(first.setup?.paymentMethod?.fingerprint).toBeTruthy();
      expect(second.setup?.paymentMethod?.fingerprint).toBe(
        first.setup?.paymentMethod?.fingerprint,
      );
      expect(other.setup?.paymentMethod?.fingerprint).not.toBe(
        first.setup?.paymentMethod?.fingerprint,
      );
    });

    it("reports a card declined at setup", async () => {
      const { setup } = await customerWithCard("declined");
      expect(setup?.status).toBe("failed");
      expect(setup?.failureCode).toBe("card_declined");
      expect(setup?.paymentMethod).toBeNull();
    });

    it("starts a trial without charging", async () => {
      const { customer, setup } = await customerWithCard("visa");
      const subscription = await h().provider.createSubscription(
        {
          customerId: customer.id,
          priceLookupKey: h().prices.basic.lookupKey,
          paymentMethodId: setup?.paymentMethod?.id ?? null,
          trialDays: 7,
          promotionId: null,
        },
        key(),
      );
      expect(subscription.status).toBe("trialing");
      expect(subscription.trialEnd).not.toBeNull();
      expect(
        (subscription.trialEnd ?? 0) - (subscription.currentPeriodStart ?? 0),
      ).toBeGreaterThanOrEqual(7 * 24 * 3_600_000 - 60_000);
      const invoice = await h().provider.retrieveInvoice(subscription.latestInvoiceId ?? "");
      expect(invoice).toMatchObject({ status: "paid", amountPaidMinor: 0 });
    });

    it("leaves a paid start incomplete until the browser confirms the first payment", async () => {
      const { customer, setup } = await customerWithCard("visa");
      const created = await h().provider.createSubscription(
        {
          customerId: customer.id,
          priceLookupKey: h().prices.basic.lookupKey,
          paymentMethodId: setup?.paymentMethod?.id ?? null,
          trialDays: null,
          promotionId: null,
        },
        key(),
      );
      expect(created.status).toBe("incomplete");
      expect(created.paymentClientSecret).toBeTruthy();
      await h().confirmPayment(created, "visa");
      const subscription = await h().provider.retrieveSubscription(created.id);
      expect(subscription?.status).toBe("active");
      const invoice = await h().provider.retrieveInvoice(subscription?.latestInvoiceId ?? "");
      expect(invoice).toMatchObject({
        status: "paid",
        amountPaidMinor: h().prices.basic.amountMinor,
      });
    });

    it("replays an outcome under its idempotency key and refuses the key with other parameters", async () => {
      const { provider } = h();
      const call = key();
      const input = {
        accountId: `acct-${operation()}`,
        email: `member-${operation()}@example.test`,
      };
      const first = await provider.createCustomer(input, call);
      expect(await provider.createCustomer(input, call)).toEqual(first);
      expect(
        await failure(
          provider.createCustomer({ ...input, email: `other-${operation()}@example.test` }, call),
        ),
      ).toBe("idempotency_conflict");
    });

    it("replays a decline under its key; a new attempt with another card needs a new key", async () => {
      const { subscription, customer } = await activeSubscription();
      const declined = await customerWithCardOn(customer.id, "charge-declined");
      const operationId = operation();
      const first = { idempotencyKey: billingIdempotencyKey(operationId, 1) };
      const upgrade = {
        subscriptionId: subscription.id,
        priceLookupKey: h().prices.premium.lookupKey,
        prorationDate: subscription.currentPeriodStart ?? 0,
      };
      await h().provider.setDefaultPaymentMethod(
        { customerId: customer.id, paymentMethodId: declined, subscriptionId: subscription.id },
        key(),
      );
      expect(await failure(h().provider.changePlan(upgrade, first))).toBe("card_declined");
      const good = await customerWithCardOn(customer.id, "visa");
      await h().provider.setDefaultPaymentMethod(
        { customerId: customer.id, paymentMethodId: good, subscriptionId: subscription.id },
        key(),
      );
      // The same key replays the decline even though the card is fixed now.
      expect(await failure(h().provider.changePlan(upgrade, first))).toBe("card_declined");
      const second = { idempotencyKey: billingIdempotencyKey(operationId, 2) };
      const changed = await h().provider.changePlan(upgrade, second);
      expect(changed.priceLookupKey).toBe(h().prices.premium.lookupKey);
    });

    async function customerWithCardOn(customerId: string, card: PaymentTestCard): Promise<string> {
      const setup = await h().provider.createSetup({ customerId }, key());
      await h().confirmSetup(setup, card);
      const confirmed = await h().provider.retrieveSetup(setup.id);
      expect(confirmed?.status).toBe("succeeded");
      return confirmed?.paymentMethod?.id ?? "";
    }

    it("invoices a plan change exactly as previewed with the same proration date", async () => {
      const { subscription } = await activeSubscription();
      const prorationDate = subscription.currentPeriodStart ?? 0;
      const preview = await h().provider.previewPlanChange({
        subscriptionId: subscription.id,
        priceLookupKey: h().prices.premium.lookupKey,
        prorationDate,
      });
      expect(preview.amountDueMinor).toBeGreaterThan(0);
      const changed = await h().provider.changePlan(
        {
          subscriptionId: subscription.id,
          priceLookupKey: h().prices.premium.lookupKey,
          prorationDate,
        },
        key(),
      );
      const invoice = await h().provider.retrieveInvoice(changed.latestInvoiceId ?? "");
      expect(invoice?.amountPaidMinor).toBe(preview.amountDueMinor);
      expect(invoice?.totalMinor).toBe(
        preview.lines.reduce((sum, line) => sum + line.amountMinor, 0),
      );
    });

    it("previews a downgrade as a credit, not a charge", async () => {
      const { subscription } = await activeSubscription(h().prices.premium.lookupKey);
      const preview = await h().provider.previewPlanChange({
        subscriptionId: subscription.id,
        priceLookupKey: h().prices.basic.lookupKey,
        prorationDate: subscription.currentPeriodStart ?? 0,
      });
      expect(preview.amountDueMinor).toBe(0);
      expect(preview.creditMinor).toBeGreaterThan(0);
    });

    it("previews the next invoice: the plan's price when a trial ends, less a downgrade's credit, none while cancelling", async () => {
      const { customer, setup } = await customerWithCard("visa");
      const trial = await h().provider.createSubscription(
        {
          customerId: customer.id,
          priceLookupKey: h().prices.basic.lookupKey,
          paymentMethodId: setup?.paymentMethod?.id ?? null,
          trialDays: 7,
          promotionId: null,
        },
        key(),
      );
      expect(await h().provider.previewNextInvoice(trial.id)).toEqual({
        at: trial.trialEnd,
        amountMinor: h().prices.basic.amountMinor,
        currency: h().prices.basic.currency.toUpperCase(),
      });
      await h().provider.setCancelAtPeriodEnd(
        { subscriptionId: trial.id, cancelAtPeriodEnd: true },
        key(),
      );
      expect(await h().provider.previewNextInvoice(trial.id)).toBeNull();

      const { subscription } = await activeSubscription(h().prices.premium.lookupKey);
      const preview = await h().provider.previewPlanChange({
        subscriptionId: subscription.id,
        priceLookupKey: h().prices.basic.lookupKey,
        prorationDate: subscription.currentPeriodStart ?? 0,
      });
      await h().provider.changePlan(
        {
          subscriptionId: subscription.id,
          priceLookupKey: h().prices.basic.lookupKey,
          prorationDate: preview.prorationDate,
        },
        key(),
      );
      // Exactly what the plan change's preview said the next renewal would be.
      expect(await h().provider.previewNextInvoice(subscription.id)).toEqual({
        at: preview.nextRenewal?.at,
        amountMinor: preview.nextRenewal?.amountMinor,
        currency: h().prices.basic.currency.toUpperCase(),
      });
      await h().provider.cancelNow({ subscriptionId: subscription.id }, key());
      expect(await h().provider.previewNextInvoice(subscription.id)).toBeNull();
    });

    it("cancels at the period end (still active) and undoes it; cancels now (ended)", async () => {
      const { subscription } = await activeSubscription();
      const pending = await h().provider.setCancelAtPeriodEnd(
        { subscriptionId: subscription.id, cancelAtPeriodEnd: true },
        key(),
      );
      expect(pending).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
      const resumed = await h().provider.setCancelAtPeriodEnd(
        { subscriptionId: subscription.id, cancelAtPeriodEnd: false },
        key(),
      );
      expect(resumed.cancelAtPeriodEnd).toBe(false);
      const ended = await h().provider.cancelNow({ subscriptionId: subscription.id }, key());
      expect(ended.status).toBe("canceled");
      expect(ended.endedAt).not.toBeNull();
      expect((await h().provider.retrieveSubscription(subscription.id))?.status).toBe("canceled");
    });

    it("refunds in parts up to what was paid, leaving the invoice paid", async () => {
      const { subscription } = await activeSubscription();
      const invoiceId = subscription.latestInvoiceId ?? "";
      const paid = h().prices.basic.amountMinor;
      const partial = await h().provider.refund({ invoiceId, amountMinor: 100 }, key());
      expect(partial.amountMinor).toBe(100);
      const rest = await h().provider.refund({ invoiceId, amountMinor: null }, key());
      expect(rest.amountMinor).toBe(paid - 100);
      expect(await failure(h().provider.refund({ invoiceId, amountMinor: 1 }, key()))).toBe(
        "invalid_request",
      );
      const invoice = await h().provider.retrieveInvoice(invoiceId);
      expect(invoice).toMatchObject({
        status: "paid",
        amountPaidMinor: paid,
        amountRefundedMinor: paid,
      });
      expect((await h().provider.retrieveSubscription(subscription.id))?.status).toBe("active");
    });

    it("reads a promo code before applying it, and says why one cannot be used", async () => {
      const code = `WFX${operation().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
      await h().createPromotion({ code, percentOff: 50, maxRedemptions: 1 });
      const lookupKey = h().prices.basic.lookupKey;
      const valid = await h().provider.validatePromotionCode({ code, priceLookupKey: lookupKey });
      expect(valid).toMatchObject({ valid: true, percentOff: 50 });
      expect(
        await h().provider.validatePromotionCode({
          code: `${code}NOPE`,
          priceLookupKey: lookupKey,
        }),
      ).toEqual({ valid: false, reason: "unknown" });
      if (!valid.valid) return;
      const { customer, setup } = await customerWithCard("visa");
      const created = await h().provider.createSubscription(
        {
          customerId: customer.id,
          priceLookupKey: lookupKey,
          paymentMethodId: setup?.paymentMethod?.id ?? null,
          trialDays: null,
          promotionId: valid.promotionId,
        },
        key(),
      );
      const invoice = await h().provider.retrieveInvoice(created.latestInvoiceId ?? "");
      // Stripe rounds the discount, not the total: 50% off 799 is 799 - 400 = 399
      // (docs/STRIPE.md §7, observed).
      const price = h().prices.basic.amountMinor;
      expect(invoice?.amountDueMinor).toBe(price - Math.round(price * 0.5));
      expect(await h().provider.validatePromotionCode({ code, priceLookupKey: lookupKey })).toEqual(
        {
          valid: false,
          reason: "exhausted",
        },
      );
    });

    it("verifies webhook signatures over the exact bytes, within the tolerance", async () => {
      const delivery = await h().webhook();
      const event = await h().provider.parseWebhook(delivery.body, delivery.signature);
      expect(event.id).toBe(delivery.id);
      expect(typeof event.type).toBe("string");
      // The normalised event survives structured cloning (queue payloads).
      expect(structuredClone(event)).toEqual(event);

      const tampered = new Uint8Array(delivery.body);
      tampered[tampered.length - 2] = (tampered[tampered.length - 2] ?? 0) ^ 1;
      await expect(h().provider.parseWebhook(tampered, delivery.signature)).rejects.toBeInstanceOf(
        WebhookSignatureError,
      );
      await expect(h().provider.parseWebhook(delivery.body, null)).rejects.toBeInstanceOf(
        WebhookSignatureError,
      );
      const stale = await h().webhook({ ageSec: 3600 });
      await expect(h().provider.parseWebhook(stale.body, stale.signature)).rejects.toBeInstanceOf(
        WebhookSignatureError,
      );
    });

    it("lists the events its calls caused, tied to their idempotency keys", async () => {
      const { provider } = h();
      const since = h().now ? (h().now?.() ?? 0) - 5 * 60_000 : 0;
      const call = key();
      const customer = await provider.createCustomer(
        { accountId: `acct-${operation()}`, email: `member-${operation()}@example.test` },
        call,
      );
      // Real providers log events asynchronously (Stripe: about a second): look a few times.
      let created: Awaited<ReturnType<typeof provider.listEvents>>[number] | undefined;
      for (let attempt = 0; attempt < 10 && !created; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
        const events = await provider.listEvents({ createdAfter: since, limit: 1000 });
        created = events.find((event) => event.customerId === customer.id);
      }
      expect(created?.idempotencyKey).toBe(call.idempotencyKey);
    });

    it("answers null for a subscription, invoice or setup it does not know", async () => {
      const { provider } = h();
      expect(await provider.retrieveSubscription("sub_WFXunknown0000000000")).toBeNull();
      expect(await provider.retrieveInvoice("in_WFXunknown0000000000")).toBeNull();
      expect(await provider.retrieveSetup("seti_WFXunknown0000000000")).toBeNull();
    });

    it("moves the end of the free period of an active subscription (a trial until then)", async () => {
      const { subscription } = await activeSubscription();
      const trialEnd = (subscription.currentPeriodStart ?? 0) + 3 * 24 * 3_600_000;
      const moved = await h().provider.setTrialEnd(
        { subscriptionId: subscription.id, trialEnd },
        key(),
      );
      expect(moved.status).toBe("trialing");
      expect(Math.abs((moved.trialEnd ?? 0) - trialEnd)).toBeLessThan(2_000);
    });

    it("deletes a customer: its subscription ends, its invoices stay, a second delete is fine", async () => {
      const { customer, subscription } = await activeSubscription();
      await h().provider.deleteCustomer({ customerId: customer.id }, key());
      expect((await h().provider.retrieveSubscription(subscription.id))?.status).toBe("canceled");
      expect((await h().provider.retrieveInvoice(subscription.latestInvoiceId ?? ""))?.status).toBe(
        "paid",
      );
      await h().provider.deleteCustomer({ customerId: customer.id }, key());
    });

    it("reports the default card for display and the clock it reads time from", async () => {
      const { subscription } = await activeSubscription();
      expect(subscription.defaultPaymentMethod).toMatchObject({ brand: "visa" });
      expect(subscription.defaultPaymentMethod?.last4).toMatch(/^\d{4}$/);
      expect(subscription.clockNow === null || typeof subscription.clockNow === "number").toBe(
        true,
      );
    });
  });
}
