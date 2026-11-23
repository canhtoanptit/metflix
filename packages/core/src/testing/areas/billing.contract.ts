import { describe, expect, it } from "vitest";
import type {
  CheckoutRecord,
  InvoiceRecord,
  MembershipRecord,
  ProviderEventRecord,
} from "../../areas/billing/repository.ts";
import type { Repositories } from "../../repositories/ports.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "../harness.ts";
import {
  DAY_MS,
  makeAccountRecord,
  makeSessionRecord,
  makeSubscriptionRecord,
  T0,
} from "../records.ts";

export interface BillingRepositoryHarness extends HarnessBase {
  repos: Repositories;
}

export function makeMembershipRecord(overrides: Partial<MembershipRecord> = {}): MembershipRecord {
  return {
    accountId: "acc-1",
    provider: "fake",
    providerCustomerId: "cus_1",
    providerSubscriptionId: "sub_1",
    planId: "standard",
    priceLookupKey: "webflix.standard.monthly.usd",
    status: "active",
    suspendedReason: null,
    cancelAtPeriodEnd: false,
    trialEndsAt: null,
    currentPeriodStart: T0,
    currentPeriodEnd: T0 + 30 * DAY_MS,
    graceStartedAt: null,
    graceInvoiceId: null,
    endedAt: null,
    latestInvoiceId: "in_1",
    paymentMethod: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 },
    trialRedeemedAt: null,
    nextInvoice: null,
    clockOffsetMs: 0,
    version: 1,
    providerSyncedAt: T0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function makeCheckoutRecord(overrides: Partial<CheckoutRecord> = {}): CheckoutRecord {
  return {
    id: "chk-1",
    accountId: "acc-1",
    planId: "standard",
    currency: "USD",
    status: "requires_setup",
    promotionCode: null,
    promotionId: null,
    promotion: null,
    provider: "fake",
    providerCustomerId: "cus_1",
    providerSetupId: "seti_1",
    providerSubscriptionId: null,
    providerPaymentMethodId: null,
    trialDays: null,
    trialFingerprint: null,
    amountDueMinor: null,
    creditAppliedMinor: null,
    discountMinor: null,
    failureReason: null,
    operationId: "op-1",
    attempt: 1,
    createdAt: T0,
    expiresAt: T0 + DAY_MS,
    updatedAt: T0,
    clientSecret: "seti_1_secret_x",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ProviderEventRecord> = {}): ProviderEventRecord {
  return {
    provider: "fake",
    eventId: "evt_1",
    type: "customer.subscription.updated",
    accountId: null,
    idempotencyKey: null,
    customerId: "cus_1",
    subscriptionId: "sub_1",
    invoiceId: null,
    setupId: null,
    eventCreatedAt: T0,
    source: "webhook",
    receivedAt: T0,
    processedAt: null,
    status: "pending",
    attempts: 0,
    lastError: null,
    ...overrides,
  };
}

function makeInvoice(overrides: Partial<InvoiceRecord> = {}): InvoiceRecord {
  return {
    id: "inv-1",
    accountId: "acc-1",
    provider: "fake",
    providerInvoiceId: "in_1",
    providerSubscriptionId: "sub_1",
    number: "FAKE-000001",
    status: "paid",
    currency: "USD",
    totalMinor: 1299,
    amountPaidMinor: 1299,
    amountDueMinor: 0,
    amountRefundedMinor: 0,
    billingReason: "subscription_create",
    periodStart: T0,
    periodEnd: T0 + 30 * DAY_MS,
    hostedUrl: null,
    pdfUrl: null,
    creditAppliedMinor: null,
    discountMinor: null,
    issuedAt: T0,
    paidAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

/** The projection, checkouts and setups reference `accounts` (they cascade with it). */
async function createAccount(repos: Repositories, id: string): Promise<void> {
  await repos.accounts.createWithSession({
    account: makeAccountRecord({ id, email: `${id}@example.com` }),
    subscription: makeSubscriptionRecord({ accountId: id }),
    session: makeSessionRecord({ id: `ses-${id}`, tokenHash: `hash-${id}`, accountId: id }),
  });
}

/**
 * Contract of the billing area's repository (`repos.billing`), run against memory, SQLite,
 * PostgreSQL and D1.
 */
export function describeBillingRepositoryContract(
  name: string,
  factory: HarnessFactory<BillingRepositoryHarness>,
): void {
  describe(`BillingRepository contract: ${name}`, () => {
    const h = useHarness(factory);
    const billing = () => h().repos.billing;

    it("keeps the first customer stored for an account and finds it by provider id", async () => {
      const first = {
        accountId: "acc-1",
        provider: "fake" as const,
        customerId: "cus_a",
        createdAt: T0,
      };
      expect(await billing().saveCustomer(first)).toEqual(first);
      expect(await billing().saveCustomer({ ...first, customerId: "cus_b" })).toEqual(first);
      expect(await billing().getCustomer("acc-1", "fake")).toEqual(first);
      expect(await billing().getCustomer("acc-1", "stripe")).toBeNull();
      expect(await billing().findCustomer("fake", "cus_a")).toEqual(first);
      expect(await billing().findCustomer("fake", "cus_b")).toBeNull();
    });

    it("writes the projection only with the version it read (compare-and-set)", async () => {
      await createAccount(h().repos, "acc-1");
      const record = makeMembershipRecord();
      expect(await billing().saveMembership(record, null)).toBe(true);
      expect(await billing().saveMembership(record, null)).toBe(false);
      expect(await billing().getMembership("acc-1")).toEqual(record);

      const next = { ...record, status: "past_due" as const, graceStartedAt: T0 + 5, version: 2 };
      expect(await billing().saveMembership(next, 1)).toBe(true);
      // A writer that read version 1 lost: its write must not land.
      expect(await billing().saveMembership({ ...record, version: 2 }, 1)).toBe(false);
      expect(await billing().getMembership("acc-1")).toEqual(next);
      expect(await billing().getMembership("acc-2")).toBeNull();
    });

    it("round-trips every field of the projection, nulls included", async () => {
      await createAccount(h().repos, "acc-1");
      const record = makeMembershipRecord({
        providerSubscriptionId: null,
        planId: null,
        priceLookupKey: null,
        status: "suspended",
        suspendedReason: "unpaid",
        cancelAtPeriodEnd: true,
        trialEndsAt: T0 + DAY_MS,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        graceStartedAt: T0 + 1,
        graceInvoiceId: "in_9",
        endedAt: T0 + 2,
        latestInvoiceId: null,
        paymentMethod: null,
        trialRedeemedAt: T0 + 3,
        clockOffsetMs: 7 * DAY_MS,
      });
      await billing().saveMembership(record, null);
      expect(await billing().getMembership("acc-1")).toEqual(record);
    });

    it("lists memberships to reconcile: stale and still able to change, oldest first", async () => {
      for (const id of ["acc-1", "acc-2", "acc-3", "acc-4"]) await createAccount(h().repos, id);
      await billing().saveMembership(
        makeMembershipRecord({ accountId: "acc-1", providerSyncedAt: T0 + 2 }),
        null,
      );
      await billing().saveMembership(
        makeMembershipRecord({ accountId: "acc-2", providerSyncedAt: T0 + 1, status: "past_due" }),
        null,
      );
      await billing().saveMembership(
        makeMembershipRecord({ accountId: "acc-3", providerSyncedAt: T0, status: "canceled" }),
        null,
      );
      await billing().saveMembership(
        makeMembershipRecord({ accountId: "acc-4", providerSyncedAt: T0 + 50 }),
        null,
      );
      const listed = await billing().listMembershipsToReconcile(T0 + 10, 10);
      expect(listed.map((record) => record.accountId)).toEqual(["acc-2", "acc-1"]);
      expect(await billing().listMembershipsToReconcile(T0 + 10, 1)).toHaveLength(1);
    });

    it("lists trials, soonest end first", async () => {
      for (const id of ["acc-1", "acc-2", "acc-3"]) await createAccount(h().repos, id);
      await billing().saveMembership(
        makeMembershipRecord({
          accountId: "acc-1",
          status: "trialing",
          trialEndsAt: T0 + 5 * DAY_MS,
        }),
        null,
      );
      await billing().saveMembership(
        makeMembershipRecord({ accountId: "acc-2", status: "trialing", trialEndsAt: T0 + DAY_MS }),
        null,
      );
      await billing().saveMembership(makeMembershipRecord({ accountId: "acc-3" }), null);
      expect((await billing().listTrialing(10)).map((record) => record.accountId)).toEqual([
        "acc-2",
        "acc-1",
      ]);
    });

    it("records an operation attempt once per idempotency key", async () => {
      const attempt = {
        id: "op-1:1",
        accountId: "acc-1",
        kind: "subscribe" as const,
        attempt: 1,
        idempotencyKey: "webflix-op-1-1",
        status: "pending" as const,
        provider: "fake" as const,
        providerRef: null,
        errorCode: null,
        createdAt: T0,
        updatedAt: T0,
      };
      expect(await billing().startOperation(attempt)).toEqual(attempt);
      expect(await billing().startOperation({ ...attempt, createdAt: T0 + 9 })).toEqual(attempt);
      await billing().finishOperation(
        "op-1:1",
        1,
        { status: "failed", providerRef: null, errorCode: "card_declined" },
        T0 + 1,
      );
      const second = { ...attempt, id: "op-1:2", attempt: 2, idempotencyKey: "webflix-op-1-2" };
      await billing().startOperation(second);
      await billing().finishOperation(
        "op-1:2",
        2,
        { status: "succeeded", providerRef: "sub_1", errorCode: null },
        T0 + 2,
      );
      expect(await billing().findOperationByKey("webflix-op-1-1")).toMatchObject({
        status: "failed",
        errorCode: "card_declined",
        updatedAt: T0 + 1,
      });
      expect(await billing().findOperationByKey("webflix-op-1-2")).toMatchObject({
        status: "succeeded",
        providerRef: "sub_1",
      });
      expect(await billing().findOperationByKey("nope")).toBeNull();
    });

    it("records a provider event once, and finds the first failure of an invoice", async () => {
      const event = makeEvent();
      expect(await billing().recordProviderEvent(event)).toEqual({ inserted: true, record: event });
      const again = await billing().recordProviderEvent({ ...event, receivedAt: T0 + 9 });
      expect(again).toEqual({ inserted: false, record: event });
      await billing().updateProviderEvent("fake", "evt_1", {
        status: "processed",
        attempts: 1,
        lastError: null,
        processedAt: T0 + 3,
        accountId: "acc-1",
      });
      expect(await billing().getProviderEvent("fake", "evt_1")).toMatchObject({
        status: "processed",
        attempts: 1,
        processedAt: T0 + 3,
        accountId: "acc-1",
      });
      expect(await billing().getProviderEvent("stripe", "evt_1")).toBeNull();

      for (const [id, at, invoiceId, type] of [
        ["evt_2", T0 + 500, "in_1", "invoice.payment_failed"],
        ["evt_3", T0 + 100, "in_1", "invoice.payment_failed"],
        ["evt_4", T0 + 50, "in_1", "invoice.paid"],
        ["evt_5", T0 + 10, "in_2", "invoice.payment_failed"],
      ] as const) {
        await billing().recordProviderEvent(
          makeEvent({ eventId: id, eventCreatedAt: at, invoiceId, type, receivedAt: T0 + 1000 }),
        );
      }
      expect(await billing().firstFailureAt("fake", "in_1")).toBe(T0 + 100);
      expect(await billing().firstFailureAt("fake", "in_3")).toBeNull();
      expect(await billing().latestEventReceivedAt("fake")).toBe(T0 + 1000);
      expect(await billing().latestEventReceivedAt("stripe")).toBeNull();
      const pending = await billing().listPendingProviderEvents(T0 + 2000, 10);
      expect(pending.map((record) => record.eventId).sort()).toEqual([
        "evt_2",
        "evt_3",
        "evt_4",
        "evt_5",
      ]);
    });

    it("lets one account claim a card fingerprint for a trial, once", async () => {
      const claim = (accountId: string, fingerprint = "fp_1") =>
        billing().claimTrialFingerprint({ provider: "fake", fingerprint, accountId, now: T0 });
      expect(await billing().hasTrialFingerprint("acc-1")).toBe(false);
      expect(await claim("acc-1")).toBe("claimed");
      expect(await claim("acc-1")).toBe("mine");
      expect(await claim("acc-2")).toBe("taken");
      expect(await billing().hasTrialFingerprint("acc-1")).toBe(true);
      await billing().releaseTrialFingerprint("fake", "fp_1", "acc-2");
      expect(await claim("acc-2")).toBe("taken");
      await billing().releaseTrialFingerprint("fake", "fp_1", "acc-1");
      expect(await claim("acc-2")).toBe("claimed");
    });

    it("upserts invoices by provider id, keeping their Webflix id, and pages newest first", async () => {
      const first = await billing().upsertInvoice(makeInvoice());
      const updated = await billing().upsertInvoice(
        makeInvoice({
          id: "inv-other",
          amountRefundedMinor: 300,
          creditAppliedMinor: 498,
          discountMinor: 650,
          updatedAt: T0 + 1,
        }),
      );
      expect(updated.id).toBe(first.id);
      expect(updated).toMatchObject({
        amountRefundedMinor: 300,
        creditAppliedMinor: 498,
        discountMinor: 650,
      });
      for (let i = 2; i <= 5; i += 1) {
        await billing().upsertInvoice(
          makeInvoice({ id: `inv-${i}`, providerInvoiceId: `in_${i}`, issuedAt: T0 + i * DAY_MS }),
        );
      }
      await billing().upsertInvoice(
        makeInvoice({ id: "inv-x", providerInvoiceId: "in_x", accountId: "acc-2" }),
      );
      const page1 = await billing().listInvoices("acc-1", { limit: 2, before: null });
      expect(page1.map((record) => record.id)).toEqual(["inv-5", "inv-4"]);
      const last = page1[1];
      if (!last) throw new Error("no page");
      const page2 = await billing().listInvoices("acc-1", {
        limit: 10,
        before: { issuedAt: last.issuedAt, id: last.id },
      });
      expect(page2.map((record) => record.id)).toEqual(["inv-3", "inv-2", "inv-1"]);
      expect(await billing().getInvoice("acc-1", "inv-1")).toMatchObject({
        amountRefundedMinor: 300,
      });
      expect(await billing().getInvoice("acc-2", "inv-1")).toBeNull();
    });

    it("stores refunds per invoice", async () => {
      const refund = {
        id: "ref-1",
        accountId: "acc-1",
        invoiceId: "inv-1",
        provider: "fake" as const,
        providerRefundId: null,
        amountMinor: 300,
        currency: "USD",
        status: "pending" as const,
        reason: "goodwill",
        staffSubject: "staff-1",
        createdAt: T0,
        updatedAt: T0,
      };
      await billing().saveRefund(refund);
      await billing().saveRefund({
        ...refund,
        providerRefundId: "re_1",
        status: "succeeded",
        updatedAt: T0 + 1,
      });
      expect(await billing().listRefunds("inv-1")).toEqual([
        { ...refund, providerRefundId: "re_1", status: "succeeded", updatedAt: T0 + 1 },
      ]);
      expect(await billing().listRefunds("inv-2")).toEqual([]);
    });

    it("keeps plan prices per plan and currency, and what each provider has", async () => {
      const usd = {
        planId: "basic" as const,
        currency: "USD",
        amountMinor: 799,
        lookupKey: "webflix.basic.monthly.usd",
        active: true,
        updatedAt: T0,
      };
      await billing().savePlanPrice(usd);
      await billing().savePlanPrice({ ...usd, amountMinor: 899, updatedAt: T0 + 1 });
      await billing().savePlanPrice({
        ...usd,
        currency: "EUR",
        lookupKey: "webflix.basic.monthly.eur",
      });
      expect(await billing().listPlanPrices()).toEqual([
        { ...usd, currency: "EUR", lookupKey: "webflix.basic.monthly.eur" },
        { ...usd, amountMinor: 899, updatedAt: T0 + 1 },
      ]);
      const price = {
        provider: "fake" as const,
        lookupKey: usd.lookupKey,
        providerPriceId: "price_1",
        amountMinor: 799,
        syncedAt: T0,
      };
      await billing().saveProviderPrices([price]);
      await billing().saveProviderPrices([
        { ...price, providerPriceId: "price_2", amountMinor: 899 },
      ]);
      expect(await billing().listProviderPrices("fake")).toEqual([
        { ...price, providerPriceId: "price_2", amountMinor: 899 },
      ]);
      expect(await billing().listProviderPrices("stripe")).toEqual([]);
    });

    it("finds the open checkout of an account and checkouts by subscription", async () => {
      await createAccount(h().repos, "acc-1");
      await billing().saveCheckout(makeCheckoutRecord({ id: "chk-old", status: "failed" }));
      await billing().saveCheckout(makeCheckoutRecord({ id: "chk-1", createdAt: T0 + 1 }));
      await billing().saveCheckout(
        makeCheckoutRecord({ id: "chk-expired", createdAt: T0 + 2, expiresAt: T0 + 3 }),
      );
      expect((await billing().findOpenCheckout("acc-1", T0 + 10))?.id).toBe("chk-1");
      const processing = makeCheckoutRecord({
        id: "chk-1",
        createdAt: T0 + 1,
        status: "processing",
        providerSubscriptionId: "sub_9",
        providerPaymentMethodId: "pm_1",
        trialDays: 7,
        trialFingerprint: "fp_1",
        amountDueMinor: 301,
        creditAppliedMinor: 498,
        discountMinor: 0,
        promotionCode: "WELCOME",
        promotionId: "promo_1",
        promotion: {
          code: "WELCOME",
          percentOff: 50,
          amountOffMinor: null,
          currency: null,
          duration: "once",
          durationInMonths: null,
        },
        attempt: 2,
        updatedAt: T0 + 5,
      });
      await billing().saveCheckout(processing);
      expect(await billing().getCheckout("acc-1", "chk-1")).toEqual(processing);
      expect(await billing().getCheckout("acc-2", "chk-1")).toBeNull();
      expect(await billing().listCheckoutsForSubscription("fake", "sub_9")).toEqual([processing]);
      await billing().saveCheckout({ ...processing, status: "complete" });
      expect(await billing().findOpenCheckout("acc-1", T0 + 10)).toBeNull();
    });

    it("stores card replacements and finds them by the provider's setup id", async () => {
      await createAccount(h().repos, "acc-1");
      const setup = {
        id: "pms-1",
        accountId: "acc-1",
        provider: "fake" as const,
        providerSetupId: "seti_1",
        providerPaymentMethodId: null,
        status: "requires_confirmation" as const,
        clientSecret: "seti_1_secret_x" as string | null,
        failureReason: null,
        attempt: 1,
        createdAt: T0,
        updatedAt: T0,
      };
      await billing().saveSetup(setup);
      await billing().saveSetup({
        ...setup,
        status: "succeeded",
        providerPaymentMethodId: "pm_1",
        clientSecret: null,
        updatedAt: T0 + 1,
      });
      expect(await billing().getSetup("acc-1", "pms-1")).toEqual({
        ...setup,
        status: "succeeded",
        providerPaymentMethodId: "pm_1",
        clientSecret: null,
        updatedAt: T0 + 1,
      });
      expect(await billing().getSetup("acc-2", "pms-1")).toBeNull();
      expect((await billing().findSetupByProviderId("fake", "seti_1"))?.id).toBe("pms-1");
      expect(await billing().findSetupByProviderId("stripe", "seti_1")).toBeNull();
    });

    it("tells whether an account had a trial, alone or with its open checkout, in one round trip", async () => {
      for (const id of ["acc-1", "acc-2", "acc-3"]) await createAccount(h().repos, id);
      expect(await billing().trialUsed("acc-1")).toBe(false);
      expect(await billing().findOpenCheckoutAndTrial("acc-1", T0)).toEqual({
        checkout: null,
        trialUsed: false,
      });
      await billing().claimTrialFingerprint({
        provider: "fake",
        fingerprint: "account:acc-1",
        accountId: "acc-1",
        now: T0,
      });
      expect(await billing().trialUsed("acc-1")).toBe(true);
      // A membership that redeemed a trial without a claim of its own (staff, milestone 1).
      await billing().saveMembership(
        makeMembershipRecord({ accountId: "acc-2", trialRedeemedAt: T0 }),
        null,
      );
      expect(await billing().trialUsed("acc-2")).toBe(true);
      await billing().saveMembership(makeMembershipRecord({ accountId: "acc-3" }), null);
      const checkout = makeCheckoutRecord({ id: "chk-3", accountId: "acc-3" });
      await billing().saveCheckout(checkout);
      expect(await billing().findOpenCheckoutAndTrial("acc-3", T0 + 1)).toEqual({
        checkout,
        trialUsed: false,
      });
    });

    it("forgets an erased account but its invoices, refunds and an unlinked trial fingerprint (M5)", async () => {
      for (const id of ["acc-1", "acc-2"]) await createAccount(h().repos, id);
      const customer = (accountId: string, customerId: string) =>
        billing().saveCustomer({ accountId, provider: "fake", customerId, createdAt: T0 });
      await customer("acc-1", "cus_gone");
      await customer("acc-2", "cus_kept");
      await billing().saveMembership(makeMembershipRecord({ accountId: "acc-1" }), null);
      await billing().saveMembership(makeMembershipRecord({ accountId: "acc-2" }), null);
      const claim = (accountId: string, fingerprint: string) =>
        billing().claimTrialFingerprint({ provider: "fake", fingerprint, accountId, now: T0 });
      await claim("acc-1", "account:acc-1");
      await claim("acc-1", "fp_card");
      await claim("acc-2", "account:acc-2");
      const operation = (accountId: string, id: string) =>
        billing().startOperation({
          id: `${id}:1`,
          accountId,
          kind: "subscribe",
          attempt: 1,
          idempotencyKey: `webflix-${id}-1`,
          status: "pending",
          provider: "fake",
          providerRef: null,
          errorCode: null,
          createdAt: T0,
          updatedAt: T0,
        });
      await operation("acc-1", "customer-acc-1");
      await operation("acc-2", "customer-acc-2");
      await billing().recordProviderEvent(makeEvent({ eventId: "evt_a", accountId: "acc-1" }));
      await billing().recordProviderEvent(
        makeEvent({ eventId: "evt_b", accountId: null, customerId: "cus_gone" }),
      );
      await billing().recordProviderEvent(
        makeEvent({ eventId: "evt_c", accountId: "acc-2", customerId: "cus_kept" }),
      );
      await billing().upsertInvoice(
        makeInvoice({ hostedUrl: "https://pay.example/i/1", pdfUrl: "https://pay.example/p/1" }),
      );
      await billing().saveRefund({
        id: "ref-1",
        accountId: "acc-1",
        invoiceId: "inv-1",
        provider: "fake",
        providerRefundId: "re_1",
        amountMinor: 100,
        currency: "USD",
        status: "succeeded",
        reason: "goodwill",
        staffSubject: "staff-1",
        createdAt: T0,
        updatedAt: T0,
      });
      await billing().saveCheckout(makeCheckoutRecord({ id: "chk-gone", accountId: "acc-1" }));
      await billing().saveCheckout(makeCheckoutRecord({ id: "chk-kept", accountId: "acc-2" }));
      await billing().saveSetup({
        id: "pms-gone",
        accountId: "acc-1",
        provider: "fake",
        providerSetupId: "seti_gone",
        providerPaymentMethodId: null,
        status: "requires_confirmation",
        clientSecret: null,
        failureReason: null,
        attempt: 1,
        createdAt: T0,
        updatedAt: T0,
      });
      expect((await billing().listCheckouts("acc-1", 10)).map((record) => record.id)).toEqual([
        "chk-gone",
      ]);
      expect((await billing().listSetups("acc-1", 10)).map((record) => record.id)).toEqual([
        "pms-gone",
      ]);

      await billing().forgetAccount({ accountId: "acc-1", customerIds: ["cus_gone"] });
      await billing().forgetAccount({ accountId: "acc-1", customerIds: ["cus_gone"] });

      expect(await billing().getCustomer("acc-1", "fake")).toBeNull();
      expect(await billing().findCustomer("fake", "cus_gone")).toBeNull();
      expect(await billing().getMembership("acc-1")).toBeNull();
      expect(await billing().hasTrialFingerprint("acc-1")).toBe(false);
      // The card still had its trial: another account claiming it is told so; the marker went.
      expect(await claim("acc-2", "fp_card")).toBe("taken");
      expect(await claim("acc-2", "account:acc-1")).toBe("claimed");
      await billing().releaseTrialFingerprint("fake", "account:acc-1", "acc-2");
      expect(await billing().findOperationByKey("webflix-customer-acc-1-1")).toBeNull();
      expect(await billing().getProviderEvent("fake", "evt_a")).toBeNull();
      expect(await billing().getProviderEvent("fake", "evt_b")).toBeNull();
      expect(await billing().listCheckouts("acc-1", 10)).toEqual([]);
      expect(await billing().listSetups("acc-1", 10)).toEqual([]);
      // The financial record stays, without the provider's hosted pages.
      expect(await billing().getInvoice("acc-1", "inv-1")).toMatchObject({
        totalMinor: 1299,
        hostedUrl: null,
        pdfUrl: null,
      });
      expect(await billing().listRefunds("inv-1")).toHaveLength(1);
      // Nothing of another account changes.
      expect(await billing().getCustomer("acc-2", "fake")).not.toBeNull();
      expect(await billing().getMembership("acc-2")).not.toBeNull();
      expect(await billing().hasTrialFingerprint("acc-2")).toBe(true);
      expect(await billing().findOperationByKey("webflix-customer-acc-2-1")).not.toBeNull();
      expect(await billing().getProviderEvent("fake", "evt_c")).not.toBeNull();
      expect(await billing().getCheckout("acc-2", "chk-kept")).not.toBeNull();
    });
  });
}
