import type Stripe from "stripe";
import { advanceClock, createClock, HOUR, nowSeconds } from "./clock.ts";
import { forCustomer, type Scenario } from "./context.ts";

/**
 * How a scenario makes time pass.
 *
 * - `test-clock`: Stripe test clocks (7-day trials, real renewals, retries over days). Creating a
 *   clock needs a full test key: the key of an unclaimed CLI sandbox is refused with 403 ("This
 *   is a claimable sandbox key with limited permissions").
 * - `real-time`: what an unclaimed sandbox allows. Trials last seconds (`trial_end` a few seconds
 *   ahead) so the first `subscription_cycle` invoice appears within about two minutes; Stripe
 *   would collect it about an hour later, so the test finalizes it and calls `invoices.pay`, an
 *   off-session attempt like Stripe's own. Checks that need days of clock time are recorded as
 *   skipped, never as passed.
 */
export type TimeMode = "test-clock" | "real-time";

/** Real-time trial length: long enough to confirm the SetupIntent first. */
const REAL_TIME_TRIAL_SECONDS = 40;

export interface Timeline {
  mode: TimeMode;
  clockId: string | null;
  customerParams(): { test_clock?: string };
  trialParams(): { trial_period_days: number } | { trial_end: number };
  /**
   * Let the trial end and the first renewal attempt happen; returns the `subscription_cycle`
   * invoice as it stands after that attempt.
   */
  endTrialAndCollect(
    subscription: Stripe.Subscription,
    customer: Stripe.Customer,
  ): Promise<Stripe.Invoice>;
  /** Advance the clock (test-clock mode only). */
  advance(to: number, why: string): Promise<number>;
  now(): Promise<number>;
  /** Record a check that this mode cannot make; returns false so callers can branch. */
  requireClock(check: string): boolean;
}

export async function createTimeline(
  s: Scenario,
  mode: TimeMode,
  label: string,
): Promise<Timeline> {
  const clock = mode === "test-clock" ? await createClock(s, label) : null;
  s.observe("time mode", mode);
  const timeline: Timeline = {
    mode,
    clockId: clock?.id ?? null,
    customerParams: () => (clock ? { test_clock: clock.id } : {}),
    trialParams: () =>
      clock ? { trial_period_days: 7 } : { trial_end: nowSeconds() + REAL_TIME_TRIAL_SECONDS },
    async now() {
      if (!clock) return nowSeconds();
      return (await s.stripe.testHelpers.testClocks.retrieve(clock.id)).frozen_time;
    },
    async advance(to, why) {
      if (!clock) throw new Error(`advance(${why}) needs a test clock`);
      return (await advanceClock(s, clock.id, to, why)).frozen_time;
    },
    requireClock(check) {
      if (clock) return true;
      s.observe(`SKIPPED (needs a test clock): ${check}`, "skipped");
      s.skipped.push(check);
      return false;
    },
    async endTrialAndCollect(subscription, customer) {
      const trialEnd = subscription.trial_end;
      if (!trialEnd) throw new Error("endTrialAndCollect needs a trialing subscription");
      const mark = s.mark();
      if (clock) {
        // Stripe drafts the invoice at the trial end and attempts it about an hour later.
        await advanceClock(s, clock.id, trialEnd + 2 * HOUR, "trial end plus 2 hours");
        // One wait over the three outcomes (a race of three waits would leave two to time out).
        const outcomes = new Set([
          "invoice.paid",
          "invoice.payment_failed",
          "invoice.payment_action_required",
        ]);
        const outcome = await s.receiver.waitFor(
          (d) => {
            const object = d.event?.data.object as unknown as Record<string, unknown> | undefined;
            return (
              d.seq >= mark &&
              d.event !== null &&
              outcomes.has(d.event.type) &&
              object !== undefined &&
              forCustomer(customer.id)(object) &&
              object.billing_reason === "subscription_cycle"
            );
          },
          240_000,
          `${s.name}: outcome of the first renewal attempt`,
        );
        const invoice = outcome.event?.data.object as Stripe.Invoice | undefined;
        if (!invoice) throw new Error("renewal outcome delivery without an event");
        return s.stripe.invoices.retrieve(invoice.id);
      }
      const created = await s.waitForEvent(
        "invoice.created",
        (o) => forCustomer(customer.id)(o) && o.billing_reason === "subscription_cycle",
        300_000,
        mark,
      );
      const draft = created.data.object as Stripe.Invoice;
      s.own(draft.id);
      s.observe("real time: first renewal invoice drafted", {
        seconds_after_trial_end: created.created - trialEnd,
        status: draft.status,
        total: draft.total,
      });
      const finalized = await s.stripe.invoices.finalizeInvoice(draft.id);
      s.record("invoice finalized early (Stripe would wait about an hour)", finalized);
      s.observe("after early finalization", {
        status: finalized.status,
        attempt_count: finalized.attempt_count,
        next_payment_attempt_in_minutes: finalized.next_payment_attempt
          ? Math.round((finalized.next_payment_attempt - nowSeconds()) / 60)
          : null,
      });
      try {
        const paid = await s.stripe.invoices.pay(draft.id);
        s.record("invoices.pay (stands in for Stripe's first automatic attempt)", paid);
      } catch (error) {
        const summary = s.recordError(
          "invoices.pay refused (stands in for Stripe's first automatic attempt)",
          error,
        );
        s.observe("first renewal attempt failed", {
          status: summary.status,
          type: summary.type,
          code: summary.code,
        });
      }
      return s.stripe.invoices.retrieve(draft.id);
    },
  };
  return timeline;
}

/**
 * Pick the time mode. `auto` tries to create (and then deletes) a test clock: an unclaimed CLI
 * sandbox key gets 403, which means real time.
 */
export async function detectTimeMode(
  stripe: Stripe,
  requested: string,
): Promise<{ mode: TimeMode; reason: string }> {
  if (requested === "real") return { mode: "real-time", reason: "requested with --time real" };
  if (requested === "clock") return { mode: "test-clock", reason: "requested with --time clock" };
  if (requested !== "auto")
    throw new Error(`--time must be auto, clock or real (got ${requested})`);
  try {
    const probe = await stripe.testHelpers.testClocks.create({
      frozen_time: nowSeconds(),
      name: "webflix proof: probe",
    });
    await stripe.testHelpers.testClocks.del(probe.id);
    return { mode: "test-clock", reason: "this key can create test clocks" };
  } catch (error) {
    const e = error as { statusCode?: number; message?: string };
    if (e.statusCode === 403) {
      return {
        mode: "real-time",
        reason:
          "this key may not create test clocks (403: a claimable sandbox key has limited permissions; " +
          "a claimed sandbox's full test key can). Clock-only checks are recorded as skipped",
      };
    }
    throw error;
  }
}
