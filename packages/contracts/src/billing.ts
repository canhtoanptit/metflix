/**
 * Milestone 2 billing and subscriptions (docs/BLUEPRINT-M2.md §5, docs/STRIPE.md). Card data
 * never appears here: the browser confirms with the provider's own form and Webflix only ever
 * sees provider tokens, client secrets and confirmation results (principle 4).
 */
import * as z from "zod";
import { Id, IsoDateTime, page, ResourceUrl } from "./common.ts";
import {
  CHECKOUT_STATUSES,
  ENTITLEMENT_REASONS,
  INVOICE_STATUSES,
  MEMBERSHIP_STATUSES,
  PAYMENT_DECLINE_REASONS,
  PAYMENT_METHOD_SETUP_STATUSES,
  PAYMENT_PROVIDERS,
  PROMOTION_OUTCOMES,
  SUSPENDED_REASONS,
} from "./constants.ts";
import { Money, PlanId, SignedMoney } from "./plans.ts";

/**
 * Why an amount is below its price, as numbers (UX review 2.2, 2.3): the account's credit it
 * uses (left from a downgrade, or the unused time of the plan being changed) and the promo code's
 * discount, each null when none. The price before them is `amount + creditApplied + discount`:
 * the plan's monthly price for a renewal or a first payment, the new plan's remaining time for a
 * plan change. Always sent by this API (optional in the type for clients' fixtures).
 */
const AmountReasons = {
  creditApplied: Money.nullable().optional(),
  discount: Money.nullable().optional(),
};

export const PaymentProviderId = z.enum(PAYMENT_PROVIDERS).meta({ id: "PaymentProviderId" });
export type PaymentProviderId = z.output<typeof PaymentProviderId>;

export const MembershipStatus = z.enum(MEMBERSHIP_STATUSES).meta({ id: "MembershipStatus" });
export type MembershipStatus = z.output<typeof MembershipStatus>;

/**
 * The membership projection (§5.2): what the provider says, as of the last verified event or
 * reconciliation. Never changed by the client or by an optimistic write (principle 3).
 */
export const MembershipState = z
  .object({
    status: MembershipStatus,
    /** The plan of the current (or last) subscription; null while `none`. */
    planId: PlanId.nullable(),
    /** The member asked to end it: entitled until `currentPeriodEnd` (trial: `trialEndsAt`). */
    cancelAtPeriodEnd: z.boolean(),
    trialEndsAt: IsoDateTime.nullable(),
    currentPeriodEnd: IsoDateTime.nullable(),
    /** `past_due` only: when grace runs out and the membership is suspended (§5.2). */
    graceEndsAt: IsoDateTime.nullable(),
    suspendedReason: z.enum(SUSPENDED_REASONS).nullable(),
    /** Null while `none`. */
    provider: PaymentProviderId.nullable(),
    /**
     * The next invoice as the payment provider previews it: when it is due (the trial's or the
     * period's end) and what it will charge (the plan's price less live discounts and credit,
     * e.g. after a downgrade). Null when there is none: cancelling, ended, unpaid, suspended, no
     * membership, milestone 1's mock membership. Always sent by this API (optional in the type
     * for clients' fixtures).
     */
    nextInvoice: z
      .object({ at: IsoDateTime, amount: Money, ...AmountReasons })
      .nullable()
      .optional(),
  })
  .meta({ id: "MembershipState" });
export type MembershipState = z.output<typeof MembershipState>;

/**
 * Whether the account may play right now (§5.2: one function of state, period end, grace and
 * plan features, which playback, browse gates and the account page all call).
 */
export const Entitlement = z
  .object({
    entitled: z.boolean(),
    reason: z.enum(ENTITLEMENT_REASONS),
    /** Concurrent streams allowed now (0 when not entitled). */
    maxStreams: z.number().int().nonnegative(),
    /** Tallest rendition allowed now; null when not entitled. */
    maxVideoHeight: z.number().int().positive().nullable(),
    /** When the entitlement ends unless something changes (period end, grace end); null if open. */
    until: IsoDateTime.nullable(),
  })
  .meta({ id: "Entitlement" });
export type Entitlement = z.output<typeof Entitlement>;

// --- Provider configuration for the web ------------------------------------------------------

/**
 * What the browser needs to render the provider's payment form (§5.6): Stripe's publishable key
 * (never a secret), or the fake provider's own form (`/_pay/*`, local modes); `none` when the
 * deployment has no payment provider (memberships cannot be started: checkouts answer
 * `payments_not_configured`).
 */
export const BillingConfig = z
  .discriminatedUnion("provider", [
    z.object({ provider: z.literal("stripe"), publishableKey: z.string().regex(/^pk_/) }),
    z.object({ provider: z.literal("fake"), formUrl: ResourceUrl }),
    z.object({ provider: z.literal("none") }),
  ])
  .meta({ id: "BillingConfig" });
