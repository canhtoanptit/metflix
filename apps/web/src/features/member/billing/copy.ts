import type {
  AppliedPromotion,
  Money,
  PAYMENT_DECLINE_REASONS,
  PROMOTION_FAILURE_REASONS,
} from "@webflix/contracts";
import { formatMoney } from "../shared/format.ts";

/**
 * Money and payment copy for checkout and membership. Amounts and currencies always come from
 * the server (`Money`), formatted in the member's locale; nothing here computes a price.
 */

export type DeclineReason = (typeof PAYMENT_DECLINE_REASONS)[number];
export type PromotionFailureReason = (typeof PROMOTION_FAILURE_REASONS)[number];

export interface DeclineCopy {
  title: string;
  /** What happened and what to do next. Nothing was charged in every case. */
  body: string;
}

/** What to tell the member for each decline reason the provider reports. */
export function describeDecline(reason: DeclineReason | null): DeclineCopy {
  switch (reason) {
    case "insufficient_funds":
      return {
        title: "Your card was declined for insufficient funds",
        body: "Use another card, or add funds and try again.",
      };
    case "expired_card":
      return {
        title: "Your card has expired",
        body: "Use another card, or check the expiry date with your bank.",
      };
    default:
      return {
        title: "Your card was declined",
        body: "Your bank didn't approve it. Use another card, or contact your bank.",
      };
  }
}

/** Why a promo code can't be used, in the member's words. */
export function describePromotionFailure(reason: PromotionFailureReason | undefined): string {
  switch (reason) {
    case "expired":
      return "This code has expired.";
    case "exhausted":
      return "This code has been used up.";
    case "not_applicable":
      return "This code doesn't apply to this plan.";
    case "already_redeemed":
      return "You've already used this code.";
    default:
      return "We don't recognize this code. Check it and try again.";
  }
}

/** "50% off" or "$5.00 off". */
export function promotionAmount(promotion: AppliedPromotion): string {
  if (promotion.percentOff !== null) return `${promotion.percentOff}% off`;
  if (promotion.amountOff) return `${formatMoney(promotion.amountOff)} off`;
  return "A discount";
}

/** "your first payment", "your first 3 months' payments", "every payment". */
export function promotionReach(promotion: AppliedPromotion): string {
  if (promotion.duration === "forever") return "every payment";
  if (promotion.duration === "repeating" && promotion.durationInMonths) {
    return promotion.durationInMonths === 1
      ? "your first month's payment"
      : `payments for your first ${promotion.durationInMonths} months`;
  }
  return "your first payment";
}

/** A `Money` of the same currency, for amounts the server sent as parts of one total. */
export function money(amountMinor: number, currency: string): Money {
  return { amountMinor, currency };
}

/** "−$6.50" for credits and discounts, "$6.49" otherwise. */
export function formatSignedMoney(value: Money): string {
  return value.amountMinor < 0
    ? `−${formatMoney({ ...value, amountMinor: -value.amountMinor })}`
    : formatMoney(value);
}
