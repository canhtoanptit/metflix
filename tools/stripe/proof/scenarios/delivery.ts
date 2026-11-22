import type Stripe from "stripe";
import type { Scenario } from "../context.ts";
import type { Delivery } from "../receiver.ts";
import { createCustomer } from "./helpers.ts";

export interface DeliveryControls {
  stopListener(): Promise<void>;
  startListener(): Promise<void>;
  /** `stripe events resend <id>` with the repository profile. */
  resend(eventId: string): Promise<{ code: number | null }>;
}

function isStep(step: string) {
  return (o: Record<string, unknown>) =>
    (o.metadata as Record<string, string> | undefined)?.step === step;
}

/**
 * What the webhook processor must tolerate (blueprint §5.3, §12): the same event delivered more
 * than once, an older event delivered after newer ones, a delivery that failed, and events
 * created while nothing was listening. Duplicates and reordering are produced with
 * `stripe events resend` (POST /v1/events/{id}/retry with for_stripecli=true), which redelivers
 * the original event to the running `stripe listen` session.
 */
export async function deliveryAnomalies(s: Scenario, controls: DeliveryControls): Promise<void> {
  const deliveriesOf = (id: string) => s.receiver.deliveries.filter((d) => d.event?.id === id);
  const waitDelivery = (id: string, n: number, timeoutMs = 60_000) =>
    s.receiver.waitFor(
      (d: Delivery) => d.event?.id === id && d.deliveryOfId === n,
      timeoutMs,
      `delivery ${n} of ${id}`,
    );

  const originals = await s.step("originals: created, updated, updated", async () => {
    const customer = await createCustomer(s, null, "delivery");
    const created = await s.waitForEvent("customer.created", (o) => o.id === customer.id);
    await s.stripe.customers.update(customer.id, { metadata: { step: "1" } });
    const first = await s.waitForEvent(
      "customer.updated",
      (o) => o.id === customer.id && isStep("1")(o),
    );
    await s.stripe.customers.update(customer.id, { metadata: { step: "2" } });
    const second = await s.waitForEvent(
      "customer.updated",
      (o) => o.id === customer.id && isStep("2")(o),
    );
    const delivery = deliveriesOf(created.id)[0];
    s.observe(
      "Stripe-Signature header entries",
      delivery?.signatureHeader.split(",").map((part) => part.split("=")[0]) ?? [],
    );
    return { customer, created, first, second };
  });

  await s.step("duplicates: the same event resent twice", async () => {
    const id = originals.first.id;
    await controls.resend(id);
    const second = await waitDelivery(id, 2);
    await controls.resend(id);
    const third = await waitDelivery(id, 3);
    const first = deliveriesOf(id)[0] as Delivery;
    s.observe("three deliveries of one event", {
      same_event_id: [first, second, third].every((d) => d.event?.id === id),
      identical_payload: [second, third].every(
        (d) => JSON.stringify(JSON.parse(d.raw)) === JSON.stringify(JSON.parse(first.raw)),
      ),
      fresh_signature_timestamps: new Set([first, second, third].map((d) => d.signedAt)).size === 3,
      all_verified: [first, second, third].every((d) => d.signatureVerified),
    });
  });

  await s.step("reordering: the oldest event delivered last", async () => {
    await controls.resend(originals.created.id);
    const late = await waitDelivery(originals.created.id, 2);
    const latestUpdate = deliveriesOf(originals.second.id)[0] as Delivery;
    s.observe("customer.created arrives after customer.updated", {
      created_event_created: originals.created.created,
      update_event_created: originals.second.created,
      arrived_after: late.seq > latestUpdate.seq,
    });
  });

  await s.step("a failed delivery is not retried by stripe listen", async () => {
    s.receiver.failNext(
      (e: Stripe.Event) =>
        e.type === "customer.updated" &&
        isStep("3")(e.data.object as unknown as Record<string, unknown>),
      500,
      1,
    );
    await s.stripe.customers.update(originals.customer.id, { metadata: { step: "3" } });
    const failed = await s.waitForEvent(
      "customer.updated",
      (o) => o.id === originals.customer.id && isStep("3")(o),
    );
    await new Promise((resolve) => setTimeout(resolve, 45_000));
    const count = deliveriesOf(failed.id).length;
    s.observe(
      "deliveries 45 s after answering 500",
      count,
      undefined,
      "stripe listen forwards once; Stripe's own retry schedule applies to webhook endpoints, not CLI sessions",
    );
    await controls.resend(failed.id);
    const recovered = await waitDelivery(failed.id, count + 1);
    s.observe("resend after the failure", { respondedWith: recovered.respondedWith });
  });

  await s.step("outage: events created while nothing listens", async () => {
    await controls.stopListener();
    const since = Math.floor(Date.now() / 1000) - 5;
    await s.stripe.customers.update(originals.customer.id, { metadata: { step: "4" } });
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await controls.startListener();
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    const delivered = s.receiver.deliveries.filter(
      (d) =>
        d.event?.type === "customer.updated" &&
        isStep("4")(d.event.data.object as unknown as Record<string, unknown>),
    );
    s.observe(
      "events created during the outage delivered after restart",
      delivered.length,
      undefined,
      "a new stripe listen session does not replay what it missed",
    );
    const listed = await s.stripe.events.list({
      type: "customer.updated",
      created: { gte: since },
      limit: 20,
    });
    const missed = listed.data.find(
      (e) =>
        (e.data.object as { id?: string }).id === originals.customer.id &&
        isStep("4")(e.data.object as unknown as Record<string, unknown>),
    );
    s.record("events.list after the outage", listed);
    s.observe("the missed event is listed by the Events API", missed !== undefined);
    if (missed) {
      await controls.resend(missed.id);
      const late = await waitDelivery(missed.id, 1);
      s.observe("missed event delivered by resend", { respondedWith: late.respondedWith });
    }
  });
}
