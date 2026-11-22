import type {
  AppliedPromotion,
  Checkout,
  Invoice,
  PaymentMethodSetup,
  Refund,
} from "@webflix/contracts";
import { toIsoString } from "../../ports/clock.ts";
import type { ProviderInvoice } from "../../ports/payment-provider.ts";
import type {
  CheckoutPromotion,
  CheckoutRecord,
  InvoiceRecord,
  PaymentMethodSetupRecord,
  RefundRecord,
} from "./repository.ts";

const iso = (value: number | null) => (value === null ? null : toIsoString(value));

export function presentPromotion(promotion: CheckoutPromotion | null): AppliedPromotion | null {
  if (!promotion) return null;
  return {
    code: promotion.code,
    description:
      promotion.percentOff !== null
        ? `${promotion.percentOff}% off`
        : promotion.amountOffMinor !== null
          ? `${(promotion.amountOffMinor / 100).toFixed(2)} ${promotion.currency ?? "USD"} off`
          : null,
    percentOff: promotion.percentOff,
    amountOff:
      promotion.amountOffMinor === null
        ? null
        : { amountMinor: promotion.amountOffMinor, currency: promotion.currency ?? "USD" },
    duration: promotion.duration,
    durationInMonths: promotion.durationInMonths,
  };
}

/** The checkout DTO; `clientSecret` only while the browser has something to confirm. */
export function presentCheckout(
  checkout: CheckoutRecord,
  extras: { clientSecret: string | null; trialEndsAt: number | null },
): Checkout {
  const waiting = checkout.status === "requires_setup" || checkout.status === "requires_payment";
  return {
    id: checkout.id,
    planId: checkout.planId,
    status: checkout.status,
    clientSecret: waiting ? extras.clientSecret : null,
    trial:
      checkout.trialDays === null || checkout.trialDays <= 0
        ? null
        : { days: checkout.trialDays, endsAt: iso(extras.trialEndsAt) },
    amountDue:
      checkout.amountDueMinor === null
        ? null
        : { amountMinor: checkout.amountDueMinor, currency: checkout.currency },
    promotion: presentPromotion(checkout.promotion),
    failureReason: checkout.failureReason,
    createdAt: toIsoString(checkout.createdAt),
    expiresAt: toIsoString(checkout.expiresAt),
  };
}

export function presentSetup(
  setup: PaymentMethodSetupRecord,
  clientSecret: string | null,
): PaymentMethodSetup {
  return {
    id: setup.id,
    status: setup.status,
    clientSecret: setup.status === "requires_confirmation" ? clientSecret : null,
    createdAt: toIsoString(setup.createdAt),
  };
}

const DESCRIPTIONS: Record<string, string> = {
  subscription_create: "Membership",
  subscription_cycle: "Membership renewal",
  subscription_update: "Plan change",
};

export function presentInvoice(invoice: InvoiceRecord): Invoice {
  const currency = invoice.currency.toUpperCase();
  return {
    id: invoice.id,
    number: invoice.number,
    status: invoice.status,
    description: DESCRIPTIONS[invoice.billingReason] ?? null,
    total: { amountMinor: invoice.totalMinor, currency },
    amountPaid: { amountMinor: invoice.amountPaidMinor, currency },
    amountDue: { amountMinor: invoice.amountDueMinor, currency },
    amountRefunded: { amountMinor: invoice.amountRefundedMinor, currency },
    periodStart: iso(invoice.periodStart),
    periodEnd: iso(invoice.periodEnd),
    createdAt: toIsoString(invoice.issuedAt),
    paidAt: iso(invoice.paidAt),
    hostedUrl: safeUrl(invoice.hostedUrl),
    pdfUrl: safeUrl(invoice.pdfUrl),
  };
}

export function presentRefund(refund: RefundRecord): Refund {
  return {
    id: refund.id,
    invoiceId: refund.invoiceId,
    amount: { amountMinor: refund.amountMinor, currency: refund.currency.toUpperCase() },
    status: refund.status,
    createdAt: toIsoString(refund.createdAt),
  };
}

/** A provider invoice as stored for the account (its Webflix id is kept on update). */
export function invoiceRecord(
  invoice: ProviderInvoice,
  input: { id: string; accountId: string; provider: InvoiceRecord["provider"]; now: number },
): InvoiceRecord {
  return {
    id: input.id,
    accountId: input.accountId,
    provider: input.provider,
    providerInvoiceId: invoice.id,
    providerSubscriptionId: invoice.subscriptionId,
    number: invoice.number,
    status: invoice.status,
    currency: invoice.currency.toUpperCase(),
    totalMinor: invoice.totalMinor,
    amountPaidMinor: invoice.amountPaidMinor,
    amountDueMinor: invoice.amountDueMinor,
    amountRefundedMinor: invoice.amountRefundedMinor,
    billingReason: invoice.billingReason,
    periodStart: invoice.periodStart,
    periodEnd: invoice.periodEnd,
    hostedUrl: invoice.hostedUrl,
    pdfUrl: invoice.pdfUrl,
    issuedAt: invoice.createdAt,
    paidAt: invoice.paidAt,
    updatedAt: input.now,
  };
}

/** Only https URLs reach the member (a provider's hosted invoice and PDF). */
function safeUrl(value: string | null): string | null {
  return value?.startsWith("https://") ? value : null;
}
