/**
 * Mock of milestone 2's billing (docs/BACKEND.md §3, "Billing"): the membership projection and
 * entitlement, checkouts confirmed in a stand-in for the provider's hosted form, plan changes
 * previewed and applied exactly, cancel and resume, card replacement and invoices. The provider's
 * form is a mock-only page of the app (`/mock-pay`, features/member/billing/MockProviderPage.tsx),
 * which calls `mockProviderConfirm` below; the real fake provider's form lives under `/_pay` and
 * needs the API.
 *
 * Test cards in mock mode: any card works, except a number ending in `0002` (declined), `9995`
 * (insufficient funds), `0069` (expired) and `3155` (asks for a challenge). One trial per account
 * and per card number. `WEBFLIX50` is a promo code (50% off the first payment).
 *
 * `?mock-membership=trialing|active|cancelling|past_due|suspended|canceled|none|incomplete` puts
 * the signed-in account's membership in that state on load (screens and screenshots).
 */
import type {
  AuthenticatedSession,
  Checkout,
  Entitlement,
  ErrorCode,
  Invoice,
  Membership,
  MembershipState,
  PaymentMethod,
  Plan,
  PlanChangePreview,
  PlanId,
  RouteInput,
  RouteOutput,
  Routes,
} from "@webflix/contracts";
import { iso, PLANS } from "./catalog.ts";
import type { MockState } from "./state.ts";

const DAY_MS = 86_400_000;
const PERIOD_MS = 30 * DAY_MS;
const TRIAL_DAYS = 7;
const PROMO = { code: "WEBFLIX50", percentOff: 50 } as const;
const MEMBERSHIP_PARAM = "mock-membership";

type DeclineReason = "card_declined" | "insufficient_funds" | "expired_card";

export interface MockCheckoutRecord {
  id: string;
  planId: PlanId;
  status: Checkout["status"];
  setupSecret: string;
  setupState: "open" | "challenge" | "succeeded" | "failed";
  setupFailure: DeclineReason | null;
  card: string | null;
  paymentSecret: string | null;
  trial: boolean | null;
  promotionCode: string | null;
  amountDueMinor: number | null;
  failureReason: DeclineReason | null;
  createdAt: string;
}

export interface MockBillingState {
  membership: MembershipState;
  trialUsed: boolean;
  trialCards: string[];
  checkouts: MockCheckoutRecord[];
  setups: Array<{
    id: string;
    secret: string;
    state: "open" | "challenge" | "succeeded" | "failed";
    failureReason?: DeclineReason | null;
    createdAt: string;
  }>;
  invoices: Invoice[];
}

/** The live state the mock API answers from (so the provider page changes the same object). */
let live: MockState | null = null;
let scenarioApplied = false;

const random = () => Math.random().toString(36).slice(2, 10);

function planOf(id: PlanId | null): Plan {
  const plan = PLANS.find((candidate) => candidate.id === id) ?? PLANS[1] ?? PLANS[0];
  if (!plan) throw new Error("No plans");
  return plan;
}

function invoice(
  description: string,
  totalMinor: number,
  options: { paid?: boolean; createdAt?: string; periodDays?: number } = {},
): Invoice {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const paid = options.paid ?? true;
  const start = Date.parse(createdAt);
  return {
    id: `in-${random()}`,
    number: `MOCK-${String(Math.floor(Math.random() * 900000) + 100000)}`,
    status: paid ? "paid" : "open",
    description,
    total: { amountMinor: totalMinor, currency: "USD" },
    amountPaid: { amountMinor: paid ? Math.max(0, totalMinor) : 0, currency: "USD" },
    amountDue: { amountMinor: paid ? 0 : totalMinor, currency: "USD" },
    amountRefunded: { amountMinor: 0, currency: "USD" },
    periodStart: createdAt,
    periodEnd: new Date(start + (options.periodDays ?? 30) * DAY_MS).toISOString(),
    createdAt,
    paidAt: paid ? createdAt : null,
    hostedUrl: null,
    pdfUrl: null,
  };
}

const NONE: MembershipState = {
  status: "none",
  planId: null,
  cancelAtPeriodEnd: false,
  trialEndsAt: null,
  currentPeriodEnd: null,
  graceEndsAt: null,
  suspendedReason: null,
  provider: null,
};

