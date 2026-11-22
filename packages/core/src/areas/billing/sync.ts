import { serializeError } from "../../ports/logger.ts";
import type { ProviderEvent, ProviderSubscription } from "../../ports/payment-provider.ts";
import { mirrorLegacySubscription } from "./accounts.ts";
import type { BillingContext } from "./context.ts";
import { emailReceipt, emailsForChange, emailTrialsEnding } from "./emails.ts";
import { invoiceRecord } from "./presenters.ts";
import {
  effectiveMembership,
  projectMembership,
  sameProjection,
  supersedes,
} from "./projection.ts";
import type { CheckoutRecord, MembershipRecord, ProviderEventRecord } from "./repository.ts";

/** A provider event job: ids only (§5.3: payloads never carry provider library objects). */
export const PROVIDER_EVENT_JOB = "billing.provider-event";
export const RECONCILE_JOB = "billing.reconcile";
/** After this many failed attempts an event is marked `failed` (the queue dead-letters it too). */
export const MAX_EVENT_ATTEMPTS = 8;
const RECONCILE_CURSOR_KEY = "billing.reconcile.cursor";
/** Events are re-listed with this much overlap (deduplicated by id): late logging, skew. */
const RECONCILE_OVERLAP_MS = 10 * 60_000;
/**
 * On the first run, look this far back (a new deployment has no outage to recover from; a
 * busy Stripe account logs thousands of events a day, and Stripe lists them newest first).
 */
const RECONCILE_FIRST_LOOKBACK_MS = 3_600_000;
/** One call reads a normal window whole (Stripe: up to ten pages in one walk). */
const RECONCILE_PAGE = 1_000;
const RECONCILE_MAX_PAGES = 5;
/** A membership not synced for this long is read from the provider again. */
export const RECONCILE_STALE_MS = 6 * 3_600_000;
const CAS_ATTEMPTS = 5;

export interface SyncOutcome {
  accountId: string;
  membership: MembershipRecord;
  changed: boolean;
}

/**
 * Records one verified (or listed) provider event once, by id, and queues its processing.
 * A redelivery of an event that is still unprocessed is queued again (processing is
 * idempotent); one already processed is only acknowledged.
 */
export async function recordProviderEvent(
  context: BillingContext,
  event: ProviderEvent,
  source: ProviderEventRecord["source"],
): Promise<{ duplicate: boolean }> {
  const { repos, jobs } = context.deps;
  const customer = event.customerId
    ? await repos.billing.findCustomer(context.provider, event.customerId)
    : null;
  const { inserted, record } = await repos.billing.recordProviderEvent({
    provider: context.provider,
    eventId: event.id,
    type: event.type,
    accountId: customer?.accountId ?? null,
    idempotencyKey: event.idempotencyKey,
    customerId: event.customerId,
    subscriptionId: event.subscriptionId,
    invoiceId: event.invoiceId,
    setupId: event.setupId,
    eventCreatedAt: event.occurredAt,
    source,
    receivedAt: context.now(),
    processedAt: null,
    status: "pending",
    attempts: 0,
    lastError: null,
  });
  if (inserted || record.status !== "processed") {
    await jobs.publish({
      type: PROVIDER_EVENT_JOB,
      payload: { provider: context.provider, eventId: event.id },
    });
  }
  return { duplicate: !inserted };
}

/**
 * Processes one recorded event. Never trusts its order or contents (§5.3, docs/STRIPE.md §11):
 * the event only says which subscription (or invoice, or card setup) to read again; the
 * projection is computed from what the provider says now.
 */
