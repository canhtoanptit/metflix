import type { DeletionMembership, Entitlement, MembershipState, Money } from "@webflix/contracts";
import { formatLongDate, formatMoney } from "../shared/format.ts";

/**
 * What a membership means for the member, in one place (UX review 2.1): when watching ends,
 * whether and when anything more is charged, and the next amount with its reason. Every screen
 * that states these facts (Membership, the plan and cancel pages, the paywall, toasts, Privacy)
 * reads them from here, so no two pages can disagree about the same membership.
 *
 * Inputs are the server's: the membership projection and entitlement (`GET /account`,
 * `GET /session`), the plan's price (`GET /plans`, or `plan` on the account) and any scheduled
 * account deletion (`GET /privacy/requests`). To say what deleting today would do, pass the
 * deletion that would be scheduled (`scheduledFor` = now plus the cooling-off period).
 */

export type WatchingEndsBecause =
  /** A free trial that will not convert (cancelled, or the account is being deleted) ends. */
  | "trial_ends"
  /** A paid period that will not renew ends. */
  | "period_ends"
  /** The account is deleted before the period closes. */
  | "account_deleted"
  /** A failed payment's grace period runs out, unless the payment goes through first. */
  | "grace_ends";

export type NoChargeBecause =
  /** The member cancelled: it ends when the period closes. */
  | "cancelled"
  /** The account's deletion is scheduled: renewals are stopped. */
  | "deletion"
  /** A payment failed: that payment is owed, nothing new is scheduled. */
  | "payment_due"
  /** On hold after the grace period: the missed payment is owed. */
  | "suspended"
  /** It has ended. */
  | "ended"
  /** No membership yet. */
  | "none"
  /** A first payment is waiting for confirmation. */
  | "pending"
  /** Milestone 1's built-in membership (no payment provider): nothing is ever charged. */
  | "built_in";

export interface NextCharge {
  /** When (provider time, like every billing date). */
  at: string;
  /** Exactly what will be charged then (the provider's preview: credit and discounts included). */
  amount: Money;
  /** The first payment when a free trial ends, or a renewal. */
  kind: "trial_converts" | "renewal";
  /**
   * Why it is that amount: the plan's price; less than it because of the account's credit (left
   * from a plan change), a promo code's discount, or both; `reduced` when it is less and the
   * server did not say why (an API from before `creditApplied`); `unknown` without the price.
   */
  reason: "plan_price" | "credit" | "discount" | "credit_and_discount" | "reduced" | "unknown";
  /** The account credit this payment uses (null when none). */
  creditApplied: Money | null;
  /** The promo code's discount on it (null when none). */
  discount: Money | null;
  /** How much less than the plan's price, all told (null when none). */
  reducedBy: Money | null;
}

export interface MembershipOutcome {
  /** The member may watch now. */
  watching: boolean;
  /** When watching stops unless something changes; null while the membership carries on. */
  watchingEnds: { at: string; because: WatchingEndsBecause } | null;
  /** The next charge; null when nothing more is scheduled to be charged. */
  nextCharge: NextCharge | null;
  /** Why nothing more is charged; null when a charge is scheduled. */
  noChargeBecause: NoChargeBecause | null;
  /** The plan's monthly price: what each payment after the next one is (null if unknown). */
  monthly: Money | null;
}

export interface OutcomeContext {
  /** The membership's plan's monthly price. */
  monthlyPrice?: Money | null;
  /** A scheduled (or, before asking, hypothetical) account deletion. */
  deletion?: { scheduledFor: string; membership?: DeletionMembership | null } | null;
}

/** A credit or discount worth saying (the server sends null for none; zero is none too). */
function positive(value: Money | null | undefined): Money | null {
  return value && value.amountMinor > 0 ? value : null;
}

function isBefore(a: string, b: string): boolean {
  return Date.parse(a) < Date.parse(b);
}

