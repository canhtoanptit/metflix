/**
 * The billing journeys against the real Stripe sandbox, in real time, with webhooks delivered
 * by Stripe (docs/BLUEPRINT-M2.md §5.5, §12 "Real Stripe"): the real billing service and the
 * Stripe adapter in this process, Stripe's events forwarded by `stripe listen` to a receiver on
 * 127.0.0.1:5672 that hands them to the webhook pipeline (verify, record, queue, process).
 *
 * Needs, besides the keys: `make stripe-listen NAME=billing FORWARD_TO=http://127.0.0.1:5672/webhook`
 * running, `STRIPE_WEBHOOK_SECRET` (that listener's signing secret) and
 * `STRIPE_JOURNEYS=1`. Otherwise every journey reports itself skipped with the reason. The
 * checks that need a test clock (Stripe's own retry schedule, retries running out, expiry of an
 * unconfirmed first payment after 23 h, mid-period proration, the renewal against its preview)
 * are not here: the sandbox key cannot create clocks (docs/STRIPE.md §4); they run against the
 * fake provider (payments-fake/test/billing).
 */
import { createServer, type Server } from "node:http";
import {
  type AuthContext,
  createHmacTokenSigner,
  createMediaTokens,
  createPbkdf2PasswordHasher,
  createServices,
  createUuidV7Generator,
  loadCoreConfig,
  type ServiceDependencies,
  type Services,
  systemClock,
} from "@webflix/core";
import {
  createMemoryAreaPorts,
  createMemoryRepositories,
  MemoryJobQueue,
  MemoryKeyValueCache,
  MemorySearchIndex,
  MemoryStreamGate,
} from "@webflix/core/memory";
import { MemoryLogger } from "@webflix/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StripePaymentProvider } from "../../src/provider.ts";
import {
  browserConfirm,
  SANDBOX_PRICES,
  type SandboxKeys,
  sandboxAvailable,
  sandboxReachable,
  stripeApi,
  TEST_PAYMENT_METHODS,
} from "../support/sandbox.ts";

const keys: SandboxKeys = {
  secretKey: process.env.STRIPE_SECRET_KEY ?? "",
  publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? "",
};
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const wanted =
  sandboxAvailable(keys) && webhookSecret !== "" && process.env.STRIPE_JOURNEYS === "1";
const unreachable = wanted ? await sandboxReachable(keys) : null;
const enabled = wanted && unreachable === null;
const RECEIVER_PORT = 5672;

let services: Services;
let deps: ServiceDependencies;
let queue: MemoryJobQueue;
let payments: StripePaymentProvider;
let server: Server;
let deliveries = 0;
let outage = false;
const subscriptions = new Set<string>();

async function drain() {
  for (let i = 0; i < 20 && queue.size > 0; i += 1) await queue.drain();
}

/** Waits for Stripe's webhooks to bring the projection to `until` (processing as they come). */
async function waitFor<T>(read: () => Promise<T>, until: (value: T) => boolean, ms = 120_000) {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!until(value)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting; last: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await drain();
    value = await read();
  }
  return value;
}

let counter = 0;
async function account(): Promise<AuthContext> {
  counter += 1;
  const id = `acct-sandbox-${Date.now()}-${counter}`;
  const now = Date.now();
  const session = {
    id: `ses-${id}`,
    tokenHash: `hash-${id}`,
    accountId: id,
    activeProfileId: null,
    deviceLabel: "Sandbox",
    deviceType: "desktop" as const,
    persistent: true,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + 86_400_000,
  };
  await deps.repos.identity.createAccount({
    account: {
      id,
      email: `${id}@example.test`,
      passwordHash: null,
      emailVerifiedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    session,
    identity: null,
  });
  return { session, profile: null };
}

const status = (accountId: string) =>
  services.billing.membership(accountId, null).then((snapshot) => snapshot.state.status);

async function checkout(
  auth: AuthContext,
  input: {
    planId: "basic" | "standard" | "premium";
    card: keyof typeof TEST_PAYMENT_METHODS;
    promotionCode?: string;
  },
) {
  const started = await services.billing.startCheckout(auth, {
    planId: input.planId,
    ...(input.promotionCode ? { promotionCode: input.promotionCode } : {}),
  });
  const confirmed = await browserConfirm(
    keys,
    "setup_intents",
    started.clientSecret ?? "",
    TEST_PAYMENT_METHODS[input.card],
  );
  return { started, setup: confirmed };
}

beforeAll(async () => {
  if (!enabled) return;
  const clock = systemClock;
  const logger = new MemoryLogger({ clock });
  const config = loadCoreConfig({ WEBFLIX_MODE: "dev", WEBFLIX_ENV: "test" });
  queue = new MemoryJobQueue({ clock, logger, maxAttempts: 5 });
  const ids = createUuidV7Generator({ clock });
  const real = new StripePaymentProvider({
    secretKey: keys.secretKey,
    webhookSecret,
    clock,
    logger,
  });
  payments = Object.create(real) as StripePaymentProvider;
  payments.createSubscription = async (input, call) => {
    const created = await real.createSubscription(input, call);
    subscriptions.add(created.id);
    return created;
  };
  deps = {
    ...createMemoryAreaPorts({ clock, ids }),
    payments,
    config,
    repos: createMemoryRepositories(),
    search: new MemorySearchIndex(),
    cache: new MemoryKeyValueCache({ clock }),
    streamGate: new MemoryStreamGate({ clock }),
    jobs: queue,
    passwords: createPbkdf2PasswordHasher({ iterations: 1_000 }),
    mediaTokens: createMediaTokens(
      createHmacTokenSigner({ keys: config.media.tokenKeys, clock }),
      clock,
    ),
    clock,
    ids,
    logger,
  };
  services = createServices(deps);
  queue.setProcessor(services.processor);
  await payments.syncCatalogue([SANDBOX_PRICES.basic, SANDBOX_PRICES.premium]);
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (outage) {
        response.writeHead(500).end();
        return;
      }
      const body = new Uint8Array(Buffer.concat(chunks));
      const signature = request.headers["stripe-signature"];
      services.billing
        .receiveWebhook("stripe", body, typeof signature === "string" ? signature : null)
        .then(
          () => {
            deliveries += 1;
            response.writeHead(200).end();
          },
          () => response.writeHead(400).end(),
        );
    });
  });
  await new Promise<void>((resolve) => server.listen(RECEIVER_PORT, "127.0.0.1", resolve));
}, 60_000);