export async function processProviderEvent(
  context: BillingContext,
  eventId: string,
  hooks: { completeSetup(providerSetupId: string): Promise<void> },
): Promise<void> {
  const { repos, logger } = context.deps;
  const event = await repos.billing.getProviderEvent(context.provider, eventId);
  if (!event || event.status === "processed") return;
  try {
    if (event.setupId) await hooks.completeSetup(event.setupId);
    let subscriptionId = event.subscriptionId;
    if (event.invoiceId) {
      const invoice = await context.payments.retrieveInvoice(event.invoiceId);
      if (invoice) {
        subscriptionId ??= invoice.subscriptionId;
        await storeInvoice(context, invoice);
      }
    }
    const customer = event.customerId
      ? await repos.billing.findCustomer(context.provider, event.customerId)
      : null;
    if (!subscriptionId && customer) {
      const membership = await repos.billing.getMembership(customer.accountId);
      subscriptionId = membership?.providerSubscriptionId ?? null;
    }
    const outcome = subscriptionId
      ? await syncSubscription(context, subscriptionId, customer?.accountId ?? null)
      : null;
    await repos.billing.updateProviderEvent(context.provider, eventId, {
      status: "processed",
      attempts: event.attempts + 1,
      lastError: null,
      processedAt: context.now(),
      ...(outcome ? { accountId: outcome.accountId } : {}),
    });
  } catch (error) {
    const attempts = event.attempts + 1;
    await repos.billing.updateProviderEvent(context.provider, eventId, {
      status: attempts >= MAX_EVENT_ATTEMPTS ? "failed" : "pending",
      attempts,
      lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      processedAt: null,
    });
    logger.warn("billing.event_failed", { eventId, type: event.type, attempts });
    throw error;
  }
}

/**
 * Reads a subscription from the provider and writes the projection, behind the version guard.
 * The order matters: read the stored version first, then the provider, then compare-and-set.
 * Any write that wins was computed from a provider read made after the version it replaced was
 * read, so a slow processor holding an older provider state can never overwrite a newer one;
 * a lost race starts over with a fresh provider read.
 */
export async function syncSubscription(
  context: BillingContext,
  subscriptionId: string,
  /** The account the caller believes owns it (checked against the provider's record). */
  accountHint: string | null,
): Promise<SyncOutcome | null> {
  const { repos, logger } = context.deps;
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const accountId = accountHint ?? (await accountOfSubscription(context, subscriptionId));
    if (!accountId) return null;
    const previous = await repos.billing.getMembership(accountId);
    const subscription = await context.payments.retrieveSubscription(subscriptionId);
    if (!subscription) return null;
    const owner = await repos.billing.findCustomer(context.provider, subscription.customerId);
    // Ownership comes from the provider's own record, never from an event.
    if (owner?.accountId !== accountId) {
      logger.warn("billing.subscription_not_ours", { subscriptionId });
      return null;
    }
    if (!supersedes(previous, subscription)) {
      return previous ? { accountId, membership: previous, changed: false } : null;
    }
    const firstFailureAt = subscription.latestInvoiceId
      ? await repos.billing.firstFailureAt(context.provider, subscription.latestInvoiceId)
      : null;
    const now = context.now();
    const next = projectMembership({
      previous,
      accountId,
      provider: context.provider,
      subscription,
      firstFailureAt,
      now,
    });
    if (!(await repos.billing.saveMembership(next, previous?.version ?? null))) continue;
    const changed = !sameProjection(previous, next);
    if (changed) await afterWrite(context, previous, next, subscription);
    return { accountId, membership: next, changed };
  }
  logger.warn("billing.sync_contended", { subscriptionId });
  throw new Error("billing: the projection kept changing under this sync; retry");
}

/** Which account a provider subscription belongs to, through our own customer records. */
async function accountOfSubscription(
  context: BillingContext,
  subscriptionId: string,
): Promise<string | null> {
  const subscription = await context.payments.retrieveSubscription(subscriptionId);
  if (!subscription) return null;
  const customer = await context.deps.repos.billing.findCustomer(
    context.provider,
    subscription.customerId,
  );
  return customer?.accountId ?? null;
}

async function afterWrite(
  context: BillingContext,
  previous: MembershipRecord | null,
  next: MembershipRecord,
  subscription: ProviderSubscription,
): Promise<void> {
  const { repos, logger } = context.deps;
  const before = previous
    ? effectiveMembership(previous, context.graceSec, previous.providerSyncedAt).status
    : "none";
  const after = effectiveMembership(next, context.graceSec, context.now()).status;
  await mirrorLegacySubscription(context.deps, next, context.graceSec, context.now());
  if (before !== after) {
    logger.info("billing.transition", { accountId: next.accountId, from: before, to: after });
    await context.seams.emitServerEvent({
      type: "billing.transition",
      payload: { from: before, to: after, planId: next.planId },
      accountId: next.accountId,
      profileId: null,
    });
  }
  // Checkouts of this subscription follow the projection.
  const checkouts = await repos.billing.listCheckoutsForSubscription(
    context.provider,
    subscription.id,
  );
  for (const checkout of checkouts) {
    const status = checkoutStatusFor(checkout, next);
    if (status !== checkout.status) {
      await repos.billing.saveCheckout({ ...checkout, status, updatedAt: context.now() });
    }
  }
  const invoice = subscription.latestInvoiceId
    ? await context.payments.retrieveInvoice(subscription.latestInvoiceId)
    : null;
  if (invoice) await storeInvoice(context, invoice);
  await emailsForChange(context, previous, next, before, after, invoice);
}