export function membershipOutcome(
  view: { membership: MembershipState; entitlement: Entitlement },
  context: OutcomeContext = {},
): MembershipOutcome {
  const { membership: m, entitlement } = view;
  const monthly = context.monthlyPrice ?? null;
  const deletion = context.deletion ?? null;
  const nothing = (
    because: NoChargeBecause,
    watchingEnds: MembershipOutcome["watchingEnds"] = null,
  ) =>
    ({
      watching: entitlement.entitled,
      watchingEnds,
      nextCharge: null,
      noChargeBecause: because,
      monthly,
    }) satisfies MembershipOutcome;
  /** Watching ends at `at`, or at the deletion when that comes first (or at the same time). */
  const endsAt = (at: string | null, because: WatchingEndsBecause) =>
    deletion && (at === null || !isBefore(at, deletion.scheduledFor))
      ? { at: deletion.scheduledFor, because: "account_deleted" as const }
      : at
        ? { at, because }
        : null;

  switch (m.status) {
    case "none":
      return nothing("none");
    case "incomplete":
      return nothing("pending");
    case "suspended":
      return nothing("suspended");
    case "canceled":
      return nothing("ended");
    case "past_due":
      return nothing("payment_due", endsAt(m.graceEndsAt ?? entitlement.until, "grace_ends"));
    case "trialing":
    case "active": {
      const trial = m.status === "trialing";
      const periodEnd =
        (trial ? (m.trialEndsAt ?? m.currentPeriodEnd) : m.currentPeriodEnd) ?? entitlement.until;
      const periodBecause: WatchingEndsBecause = trial ? "trial_ends" : "period_ends";
      // Milestone 1's built-in membership: never charged; a deletion ends it with the account.
      if (m.provider === null) {
        return nothing(
          "built_in",
          deletion
            ? endsAt(null, periodBecause)
            : m.cancelAtPeriodEnd
              ? endsAt(periodEnd, periodBecause)
              : null,
        );
      }
      // A scheduled deletion stops the renewals (the request says so unless it could not).
      const stillRenews = deletion?.membership?.status === "renewing";
      if (m.cancelAtPeriodEnd || (deletion && !stillRenews)) {
        const ends = endsAt(deletion?.membership?.endsAt ?? periodEnd, periodBecause);
        return nothing(deletion ? "deletion" : "cancelled", ends);
      }
      const next = m.nextInvoice ?? null;
      const at = next?.at ?? periodEnd;
      const amount = next?.amount ?? monthly;
      if (!at || !amount) return nothing("ended", endsAt(periodEnd, periodBecause));
      // Renewals that could not be stopped: charged only before the account goes.
      if (deletion && !isBefore(at, deletion.scheduledFor)) {
        return nothing("deletion", endsAt(null, periodBecause));
      }
      const creditApplied = positive(next?.creditApplied);
      const discount = positive(next?.discount);
      // The price before credit and discounts: amount + creditApplied + discount (the server's
      // rule); without its reasons, the plan's price.
      const explained = creditApplied !== null || discount !== null;
      const reducedMinor = explained
        ? (creditApplied?.amountMinor ?? 0) + (discount?.amountMinor ?? 0)
        : monthly !== null && monthly.currency === amount.currency
          ? Math.max(0, monthly.amountMinor - amount.amountMinor)
          : null;
      const reducedBy = reducedMinor
        ? { amountMinor: reducedMinor, currency: amount.currency }
        : null;
      const reason: NextCharge["reason"] =
        creditApplied && discount
          ? "credit_and_discount"
          : creditApplied
            ? "credit"
            : discount
              ? "discount"
              : reducedMinor === null
                ? "unknown"
                : reducedBy
                  ? "reduced"
                  : "plan_price";
      return {
        watching: entitlement.entitled,
        watchingEnds: deletion ? endsAt(null, periodBecause) : null,
        nextCharge: {
          at,
          amount,
          kind: trial ? "trial_converts" : "renewal",
          reason,
          creditApplied,
          discount,
          reducedBy,
        },
        noChargeBecause: null,
        monthly,
      };
    }
  }
}

/** The outcome in Webflix's words: one sentence each, or null when the page says it otherwise. */
export interface OutcomeWording {
  /** When watching ends and why ("You can watch until December 7, 2026, when …"). */
  watching: string | null;
  /** Whether and when anything more is charged, with the amount's reason. */
  charge: string | null;
}