afterAll(async () => {
  if (!enabled) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Leave the sandbox quiet: nothing this run subscribed keeps running.
  for (const id of subscriptions) {
    const current = await stripeApi(keys, "GET", `/v1/subscriptions/${id}`);
    if (current.status !== "canceled" && current.status !== "incomplete_expired") {
      await stripeApi(keys, "DELETE", `/v1/subscriptions/${id}`);
    }
  }
}, 120_000);

describe.skipIf(!enabled)(
  "billing journeys on the Stripe sandbox, webhooks delivered by Stripe",
  () => {
    let paidAccount = "";

    it("trial: card first, then trialing once Stripe's events arrive", async () => {
      const auth = await account();
      const { started, setup } = await checkout(auth, { planId: "standard", card: "visa" });
      expect(setup.body.status).toBe("succeeded");
      const confirmed = await services.billing.confirmCheckout(auth.session.accountId, started.id);
      expect(confirmed.trial?.days).toBe(7);
      await waitFor(
        () => status(auth.session.accountId),
        (value) => value === "trialing",
      );
      expect(deliveries).toBeGreaterThan(0);
    });

    it("the same card again: no trial, the first payment confirmed in the browser activates it via Stripe's event", async () => {
      const auth = await account();
      paidAccount = auth.session.accountId;
      const { started } = await checkout(auth, { planId: "basic", card: "visa" });
      const confirmed = await services.billing.confirmCheckout(auth.session.accountId, started.id);
      expect(confirmed).toMatchObject({ status: "requires_payment", trial: null });
      expect(confirmed.amountDue).toEqual({ amountMinor: 799, currency: "USD" });
      expect(await status(paidAccount)).toBe("incomplete");
      const paid = await browserConfirm(
        keys,
        "payment_intents",
        confirmed.clientSecret ?? "",
        TEST_PAYMENT_METHODS.visa,
      );
      expect(paid.body.status).toBe("succeeded");
      await waitFor(
        () => status(paidAccount),
        (value) => value === "active",
      );
      expect((await services.billing.getCheckout(paidAccount, started.id)).status).toBe("complete");
    });

    it("a card declined at setup is refused, and another card works in the same checkout", async () => {
      const auth = await account();
      const { started, setup } = await checkout(auth, { planId: "standard", card: "declined" });
      expect(setup.status).toBe(402);
      const refused = await services.billing
        .confirmCheckout(auth.session.accountId, started.id)
        .catch((error: unknown) => error as { code?: string });
      expect(refused).toMatchObject({ code: "payment_declined" });
      const retry = await services.billing.getCheckout(auth.session.accountId, started.id);
      await browserConfirm(
        keys,
        "setup_intents",
        retry.clientSecret ?? "",
        TEST_PAYMENT_METHODS.mastercard,
      );
      const confirmed = await services.billing.confirmCheckout(auth.session.accountId, started.id);
      expect(confirmed.trial?.days).toBe(7);
    });

    it("an upgrade is invoiced exactly as previewed; cancel and resume; a partial refund", async () => {
      const preview = await services.billing.previewPlanChange(paidAccount, "premium");
      expect(preview.amountDue.amountMinor).toBeGreaterThan(0);
      const changed = await services.billing.changePlan(paidAccount, {
        planId: "premium",
        previewToken: preview.previewToken,
      });
      expect(changed.plan.id).toBe("premium");
      const record = await deps.repos.billing.getMembership(paidAccount);
      const invoice = await payments.retrieveInvoice(record?.latestInvoiceId ?? "");
      expect(invoice?.amountPaidMinor).toBe(preview.amountDue.amountMinor);
      expect(invoice?.totalMinor).toBe(
        preview.lines.reduce((sum, line) => sum + line.amount.amountMinor, 0),
      );

      expect((await services.billing.cancel(paidAccount)).subscription.status).toBe("canceling");
      expect((await services.billing.resume(paidAccount)).subscription.status).toBe("active");

      const invoices = await services.billing.listInvoices(paidAccount, {});
      const first = invoices.items.find((candidate) => candidate.amountPaid.amountMinor === 799);
      expect(first).toBeDefined();
      const refund = await services.billing.refundInvoice({
        accountId: paidAccount,
        invoiceId: first?.id ?? "",
        amount: { amountMinor: 300, currency: "USD" },
        reason: "sandbox journey",
        staffSubject: "staff-sandbox",
      });
      expect(refund).toMatchObject({ amount: { amountMinor: 300 }, status: "succeeded" });
      const after = await deps.repos.billing.getInvoice(paidAccount, first?.id ?? "");
      expect(after).toMatchObject({ status: "paid", amountRefundedMinor: 300 });
    });

    it("a promo code is read before use and applied at checkout", async () => {
      const code = `WFXJ${Date.now().toString(36).toUpperCase()}`;
      const coupon = await stripeApi(keys, "POST", "/v1/coupons", {
        percent_off: "50",
        duration: "once",
      });
      await stripeApi(keys, "POST", "/v1/promotion_codes", {
        "promotion[type]": "coupon",
        "promotion[coupon]": String(coupon.id),
        code,
        max_redemptions: "1",
      });
      const quote = await services.billing.validatePromotion({ code, planId: "premium" });
      expect(quote.discountedPrice.amountMinor).toBe(1899 - Math.round(1899 / 2));
      const auth = await account();
      const { started } = await checkout(auth, {
        planId: "premium",
        card: "visa",
        promotionCode: code,
      });
      const confirmed = await services.billing.confirmCheckout(auth.session.accountId, started.id);
      expect(confirmed.amountDue?.amountMinor).toBe(949);
      const exhausted = await services.billing
        .validatePromotion({ code, planId: "premium" })
        .catch((error: unknown) => error as { code?: string; extensions?: unknown });
      expect(exhausted).toMatchObject({ code: "promotion_code_invalid" });
    });

    it("a retried confirmation (answer lost) creates one subscription at Stripe", async () => {
      const auth = await account();
      const { started } = await checkout(auth, { planId: "basic", card: "mastercard" });
      const realCreate = payments.createSubscription.bind(payments);
      let crash = true;
      payments.createSubscription = async (input, call) => {
        const created = await realCreate(input, call);
        if (crash) {
          crash = false;
          throw new Error("connection reset after Stripe answered");
        }
        return created;
      };
      await expect(
        services.billing.confirmCheckout(auth.session.accountId, started.id),
      ).rejects.toThrow();
      await services.billing.confirmCheckout(auth.session.accountId, started.id);
      payments.createSubscription = realCreate;
      const customer = await deps.repos.billing.getCustomer(auth.session.accountId, "stripe");
      const list = await stripeApi(keys, "GET", "/v1/subscriptions", {
        customer: customer?.customerId ?? "",
        status: "all",
      });
      expect((list.data as unknown[]).length).toBe(1);
    });

    it("after an outage (deliveries refused, never replayed by the listener), reconciliation repairs the projection", async () => {
      const record = await deps.repos.billing.getMembership(paidAccount);
      const subscriptionId = record?.providerSubscriptionId ?? "";
      // Let earlier deliveries settle, then refuse every delivery while the member cancels.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      await drain();
      const outageStarted = Date.now() - 1_000;
      outage = true;
      await payments.setCancelAtPeriodEnd(
        { subscriptionId, cancelAtPeriodEnd: true },
        { idempotencyKey: `webflix-sandbox-outage-${Date.now()}` },
      );
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      outage = false;
      const missed = (
        await payments.listEvents({ createdAfter: outageStarted - 1_000, limit: 100 })
      ).filter((event) => event.subscriptionId === subscriptionId);
      expect(missed.length).toBeGreaterThan(0);
      for (const event of missed) {
        expect(await deps.repos.billing.getProviderEvent("stripe", event.id)).toBeNull();
      }
      const repaired = await waitFor(
        async () => {
          await services.billing.reconcile();
          await drain();
          return (await deps.repos.billing.getMembership(paidAccount))?.cancelAtPeriodEnd;
        },
        (value) => value === true,
        60_000,
      );
      expect(repaired).toBe(true);
      const recorded = await Promise.all(
        missed.map((event) => deps.repos.billing.getProviderEvent("stripe", event.id)),
      );
      expect(recorded.every((event) => event?.source === "reconcile")).toBe(true);
    });

    it("a renewal declines, the member is past due in grace, and a replaced card recovers it (real time)", async () => {
      const auth = await account();
      const accountId = auth.session.accountId;
      const { started } = await checkout(auth, { planId: "standard", card: "charge-declined" });
      const confirmed = await services.billing.confirmCheckout(accountId, started.id);
      expect(confirmed.trial).not.toBeNull();
      const record = await waitFor(
        () => deps.repos.billing.getMembership(accountId),
        (value) => value?.status === "trialing",
      );
      const subscriptionId = record?.providerSubscriptionId ?? "";
      // The real-time substitute for a test clock (docs/STRIPE.md §12): the trial ends in 40 s,
      // Stripe drafts the renewal 12-47 s later, and paying it stands in for Stripe's attempt.
      await payments.setTrialEnd(
        { subscriptionId, trialEnd: Date.now() + 40_000 },
        { idempotencyKey: `webflix-sandbox-trial-end-${subscriptionId}` },
      );
      const renewal = await waitFor(
        async () => {
          const current = await payments.retrieveSubscription(subscriptionId);
          const invoice = current?.latestInvoiceId
            ? await payments.retrieveInvoice(current.latestInvoiceId)
            : null;
          return invoice?.billingReason === "subscription_cycle" ? invoice : null;
        },
        (value) => value !== null,
        180_000,
      );
      await payments
        .payInvoice(
          { invoiceId: renewal?.id ?? "" },
          { idempotencyKey: `webflix-sandbox-renewal-${renewal?.id}` },
        )
        .catch(() => undefined);
      const pastDue = await waitFor(
        () => deps.repos.billing.getMembership(accountId),
        (value) => value?.status === "past_due",
      );
      expect(pastDue?.graceStartedAt).not.toBeNull();
      const snapshot = await services.billing.membership(accountId, null);
      expect(snapshot.entitlement.entitled).toBe(true);
      expect(snapshot.state.graceEndsAt).not.toBeNull();

      const setup = await services.billing.setupPaymentMethod(accountId);
      await browserConfirm(
        keys,
        "setup_intents",
        setup.clientSecret ?? "",
        TEST_PAYMENT_METHODS.visa,
      );
      await waitFor(
        () => status(accountId),
        (value) => value === "active",
      );
      expect((await services.billing.getPaymentMethodSetup(accountId, setup.id)).status).toBe(
        "succeeded",
      );
    }, 420_000);
  },
);