/** The seeded account's membership: a running, paid one at the (mock) provider. */
function seededBilling(state: MockState): MockBillingState {
  const legacy = state.subscriptionStatus;
  const price = planOf(state.planId).monthlyPrice.amountMinor;
  return {
    membership: {
      status: legacy === "ended" ? "canceled" : "active",
      planId: state.planId,
      cancelAtPeriodEnd: legacy === "canceling",
      trialEndsAt: null,
      currentPeriodEnd: iso(-18 * DAY_MS),
      graceEndsAt: null,
      suspendedReason: null,
      provider: "fake",
    },
    trialUsed: true,
    trialCards: [],
    checkouts: [],
    setups: [],
    invoices: [
      invoice("Membership renewal", price, { createdAt: iso(12 * DAY_MS) }),
      invoice("Membership renewal", price, { createdAt: iso(42 * DAY_MS) }),
      invoice("Membership", 0, { createdAt: iso(49 * DAY_MS), periodDays: TRIAL_DAYS }),
    ],
  };
}

export function billingOf(state: MockState): MockBillingState {
  live = state;
  state.billing ??= seededBilling(state);
  if (!scenarioApplied) {
    scenarioApplied = true;
    const scenario =
      typeof location === "undefined"
        ? null
        : new URLSearchParams(location.search).get(MEMBERSHIP_PARAM);
    if (scenario) applyScenario(state, state.billing, scenario);
  }
  return state.billing;
}

/** Put the account's membership in a state (tests; the `?mock-membership=` parameter). */
export function setMockMembership(state: MockState, scenario: string): void {
  state.billing ??= seededBilling(state);
  applyScenario(state, state.billing, scenario);
}

function applyScenario(state: MockState, billing: MockBillingState, scenario: string): void {
  const planId = state.planId;
  const base: MembershipState = { ...NONE, planId, provider: "fake" };
  switch (scenario) {
    case "none":
      billing.membership = NONE;
      break;
    case "incomplete":
      billing.membership = { ...base, status: "incomplete" };
      break;
    case "trialing":
      billing.membership = {
        ...base,
        status: "trialing",
        trialEndsAt: iso(-5 * DAY_MS),
        currentPeriodEnd: iso(-5 * DAY_MS),
      };
      break;
    case "active":
      billing.membership = { ...base, status: "active", currentPeriodEnd: iso(-18 * DAY_MS) };
      break;
    case "cancelling":
      billing.membership = {
        ...base,
        status: "active",
        cancelAtPeriodEnd: true,
        currentPeriodEnd: iso(-18 * DAY_MS),
      };
      break;
    case "past_due":
      billing.membership = {
        ...base,
        status: "past_due",
        currentPeriodEnd: iso(-29 * DAY_MS),
        graceEndsAt: iso(-6 * DAY_MS),
      };
      billing.invoices.unshift(
        invoice("Membership renewal", planOf(planId).monthlyPrice.amountMinor, { paid: false }),
      );
      break;
    case "suspended":
      billing.membership = {
        ...base,
        status: "suspended",
        currentPeriodEnd: iso(-22 * DAY_MS),
        suspendedReason: "grace_expired",
      };
      break;
    case "canceled":
      billing.membership = { ...base, status: "canceled", currentPeriodEnd: iso(3 * DAY_MS) };
      break;
    default:
      return;
  }
  syncLegacy(state, billing);
}

/** Milestone 1's fields follow the projection, so older screens agree with it. */
function syncLegacy(state: MockState, billing: MockBillingState): void {
  const m = billing.membership;
  if (m.planId) state.planId = m.planId;
  state.subscriptionStatus = !entitlementOf(m).entitled
    ? "ended"
    : m.cancelAtPeriodEnd
      ? "canceling"
      : "active";
}