export function describeWatchingEnds(ends: NonNullable<MembershipOutcome["watchingEnds"]>): string {
  const date = formatLongDate(ends.at);
  switch (ends.because) {
    case "trial_ends":
      return `You can watch until ${date}, when your free trial ends.`;
    case "period_ends":
      return `You can watch until ${date}, when your membership ends.`;
    case "account_deleted":
      return `You can watch until ${date}, when your account is deleted.`;
    case "grace_ends":
      return `You can watch until ${date}. Update your payment method before then to keep watching.`;
  }
}

/**
 * Why an amount is below its price, as a phrase: "your $4.98 credit", "your $4.00 discount",
 * "your $2.00 credit and $1.00 discount"; null when nothing is taken off.
 */
export function describeReduction(
  creditApplied: Money | null | undefined,
  discount: Money | null | undefined,
  /** The promo code behind the discount, when known: "your $6.50 WEBFLIX50 discount". */
  code?: string | null,
): string | null {
  const credit = positive(creditApplied);
  const off = positive(discount);
  const discountName = code ? `${code} discount` : "discount";
  if (credit && off)
    return `your ${formatMoney(credit)} credit and ${formatMoney(off)} ${discountName}`;
  if (credit) return `your ${formatMoney(credit)} credit`;
  if (off) return `your ${formatMoney(off)} ${discountName}`;
  return null;
}

/** "$12.99 less your $6.50 WEBFLIX50 discount": an amount's price and why it is lower, or null. */
export function describeAmountReason(
  amount: Money | null | undefined,
  reasons: {
    creditApplied?: Money | null;
    discount?: Money | null;
    code?: string | null;
  },
): string | null {
  const why = describeReduction(reasons.creditApplied, reasons.discount, reasons.code);
  if (!amount || !why) return null;
  const before = formatMoney({
    amountMinor:
      amount.amountMinor +
      (positive(reasons.creditApplied)?.amountMinor ?? 0) +
      (positive(reasons.discount)?.amountMinor ?? 0),
    currency: amount.currency,
  });
  return `${before} less ${why}`;
}

/** "$3.01 ($7.99 less your $4.98 credit)", or just the amount when it is the plan's price. */
export function describeChargeAmount(charge: NextCharge): string {
  const amount = formatMoney(charge.amount);
  if (!charge.reducedBy) return amount;
  const full = formatMoney({
    amountMinor: charge.amount.amountMinor + charge.reducedBy.amountMinor,
    currency: charge.amount.currency,
  });
  const why =
    describeReduction(charge.creditApplied, charge.discount) ??
    `${formatMoney(charge.reducedBy)} of credit and discounts`;
  return `${amount} (${full} less ${why})`;
}

/**
 * The next charge in one sentence, its reason first when something lowers it: "Your $4.98 credit
 * makes your next payment $3.01 on December 30, 2026, then $7.99 a month."
 */
export function describeNextCharge(charge: NextCharge, monthly: Money | null): string {
  const date = formatLongDate(charge.at);
  const amount = formatMoney(charge.amount);
  const first = charge.kind === "trial_converts";
  const then = charge.reducedBy && monthly ? `, then ${formatMoney(monthly)} a month` : "";
  const when = first ? `${date}, when your free trial ends` : date;
  const why = describeReduction(charge.creditApplied, charge.discount);
  if (why) {
    const verb = charge.creditApplied && charge.discount ? "make" : "makes";
    return `${capitalize(why)} ${verb} your ${first ? "first" : "next"} payment ${amount} on ${when}${then}.`;
  }
  return first
    ? `Your first payment, ${describeChargeAmount(charge)}, is on ${when}${then}.`
    : `Your next payment is ${describeChargeAmount(charge)} on ${when}${then}.`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function describeOutcome(outcome: MembershipOutcome): OutcomeWording {
  const watching = outcome.watchingEnds ? describeWatchingEnds(outcome.watchingEnds) : null;
  let charge: string | null = null;
  if (outcome.nextCharge) charge = describeNextCharge(outcome.nextCharge, outcome.monthly);
  else if (
    outcome.noChargeBecause === "cancelled" ||
    outcome.noChargeBecause === "deletion" ||
    outcome.noChargeBecause === "built_in"
  ) {
    charge = "Nothing more is charged.";
  }
  return { watching, charge };
}
