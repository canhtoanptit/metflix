/**
 * The fake payment provider's browser side and test clock, driven over HTTP (milestone 2
 * §5.5): what its payment form does with a client secret (`POST /_pay/api/confirm`, the JSON
 * form of the page at `/_pay/form`), its webhook delivery policy (`/_pay/api/delivery`), and the
 * per-customer test clock (`POST /diagnostics/billing/clock`). Plus the member's checkout as the
 * web drives it: start, confirm the card at the provider, confirm, pay the first invoice when
 * there is no trial, poll until complete.
 */
import { randomBytes } from "node:crypto";
import type {
  AccountDetails,
  Checkout,
  MembershipState,
  PlanId,
  PlaybackSession,
} from "@webflix/contracts";
import { check, equal, fail, SkipSignal, succeeds } from "./expect.ts";
import type { Agent } from "./http.ts";
import type { CheckContext } from "./types.ts";

export const FAKE_BASE = "/_pay";

/** The fake provider's test cards (packages/payments-fake `FAKE_CARDS`, by name). */
export type FakeCard =
  | "visa"
  | "mastercard"
  | "declined"
  | "insufficient-funds"
  | "expired-card"
  | "incorrect-cvc"
  | "processing-error"
  | "lost-card"
  | "charge-declined"
  | "authentication-required"
  | "challenge";

/**
 * A card as the provider's form takes it: a test card, or a labelled one (`visa:run-42`) that
 * behaves like the test card with a fingerprint of its own, so a card that never had a trial
 * (one trial per card fingerprint, §5.4); the same label again is the same card.
 */
export type CardChoice = FakeCard | `${FakeCard}:${string}`;

/**
 * A card of `card`'s kind no other run has used: `card:smk-<run>-<purpose>-<random>` (random
 * too, so a run repeated with the same `--run-id` still gets a card that never had a trial).
 */
export function labelledCard(card: FakeCard, runId: string, purpose: string): CardChoice {
  const label = `smk-${runId}-${purpose}`.slice(0, 55);
  return `${card}:${label}-${randomBytes(3).toString("hex")}` as CardChoice;
}

export type FormOutcome =
  | { status: "succeeded" }
  | { status: "requires_action" }
  | { status: "failed"; code: string };

/**
 * Confirm a setup or a payment the way the provider's form does in the browser: with a test
 * card, the card on file (no card), or by completing or failing a challenge.
 */
export async function confirmAtProvider(
  agent: Agent,
  clientSecret: string,
  options: { card?: CardChoice; challenge?: "complete" | "fail" } = {},
): Promise<FormOutcome> {
  const result = await agent.fetch(`${FAKE_BASE}/api/confirm`, {
    method: "POST",
    body: {
      clientSecret,
      ...(options.card === undefined ? {} : { card: options.card }),
      ...(options.challenge === undefined ? {} : { challenge: options.challenge }),
    },
  });
  const type = result.headers.get("Content-Type") ?? "";
  if (result.status === 422 && options.card?.includes(":")) {
    throw new SkipSignal(
      `the fake provider does not take labelled cards (${options.card} → ${result.status} ${result.exchange.responseBody ?? ""}): an older payments-fake; a card that never had a trial needs \`<test card>:<label>\``,
    );
  }
  if (result.status !== 200 || !type.includes("json")) {
    fail("the fake provider's form refused the confirmation", {
      expected: "200 {status}",
      observed: `${result.status} ${result.exchange.responseBody ?? ""}`.trim(),
      exchange: result.exchange,
    });
  }
  return result.json<FormOutcome>();
}

/** Confirm with `card`, completing a challenge if the card asks for one; must succeed. */
export async function confirmCard(
  agent: Agent,
  clientSecret: string,
  card: CardChoice | undefined,
  what: string,
): Promise<{ challenged: boolean }> {
  let outcome = await confirmAtProvider(agent, clientSecret, card === undefined ? {} : { card });
  let challenged = false;
  if (outcome.status === "requires_action") {
    challenged = true;
    outcome = await confirmAtProvider(agent, clientSecret, { challenge: "complete" });
  }
  equal(outcome.status, "succeeded", `${what}: the provider's confirmation`);
  return { challenged };
}