export function entitlementOf(m: MembershipState): Entitlement {
  const entitled = m.status === "trialing" || m.status === "active" || m.status === "past_due";
  const plan = planOf(m.planId);
  return {
    entitled,
    reason: entitled
      ? "entitled"
      : m.status === "none"
        ? "no_membership"
        : m.status === "incomplete"
          ? "payment_pending"
          : m.status === "suspended"
            ? "suspended"
            : "ended",
    maxStreams: entitled ? plan.maxStreams : 0,
    maxVideoHeight: entitled ? plan.maxVideoHeight : null,
    until:
      m.status === "past_due"
        ? m.graceEndsAt
        : entitled && m.cancelAtPeriodEnd
          ? (m.trialEndsAt ?? m.currentPeriodEnd)
          : null,
  };
}

/** `membership` and `entitlement` of the session and the account. */
export function billingSessionFields(
  state: MockState,
): Pick<AuthenticatedSession, "membership" | "entitlement"> {
  const { membership } = billingOf(state);
  return {
    membership: { ...membership, nextInvoice: nextInvoiceOf(membership) },
    entitlement: entitlementOf(membership),
  };
}

/** The next bill, as the server previews it: none while cancelling, ended, unpaid or on hold. */
function nextInvoiceOf(m: MembershipState): MembershipState["nextInvoice"] {
  if (m.cancelAtPeriodEnd || m.provider === null) return null;
  const at =
    m.status === "trialing" ? m.trialEndsAt : m.status === "active" ? m.currentPeriodEnd : null;
  return at ? { at, amount: planOf(m.planId).monthlyPrice } : null;
}

/** A new account (sign-up without payment): no membership, no card. */
export function resetBillingForNewAccount(state: MockState): void {
  state.billing = {
    membership: NONE,
    trialUsed: false,
    trialCards: state.billing?.trialCards ?? [],
    checkouts: [],
    setups: [],
    invoices: [],
  };
  delete state.paymentMethod;
  state.subscriptionStatus = "ended";
  scenarioApplied = true;
}

/** The card on file: absent until a checkout or card change confirmed one. */
export function billingPaymentMethod(
  state: MockState,
  seeded: PaymentMethod,
): PaymentMethod | null {
  const billing = billingOf(state);
  if (state.paymentMethod) return state.paymentMethod;
  return billing.membership.status === "none" && billing.invoices.length === 0 ? null : seeded;
}

function cardFrom(card: string | null): PaymentMethod {
  const digits = (card ?? "").replace(/\D/g, "");
  return {
    brand: digits.startsWith("5") ? "mastercard" : "visa",
    last4: digits.length >= 4 ? digits.slice(-4) : "4242",
    expMonth: 12,
    expYear: new Date().getFullYear() + 3,
  };
}

function declineOf(card: string | null): DeclineReason | null {
  const digits = (card ?? "").replace(/\D/g, "");
  if (digits.endsWith("0002")) return "card_declined";
  if (digits.endsWith("9995")) return "insufficient_funds";
  if (digits.endsWith("0069")) return "expired_card";
  return null;
}

const challenges = (card: string | null) => (card ?? "").replace(/\D/g, "").endsWith("3155");

/**
 * What the mock provider's form does with a client secret: confirm a setup (a card) or a first
 * payment, ask for a challenge, or decline. Changes the live mock state and saves it.
 */
export function mockProviderConfirm(
  secret: string,
  input: { card?: string | null; challenge?: "complete" | "fail" },
  save: (state: MockState) => void,
): { status: "succeeded" | "requires_action" | "failed"; reason?: DeclineReason } {
  const state = live;
  if (!state) return { status: "failed", reason: "card_declined" };
  const billing = billingOf(state);
  const checkout = billing.checkouts.find(
    (candidate) => candidate.setupSecret === secret || candidate.paymentSecret === secret,
  );
  const setup = billing.setups.find((candidate) => candidate.secret === secret);
  const outcome = (() => {
    if (checkout && checkout.paymentSecret === secret) {
      checkout.status = "complete";
      checkout.paymentSecret = null;
      activate(state, billing, checkout);
      return { status: "succeeded" as const };
    }
    const target = checkout ?? setup;
    if (!target) return { status: "failed" as const, reason: "card_declined" as const };
    const card = input.card ?? (checkout ? checkout.card : null);
    const currentState = checkout ? checkout.setupState : (setup?.state ?? "open");
    if (input.challenge === "fail") {
      if (checkout) {
        checkout.setupState = "failed";
        checkout.setupFailure = "card_declined";
      } else if (setup) setup.state = "failed";
      return { status: "failed" as const, reason: "card_declined" as const };
    }
    if (currentState !== "challenge" || input.challenge !== "complete") {
      const declined = declineOf(card);
      if (declined) {
        if (checkout) {
          checkout.setupState = "failed";
          checkout.setupFailure = declined;
        } else if (setup) {
          setup.state = "failed";
          setup.failureReason = declined;
        }
        return { status: "failed" as const, reason: declined };
      }
      if (challenges(card)) {
        if (checkout) {
          checkout.setupState = "challenge";
          checkout.card = card;
        } else if (setup) setup.state = "challenge";
        return { status: "requires_action" as const };
      }
    }
    if (checkout) {
      checkout.setupState = "succeeded";
      checkout.card = card;
    } else if (setup) {
      setup.state = "succeeded";
      state.paymentMethod = cardFrom(card);
      recover(state, billing);
    }
    return { status: "succeeded" as const };
  })();
  save(state);
  return outcome;
}

