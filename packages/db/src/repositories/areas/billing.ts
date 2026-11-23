import {
  type BillingCustomerRecord,
  type BillingOperationRecord,
  type BillingRepository,
  type CheckoutRecord,
  ERASED_TRIAL_OWNER,
  type InvoiceRecord,
  type MembershipRecord,
  type PaymentMethodSetupRecord,
  type PlanPriceRecord,
  type ProviderEventRecord,
  type ProviderPriceRecord,
  type RefundRecord,
  type StoredCard,
} from "@webflix/core";
import type { Database } from "../../database.ts";
import type {
  CheckoutsTable,
  InvoicesTable,
  MembershipsTable,
  PaymentMethodSetupsTable,
  ProviderEventsTable,
  RefundsTable,
} from "../../tables/billing.ts";

const OPEN_CHECKOUT = ["requires_setup", "requires_payment", "processing"];
const RECONCILABLE = ["incomplete", "trialing", "active", "past_due", "suspended"];

const num = (value: number | string | bigint): number => Number(value);
const numOrNull = (value: number | string | bigint | null): number | null =>
  value === null ? null : Number(value);

function toMembership(row: MembershipsTable): MembershipRecord {
  return {
    accountId: row.account_id,
    provider: row.provider as MembershipRecord["provider"],
    providerCustomerId: row.provider_customer_id,
    providerSubscriptionId: row.provider_subscription_id,
    planId: row.plan_id as MembershipRecord["planId"],
    priceLookupKey: row.price_lookup_key,
    status: row.status as MembershipRecord["status"],
    suspendedReason: row.suspended_reason as MembershipRecord["suspendedReason"],
    cancelAtPeriodEnd: num(row.cancel_at_period_end) === 1,
    trialEndsAt: numOrNull(row.trial_ends_at),
    currentPeriodStart: numOrNull(row.current_period_start),
    currentPeriodEnd: numOrNull(row.current_period_end),
    graceStartedAt: numOrNull(row.grace_started_at),
    graceInvoiceId: row.grace_invoice_id,
    endedAt: numOrNull(row.ended_at),
    latestInvoiceId: row.latest_invoice_id,
    paymentMethod:
      row.payment_method_json === null ? null : (JSON.parse(row.payment_method_json) as StoredCard),
    trialRedeemedAt: numOrNull(row.trial_redeemed_at),
    clockOffsetMs: num(row.clock_offset_ms ?? 0),
    nextInvoice:
      row.next_invoice_json === null || row.next_invoice_json === undefined
        ? null
        : (JSON.parse(row.next_invoice_json) as MembershipRecord["nextInvoice"]),
    version: num(row.version),
    providerSyncedAt: num(row.provider_synced_at),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

function fromMembership(record: MembershipRecord): MembershipsTable {
  return {
    account_id: record.accountId,
    provider: record.provider,
    provider_customer_id: record.providerCustomerId,
    provider_subscription_id: record.providerSubscriptionId,
    plan_id: record.planId,
    price_lookup_key: record.priceLookupKey,
    status: record.status,
    suspended_reason: record.suspendedReason,
    cancel_at_period_end: record.cancelAtPeriodEnd ? 1 : 0,
    trial_ends_at: record.trialEndsAt,
    current_period_start: record.currentPeriodStart,
    current_period_end: record.currentPeriodEnd,
    grace_started_at: record.graceStartedAt,
    grace_invoice_id: record.graceInvoiceId,
    ended_at: record.endedAt,
    latest_invoice_id: record.latestInvoiceId,
    payment_method_json:
      record.paymentMethod === null ? null : JSON.stringify(record.paymentMethod),
    trial_redeemed_at: record.trialRedeemedAt,
    clock_offset_ms: record.clockOffsetMs,
    next_invoice_json: record.nextInvoice === null ? null : JSON.stringify(record.nextInvoice),
    version: record.version,
    provider_synced_at: record.providerSyncedAt,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function toEvent(row: ProviderEventsTable): ProviderEventRecord {
  return {
    provider: row.provider as ProviderEventRecord["provider"],
    eventId: row.event_id,
    type: row.type,
    accountId: row.account_id,
    idempotencyKey: row.idempotency_key,
    customerId: row.provider_customer_id,
    subscriptionId: row.provider_subscription_id,
    invoiceId: row.provider_invoice_id,
    setupId: row.provider_setup_id,
    eventCreatedAt: num(row.event_created_at ?? row.received_at),
    source: row.source === "reconcile" ? "reconcile" : "webhook",
    receivedAt: num(row.received_at),
    processedAt: numOrNull(row.processed_at),
    status: row.status as ProviderEventRecord["status"],
    attempts: num(row.attempts),
    lastError: row.last_error,
  };
}

function toInvoice(row: InvoicesTable): InvoiceRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    provider: row.provider as InvoiceRecord["provider"],
    providerInvoiceId: row.provider_invoice_id,
    providerSubscriptionId: row.provider_subscription_id,
    number: row.number,
    status: row.status as InvoiceRecord["status"],
    currency: row.currency,
    totalMinor: num(row.total_minor),
    amountPaidMinor: num(row.amount_paid_minor),
    amountDueMinor: num(row.amount_due_minor),
    amountRefundedMinor: num(row.amount_refunded_minor),
    billingReason: row.billing_reason,
    periodStart: numOrNull(row.period_start),
    periodEnd: numOrNull(row.period_end),
    hostedUrl: row.hosted_url,
    pdfUrl: row.pdf_url,
    creditAppliedMinor: numOrNull(row.credit_applied_minor ?? null),
    discountMinor: numOrNull(row.discount_minor ?? null),
    issuedAt: num(row.issued_at),
    paidAt: numOrNull(row.paid_at),
    updatedAt: num(row.updated_at),
  };
}

function fromInvoice(record: InvoiceRecord): InvoicesTable {
  return {
    id: record.id,
    account_id: record.accountId,
    provider: record.provider,
    provider_invoice_id: record.providerInvoiceId,
    provider_subscription_id: record.providerSubscriptionId,
    number: record.number,
    status: record.status,
    currency: record.currency,
    total_minor: record.totalMinor,
    amount_paid_minor: record.amountPaidMinor,
    amount_due_minor: record.amountDueMinor,
    amount_refunded_minor: record.amountRefundedMinor,
    billing_reason: record.billingReason,
    period_start: record.periodStart,
    period_end: record.periodEnd,
    hosted_url: record.hostedUrl,
    pdf_url: record.pdfUrl,
    credit_applied_minor: record.creditAppliedMinor,
    discount_minor: record.discountMinor,
    issued_at: record.issuedAt,
    paid_at: record.paidAt,
    updated_at: record.updatedAt,
  };
}

function toRefund(row: RefundsTable): RefundRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    invoiceId: row.invoice_id,
    provider: row.provider as RefundRecord["provider"],
    providerRefundId: row.provider_refund_id,
    amountMinor: num(row.amount_minor),
    currency: row.currency,
    status: row.status as RefundRecord["status"],
    reason: row.reason,
    staffSubject: row.staff_subject,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

function toCheckout(row: CheckoutsTable): CheckoutRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    planId: row.plan_id as CheckoutRecord["planId"],
    currency: row.currency,
    status: row.status as CheckoutRecord["status"],
    promotionCode: row.promotion_code,
    promotionId: row.promotion_id,
    promotion:
      row.promotion_json === null
        ? null
        : (JSON.parse(row.promotion_json) as CheckoutRecord["promotion"]),
    provider: row.provider as CheckoutRecord["provider"],
    providerCustomerId: row.provider_customer_id,
    providerSetupId: row.provider_setup_id,
    providerSubscriptionId: row.provider_subscription_id,
    providerPaymentMethodId: row.provider_payment_method_id,
    trialDays: numOrNull(row.trial_days),
    trialFingerprint: row.trial_fingerprint,
    amountDueMinor: numOrNull(row.amount_due_minor),
    creditAppliedMinor: numOrNull(row.credit_applied_minor ?? null),
    discountMinor: numOrNull(row.discount_minor ?? null),
    failureReason: row.failure_reason as CheckoutRecord["failureReason"],
    clientSecret: row.client_secret ?? null,
    operationId: row.operation_id ?? row.id,
    attempt: num(row.attempt ?? 1),
    createdAt: num(row.created_at),
    expiresAt: num(row.expires_at),
    updatedAt: num(row.updated_at),
  };
}

