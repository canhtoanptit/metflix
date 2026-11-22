import type Stripe from "stripe";
import { DAY, HOUR } from "../clock.ts";
import { forCustomer, type Scenario } from "../context.ts";
import { createTimeline } from "../timeline.ts";
import {
  createCustomer,
  lookupKey,
  periodEnd,
  priceIds,
  subscribePaid,
  waitActive,
} from "./helpers.ts";

function lines(invoice: Stripe.Invoice): Array<Record<string, unknown>> {
  return invoice.lines.data.map((line) => ({
    description: line.description,
    amount: line.amount,
    proration:
      (line.parent as { subscription_item_details?: { proration?: boolean } } | null)
        ?.subscription_item_details?.proration ?? null,
    period: [line.period.start, line.period.end],
  }));
}

/**
 * Upgrade and downgrade, each previewed with `invoices.createPreview` and then applied with the
 * same `proration_date` (blueprint §12: "plan upgrade and downgrade with the previewed
 * proration"). With a test clock the changes happen 10 and 15 days into the period; in real
 * time a few seconds in, so the prorations are nearly whole-period amounts.
 */
export async function planChange(s: Scenario): Promise<void> {
  const prices = await priceIds(s.stripe);
  const time = await createTimeline(s, s.timeMode, "proration");
  const start = await time.now();
  const customer = await createCustomer(s, time, "member");
  const { subscription } = await s.step("subscribe to Standard", async () => {
    const result = await subscribePaid(
      s,
      customer,
      prices[lookupKey("standard", "usd")] as string,
      "pm_card_visa",
      "member",
    );
    await waitActive(s, customer, "first payment");
    return result;
  });
  const itemId = subscription.items.data[0]?.id as string;
  s.own(itemId);

  async function change(label: string, plan: "premium" | "basic", daysIn: number) {
    // In real time, two seconds back: a proration_date ahead of Stripe's clock is refused.
    const at =
      time.mode === "test-clock"
        ? await time.advance(start + daysIn * DAY, `${daysIn} days into the period`)
        : (await time.now()) - 2;
    const price = prices[lookupKey(plan, "usd")] as string;
    const preview = await s.stripe.invoices.createPreview({
      customer: customer.id,
      subscription: subscription.id,
      subscription_details: {
        items: [{ id: itemId, price }],
        proration_date: at,
        proration_behavior: "always_invoice",
      },
    });
    s.record(`${label} preview`, preview);
    const mark = s.mark();
    const updated = await s.stripe.subscriptions.update(subscription.id, {
      items: [{ id: itemId, price }],
      proration_date: at,
      proration_behavior: "always_invoice",
      payment_behavior: "pending_if_incomplete",
      expand: ["latest_invoice"],
    });
    s.record(`subscription after ${label}`, updated);
    const invoice = updated.latest_invoice as Stripe.Invoice;
    s.own(invoice.id);
    s.observe(`${label}: preview lines`, lines(preview));
    s.observe(`${label}: invoice lines`, lines(invoice));
    s.expect(`${label}: invoiced total equals previewed total`, invoice.total, preview.total);
    s.observe(`${label}: totals`, {
      preview: preview.total,
      invoiced: invoice.total,
      amount_due: invoice.amount_due,
      status: invoice.status,
    });
    if (invoice.total > 0)
      await s
        .waitForEvent("invoice.paid", (o) => o.id === invoice.id, 120_000, mark)
        .catch(() => null);
    const after = await s.stripe.customers.retrieve(customer.id);
    s.observe(
      `${label}: customer balance afterwards (negative = credit)`,
      (after as Stripe.Customer).balance,
    );
    return updated;
  }

  await s.step("upgrade to Premium, invoiced now", () => change("upgrade", "premium", 10));
  const downgraded = await s.step("downgrade to Basic, credited now", () =>
    change("downgrade", "basic", 15),
  );

  await s.step("next renewal against its preview", async () => {
    const preview = await s.stripe.invoices.createPreview({
      customer: customer.id,
      subscription: subscription.id,
    });
    s.record("preview of the next renewal (credit applied)", preview);
    s.observe("next renewal preview", {
      total: preview.total,
      amount_due: preview.amount_due,
      starting_balance: preview.starting_balance,
    });
    if (!time.requireClock("the renewal invoice after a downgrade matches its preview")) return;
    const mark = s.mark();
    await time.advance(periodEnd(downgraded) + 2 * HOUR, "renewal after the downgrade");
    const paid = await s.waitForEvent(
      "invoice.paid",
      (o) => forCustomer(customer.id)(o) && o.billing_reason === "subscription_cycle",
      240_000,
      mark,
    );
    const renewal = await s.stripe.invoices.retrieve((paid.data.object as Stripe.Invoice).id);
    s.record("renewal invoice", renewal);
    s.expect("renewal total equals the preview", renewal.total, preview.total);
    s.expect("renewal amount due equals the preview", renewal.amount_due, preview.amount_due);
  });
}