/** Poll `GET /billing/checkout/:id` until it is `complete` (or fails the check). */
export async function awaitCheckout(
  ctx: CheckContext,
  agent: Agent,
  id: string,
  what: string,
): Promise<Checkout> {
  const { value } = await ctx.eventually(`${what}: checkout complete`, async () => {
    const checkout = await succeeds(
      () => agent.api.getCheckout({ params: { id } }),
      "GET /billing/checkout/:id",
    );
    if (checkout.status === "complete") return { done: true, value: checkout };
    if (checkout.status === "failed" || checkout.status === "expired") {
      fail(`${what}: the checkout ended ${checkout.status}`, {
        expected: "complete",
        observed: JSON.stringify(checkout),
      });
    }
    return { done: false, observed: `status ${checkout.status}` };
  });
  return value;
}

export interface Subscription {
  checkout: Checkout;
  /** The checkout granted the trial (one per account and per card, §5.4). */
  trial: boolean;
  account: AccountDetails;
  membership: MembershipState;
}

/**
 * A membership through the two-step checkout (§5.1, §5.4): the card is confirmed first, the
 * server decides the trial, and without one the first payment is confirmed too.
 */
export async function subscribe(
  ctx: CheckContext,
  agent: Agent,
  options: { planId: PlanId; card: CardChoice; promotionCode?: string },
): Promise<Subscription> {
  const what = `checkout (${options.planId}, ${options.card})`;
  const started = await succeeds(
    () =>
      agent.api.startCheckout({
        body: {
          planId: options.planId,
          ...(options.promotionCode === undefined ? {} : { promotionCode: options.promotionCode }),
        },
      }),
    `${what}: POST /billing/checkout`,
  );
  equal(started.status, "requires_setup", `${what}: status of a new checkout`);
  check(started.clientSecret, `${what}: a new checkout carries no client secret`, {
    observed: JSON.stringify(started),
  });
  await confirmCard(agent, started.clientSecret, options.card, `${what}: card`);
  const confirmed = await succeeds(
    () => agent.api.confirmCheckout({ params: { id: started.id } }),
    `${what}: POST /billing/checkout/:id/confirm`,
  );
  if (confirmed.status === "requires_payment") {
    check(confirmed.clientSecret, `${what}: requires_payment without a client secret`, {
      observed: JSON.stringify(confirmed),
    });
    await confirmCard(agent, confirmed.clientSecret, undefined, `${what}: first payment`);
  }
  const checkout =
    confirmed.status === "complete" ? confirmed : await awaitCheckout(ctx, agent, started.id, what);
  const account = await succeeds(() => agent.api.getAccount(), `${what}: GET /account`);
  check(account.membership, `${what}: GET /account carries no membership`, {
    observed: JSON.stringify(account).slice(0, 300),
  });
  return { checkout, trial: checkout.trial !== null, account, membership: account.membership };
}

/** The customer's test-clock reading (an advance of one second reads it). */
export async function providerNow(agent: Agent): Promise<number> {
  const clock = await succeeds(
    () => agent.api.advanceBillingClock({ body: { seconds: 1 } }),
    "POST /diagnostics/billing/clock (read)",
  );
  return Date.parse(clock.now);
}

/**
 * Move the account's test clock to `extraSec` seconds past `instant` (an ISO time in the
 * provider's time: a trial end, a period end, the end of grace). Never moves it backwards.
 */
export async function advancePast(
  agent: Agent,
  instant: string,
  extraSec: number,
  what: string,
): Promise<string> {
  const now = await providerNow(agent);
  const seconds = Math.max(1, Math.ceil((Date.parse(instant) - now) / 1000) + extraSec);
  const clock = await succeeds(
    () => agent.api.advanceBillingClock({ body: { seconds } }),
    `POST /diagnostics/billing/clock (${what}: ${seconds}s)`,
  );
  return clock.now;
}