/** What a client secret is for, as the mock provider's page shows it. */
export function mockDescribeSecret(
  secret: string,
): { kind: "setup" | "payment"; amountMinor: number | null; done: boolean } | null {
  if (!live) return null;
  const billing = billingOf(live);
  const checkout = billing.checkouts.find(
    (candidate) => candidate.setupSecret === secret || candidate.paymentSecret === secret,
  );
  if (checkout?.paymentSecret === secret) {
    return { kind: "payment", amountMinor: checkout.amountDueMinor, done: false };
  }
  if (checkout)
    return { kind: "setup", amountMinor: null, done: checkout.setupState === "succeeded" };
  const setup = billing.setups.find((candidate) => candidate.secret === secret);
  return setup ? { kind: "setup", amountMinor: null, done: setup.state === "succeeded" } : null;
}

function activate(state: MockState, billing: MockBillingState, checkout: MockCheckoutRecord) {
  const now = Date.now();
  const plan = planOf(checkout.planId);
  state.paymentMethod = cardFrom(checkout.card);
  if (checkout.trial) {
    billing.trialUsed = true;
    if (checkout.card) billing.trialCards.push(checkout.card);
    const end = new Date(now + TRIAL_DAYS * DAY_MS).toISOString();
    billing.membership = {
      ...NONE,
      status: "trialing",
      planId: checkout.planId,
      trialEndsAt: end,
      currentPeriodEnd: end,
      provider: "fake",
    };
    billing.invoices.unshift(invoice("Membership", 0, { periodDays: TRIAL_DAYS }));
  } else {
    billing.membership = {
      ...NONE,
      status: "active",
      planId: checkout.planId,
      currentPeriodEnd: new Date(now + PERIOD_MS).toISOString(),
      provider: "fake",
    };
    billing.invoices.unshift(
      invoice("Membership", checkout.amountDueMinor ?? plan.monthlyPrice.amountMinor),
    );
  }
  syncLegacy(state, billing);
}

/** A card change on an unpaid membership pays what is due: it is active again. */
function recover(state: MockState, billing: MockBillingState) {
  const m = billing.membership;
  if (m.status !== "past_due" && m.status !== "suspended") return;
  for (const open of billing.invoices.filter((item) => item.status === "open")) {
    open.status = "paid";
    open.amountPaid = open.amountDue;
    open.amountDue = { ...open.amountDue, amountMinor: 0 };
    open.paidAt = new Date().toISOString();
  }
  billing.membership = {
    ...m,
    status: "active",
    graceEndsAt: null,
    suspendedReason: null,
    currentPeriodEnd: new Date(Date.now() + PERIOD_MS).toISOString(),
  };
  syncLegacy(state, billing);
}