if (!enabled) {
  describe("billing journeys on the Stripe sandbox", () => {
    it.skip(
      unreachable
        ? `skipped: ${unreachable}`
        : "skipped: needs the sandbox keys, STRIPE_WEBHOOK_SECRET, a running `make stripe-listen NAME=billing FORWARD_TO=http://127.0.0.1:5672/webhook` and STRIPE_JOURNEYS=1",
      () => {},
    );
  });
}

/**
 * What the claimable sandbox key cannot do (docs/STRIPE.md §4: 403 on test clocks, customer
 * sessions and tax), reported here as skipped against Stripe with the reason; each runs against
 * the fake provider instead (packages/payments-fake/test, named alongside).
 */
describe("Stripe checks that need a full test key", () => {
  const clock =
    "needs a test clock; the claimable sandbox key cannot create one (403, docs/STRIPE.md §4)";
  for (const [check, fake] of [
    ["Stripe's own retry schedule after a declined renewal", "engine: retries a declined renewal"],
    ["retries running out (cancel, or mark unpaid)", "engine + journeys: when retries run out"],
    ["expiry of an unconfirmed first payment after 23 h", "journeys: unconfirmed first payment"],
    ["mid-period proration", "journeys: previews a plan change … retried"],
    [
      "the renewal invoice after a downgrade against its preview",
      "journeys: downgrades with a credit",
    ],
    [
      "the trial-ending notice three days before a 7-day trial",
      "seams: emails … the end of a trial",
    ],
  ] as const) {
    it.skip(`skipped against Stripe: ${check} (${clock}); runs against the fake: ${fake}`, () => {});
  }
  it.skip("skipped against Stripe: saved cards in the Payment Element (customer sessions are refused for the claimable key, 403); nothing server-side depends on them", () => {});
  it.skip("skipped against Stripe: automatic tax (the tax endpoints are refused for the claimable key, 403); tax stays off in the sandbox lane (§5.4)", () => {});
});