/** Collection happens about an hour after the renewal invoice is drafted (docs/STRIPE.md §12). */
export const RENEWAL_SETTLE_SEC = 2 * 3600;

/** A running trial becomes a paid membership: the clock passes the trial end and collects. */
export async function convertTrial(agent: Agent, membership: MembershipState): Promise<void> {
  check(membership.trialEndsAt, "a trialing membership has no trialEndsAt", {
    observed: JSON.stringify(membership),
  });
  await advancePast(agent, membership.trialEndsAt, RENEWAL_SETTLE_SEC, "past the trial end");
}

/** A paid, active membership (a trial the checkout granted is converted first). */
export async function paidMembership(
  ctx: CheckContext,
  agent: Agent,
  options: { planId: PlanId; card: CardChoice },
): Promise<{ trialConverted: boolean; membership: MembershipState; account: AccountDetails }> {
  const subscribed = await subscribe(ctx, agent, options);
  if (subscribed.trial) {
    await convertTrial(agent, subscribed.membership);
    ctx.note(`the checkout with ${options.card} granted a trial: converted on the test clock`);
  }
  const account = await succeeds(() => agent.api.getAccount(), "GET /account");
  check(account.membership?.status === "active", "the membership is not active and paid", {
    expected: "membership.status active",
    observed: JSON.stringify(account.membership),
  });
  return { trialConverted: subscribed.trial, membership: account.membership, account };
}

/** `POST /playback/sessions` as a raw request (402 subscription_required is asserted by callers). */
export function startPlayback(agent: Agent, titleId: string) {
  return agent.fetch("/api/v1/playback/sessions", {
    method: "POST",
    headers: { "X-Webflix-Client": "web" },
    body: { titleId },
  });
}

/** Start and stop a playback session: the account is entitled to play right now. */
export async function playsOnce(
  agent: Agent,
  titleId: string,
  what: string,
): Promise<PlaybackSession> {
  const session = await succeeds(
    () => agent.api.createPlaybackSession({ body: { titleId } }),
    `${what}: POST /playback/sessions`,
  );
  await succeeds(
    () => agent.api.endPlaybackSession({ params: { id: session.id } }),
    `${what}: stop playback`,
  );
  return session;
}

/** The fake provider's webhook delivery policy (deployment-wide). */
export type DeliveryPolicy =
  | { mode: "orderly" }
  | { mode: "unruly"; duplicateRate: number; maxDelayMs: number; seed?: number }
  | { mode: "outage" };

export async function deliveryPolicy(agent: Agent): Promise<DeliveryPolicy> {
  const result = await agent.fetch(`${FAKE_BASE}/api/delivery`);
  check(result.status === 200, "GET /_pay/api/delivery failed", {
    observed: `${result.status} ${result.exchange.responseBody ?? ""}`,
    exchange: result.exchange,
  });
  return result.json<DeliveryPolicy>();
}

export async function setDeliveryPolicy(agent: Agent, policy: DeliveryPolicy): Promise<void> {
  const result = await agent.fetch(`${FAKE_BASE}/api/delivery`, { method: "PUT", body: policy });
  check(result.status === 200, "PUT /_pay/api/delivery failed", {
    observed: `${result.status} ${result.exchange.responseBody ?? ""}`,
    exchange: result.exchange,
  });
}

/** Deliver what is due now; the counts of delivered and still pending deliveries. */
export async function deliverPending(
  agent: Agent,
): Promise<{ delivered: number; pending: number }> {
  const result = await agent.fetch(`${FAKE_BASE}/api/deliver`, { method: "POST", body: {} });
  check(result.status === 200, "POST /_pay/api/deliver failed", {
    observed: `${result.status} ${result.exchange.responseBody ?? ""}`,
    exchange: result.exchange,
  });
  return result.json<{ delivered: number; pending: number }>();
}
