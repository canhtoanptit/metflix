import type Stripe from "stripe";
import type { Scenario } from "./context.ts";

export const DAY = 86_400;
export const HOUR = 3_600;

/** Now, in whole seconds (test clocks take Unix seconds). */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export async function createClock(
  s: Scenario,
  label: string,
): Promise<Stripe.TestHelpers.TestClock> {
  const clock = await s.stripe.testHelpers.testClocks.create({
    frozen_time: nowSeconds(),
    name: `webflix proof ${s.name} ${label}`.slice(0, 50),
  });
  s.own(clock.id);
  s.clocks.push(clock.id);
  s.record(`test clock created (${label})`, clock);
  return clock;
}

/**
 * Advance a clock and wait until Stripe reports it `ready`. The advance call returns at once
 * with status `advancing`; invoices, payment attempts and their webhooks happen while it
 * advances, so callers then wait for the specific events they need (webhooks can still arrive
 * after `ready`).
 */
export async function advanceClock(
  s: Scenario,
  clockId: string,
  to: number,
  why: string,
): Promise<Stripe.TestHelpers.TestClock> {
  const before = await s.stripe.testHelpers.testClocks.retrieve(clockId);
  const started = performance.now();
  await s.stripe.testHelpers.testClocks.advance(clockId, { frozen_time: to });
  let polls = 0;
  let clock = before;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    polls++;
    clock = await s.stripe.testHelpers.testClocks.retrieve(clockId);
    if (clock.status === "ready") break;
    if (clock.status === "internal_failure")
      throw new Error(`Test clock ${clockId} failed while advancing (${why}).`);
    if (performance.now() - started > 600_000)
      throw new Error(`Test clock ${clockId} still advancing after 10 min (${why}).`);
  }
  s.advances.push({
    clock: clockId,
    fromTime: before.frozen_time,
    toTime: to,
    ms: Math.round(performance.now() - started),
    polls,
  });
  s.observe(`clock advanced: ${why}`, {
    from: new Date(before.frozen_time * 1000).toISOString(),
    to: new Date(to * 1000).toISOString(),
    seconds: Math.round((performance.now() - started) / 1000),
  });
  return clock;
}

export async function deleteClock(stripe: Stripe, clockId: string): Promise<void> {
  try {
    await stripe.testHelpers.testClocks.del(clockId);
  } catch {
    // Already gone, or Stripe deletes it on its own schedule.
  }
}
