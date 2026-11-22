import type { PaymentProviderId } from "@webflix/contracts";
import type {
  BillingCustomerRecord,
  BillingOperationRecord,
  BillingRepository,
  CheckoutRecord,
  InvoiceRecord,
  MembershipRecord,
  PaymentMethodSetupRecord,
  PlanPriceRecord,
  ProviderEventRecord,
  ProviderPriceRecord,
  RefundRecord,
} from "../../areas/billing/repository.ts";

const OPEN_CHECKOUT = new Set(["requires_setup", "requires_payment", "processing"]);
const RECONCILABLE = new Set(["incomplete", "trialing", "active", "past_due", "suspended"]);

const clone = <T>(value: T): T => structuredClone(value);

/** In-memory `BillingRepository` (service tests, the HTTP suite, dev without a database). */
export function createMemoryBillingRepository(): BillingRepository {
  const customers = new Map<string, BillingCustomerRecord>();
  const memberships = new Map<string, MembershipRecord>();
  const operations = new Map<string, BillingOperationRecord>();
  const events = new Map<string, ProviderEventRecord>();
  const fingerprints = new Map<string, { accountId: string; createdAt: number }>();
  const invoices = new Map<string, InvoiceRecord>();
  const refunds = new Map<string, RefundRecord>();
  const planPrices = new Map<string, PlanPriceRecord>();
  const providerPrices = new Map<string, ProviderPriceRecord>();
  const checkouts = new Map<string, CheckoutRecord>();
  const setups = new Map<string, PaymentMethodSetupRecord>();

  const eventKey = (provider: PaymentProviderId, id: string) => `${provider}:${id}`;

  return {
    async getCustomer(accountId, provider) {
      const record = customers.get(`${accountId}:${provider}`);
      return record ? clone(record) : null;
    },
    async findCustomer(provider, customerId) {
      const record = [...customers.values()].find(
        (candidate) => candidate.provider === provider && candidate.customerId === customerId,
      );
      return record ? clone(record) : null;
    },
    async saveCustomer(record) {
      const key = `${record.accountId}:${record.provider}`;
      const existing = customers.get(key);
      if (existing) return clone(existing);
      customers.set(key, clone(record));
      return clone(record);
    },

    async getMembership(accountId) {
      const record = memberships.get(accountId);
      return record ? clone(record) : null;
    },
    async saveMembership(record, expectedVersion) {
      const existing = memberships.get(record.accountId);
      if (
        expectedVersion === null ? existing !== undefined : existing?.version !== expectedVersion
      ) {
        return false;
      }
      memberships.set(record.accountId, clone(record));
      return true;
    },
    async listMembershipsToReconcile(syncedBefore, limit) {
      return [...memberships.values()]
        .filter(
          (record) => RECONCILABLE.has(record.status) && record.providerSyncedAt < syncedBefore,
        )
        .sort((a, b) => a.providerSyncedAt - b.providerSyncedAt)
        .slice(0, limit)
        .map(clone);
    },

    async listTrialing(limit) {
      return [...memberships.values()]
        .filter((record) => record.status === "trialing")
        .sort((a, b) => (a.trialEndsAt ?? 0) - (b.trialEndsAt ?? 0))
        .slice(0, limit)
        .map(clone);
    },

    async startOperation(record) {
      const existing = [...operations.values()].find(
        (candidate) => candidate.idempotencyKey === record.idempotencyKey,
      );
      if (existing) return clone(existing);
      operations.set(`${record.id}:${record.attempt}`, clone(record));
      return clone(record);
    },
    async finishOperation(id, attempt, outcome, now) {
      const record = operations.get(`${id}:${attempt}`);
      if (record) Object.assign(record, outcome, { updatedAt: now });
    },
    async findOperationByKey(idempotencyKey) {
      const record = [...operations.values()].find(
        (candidate) => candidate.idempotencyKey === idempotencyKey,
      );
      return record ? clone(record) : null;
    },

    async recordProviderEvent(record) {
      const key = eventKey(record.provider, record.eventId);
      const existing = events.get(key);
      if (existing) return { inserted: false, record: clone(existing) };
      events.set(key, clone(record));
      return { inserted: true, record: clone(record) };
    },
    async getProviderEvent(provider, eventId) {
      const record = events.get(eventKey(provider, eventId));
      return record ? clone(record) : null;
    },
    async updateProviderEvent(provider, eventId, patch) {
      const record = events.get(eventKey(provider, eventId));
      if (!record) return;
      record.status = patch.status;
      record.attempts = patch.attempts;
      record.lastError = patch.lastError;
      record.processedAt = patch.processedAt;
      if (patch.accountId !== undefined) record.accountId = patch.accountId;
    },
    async latestEventReceivedAt(provider) {
      let latest: number | null = null;
      for (const record of events.values()) {
        if (record.provider === provider && (latest === null || record.receivedAt > latest)) {
          latest = record.receivedAt;
        }
      }
      return latest;
    },
    async firstFailureAt(provider, invoiceId) {
      let first: number | null = null;
      for (const record of events.values()) {
        if (
          record.provider === provider &&
          record.invoiceId === invoiceId &&
          record.type === "invoice.payment_failed" &&
          (first === null || record.eventCreatedAt < first)
        ) {
          first = record.eventCreatedAt;
        }
      }
      return first;
    },
    async listPendingProviderEvents(receivedBefore, limit) {
      return [...events.values()]
        .filter((record) => record.status === "pending" && record.receivedAt < receivedBefore)
        .sort((a, b) => a.receivedAt - b.receivedAt)
        .slice(0, limit)
        .map(clone);
    },

    async claimTrialFingerprint({ provider, fingerprint, accountId, now }) {
      const key = `${provider}:${fingerprint}`;
      const existing = fingerprints.get(key);
      if (existing) return existing.accountId === accountId ? "mine" : "taken";
      fingerprints.set(key, { accountId, createdAt: now });
      return "claimed";
    },
    async releaseTrialFingerprint(provider, fingerprint, accountId) {
      const key = `${provider}:${fingerprint}`;
      if (fingerprints.get(key)?.accountId === accountId) fingerprints.delete(key);
    },
    async hasTrialFingerprint(accountId) {
      return [...fingerprints.values()].some((claim) => claim.accountId === accountId);
    },

    async upsertInvoice(record) {
      const existing = [...invoices.values()].find(
        (candidate) =>
          candidate.provider === record.provider &&
          candidate.providerInvoiceId === record.providerInvoiceId,
      );
      const stored = existing ? { ...record, id: existing.id } : record;
      invoices.set(stored.id, clone(stored));
      return clone(stored);
    },
    async getInvoice(accountId, id) {
      const record = invoices.get(id);
      return record && record.accountId === accountId ? clone(record) : null;
    },
    async listInvoices(accountId, { limit, before }) {
      return [...invoices.values()]
        .filter((record) => record.accountId === accountId)
        .filter(
          (record) =>
            before === null ||
            record.issuedAt < before.issuedAt ||
            (record.issuedAt === before.issuedAt && record.id < before.id),
        )
        .sort((a, b) => b.issuedAt - a.issuedAt || (a.id < b.id ? 1 : -1))
        .slice(0, limit)
        .map(clone);
    },
    async saveRefund(record) {
      refunds.set(record.id, clone(record));
    },
    async listRefunds(invoiceId) {
      return [...refunds.values()]
        .filter((record) => record.invoiceId === invoiceId)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(clone);
    },

    async listPlanPrices() {
      return [...planPrices.values()]
        .sort((a, b) => (a.lookupKey < b.lookupKey ? -1 : 1))
        .map(clone);
    },
    async savePlanPrice(record) {
      planPrices.set(`${record.planId}:${record.currency}`, clone(record));
    },
    async listProviderPrices(provider) {
      return [...providerPrices.values()]
        .filter((record) => record.provider === provider)
        .map(clone);
    },
    async saveProviderPrices(records) {
      for (const record of records) {
        providerPrices.set(`${record.provider}:${record.lookupKey}`, clone(record));
      }
    },

    async saveCheckout(record) {
      checkouts.set(record.id, clone(record));
    },
    async getCheckout(accountId, id) {
      const record = checkouts.get(id);
      return record && record.accountId === accountId ? clone(record) : null;
    },
    async findOpenCheckout(accountId, now) {
      const open = [...checkouts.values()]
        .filter(
          (record) =>
            record.accountId === accountId &&
            OPEN_CHECKOUT.has(record.status) &&
            record.expiresAt > now,
        )
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
      return open[0] ? clone(open[0]) : null;
    },
    async listCheckoutsForSubscription(provider, subscriptionId) {
      return [...checkouts.values()]
        .filter(
          (record) =>
            record.provider === provider && record.providerSubscriptionId === subscriptionId,
        )
        .map(clone);
    },
    async saveSetup(record) {
      setups.set(record.id, clone(record));
    },
    async getSetup(accountId, id) {
      const record = setups.get(id);
      return record && record.accountId === accountId ? clone(record) : null;
    },
    async findSetupByProviderId(provider, providerSetupId) {
      const record = [...setups.values()].find(
        (candidate) =>
          candidate.provider === provider && candidate.providerSetupId === providerSetupId,
      );
      return record ? clone(record) : null;
    },
  };
}