function fromCheckout(record: CheckoutRecord): CheckoutsTable {
  return {
    id: record.id,
    account_id: record.accountId,
    plan_id: record.planId,
    currency: record.currency,
    status: record.status,
    promotion_code: record.promotionCode,
    promotion_id: record.promotionId,
    promotion_json: record.promotion === null ? null : JSON.stringify(record.promotion),
    provider: record.provider,
    provider_customer_id: record.providerCustomerId,
    provider_setup_id: record.providerSetupId,
    provider_subscription_id: record.providerSubscriptionId,
    provider_payment_method_id: record.providerPaymentMethodId,
    trial_days: record.trialDays,
    trial_fingerprint: record.trialFingerprint,
    amount_due_minor: record.amountDueMinor,
    credit_applied_minor: record.creditAppliedMinor,
    discount_minor: record.discountMinor,
    failure_reason: record.failureReason,
    client_secret: record.clientSecret,
    operation_id: record.operationId,
    attempt: record.attempt,
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    updated_at: record.updatedAt,
  };
}

function toSetup(row: PaymentMethodSetupsTable): PaymentMethodSetupRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    provider: row.provider as PaymentMethodSetupRecord["provider"],
    providerSetupId: row.provider_setup_id,
    providerPaymentMethodId: row.provider_payment_method_id,
    status: row.status as PaymentMethodSetupRecord["status"],
    clientSecret: row.client_secret ?? null,
    failureReason: (row.failure_reason ?? null) as PaymentMethodSetupRecord["failureReason"],
    attempt: num(row.attempt ?? 1),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

