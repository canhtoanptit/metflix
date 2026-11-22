import type { PaymentFailureCode, PaymentTestCard } from "@webflix/core";

/**
 * The fake provider's test cards: the five the port's contract suite pays with
 * (`PAYMENT_TEST_CARDS`) plus every other outcome a real provider produces. Each has the number
 * Stripe documents for the same behaviour, so the fake's form accepts what people already type
 * in Stripe's test mode (docs/STRIPE.md §6). No real card number is ever accepted: anything not
 * listed here is refused.
 */
export const FAKE_TEST_CARDS = [
  "visa",
  "mastercard",
  "declined",
  "insufficient-funds",
  "expired-card",
  "incorrect-cvc",
  "processing-error",
  "lost-card",
  "charge-declined",
  "authentication-required",
  "challenge",
] as const satisfies readonly (PaymentTestCard | string)[];
export type FakeTestCard = (typeof FAKE_TEST_CARDS)[number];

export interface FakeCardSpec {
  number: string;
  brand: "visa" | "mastercard";
  label: string;
  /** Refused when the card is confirmed (setup or on-session payment). */
  declineAtConfirm: PaymentFailureCode | null;
  /** Refused when charged off-session later (renewals, prorations, explicit attempts). */
  declineOffSession: PaymentFailureCode | null;
  /** A challenge (3-D Secure) must be completed in the form before it is confirmed. */
  challenge: boolean;
}

export const FAKE_CARDS: Record<FakeTestCard, FakeCardSpec> = {
  visa: card("4242424242424242", "visa", "Succeeds"),
  mastercard: card(
    "5555555555554444",
    "mastercard",
    "Succeeds (a second card, another fingerprint)",
  ),
  declined: card("4000000000000002", "visa", "Declined (generic)", "card_declined"),
  "insufficient-funds": card(
    "4000000000009995",
    "visa",
    "Declined: insufficient funds",
    "insufficient_funds",
  ),
  "expired-card": card("4000000000000069", "visa", "Declined: expired card", "expired_card"),
  "incorrect-cvc": card("4000000000000127", "visa", "Declined: incorrect CVC", "incorrect_cvc"),
  "processing-error": card(
    "4000000000000119",
    "visa",
    "Declined: processing error",
    "processing_error",
  ),
  "lost-card": card("4000000000009987", "visa", "Declined: lost card", "card_declined"),
  "charge-declined": {
    ...card("4000000000000341", "visa", "Saved fine, declined when charged later"),
    declineOffSession: "card_declined",
  },
  "authentication-required": {
    ...card("4000002760003184", "visa", "Always asks for a challenge, also off-session"),
    challenge: true,
    declineOffSession: "authentication_required",
  },
  challenge: {
    ...card("4000002500003155", "visa", "Asks for a challenge once, then charges off-session"),
    challenge: true,
  },
};

function card(
  number: string,
  brand: "visa" | "mastercard",
  label: string,
  declineAtConfirm: PaymentFailureCode | null = null,
): FakeCardSpec {
  return {
    number,
    brand,
    label,
    declineAtConfirm,
    declineOffSession: declineAtConfirm,
    challenge: false,
  };
}

/** A test card by name or by its number (spaces and dashes ignored); null for anything else. */
export function resolveTestCard(input: string): FakeTestCard | null {
  const value = input.trim().toLowerCase();
  if ((FAKE_TEST_CARDS as readonly string[]).includes(value)) return value as FakeTestCard;
  const digits = value.replaceAll(/[\s-]/g, "");
  for (const name of FAKE_TEST_CARDS) {
    if (FAKE_CARDS[name].number === digits) return name;
  }
  return null;
}

/** The same card has the same fingerprint for every customer (like a real provider). */
export function cardFingerprint(card: FakeTestCard): string {
  return `fp_fake_${card.replaceAll("-", "_")}`;
}