function view(record: MockCheckoutRecord): Checkout {
  const plan = planOf(record.planId);
  const promotion = record.promotionCode
    ? {
        code: record.promotionCode,
        description: "50% off",
        percentOff: PROMO.percentOff,
        amountOff: null,
        duration: "once" as const,
        durationInMonths: null,
      }
    : null;
  return {
    id: record.id,
    planId: record.planId,
    status: record.status,
    clientSecret:
      record.status === "requires_setup"
        ? record.setupSecret
        : record.status === "requires_payment"
          ? record.paymentSecret
          : null,
    trial:
      record.trial === null
        ? null
        : record.trial
          ? {
              days: TRIAL_DAYS,
              endsAt:
                record.status === "complete"
                  ? new Date(Date.now() + TRIAL_DAYS * DAY_MS).toISOString()
                  : null,
            }
          : null,
    amountDue:
      record.amountDueMinor === null
        ? null
        : { amountMinor: record.amountDueMinor, currency: plan.monthlyPrice.currency },
    promotion,
    promotionOutcome: !record.promotionCode
      ? null
      : record.trial === null
        ? "pending"
        : record.trial
          ? "not_applied_trial"
          : "applied",
    failureReason: record.failureReason,
    createdAt: record.createdAt,
    expiresAt: new Date(Date.parse(record.createdAt) + DAY_MS).toISOString(),
  };
}

function discounted(amountMinor: number, promotionCode: string | null): number {
  return promotionCode
    ? amountMinor - Math.round((amountMinor * PROMO.percentOff) / 100)
    : amountMinor;
}

export interface BillingHandlerDeps {
  problem: (code: ErrorCode, extensions?: Record<string, unknown>) => Error;
  requireAccount: (state: MockState) => void;
  requireAccountHolder: (state: MockState) => void;
  requireNotDemo: (state: MockState) => void;
  /** Whether the active profile may start a membership (not kids, not a lowered ceiling). */
  unrestricted: (state: MockState) => boolean;
  session: (state: MockState) => AuthenticatedSession;
  persist: (state: MockState) => void;
}

type Handlers = {
  [K in keyof Routes]?: (
    input: RouteInput<Routes[K]>,
    state: MockState,
  ) => RouteOutput<Routes[K]> | Promise<RouteOutput<Routes[K]>>;
};

