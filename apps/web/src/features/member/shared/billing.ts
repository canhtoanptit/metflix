import { ApiError, type PAYMENT_DECLINE_REASONS } from "@webflix/contracts";
import type { CardForm, CardFormErrors } from "./validation.ts";

type DeclineReason = (typeof PAYMENT_DECLINE_REASONS)[number];

export interface DeclineCopy {
  title: string;
  body: string;
  /** The field to mark and focus. */
  field: keyof CardForm;
  fieldError: string;
}

/** What to tell the member for each decline reason the mock provider returns. */
export function describeDecline(reason: DeclineReason): DeclineCopy {
  switch (reason) {
    case "card_declined":
      return {
        title: "Your card was declined",
        body: "Your bank didn't approve this payment. Try another card, or contact your bank.",
        field: "cardNumber",
        fieldError: "This card was declined. Try another card.",
      };
    case "insufficient_funds":
      return {
        title: "Your card was declined for insufficient funds",
        body: "Try another card, or add funds and try again.",
        field: "cardNumber",
        fieldError: "Insufficient funds on this card.",
      };
    case "expired_card":
      return {
        title: "Your card has expired",
        body: "Check the expiry date, or use another card.",
        field: "expiry",
        fieldError: "This card has expired.",
      };
  }
}

/** Map a decline or a `validation_failed` problem onto card field errors. */
export function cardErrorsFrom(error: unknown): CardFormErrors {
  if (ApiError.is(error, "payment_declined")) {
    const copy = describeDecline(error.problem.declineReason);
    return { [copy.field]: copy.fieldError };
  }
  if (ApiError.is(error, "validation_failed")) {
    const errors: CardFormErrors = {};
    for (const issue of error.problem.issues) {
      if (issue.path.endsWith("cardNumber")) errors.cardNumber = "Check your card number.";
      else if (issue.path.endsWith("expMonth") || issue.path.endsWith("expYear"))
        errors.expiry = "Check the expiry date.";
      else if (issue.path.endsWith("cvc")) errors.cvc = "Check the security code.";
      else if (issue.path.endsWith("nameOnCard")) errors.nameOnCard = "Check the name on the card.";
    }
    return errors;
  }
  return {};
}