export type BillingConfig = z.output<typeof BillingConfig>;

// --- Promotions -------------------------------------------------------------------------------

/** A promo code as members type it. */
export const PromotionCode = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Enter a valid promo code");

export const AppliedPromotion = z
  .object({
    code: z.string(),
    description: z.string().nullable(),
    /** Exactly one of `percentOff` and `amountOff` is set. */
    percentOff: z.number().positive().max(100).nullable(),
    amountOff: Money.nullable(),
    duration: z.enum(["once", "repeating", "forever"]),
    durationInMonths: z.number().int().positive().nullable(),
  })
  .meta({ id: "AppliedPromotion" });
export type AppliedPromotion = z.output<typeof AppliedPromotion>;

export const ValidatePromotionBody = z
  .object({ code: PromotionCode, planId: PlanId })
  .meta({ id: "ValidatePromotionBody" });
export type ValidatePromotionBody = z.input<typeof ValidatePromotionBody>;

/** A code that can be applied, and what it does to the plan's price. */
export const PromotionQuote = z
  .object({
    promotion: AppliedPromotion,
    price: Money,
    discountedPrice: Money,
  })
  .meta({ id: "PromotionQuote" });
export type PromotionQuote = z.output<typeof PromotionQuote>;

// --- Checkout (§5.1, §5.4: the two-step flow) ------------------------------------------------

export const StartCheckoutBody = z
  .object({ planId: PlanId, promotionCode: PromotionCode.optional() })
  .meta({ id: "StartCheckoutBody" });
export type StartCheckoutBody = z.input<typeof StartCheckoutBody>;

/**
 * One attempt to start (or restart) a membership. The browser confirms `clientSecret` with the
 * provider's form at `requires_setup` (card first, so the server can check the card's
 * fingerprint against `trial_fingerprints`) and again at `requires_payment` (no trial: the first
 * payment, including a 3-D Secure challenge). Then the provider's event activates the
 * membership; the web polls this or `GET /account` meanwhile.
 */
export const Checkout = z
  .object({
    id: Id,
    planId: PlanId,
    status: z.enum(CHECKOUT_STATUSES),
    /** Set while the browser has something to confirm; null otherwise. Never logged. */
    clientSecret: z.string().nullable(),
    /** The trial this checkout grants, once known (after the card is confirmed); else null. */
    trial: z
      .object({ days: z.number().int().positive(), endsAt: IsoDateTime.nullable() })
      .nullable(),
    /**
     * What is charged now (0 with a trial), once known: from the start for an account that can
     * no longer have a trial (`OpenCheckout.trialEligible` false: the first invoice as the
     * provider previews it, the account's credit and the code applied), otherwise once the card
     * is confirmed. `creditApplied` and `discount` explain it (null while it is null).
     */
    amountDue: Money.nullable(),
    ...AmountReasons,
    promotion: AppliedPromotion.nullable(),
    /**
     * What became of `promotion`: null without a code; `pending` until the card is confirmed
     * (the trial is decided then); `applied` to the first payment; `not_applied_trial` when the
     * checkout grants a trial: a code is never spent on a payment of nothing, so it was neither
     * applied nor redeemed and can still be used. Always sent by this API (optional in the type
     * for clients' fixtures).
     */
    promotionOutcome: z.enum(PROMOTION_OUTCOMES).nullable().optional(),
    /** Why a `failed` checkout failed. */
    failureReason: z.enum(PAYMENT_DECLINE_REASONS).nullable(),
    createdAt: IsoDateTime,
    expiresAt: IsoDateTime,
  })
  .meta({ id: "Checkout" });
export type Checkout = z.output<typeof Checkout>;

/**
 * `GET /billing/checkout`: the account's checkout in progress (`requires_setup`,
 * `requires_payment` or `processing`, not expired), or null. What the member needs to continue
 * on any device: plan, promotion, state, trial, amount. Its `clientSecret` is always null here;
 * `GET /billing/checkout/:id` answers it to the session that continues.
 */
export const OpenCheckout = z
  .object({
    checkout: Checkout.nullable(),
    /**
     * Whether this account can still have a free trial (UX review 2.6): true until it has had
     * one, so the plan's `trial` is what it gets, unless the card it confirms already had a trial
     * on another account (then the checkout asks for the first payment: `requires_payment`).
     * False once the account had a trial, and when no trial is offered (no payment provider).
     * Always sent by this API (optional in the type for clients' fixtures).
     */
    trialEligible: z.boolean().optional(),
  })
  .meta({ id: "OpenCheckout" });
export type OpenCheckout = z.output<typeof OpenCheckout>;

// --- Plan changes (§12: upgrade and downgrade with the previewed proration) -------------------

