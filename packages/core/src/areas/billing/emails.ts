import { getPlan } from "../../domain/plans.ts";
import { toIsoString } from "../../ports/clock.ts";
import { serializeError } from "../../ports/logger.ts";
import type { ProviderInvoice } from "../../ports/payment-provider.ts";
import type { EmailRequest } from "../identity/email.ts";
import { readAccount } from "./accounts.ts";
import type { BillingContext } from "./context.ts";
import type { MembershipRecord } from "./repository.ts";

/** "Trial ending" goes out this long before the trial ends (§5.4: from `trial_end`). */
export const TRIAL_ENDING_NOTICE_MS = 3 * 24 * 3_600_000;

/** An amount for a template: minor units and currency, formatted once by `packages/email`. */
const money = (amountMinor: number, currency: string) => ({
  amountMinor,
  currency: currency.toUpperCase(),
});

/**
 * Billing's emails (§8.2: receipt, payment failed, trial ending, plan changed, cancellation),
 * through the identity area's `sendEmail` seam. Each has an idempotency key derived from the
 * provider fact it reports, so a redelivered event or a reconciliation never sends it twice. A
 * failure to queue is logged and never fails the sync that noticed it.
 */
async function send(
  context: BillingContext,
  accountId: string,
  request: Omit<EmailRequest, "to">,
): Promise<void> {
  try {
    const loaded = await readAccount(context.deps, accountId);
    if (!loaded?.account.email) return;
    await context.seams.sendEmail({ ...request, to: loaded.account.email } as EmailRequest);
  } catch (error) {
    context.deps.logger.warn("billing.email_not_queued", {
      template: request.template,
      error: serializeError(error),
    });
  }
}

/**
 * Whether the account's deletion is scheduled, asked when a cancellation email is decided
 * (privacy review M7). A deletion stops the renewals through `cancel`, but "keep watching until
 * the period ends, restart at any time" is false then: access ends with the erasure and a
 * restart is refused; the events area sends the deletion's own email. The request is recorded
 * before any cancel it causes (the member's request, the sweep's retry), so the answer is
 * already true on every such path, and on a staff cancel while the deletion is scheduled.
 * Unknown (the read failed): no email, rather than one that may be false.
 */
async function deletionScheduled(context: BillingContext, accountId: string): Promise<boolean> {
  try {
    return await context.seams.accountDeletionScheduled(accountId);
  } catch (error) {
    context.deps.logger.warn("billing.deletion_unknown", { error: serializeError(error) });
    return true;
  }
}

function link(context: BillingContext, path: string): string {
  return `${context.deps.config.publicOrigin}${path}`;
}

/** Emails a change of the projection calls for (called right after it was written). */
export async function emailsForChange(
  context: BillingContext,
  previous: MembershipRecord | null,
  next: MembershipRecord,
  before: string,
  after: string,
  latestInvoice: ProviderInvoice | null,
): Promise<void> {
  const planName = next.planId ? getPlan(next.planId).name : "Webflix";
  const subscriptionId = next.providerSubscriptionId ?? "none";
  if (after === "past_due" && before !== "past_due") {
    await send(context, next.accountId, {
      template: "payment-failed",
      data: {
        planName,
        amount: latestInvoice ? money(latestInvoice.amountDueMinor, latestInvoice.currency) : null,
        retryAt:
          latestInvoice?.nextPaymentAttempt != null
            ? toIsoString(latestInvoice.nextPaymentAttempt)
            : null,
        updateUrl: link(context, "/account"),
      },
      idempotencyKey: `payment-failed:${next.graceInvoiceId ?? subscriptionId}`,
    });
  }
  const periodEnd = next.status === "trialing" ? next.trialEndsAt : next.currentPeriodEnd;
  if (
    next.cancelAtPeriodEnd &&
    !(previous?.cancelAtPeriodEnd ?? false) &&
    periodEnd !== null &&
    !(await deletionScheduled(context, next.accountId))
  ) {
    await send(context, next.accountId, {
      template: "cancellation",
      data: {
        planName,
        accessUntil: toIsoString(periodEnd),
        restartUrl: link(context, "/account"),
      },
      idempotencyKey: `cancellation:${subscriptionId}:${periodEnd}`,
    });
  }
  if (
    previous?.providerSubscriptionId === next.providerSubscriptionId &&
    previous?.planId &&
    next.planId &&
    previous.planId !== next.planId
  ) {
    await send(context, next.accountId, {
      template: "plan-changed",
      data: {
        fromPlan: getPlan(previous.planId).name,
        toPlan: getPlan(next.planId).name,
        effectiveAt: toIsoString(next.updatedAt),
      },
      idempotencyKey: `plan-changed:${subscriptionId}:${next.latestInvoiceId ?? next.version}`,
    });
  }
}

/** A receipt for a paid invoice with something paid (the 0.00 trial invoice gets none). */
export async function emailReceipt(
  context: BillingContext,
  accountId: string,
  invoice: ProviderInvoice,
  planId: MembershipRecord["planId"],
): Promise<void> {
  if (invoice.status !== "paid" || invoice.amountPaidMinor <= 0) return;
  await send(context, accountId, {
    template: "receipt",
    data: {
      planName: planId ? getPlan(planId).name : "Webflix",
      amount: money(invoice.amountPaidMinor, invoice.currency),
      paidAt: toIsoString(invoice.paidAt ?? invoice.createdAt),
      periodEnd: invoice.periodEnd === null ? null : toIsoString(invoice.periodEnd),
      invoiceUrl: invoice.hostedUrl?.startsWith("https://") ? invoice.hostedUrl : null,
    },
    idempotencyKey: `receipt:${invoice.id}`,
  });
}

/**
 * "Trial ending", scheduled from the trial's end (§5.4: the provider's own hint arrived for 1
 * of 11 short trials), for every trial ending within the notice, in the provider's time.
 */
export async function emailTrialsEnding(context: BillingContext): Promise<number> {
  let sent = 0;
  for (const record of await context.deps.repos.billing.listTrialing(200)) {
    if (record.trialEndsAt === null || record.cancelAtPeriodEnd) continue;
    const providerNow = context.now() + record.clockOffsetMs;
    if (
      record.trialEndsAt - providerNow > TRIAL_ENDING_NOTICE_MS ||
      record.trialEndsAt <= providerNow
    ) {
      continue;
    }
    const plan = record.planId ? getPlan(record.planId) : null;
    await send(context, record.accountId, {
      template: "trial-ending",
      data: {
        planName: plan?.name ?? "Webflix",
        trialEndsAt: toIsoString(record.trialEndsAt),
        amount: plan ? money(plan.monthlyPrice.amountMinor, plan.monthlyPrice.currency) : null,
        manageUrl: link(context, "/account"),
      },
      idempotencyKey: `trial-ending:${record.providerSubscriptionId}:${record.trialEndsAt}`,
    });
    sent += 1;
  }
  return sent;
}