/**
 * The billing area's repository on every dialect (SQLite, PostgreSQL, D1), over its tables
 * (`tables/billing.ts`). Atomic writes are single statements (D1 has no interactive
 * transactions): the projection's version guard is an `UPDATE … WHERE version = ?`, and
 * first-writer-wins inserts are `ON CONFLICT DO NOTHING` followed by a read.
 */
export function createBillingRepository(database: Database): BillingRepository {
  const openCheckoutQuery = (accountId: string, now: number) =>
    database.db
      .selectFrom("checkouts")
      .selectAll()
      .where("account_id", "=", accountId)
      .where("status", "in", OPEN_CHECKOUT)
      .where("expires_at", ">", now)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1);
  // A trial claim of the account's own, or a membership that redeemed one: one statement.
  const trialUsedQuery = (accountId: string) =>
    database.db.selectNoFrom((eb) => [
      eb
        .exists(
          eb
            .selectFrom("trial_fingerprints")
            .select("fingerprint")
            .where("account_id", "=", accountId),
        )
        .as("claimed"),
      eb
        .exists(
          eb
            .selectFrom("memberships")
            .select("account_id")
            .where("account_id", "=", accountId)
            .where("trial_redeemed_at", "is not", null),
        )
        .as("redeemed"),
    ]);
  const truthy = (value: unknown) => value === true || Number(value) === 1;
  const trialUsedOf = (row: { claimed: unknown; redeemed: unknown } | undefined) =>
    row !== undefined && (truthy(row.claimed) || truthy(row.redeemed));

  const { db } = database;

  const repository: BillingRepository = {
    async getCustomer(accountId, provider) {
      const row = await db
        .selectFrom("billing_customers")
        .selectAll()
        .where("account_id", "=", accountId)
        .where("provider", "=", provider)
        .executeTakeFirst();
      return row ? customer(row) : null;
    },
    async findCustomer(provider, customerId) {
      const row = await db
        .selectFrom("billing_customers")
        .selectAll()
        .where("provider", "=", provider)
        .where("customer_id", "=", customerId)
        .executeTakeFirst();
      return row ? customer(row) : null;
    },
    async saveCustomer(record) {
      await db
        .insertInto("billing_customers")
        .values({
          account_id: record.accountId,
          provider: record.provider,
          customer_id: record.customerId,
          created_at: record.createdAt,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      return (await repository.getCustomer(record.accountId, record.provider)) ?? record;
    },

    async getMembership(accountId) {
      const row = await db
        .selectFrom("memberships")
        .selectAll()
        .where("account_id", "=", accountId)
        .executeTakeFirst();
      return row ? toMembership(row) : null;
    },
    async saveMembership(record, expectedVersion) {
      const values = fromMembership(record);
      if (expectedVersion === null) {
        const result = await db
          .insertInto("memberships")
          .values(values)
          .onConflict((oc) => oc.column("account_id").doNothing())
          .executeTakeFirst();
        return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
      }
      const { account_id: _id, created_at: _created, ...changes } = values;
      const result = await db
        .updateTable("memberships")
        .set(changes)
        .where("account_id", "=", record.accountId)
        .where("version", "=", expectedVersion)
        .executeTakeFirst();
      return Number(result.numUpdatedRows) > 0;
    },
    async listMembershipsToReconcile(syncedBefore, limit) {
      const rows = await db
        .selectFrom("memberships")
        .selectAll()
        .where("status", "in", RECONCILABLE)
        .where("provider_synced_at", "<", syncedBefore)
        .orderBy("provider_synced_at", "asc")
        .limit(limit)
        .execute();
      return rows.map(toMembership);
    },

    async listTrialing(limit) {
      const rows = await db
        .selectFrom("memberships")
        .selectAll()
        .where("status", "=", "trialing")
        .orderBy("trial_ends_at", "asc")
        .limit(limit)
        .execute();
      return rows.map(toMembership);
    },

    async startOperation(record) {
      await db
        .insertInto("billing_operations")
        .values({
          id: record.id,
          account_id: record.accountId,
          kind: record.kind,
          attempt: record.attempt,
          idempotency_key: record.idempotencyKey,
          status: record.status,
          provider: record.provider,
          provider_ref: record.providerRef,
          error_code: record.errorCode,
          created_at: record.createdAt,
          updated_at: record.updatedAt,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      return (await repository.findOperationByKey(record.idempotencyKey)) ?? record;
    },
    async finishOperation(id, attempt, outcome, now) {
      await db
        .updateTable("billing_operations")
        .set({
          status: outcome.status,
          provider_ref: outcome.providerRef,
          error_code: outcome.errorCode,
          updated_at: now,
        })
        .where("id", "=", id)
        .where("attempt", "=", attempt)
        .execute();
    },
    async findOperationByKey(idempotencyKey) {
      const row = await db
        .selectFrom("billing_operations")
        .selectAll()
        .where("idempotency_key", "=", idempotencyKey)
        .executeTakeFirst();
      if (!row) return null;
      return {
        id: row.id,
        accountId: row.account_id,
        kind: row.kind as BillingOperationRecord["kind"],
        attempt: num(row.attempt ?? 1),
        idempotencyKey: row.idempotency_key,
        status: row.status as BillingOperationRecord["status"],
        provider: row.provider as BillingOperationRecord["provider"],
        providerRef: row.provider_ref,
        errorCode: row.error_code,
        createdAt: num(row.created_at),
        updatedAt: num(row.updated_at),
      };
    },

    async recordProviderEvent(record) {
      const result = await db
        .insertInto("provider_events")
        .values({
          provider: record.provider,
          event_id: record.eventId,
          type: record.type,
          account_id: record.accountId,
          idempotency_key: record.idempotencyKey,
          provider_customer_id: record.customerId,
          provider_subscription_id: record.subscriptionId,
          provider_invoice_id: record.invoiceId,
          provider_setup_id: record.setupId,
          event_created_at: record.eventCreatedAt,
          source: record.source,
          received_at: record.receivedAt,
          processed_at: record.processedAt,
          status: record.status,
          attempts: record.attempts,
          last_error: record.lastError,
        })
        .onConflict((oc) => oc.columns(["provider", "event_id"]).doNothing())
        .executeTakeFirst();
      if (Number(result.numInsertedOrUpdatedRows ?? 0) > 0) return { inserted: true, record };
      const stored = await repository.getProviderEvent(record.provider, record.eventId);
      return { inserted: false, record: stored ?? record };
    },
    async getProviderEvent(provider, eventId) {
      const row = await db
        .selectFrom("provider_events")
        .selectAll()
        .where("provider", "=", provider)
        .where("event_id", "=", eventId)
        .executeTakeFirst();
      return row ? toEvent(row) : null;
    },
    async updateProviderEvent(provider, eventId, patch) {
      await db
        .updateTable("provider_events")
        .set({
          status: patch.status,
          attempts: patch.attempts,
          last_error: patch.lastError,
          processed_at: patch.processedAt,
          ...(patch.accountId !== undefined ? { account_id: patch.accountId } : {}),
        })
        .where("provider", "=", provider)
        .where("event_id", "=", eventId)
        .execute();
    },
    async latestEventReceivedAt(provider) {
      const row = await db
        .selectFrom("provider_events")
        .select((eb) => eb.fn.max("received_at").as("latest"))
        .where("provider", "=", provider)
        .executeTakeFirst();
      return row?.latest === null || row?.latest === undefined ? null : num(row.latest);
    },
    async firstFailureAt(provider, invoiceId) {
      const row = await db
        .selectFrom("provider_events")
        .select((eb) => eb.fn.min("event_created_at").as("first"))
        .where("provider", "=", provider)
        .where("provider_invoice_id", "=", invoiceId)
        .where("type", "=", "invoice.payment_failed")
        .executeTakeFirst();
      return row?.first === null || row?.first === undefined ? null : num(row.first);
    },
    async listPendingProviderEvents(receivedBefore, limit) {
      const rows = await db
        .selectFrom("provider_events")
        .selectAll()
        .where("status", "=", "pending")
        .where("received_at", "<", receivedBefore)
        .orderBy("received_at", "asc")
        .limit(limit)
        .execute();
      return rows.map(toEvent);
    },

    async claimTrialFingerprint({ provider, fingerprint, accountId, now }) {
      const result = await db
        .insertInto("trial_fingerprints")
        .values({ provider, fingerprint, account_id: accountId, created_at: now })
        .onConflict((oc) => oc.columns(["provider", "fingerprint"]).doNothing())
        .executeTakeFirst();
      if (Number(result.numInsertedOrUpdatedRows ?? 0) > 0) return "claimed";
      const row = await db
        .selectFrom("trial_fingerprints")
        .select("account_id")
        .where("provider", "=", provider)
        .where("fingerprint", "=", fingerprint)
        .executeTakeFirst();
      return row?.account_id === accountId ? "mine" : "taken";
    },
    async releaseTrialFingerprint(provider, fingerprint, accountId) {
      await db
        .deleteFrom("trial_fingerprints")
        .where("provider", "=", provider)
        .where("fingerprint", "=", fingerprint)
        .where("account_id", "=", accountId)
        .execute();
    },
    async hasTrialFingerprint(accountId) {
      const row = await db
        .selectFrom("trial_fingerprints")
        .select("fingerprint")
        .where("account_id", "=", accountId)
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },

    async trialUsed(accountId) {
      return trialUsedOf(await trialUsedQuery(accountId).executeTakeFirst());
    },

    async forgetAccount({ accountId, customerIds }) {
      // Each statement is idempotent and the customer links go last: a run cut short anywhere
      // is finished by the erasure job's next run.
      await db
        .deleteFrom("trial_fingerprints")
        .where("account_id", "=", accountId)
        .where("fingerprint", "=", `account:${accountId}`)
        .execute();
      await db
        .updateTable("trial_fingerprints")
        .set({ account_id: ERASED_TRIAL_OWNER, created_at: 0 })
        .where("account_id", "=", accountId)
        .execute();
      await db.deleteFrom("billing_operations").where("account_id", "=", accountId).execute();
      await db.deleteFrom("provider_events").where("account_id", "=", accountId).execute();
      for (const customerId of customerIds) {
        await db
          .deleteFrom("provider_events")
          .where("provider_customer_id", "=", customerId)
          .execute();
      }
      await db
        .updateTable("invoices")
        .set({ hosted_url: null, pdf_url: null })
        .where("account_id", "=", accountId)
        .execute();
      await db.deleteFrom("checkouts").where("account_id", "=", accountId).execute();
      await db.deleteFrom("payment_method_setups").where("account_id", "=", accountId).execute();
      await db.deleteFrom("memberships").where("account_id", "=", accountId).execute();
      await db.deleteFrom("billing_customers").where("account_id", "=", accountId).execute();
    },
    async listCheckouts(accountId, limit) {
      const rows = await db
        .selectFrom("checkouts")
        .selectAll()
        .where("account_id", "=", accountId)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .execute();
      return rows.map(toCheckout);
    },
    async listSetups(accountId, limit) {
      const rows = await db
        .selectFrom("payment_method_setups")
        .selectAll()
        .where("account_id", "=", accountId)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .execute();
      return rows.map(toSetup);
    },

    async upsertInvoice(record) {
      // An invoice keeps its Webflix id and never moves between accounts.
      const { id: _id, account_id: _account, ...changes } = fromInvoice(record);
      await db
        .insertInto("invoices")
        .values(fromInvoice(record))
        .onConflict((oc) => oc.columns(["provider", "provider_invoice_id"]).doUpdateSet(changes))
        .execute();
      const row = await db
        .selectFrom("invoices")
        .selectAll()
        .where("provider", "=", record.provider)
        .where("provider_invoice_id", "=", record.providerInvoiceId)
        .executeTakeFirstOrThrow();
      return toInvoice(row);
    },
    async getInvoice(accountId, id) {
      const row = await db
        .selectFrom("invoices")
        .selectAll()
        .where("account_id", "=", accountId)
        .where("id", "=", id)
        .executeTakeFirst();
      return row ? toInvoice(row) : null;
    },
    async listInvoices(accountId, { limit, before }) {
      let query = db
        .selectFrom("invoices")
        .selectAll()
        .where("account_id", "=", accountId)
        .orderBy("issued_at", "desc")
        .orderBy("id", "desc")
        .limit(limit);
      if (before) {
        query = query.where((eb) =>
          eb.or([
            eb("issued_at", "<", before.issuedAt),
            eb.and([eb("issued_at", "=", before.issuedAt), eb("id", "<", before.id)]),
          ]),
        );
      }
      return (await query.execute()).map(toInvoice);
    },
    async saveRefund(record) {
      const values = {
        id: record.id,
        account_id: record.accountId,
        invoice_id: record.invoiceId,
        provider: record.provider,
        provider_refund_id: record.providerRefundId,
        amount_minor: record.amountMinor,
        currency: record.currency,
        status: record.status,
        reason: record.reason,
        staff_subject: record.staffSubject,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      };
      await db
        .insertInto("refunds")
        .values(values)
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            provider_refund_id: values.provider_refund_id,
            status: values.status,
            updated_at: values.updated_at,
          }),
        )
        .execute();
    },
    async listRefunds(invoiceId) {
      const rows = await db
        .selectFrom("refunds")
        .selectAll()
        .where("invoice_id", "=", invoiceId)
        .orderBy("created_at", "asc")
        .execute();
      return rows.map(toRefund);
    },

    async listPlanPrices() {
      const rows = await db.selectFrom("plan_prices").selectAll().orderBy("lookup_key").execute();
      return rows.map(
        (row): PlanPriceRecord => ({
          planId: row.plan_id as PlanPriceRecord["planId"],
          currency: row.currency,
          amountMinor: num(row.amount_minor),
          lookupKey: row.lookup_key,
          active: num(row.active) === 1,
          updatedAt: num(row.updated_at),
        }),
      );
    },
    async savePlanPrice(record) {
      const values = {
        plan_id: record.planId,
        currency: record.currency,
        amount_minor: record.amountMinor,
        lookup_key: record.lookupKey,
        active: record.active ? 1 : 0,
        updated_at: record.updatedAt,
      };
      await db
        .insertInto("plan_prices")
        .values(values)
        .onConflict((oc) =>
          oc.columns(["plan_id", "currency"]).doUpdateSet({
            amount_minor: values.amount_minor,
            lookup_key: values.lookup_key,
            active: values.active,
            updated_at: values.updated_at,
          }),
        )
        .execute();
    },
    async listProviderPrices(provider) {
      const rows = await db
        .selectFrom("provider_prices")
        .selectAll()
        .where("provider", "=", provider)
        .execute();
      return rows.map(
        (row): ProviderPriceRecord => ({
          provider: row.provider as ProviderPriceRecord["provider"],
          lookupKey: row.lookup_key,
          providerPriceId: row.provider_price_id,
          amountMinor: num(row.amount_minor),
          syncedAt: num(row.synced_at),
        }),
      );
    },
    async saveProviderPrices(records) {
      if (records.length === 0) return;
      await database.batch(
        records.map((record) =>
          db
            .insertInto("provider_prices")
            .values({
              provider: record.provider,
              lookup_key: record.lookupKey,
              provider_price_id: record.providerPriceId,
              amount_minor: record.amountMinor,
              synced_at: record.syncedAt,
            })
            .onConflict((oc) =>
              oc.columns(["provider", "lookup_key"]).doUpdateSet({
                provider_price_id: record.providerPriceId,
                amount_minor: record.amountMinor,
                synced_at: record.syncedAt,
              }),
            ),
        ),
      );
    },

    async saveCheckout(record) {
      const values = fromCheckout(record);
      const { id: _id, account_id: _account, created_at: _created, ...changes } = values;
      await db
        .insertInto("checkouts")
        .values(values)
        .onConflict((oc) => oc.column("id").doUpdateSet(changes))
        .execute();
    },
    async getCheckout(accountId, id) {
      const row = await db
        .selectFrom("checkouts")
        .selectAll()
        .where("account_id", "=", accountId)
        .where("id", "=", id)
        .executeTakeFirst();
      return row ? toCheckout(row) : null;
    },
    async findOpenCheckout(accountId, now) {
      const row = await openCheckoutQuery(accountId, now).executeTakeFirst();
      return row ? toCheckout(row) : null;
    },
    async findOpenCheckoutAndTrial(accountId, now) {
      const [open, trial] = await database.batch([
        openCheckoutQuery(accountId, now),
        trialUsedQuery(accountId),
      ]);
      const row = open.rows[0];
      return { checkout: row ? toCheckout(row) : null, trialUsed: trialUsedOf(trial.rows[0]) };
    },
    async listCheckoutsForSubscription(provider, subscriptionId) {
      const rows = await db
        .selectFrom("checkouts")
        .selectAll()
        .where("provider", "=", provider)
        .where("provider_subscription_id", "=", subscriptionId)
        .execute();
      return rows.map(toCheckout);
    },
    async saveSetup(record) {
      const values = {
        id: record.id,
        account_id: record.accountId,
        provider: record.provider,
        provider_setup_id: record.providerSetupId,
        provider_payment_method_id: record.providerPaymentMethodId,
        status: record.status,
        client_secret: record.clientSecret,
        failure_reason: record.failureReason,
        attempt: record.attempt,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      };
      await db
        .insertInto("payment_method_setups")
        .values(values)
        .onConflict((oc) =>
          oc.column("id").doUpdateSet({
            provider_setup_id: values.provider_setup_id,
            provider_payment_method_id: values.provider_payment_method_id,
            status: values.status,
            client_secret: values.client_secret,
            failure_reason: values.failure_reason,
            attempt: values.attempt,
            updated_at: values.updated_at,
          }),
        )
        .execute();
    },
    async getSetup(accountId, id) {
      const row = await db
        .selectFrom("payment_method_setups")
        .selectAll()
        .where("account_id", "=", accountId)
        .where("id", "=", id)
        .executeTakeFirst();
      return row ? toSetup(row) : null;
    },
    async findSetupByProviderId(provider, providerSetupId) {
      const row = await db
        .selectFrom("payment_method_setups")
        .selectAll()
        .where("provider", "=", provider)
        .where("provider_setup_id", "=", providerSetupId)
        .executeTakeFirst();
      return row ? toSetup(row) : null;
    },
  };
  return repository;
}

function customer(row: {
  account_id: string;
  provider: string;
  customer_id: string;
  created_at: number;
}): BillingCustomerRecord {
  return {
    accountId: row.account_id,
    provider: row.provider as BillingCustomerRecord["provider"],
    customerId: row.customer_id,
    createdAt: num(row.created_at),
  };
}