export const PlanChangePreviewBody = z
  .object({ planId: PlanId })
  .meta({ id: "PlanChangePreviewBody" });
export type PlanChangePreviewBody = z.input<typeof PlanChangePreviewBody>;

export const PlanChangePreview = z
  .object({
    planId: PlanId,
    /** Charged when the change is applied (0 when the change produces a credit). */
    amountDue: Money,
    /**
     * Why `amountDue` is below the new plan's remaining time: the credit for the current plan's
     * unused time (and any credit the account had), and a discount. The remaining time on the
     * new plan is `amountDue + creditApplied + discount`.
     */
    ...AmountReasons,
    /** Credit left on the account after the change (0 when none): it pays `nextRenewal`. */
    credit: Money,
    /** The provider's own line items, in its words: for detail only, never the summary. */
    lines: z.array(z.object({ description: z.string(), amount: SignedMoney })),
    /** When the new plan takes effect. */
    effectiveAt: IsoDateTime,
    /** The first renewal on the new plan, with the credit it uses (`creditApplied`). */
    nextRenewal: z.object({ at: IsoDateTime, amount: Money, ...AmountReasons }).nullable(),
    /** Pass to `PUT /account/subscription` to apply exactly this preview. Opaque. */
    previewToken: z.string().min(1),
    expiresAt: IsoDateTime,
  })
  .meta({ id: "PlanChangePreview" });
export type PlanChangePreview = z.output<typeof PlanChangePreview>;

// --- Payment method (§5.4: changing the card) -------------------------------------------------

/**
 * Replacing the card: the browser confirms `clientSecret` with the provider's form; the
 * provider's event makes it the default server-side (the browser decides nothing), and a
 * `past_due` membership's open invoice is paid explicitly (docs/STRIPE.md §7).
 */
export const PaymentMethodSetup = z
  .object({
    id: Id,
    status: z.enum(PAYMENT_METHOD_SETUP_STATUSES),
    clientSecret: z.string().nullable(),
    /**
     * Why a `failed` card change failed, in the words a checkout's decline uses; null
     * otherwise. Always sent by this API (optional in the type for clients' fixtures).
     */
    failureReason: z.enum(PAYMENT_DECLINE_REASONS).nullable().optional(),
    createdAt: IsoDateTime,
  })
  .meta({ id: "PaymentMethodSetup" });
export type PaymentMethodSetup = z.output<typeof PaymentMethodSetup>;

// --- Invoices ---------------------------------------------------------------------------------

export const Invoice = z
  .object({
    id: Id,
    /** The provider's human-readable number, once finalised. */
    number: z.string().nullable(),
    status: z.enum(INVOICE_STATUSES),
    description: z.string().nullable(),
    /**
     * After discounts. Negative: a credit to the account (a downgrade's unused time), not a
     * payment: nothing was paid (`amountPaid` 0) and later invoices use it (`creditApplied`).
     */
    total: SignedMoney,
    /** The account credit this invoice used, and its discount (null when none). */
    ...AmountReasons,
    amountPaid: Money,
    amountDue: Money,
    amountRefunded: Money,
    periodStart: IsoDateTime.nullable(),
    periodEnd: IsoDateTime.nullable(),
    createdAt: IsoDateTime,
    paidAt: IsoDateTime.nullable(),
    /** The provider's hosted invoice and PDF, when it offers them. */
    hostedUrl: ResourceUrl.nullable(),
    pdfUrl: ResourceUrl.nullable(),
  })
  .meta({ id: "Invoice" });
export type Invoice = z.output<typeof Invoice>;

export const InvoicePage = page(Invoice).meta({ id: "InvoicePage" });
export type InvoicePage = z.output<typeof InvoicePage>;

// --- Webhooks (§5.3) --------------------------------------------------------------------------

export const PaymentWebhookParams = z.object({ provider: PaymentProviderId });

/** 2xx as soon as the event id is recorded and queued; processing is a job. */
export const WebhookAck = z
  .object({
    received: z.literal(true),
    /** True when this event id was already recorded (a redelivery): nothing new was queued. */
    duplicate: z.boolean(),
  })
  .meta({ id: "WebhookAck" });
export type WebhookAck = z.output<typeof WebhookAck>;

// --- Diagnostics (non-production) -------------------------------------------------------------

/** Move the fake provider's clock of the signed-in account's customer forward (§5.5). */
export const AdvanceBillingClockBody = z
  .object({
    seconds: z
      .number()
      .int()
      .positive()
      .max(400 * 24 * 60 * 60),
  })
  .meta({ id: "AdvanceBillingClockBody" });
export type AdvanceBillingClockBody = z.input<typeof AdvanceBillingClockBody>;

export const BillingClock = z.object({ now: IsoDateTime }).meta({ id: "BillingClock" });
export type BillingClock = z.output<typeof BillingClock>;