/** A checkout is complete once the membership it started is entitled (§5.1 step 4). */
export function checkoutStatusFor(
  checkout: CheckoutRecord,
  membership: MembershipRecord,
): CheckoutRecord["status"] {
  if (checkout.status === "complete" || checkout.status === "failed") return checkout.status;
  switch (membership.status) {
    case "trialing":
    case "active":
    case "past_due":
      return "complete";
    case "none":
    case "canceled":
      return "expired";
    default:
      return checkout.status;
  }
}

/** Keeps the account's copy of a provider invoice (history, receipts, staff refunds). */
export async function storeInvoice(
  context: BillingContext,
  invoice: Parameters<typeof invoiceRecord>[0],
): Promise<void> {
  const { repos, ids } = context.deps;
  const customer = await repos.billing.findCustomer(context.provider, invoice.customerId);
  if (!customer) return;
  const membership = await repos.billing.getMembership(customer.accountId);
  await emailReceipt(context, customer.accountId, invoice, membership?.planId ?? null);
  await repos.billing.upsertInvoice(
    invoiceRecord(invoice, {
      id: ids.next(),
      accountId: customer.accountId,
      provider: context.provider,
      now: context.now(),
    }),
  );
}

/**
 * The recovery path (§5.3): records every event the provider logged since the last run (the
 * CLI listener replays nothing after an outage, docs/STRIPE.md §11), re-queues events whose job
 * was lost, and reads stale memberships again.
 */
export async function reconcile(
  context: BillingContext,
): Promise<{ listed: number; recorded: number; requeued: number; resynced: number }> {
  const { repos, jobs, logger } = context.deps;
  const now = context.now();
  const cursorKey = `${RECONCILE_CURSOR_KEY}.${context.provider}`;
  const stored = Number(await repos.meta.get(cursorKey));
  let since =
    (Number.isFinite(stored) && stored > 0 ? stored : now - RECONCILE_FIRST_LOOKBACK_MS) -
    RECONCILE_OVERLAP_MS;
  let listed = 0;
  let recorded = 0;
  let covered = since;
  for (let page = 0; page < RECONCILE_MAX_PAGES; page += 1) {
    const events = await context.payments.listEvents({
      createdAfter: since,
      limit: RECONCILE_PAGE,
    });
    listed += events.length;
    for (const event of events) {
      const { duplicate } = await recordProviderEvent(context, event, "reconcile");
      if (!duplicate) recorded += 1;
    }
    const last = events[events.length - 1];
    if (events.length < RECONCILE_PAGE || !last) {
      // Everything logged up to a minute ago has been seen.
      covered = Math.max(covered, now - 60_000);
      await repos.meta.set(cursorKey, String(Math.floor(covered)), now);
      break;
    }
    covered = Math.max(covered, last.createdAt);
    since = last.createdAt - 1;
    // Saved as it goes: a run cut short (rate limits, an outage) resumes where it stopped.
    await repos.meta.set(cursorKey, String(Math.floor(covered)), now);
  }

  let requeued = 0;
  for (const event of await repos.billing.listPendingProviderEvents(now - 10 * 60_000, 100)) {
    await jobs.publish({
      type: PROVIDER_EVENT_JOB,
      payload: { provider: context.provider, eventId: event.eventId },
    });
    requeued += 1;
  }

  let resynced = 0;
  for (const membership of await repos.billing.listMembershipsToReconcile(
    now - RECONCILE_STALE_MS,
    50,
  )) {
    if (!membership.providerSubscriptionId || membership.provider !== context.provider) continue;
    try {
      await syncSubscription(context, membership.providerSubscriptionId, membership.accountId);
      resynced += 1;
    } catch (error) {
      logger.warn("billing.reconcile_failed", {
        accountId: membership.accountId,
        error: serializeError(error),
      });
    }
  }
  await emailTrialsEnding(context);
  if (recorded > 0 || requeued > 0) {
    logger.info("billing.reconciled", { listed, recorded, requeued, resynced });
  }
  return { listed, recorded, requeued, resynced };
}