/** The billing routes, answered from `MockState.billing`. */
export function createBillingHandlers(deps: BillingHandlerDeps): Handlers {
  const { problem } = deps;
  const membershipView = (state: MockState): Membership => {
    const session = deps.session(state);
    if (!session.subscription || !session.plan) {
      throw problem("subscription_required", {
        subscriptionStatus: "ended",
        membershipStatus: "none",
      });
    }
    return { subscription: session.subscription, plan: session.plan };
  };
  const promotionCheck = (code: string | undefined) => {
    if (code === undefined) return null;
    if (code.toUpperCase() !== PROMO.code) {
      throw problem("promotion_code_invalid", { promotionReason: "unknown" });
    }
    return PROMO.code;
  };
  const requireRunning = (billing: MockBillingState) => {
    const m = billing.membership;
    if (m.provider === null || m.status === "none") {
      throw problem("subscription_required", {
        subscriptionStatus: "ended",
        membershipStatus: m.status,
      });
    }
    return m;
  };

  return {
    listPlans: () => ({ items: PLANS.map((plan) => ({ ...plan, trial: { days: TRIAL_DAYS } })) }),

    getBillingConfig: () => ({ provider: "fake", formUrl: "/mock-pay" }),

    validatePromotion: ({ body }, state) => {
      deps.requireAccount(state);
      const code = promotionCheck(body.code);
      const price = planOf(body.planId).monthlyPrice;
      return {
        promotion: {
          code: code ?? PROMO.code,
          description: "50% off",
          percentOff: PROMO.percentOff,
          amountOff: null,
          duration: "once",
          durationInMonths: null,
        },
        price,
        discountedPrice: { ...price, amountMinor: discounted(price.amountMinor, code) },
      };
    },

    startCheckout: ({ body }, state) => {
      deps.requireAccount(state);
      if (!deps.unrestricted(state)) throw problem("unrestricted_profile_required");
      deps.requireNotDemo(state);
      const billing = billingOf(state);
      if (entitlementOf(billing.membership).entitled) {
        throw problem("checkout_state_conflict", {
          detail: "This account already has a membership.",
        });
      }
      if (["past_due", "suspended"].includes(billing.membership.status)) {
        throw problem("checkout_state_conflict", {
          detail: "Replace the card to restore this membership.",
        });
      }
      const code = promotionCheck(body.promotionCode);
      const open = billing.checkouts.find((candidate) =>
        ["requires_setup", "requires_payment", "processing"].includes(candidate.status),
      );
      if (open?.status === "requires_setup") {
        open.planId = body.planId;
        open.promotionCode = code;
        deps.persist(state);
        return view(open);
      }
      if (open && open.planId === body.planId && open.promotionCode === code) return view(open);
      if (open) {
        open.status = "expired";
        billing.membership = NONE;
        syncLegacy(state, billing);
      }
      const record: MockCheckoutRecord = {
        id: `co-${random()}`,
        planId: body.planId,
        status: "requires_setup",
        setupSecret: `seti_mock_${random()}`,
        setupState: "open",
        setupFailure: null,
        card: null,
        paymentSecret: null,
        trial: null,
        promotionCode: code,
        amountDueMinor: null,
        failureReason: null,
        createdAt: new Date().toISOString(),
      };
      billing.checkouts.unshift(record);
      deps.persist(state);
      return view(record);
    },

    getCheckout: ({ params }, state) => {
      deps.requireAccount(state);
      const record = billingOf(state).checkouts.find((candidate) => candidate.id === params.id);
      if (!record) throw problem("not_found");
      return view(record);
    },

    confirmCheckout: ({ params }, state) => {
      deps.requireAccount(state);
      const billing = billingOf(state);
      const record = billing.checkouts.find((candidate) => candidate.id === params.id);
      if (!record) throw problem("not_found");
      if (record.status === "failed" || record.status === "expired") {
        throw problem("checkout_state_conflict", { detail: "Start a new checkout." });
      }
      if (record.status !== "requires_setup") return view(record);
      if (record.setupState === "failed") {
        const reason = record.setupFailure ?? "card_declined";
        record.setupSecret = `seti_mock_${random()}`;
        record.setupState = "open";
        record.failureReason = reason;
        deps.persist(state);
        throw problem("payment_declined", { declineReason: reason });
      }
      if (record.setupState !== "succeeded") {
        throw problem("checkout_state_conflict", {
          detail: "Confirm the card with the payment form first.",
        });
      }
      const card = record.card ?? "visa";
      const trial = !billing.trialUsed && !billing.trialCards.includes(card);
      record.trial = trial;
      record.failureReason = null;
      if (trial) {
        record.amountDueMinor = 0;
        record.status = "complete";
        activate(state, billing, record);
      } else {
        record.amountDueMinor = discounted(
          planOf(record.planId).monthlyPrice.amountMinor,
          record.promotionCode,
        );
        record.status = "requires_payment";
        record.paymentSecret = `in_mock_${random()}`;
        billing.membership = {
          ...NONE,
          status: "incomplete",
          planId: record.planId,
          provider: "fake",
        };
        syncLegacy(state, billing);
      }
      deps.persist(state);
      return view(record);
    },

    getAccount: (_input, state) => {
      deps.requireAccountHolder(state);
      const session = deps.session(state);
      return {
        account: session.account,
        subscription: session.subscription,
        plan: session.plan,
        paymentMethod: billingPaymentMethod(state, {
          brand: "visa",
          last4: "4242",
          expMonth: 8,
          expYear: 2029,
        }),
        ...billingSessionFields(state),
      };
    },

    previewPlanChange: ({ body }, state) => {
      deps.requireAccountHolder(state);
      deps.requireNotDemo(state);
      const billing = billingOf(state);
      const m = requireRunning(billing);
      if (m.planId === body.planId) {
        throw problem("checkout_state_conflict", { detail: "That is already the plan." });
      }
      const current = planOf(m.planId);
      const next = planOf(body.planId);
      const trialing = m.status === "trialing";
      const end = m.currentPeriodEnd ?? new Date(Date.now() + PERIOD_MS).toISOString();
      const fraction = trialing
        ? 0
        : Math.max(0, Math.min(1, (Date.parse(end) - Date.now()) / PERIOD_MS));
      const unused = -Math.round(current.monthlyPrice.amountMinor * fraction);
      const remaining = Math.round(next.monthlyPrice.amountMinor * fraction);
      const total = unused + remaining;
      const amountDue = Math.max(0, total);
      const credit = Math.max(0, -total);
      const money = (amountMinor: number) => ({ amountMinor, currency: "USD" });
      const preview: PlanChangePreview = {
        planId: body.planId,
        amountDue: money(amountDue),
        credit: money(credit),
        lines: trialing
          ? []
          : [
              { description: `Unused time on Webflix ${current.name}`, amount: money(unused) },
              { description: `Remaining time on Webflix ${next.name}`, amount: money(remaining) },
            ],
        effectiveAt: new Date().toISOString(),
        nextRenewal: {
          at: end,
          amount: money(Math.max(0, next.monthlyPrice.amountMinor - credit)),
        },
        previewToken: `preview.${body.planId}.${random()}`,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      };
      return preview;
    },

    changePlan: ({ body }, state) => {
      deps.requireAccountHolder(state);
      deps.requireNotDemo(state);
      const billing = billingOf(state);
      const m = requireRunning(billing);
      if (body.previewToken && !body.previewToken.startsWith(`preview.${body.planId}.`)) {
        throw problem("checkout_state_conflict", { detail: "This preview no longer applies." });
      }
      billing.membership = { ...m, planId: body.planId };
      billing.invoices.unshift(invoice(`Plan change to ${planOf(body.planId).name}`, 0));
      syncLegacy(state, billing);
      deps.persist(state);
      return membershipView(state);
    },

    cancelMembership: (_input, state) => {
      deps.requireAccountHolder(state);
      deps.requireNotDemo(state);
      const billing = billingOf(state);
      const m = requireRunning(billing);
      billing.membership = { ...m, cancelAtPeriodEnd: true };
      syncLegacy(state, billing);
      deps.persist(state);
      return membershipView(state);
    },

    resumeMembership: (_input, state) => {
      deps.requireAccountHolder(state);
      const billing = billingOf(state);
      const m = requireRunning(billing);
      if (!entitlementOf(m).entitled) {
        throw problem("checkout_state_conflict", { detail: "This membership has ended." });
      }
      billing.membership = { ...m, cancelAtPeriodEnd: false };
      syncLegacy(state, billing);
      deps.persist(state);
      return membershipView(state);
    },

    setupPaymentMethod: (_input, state) => {
      deps.requireAccountHolder(state);
      deps.requireNotDemo(state);
      const billing = billingOf(state);
      requireRunning(billing);
      const setup = {
        id: `pms-${random()}`,
        secret: `seti_mock_${random()}`,
        state: "open" as const,
        createdAt: new Date().toISOString(),
      };
      billing.setups.unshift(setup);
      deps.persist(state);
      return {
        id: setup.id,
        status: "requires_confirmation",
        clientSecret: setup.secret,
        createdAt: setup.createdAt,
      };
    },

    getPaymentMethodSetup: ({ params }, state) => {
      deps.requireAccountHolder(state);
      const setup = billingOf(state).setups.find((candidate) => candidate.id === params.id);
      if (!setup) throw problem("not_found");
      return {
        id: setup.id,
        status:
          setup.state === "succeeded"
            ? "succeeded"
            : setup.state === "failed"
              ? "failed"
              : "requires_confirmation",
        clientSecret: setup.state === "open" || setup.state === "challenge" ? setup.secret : null,
        failureReason: setup.state === "failed" ? (setup.failureReason ?? "card_declined") : null,
        createdAt: setup.createdAt,
      };
    },

    getOpenCheckout: (_input, state) => {
      deps.requireAccount(state);
      const open = billingOf(state).checkouts.find((candidate) =>
        ["requires_setup", "requires_payment", "processing"].includes(candidate.status),
      );
      return { checkout: open ? { ...view(open), clientSecret: null } : null };
    },

    listInvoices: (_input, state) => {
      deps.requireAccountHolder(state);
      return { items: billingOf(state).invoices, nextCursor: null };
    },
  };
}

/** Playback is refused unless the membership entitles it (`subscription_required`). */
export function requireEntitled(state: MockState, problem: BillingHandlerDeps["problem"]): void {
  const { membership } = billingOf(state);
  if (!entitlementOf(membership).entitled) {
    throw problem("subscription_required", {
      subscriptionStatus: "ended",
      membershipStatus: membership.status,
    });
  }
}
