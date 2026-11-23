import type { Plan, PlanChangePreview } from "@webflix/contracts";
import { formatMoney } from "../shared/format.ts";
import { describeNextCharge, type NextCharge } from "./outcome.ts";

/**
 * A plan change in Webflix's words (UX review 2.3): what is paid today and why, and the next
 * payment and why, one sentence each, from the server's preview (`creditApplied`, `discount`).
 * The provider's own line items stay folded away as detail; the plan page, its confirmation toast
 * and the Membership page afterwards all say the same thing.
 */
export interface PlanChangeWording {
  /** "You pay $5.99 today: $18.94 for the rest of this period on Premium, less ..." */
  today: string;
  /** "Your $4.98 credit makes your next payment $3.01 on December 30, 2026, then $7.99 a month." */
  next: string | null;
}

export function describePlanChange(
  preview: PlanChangePreview,
  plans: { current: Plan; next: Plan; trialing: boolean },
): PlanChangeWording {
  const { current, next, trialing } = plans;
  const due = preview.amountDue.amountMinor > 0;
  const credit = positive(preview.creditApplied);
  const discount = positive(preview.discount);
  let today: string;
  if (trialing && !due) {
    today = `Nothing to pay today: your free trial carries on with ${next.name}.`;
  } else if (due) {
    const full = formatMoney({
      amountMinor:
        preview.amountDue.amountMinor + (credit?.amountMinor ?? 0) + (discount?.amountMinor ?? 0),
      currency: preview.amountDue.currency,
    });
    const less = [
      credit ? `your ${formatMoney(credit)} credit for the time left on ${current.name}` : null,
      discount ? `your ${formatMoney(discount)} discount` : null,
    ]
      .filter(Boolean)
      .join(" and ");
    today = less
      ? `You pay ${formatMoney(preview.amountDue)} today: ${full} for the rest of this billing period on ${next.name}, less ${less}.`
      : `You pay ${formatMoney(preview.amountDue)} today for the rest of this billing period on ${next.name}.`;
  } else if (preview.credit.amountMinor > 0) {
    today = `Nothing to pay today. The time left on ${current.name} covers ${next.name} until your next payment, with ${formatMoney(preview.credit)} left over as credit.`;
  } else {
    today = "Nothing to pay today.";
  }
  return { today, next: preview.nextRenewal ? describeRenewal(preview, next, trialing) : null };
}

function describeRenewal(preview: PlanChangePreview, next: Plan, trialing: boolean): string {
  const renewal = preview.nextRenewal;
  if (!renewal) return "";
  const creditApplied = positive(renewal.creditApplied);
  const discount = positive(renewal.discount);
  const explained = creditApplied || discount;
  const reducedMinor = explained
    ? (creditApplied?.amountMinor ?? 0) + (discount?.amountMinor ?? 0)
    : Math.max(0, next.monthlyPrice.amountMinor - renewal.amount.amountMinor);
  const charge: NextCharge = {
    at: renewal.at,
    amount: renewal.amount,
    kind: trialing ? "trial_converts" : "renewal",
    reason:
      creditApplied && discount
        ? "credit_and_discount"
        : creditApplied
          ? "credit"
          : discount
            ? "discount"
            : reducedMinor
              ? "reduced"
              : "plan_price",
    creditApplied,
    discount,
    reducedBy: reducedMinor
      ? { amountMinor: reducedMinor, currency: renewal.amount.currency }
      : null,
  };
  return describeNextCharge(charge, next.monthlyPrice);
}

/** For the toast once applied: what was charged, and the next payment. */
export function describeAppliedPlanChange(
  preview: PlanChangePreview,
  plans: { current: Plan; next: Plan; trialing: boolean },
): string {
  const wording = describePlanChange(preview, plans);
  const charged =
    preview.amountDue.amountMinor > 0
      ? `${formatMoney(preview.amountDue)} was charged today.`
      : "Nothing was charged today.";
  return [charged, wording.next].filter(Boolean).join(" ");
}

/** The credit a preview leaves, labelled as credit (never as a payment). */
export function describeCreditKept(preview: PlanChangePreview): string | null {
  return preview.credit.amountMinor > 0
    ? `${formatMoney(preview.credit)} credit, used for your next payments`
    : null;
}

function positive<T extends { amountMinor: number }>(value: T | null | undefined): T | null {
  return value && value.amountMinor > 0 ? value : null;
}
