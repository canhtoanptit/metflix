/**
 * Privacy review M7: a deletion stops the renewals through billing's cancel, which must not send
 * the `cancellation` email ("keep watching until …", "restart at any time": both false while a
 * deletion is scheduled). An ordinary cancel still sends it. Decided where the email is decided,
 * from the events area's seam, which every path that cancels for a deletion finds true already:
 * the member's request, the sweep's retry, and a staff cancel while the deletion is scheduled.
 */
import { describe, expect, it } from "vitest";
import { createMember, elevate, eventServices, type Member } from "../events/helpers.ts";

type T = Awaited<ReturnType<typeof eventServices>>;

/** A member whose trial membership is the payment provider's. */
async function providerMember(t: T, id: string): Promise<Member> {
  const member = await createMember(t, id, { membership: false });
  const started = await t.services.billing.startCheckout(member.as("adult"), { planId: "basic" });
  if (!started.clientSecret) throw new Error("no setup secret");
  await t.ports.payments.confirmSetup(started.clientSecret, "visa");
  await t.services.billing.confirmCheckout(id, started.id);
  await t.queue.drain();
  return member;
}

const templates = (t: T) => t.ports.email.mailbox().map((mail) => mail.template);

async function sweep(t: T) {
  await t.services.scheduler.tick();
  await t.queue.drain();
}

describe("the cancellation email and a scheduled deletion", () => {
  it("an ordinary cancel sends it", async () => {
    const t = await eventServices({}, {});
    const member = await providerMember(t, "acc-plain-cancel");
    await t.services.billing.cancel(member.accountId);
    await t.queue.drain();
    expect(templates(t)).toContain("cancellation");
  });

  it("a deletion's cancel does not, nor does its processing of the provider's events", async () => {
    const t = await eventServices({}, {});
    const member = await providerMember(t, "acc-deleting");
    await elevate(t, member);
    await t.services.events.requestDeletion(member.as("adult"));
    await t.queue.drain();
    expect((await t.services.billing.membership(member.accountId, null)).state).toMatchObject({
      cancelAtPeriodEnd: true,
    });
    expect(templates(t)).not.toContain("cancellation");
  });

  it("nor the sweep's retry when the request's own cancel failed", async () => {
    const t = await eventServices({}, {});
    const member = await providerMember(t, "acc-retried");
    const provider = t.ports.payments;
    const original = provider.setCancelAtPeriodEnd.bind(provider);
    let failures = 1;
    provider.setCancelAtPeriodEnd = async (input, call) => {
      if (failures-- > 0) {
        const { PaymentProviderError } = await import("../../src/ports/payment-provider.ts");
        throw new PaymentProviderError("unavailable", "briefly unavailable");
      }
      return original(input, call);
    };
    await elevate(t, member);
    await t.services.events.requestDeletion(member.as("adult"));
    expect(
      (await t.services.billing.membership(member.accountId, null)).state.cancelAtPeriodEnd,
    ).toBe(false);
    await sweep(t);
    expect(
      (await t.services.billing.membership(member.accountId, null)).state.cancelAtPeriodEnd,
    ).toBe(true);
    expect(templates(t)).not.toContain("cancellation");
  });

  it("nor a staff cancel while the deletion is scheduled", async () => {
    const t = await eventServices({}, {});
    const member = await providerMember(t, "acc-staff");
    const provider = t.ports.payments;
    const original = provider.setCancelAtPeriodEnd.bind(provider);
    let refusing = true;
    // The deletion's own cancel cannot reach the provider; staff cancel before the sweep does.
    provider.setCancelAtPeriodEnd = async (input, call) => {
      if (refusing) {
        refusing = false;
        const { PaymentProviderError } = await import("../../src/ports/payment-provider.ts");
        throw new PaymentProviderError("unavailable", "briefly unavailable");
      }
      return original(input, call);
    };
    await elevate(t, member);
    await t.services.events.requestDeletion(member.as("adult"));
    await t.services.billing.cancelForStaff({
      accountId: member.accountId,
      when: "period_end",
      reason: "member asked by phone",
      staffSubject: "staff-1",
    });
    await t.queue.drain();
    expect(
      (await t.services.billing.membership(member.accountId, null)).state.cancelAtPeriodEnd,
    ).toBe(true);
    expect(templates(t)).not.toContain("cancellation");
  });

  it("once the account is kept, a later cancel sends it again", async () => {
    const t = await eventServices({}, {});
    const member = await providerMember(t, "acc-kept");
    await elevate(t, member);
    await t.services.events.requestDeletion(member.as("adult"));
    await t.services.events.cancelDeletion(member.as("adult"));
    await t.services.billing.resume(member.accountId);
    await t.queue.drain();
    await t.services.billing.cancel(member.accountId);
    await t.queue.drain();
    expect(templates(t)).toContain("cancellation");
  });
});
