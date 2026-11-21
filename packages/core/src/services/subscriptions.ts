import {
  MOCK_CARDS,
  type MockCardPayment,
  type PAYMENT_DECLINE_REASONS,
  type SubscriptionStatus,
} from "@webflix/contracts";
import type { CardBrand, StoredCard, SubscriptionRecord } from "../repositories/records.ts";

/** Mock billing periods are 30 days. */
export const BILLING_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Status is derived from the record and the clock, never stored, so no job has to flip
 * memberships at period boundaries:
 * - not canceled: `active`; the period renews automatically (the mock provider always
 *   collects), so the effective period end rolls forward past `now`;
 * - canceled: `canceling` until the period end, then `ended`.
 */
export function effectiveSubscription(
  subscription: SubscriptionRecord,
  now: number,
): { status: SubscriptionStatus; currentPeriodEnd: number } {
  if (subscription.canceledAt === null) {
    let end = subscription.currentPeriodEnd;
    if (end <= now) end += Math.ceil((now - end + 1) / BILLING_PERIOD_MS) * BILLING_PERIOD_MS;
    return { status: "active", currentPeriodEnd: end };
  }
  return {
    status: now < subscription.currentPeriodEnd ? "canceling" : "ended",
    currentPeriodEnd: subscription.currentPeriodEnd,
  };
}

// --- Mock billing ---------------------------------------------------------------------------

export type DeclineReason = (typeof PAYMENT_DECLINE_REASONS)[number];

/** A card as the API receives it (after contract validation: digits only). */
export type CardInput = Omit<MockCardPayment, "cardNumber"> & { cardNumber: string };

export type ChargeResult =
  | { approved: true; card: StoredCard }
  | { approved: false; reason: DeclineReason };

/**
 * Port for the payment provider. Only a mock exists (blueprint §1.3: no real payments), but it
 * sits behind an interface so the HTTP and service code never special-cases test cards.
 */
export interface BillingProvider {
  /** Charge (or, with amount 0, verify) a new card or the stored one. */
  charge(input: {
    card: CardInput | StoredCard;
    amountMinor: number;
    currency: string;
    now: number;
  }): Promise<ChargeResult>;
}

export function cardBrand(cardNumber: string): CardBrand {
  if (/^4/.test(cardNumber)) return "visa";
  if (/^(5[1-5]|2(2[2-9][1-9]|2[3-9]\d|[3-6]\d\d|7[01]\d|720))/.test(cardNumber))
    return "mastercard";
  if (/^3[47]/.test(cardNumber)) return "amex";
  if (/^(6011|65|64[4-9])/.test(cardNumber)) return "discover";
  return "other";
}

function isExpired(expMonth: number, expYear: number, now: number): boolean {
  const date = new Date(now);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return expYear < year || (expYear === year && expMonth < month);
}

/**
 * The mock provider. Test cards (documented in docs/BACKEND.md and `MOCK_CARDS`):
 * - `4000 0000 0000 0002` → declined (`card_declined`)
 * - `4000 0000 0000 9995` → declined (`insufficient_funds`)
 * - any card whose expiry month is in the past → declined (`expired_card`)
 * - anything else that passes the contract's format check → approved.
 */
export function createMockBillingProvider(): BillingProvider {
  return {
    async charge({ card, now }) {
      if ("cardNumber" in card) {
        if (card.cardNumber === MOCK_CARDS.declined)
          return { approved: false, reason: "card_declined" };
        if (card.cardNumber === MOCK_CARDS.insufficientFunds) {
          return { approved: false, reason: "insufficient_funds" };
        }
        if (isExpired(card.expMonth, card.expYear, now))
          return { approved: false, reason: "expired_card" };
        return {
          approved: true,
          card: {
            brand: cardBrand(card.cardNumber),
            last4: card.cardNumber.slice(-4),
            expMonth: card.expMonth,
            expYear: card.expYear,
          },
        };
      }
      if (isExpired(card.expMonth, card.expYear, now))
        return { approved: false, reason: "expired_card" };
      return { approved: true, card: { ...card } };
    },
  };
}
