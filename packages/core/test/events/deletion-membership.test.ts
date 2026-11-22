/**
 * What a member is told before asking (the terms), and what asking for a deletion does to the
 * membership: the renewals stop at once through billing's service (the membership ends at the
 * close of its period, or with the account), whatever billing answers the request is recorded,
 * a failure to stop them is retried by the sweep, and keeping the account leaves the membership
 * set to end with one action to resume it.
 */
import { describe, expect, it, vi } from "vitest";
import { createMember, DAY_MS, elevate, eventServices, type Member } from "./helpers.ts";

type T = Awaited<ReturnType<typeof eventServices>>;

/** A member whose membership is the payment provider's: a trial, or (`paying`) a paid period. */
async function providerMember(t: T, id: string, options: { paying?: boolean } = {}) {
  const subscribe = async (accountId: string) => {
    const member = await createMember(t, accountId, { membership: false });
    const started = await t.services.billing.startCheckout(member.as("adult"), {
      planId: "basic",
    });
    if (!started.clientSecret) throw new Error("no setup secret");
    await t.ports.payments.confirmSetup(started.clientSecret, "visa");
    const confirmed = await t.services.billing.confirmCheckout(accountId, started.id);
    if (confirmed.status === "requires_payment" && confirmed.clientSecret) {
      await t.ports.payments.confirmPayment(confirmed.clientSecret, "visa");
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await t.queue.drain();
      if ((await t.services.billing.getCheckout(accountId, started.id)).status === "complete") {
        break;
      }
    }
    return member;
  };
  // The card's first account takes its one trial; a second one pays at once.
  if (options.paying) await subscribe(`${id}-trial`);
  return subscribe(id);
}

async function billingState(t: T, member: Member) {
  return (await t.services.billing.membership(member.accountId, null)).state;
}

async function deletionOf(t: T, member: Member) {
  const list = await t.services.events.listPrivacyRequests(member.as("adult"));
  return list.items.find((item) => item.kind === "deletion");
}

async function sweep(t: T) {
  await t.services.scheduler.tick();
  await t.queue.drain();
}

describe("the terms a member is told before asking", () => {
  it("are this deployment's settings, served with the requests", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t);
    expect((await t.services.events.listPrivacyRequests(member.as("adult"))).terms).toEqual({
      deletionCoolingOffSec: 14 * 24 * 3600,
      exportLinkTtlSec: 7 * 24 * 3600,
      exportMode: "inline",
      exportTypicalSec: 60,
      eventsRetentionDays: 396,
      aggregatesRetentionDays: 1126,
    });
    const configured = await eventServices(
      {
        WEBFLIX_DELETION_COOLING_OFF_SEC: "30",
        WEBFLIX_EXPORT_LINK_TTL_SEC: "3600",
        WEBFLIX_EXPORT_EVENTS: "batch",
        WEBFLIX_EVENTS_RETENTION_DAYS: "90",
      },
      {},
    );
    const other = await createMember(configured);
    expect(
      (await configured.services.events.listPrivacyRequests(other.as("adult"))).terms,
    ).toMatchObject({
      deletionCoolingOffSec: 30,
      exportLinkTtlSec: 3600,
      exportMode: "batch",
      exportTypicalSec: 30 * 60, // batch: the pipeline's schedule plus its grace
      eventsRetentionDays: 90,
    });
    const told = await eventServices({ WEBFLIX_EXPORT_TYPICAL_SEC: "240" }, {});
    const third = await createMember(told);
    expect(
      (await told.services.events.listPrivacyRequests(third.as("adult"))).terms.exportTypicalSec,
    ).toBe(240);
  });

  it("match what a request then gets (the cooling-off period, the link's lifetime)", async () => {
    const t = await eventServices({ WEBFLIX_DELETION_COOLING_OFF_SEC: "3600" }, {});
    const member = await createMember(t, "acc-terms", { membership: false });
    const { terms } = await t.services.events.listPrivacyRequests(member.as("adult"));
    await elevate(t, member);
    const deletion = await t.services.events.requestDeletion(member.as("adult"));
    expect(Date.parse(deletion.scheduledFor ?? "") - Date.parse(deletion.requestedAt)).toBe(
      terms.deletionCoolingOffSec * 1000,
    );
  });
});

describe("asking for a deletion stops the membership's renewals", () => {
  it("at once: the membership ends at its period's close, or with the account if sooner", async () => {
    const t = await eventServices({}, {});
    const member = await providerMember(t, "acc-paying", { paying: true });
    const before = await billingState(t, member);
    expect(before).toMatchObject({ status: "active", cancelAtPeriodEnd: false });
    const periodEnd = Date.parse(before.currentPeriodEnd ?? "");
    await elevate(t, member);
    const deletion = await t.services.events.requestDeletion(member.as("adult"));
    // A paid month outlasts the 14 days: the erasure ends it, on the scheduled date.
    expect(periodEnd).toBeGreaterThan(Date.parse(deletion.scheduledFor ?? ""));
    expect(deletion.membership).toEqual({
      status: "ending",
      endsAt: deletion.scheduledFor,
      resumable: false,
    });
    // Billing's own record: set to end, so the provider charges no renewal.
    expect(await billingState(t, member)).toMatchObject({
      status: "active",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: before.currentPeriodEnd,
    });
    expect((await deletionOf(t, member))?.membership).toEqual(deletion.membership);
  });

  it("a period that closes inside the cooling-off simply ends the membership", async () => {
    const t = await eventServices({}, {});
    const member = await providerMember(t, "acc-trial");
    const before = await billingState(t, member);
    expect(before.status).toBe("trialing");
    await elevate(t, member);
    const deletion = await t.services.events.requestDeletion(member.as("adult"));
    expect(Date.parse(before.trialEndsAt ?? "")).toBeLessThan(
      Date.parse(deletion.scheduledFor ?? ""),
    );
    expect(deletion.membership).toEqual({
      status: "ending",
      endsAt: before.trialEndsAt,
      resumable: false,
    });
    expect(await billingState(t, member)).toMatchObject({ cancelAtPeriodEnd: true });
    // Once the trial is over the membership has ended; the deletion still runs on its date.
    t.clock.advance(8 * DAY_MS);
    expect(await deletionOf(t, member)).toMatchObject({
      status: "scheduled",
      membership: { status: "ended", endsAt: null, resumable: false },
    });
  });

  it("keeping the account leaves the membership set to end, with one action to resume it", async () => {
    const t = await eventServices({}, {});
    const member = await providerMember(t, "acc-keeps", { paying: true });
    const periodEnd = (await billingState(t, member)).currentPeriodEnd;
    await elevate(t, member);
    await t.services.events.requestDeletion(member.as("adult"));
    await t.services.events.cancelDeletion(member.as("adult"));
    // Not silently turned back on.
    expect(await billingState(t, member)).toMatchObject({ cancelAtPeriodEnd: true });
    expect(await deletionOf(t, member)).toMatchObject({
      status: "canceled",
      membership: { status: "ending", endsAt: periodEnd, resumable: true },
    });
    // The member resumes it (billing's resume): it renews again, nothing left to offer.
    await t.services.billing.resume(member.accountId);
    expect(await billingState(t, member)).toMatchObject({ cancelAtPeriodEnd: false });
    expect((await deletionOf(t, member))?.membership).toEqual({
      status: "renewing",
      endsAt: null,
      resumable: false,
    });
    // Asking again stops the renewals again.
    await elevate(t, member);
    const again = await t.services.events.requestDeletion(member.as("adult"));
    expect(again.membership?.status).toBe("ending");
    expect(await billingState(t, member)).toMatchObject({ cancelAtPeriodEnd: true });
  });

  it("an account with no membership a provider renews is recorded as such", async () => {
    const t = await eventServices({}, {});
    // Sign-up without a card: no membership at all.
    const bare = await createMember(t, "acc-bare", { membership: false });
    await elevate(t, bare);
    expect((await t.services.events.requestDeletion(bare.as("adult"))).membership).toEqual({
      status: "none",
      endsAt: null,
      resumable: false,
    });
    // Milestone 1's mock membership charges nothing on renewal: nothing to stop.
    const legacy = await createMember(t, "acc-legacy");
    await elevate(t, legacy);
    expect((await t.services.events.requestDeletion(legacy.as("adult"))).membership?.status).toBe(
      "none",
    );
    // An export says nothing about the membership.
    const exported = await t.services.events.requestExport(legacy.as("adult"));
    expect(exported.membership).toBeNull();
  });

  it("is recorded whatever billing answers, and a failure to stop the renewals is retried", async () => {
    const t = await eventServices({}, {});
    const member = await providerMember(t, "acc-outage", { paying: true });
    const cancel = vi
      .spyOn(t.ports.payments, "setCancelAtPeriodEnd")
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockRejectedValueOnce(new Error("provider unavailable"));
    await elevate(t, member);
    const deletion = await t.services.events.requestDeletion(member.as("adult"));
    expect(deletion).toMatchObject({
      status: "scheduled",
      membership: { status: "stopping", endsAt: null, resumable: false },
    });
    expect(await billingState(t, member)).toMatchObject({ cancelAtPeriodEnd: false });
    // The next sweep fails again: still stopping, never lost.
    await sweep(t);
    expect((await deletionOf(t, member))?.membership?.status).toBe("stopping");
    // Then the provider answers: the renewals stop.
    await sweep(t);
    expect(cancel).toHaveBeenCalledTimes(3);
    expect((await deletionOf(t, member))?.membership).toMatchObject({ status: "ending" });
    expect(await billingState(t, member)).toMatchObject({ cancelAtPeriodEnd: true });
    // Nothing left to retry.
    await sweep(t);
    expect(cancel).toHaveBeenCalledTimes(3);
  });

  it("a deletion the member keeps before billing answered stops being retried", async () => {
    const t = await eventServices({}, {});
    const member = await providerMember(t, "acc-quick", { paying: true });
    const cancel = vi
      .spyOn(t.ports.payments, "setCancelAtPeriodEnd")
      .mockRejectedValueOnce(new Error("provider unavailable"));
    await elevate(t, member);
    await t.services.events.requestDeletion(member.as("adult"));
    await t.services.events.cancelDeletion(member.as("adult"));
    await sweep(t);
    expect(cancel).toHaveBeenCalledTimes(1);
    // The membership was never touched: it renews as before, nothing to resume.
    expect((await deletionOf(t, member))?.membership).toEqual({
      status: "renewing",
      endsAt: null,
      resumable: false,
    });
  });

  it("the erasure ends whatever is left of the membership", async () => {
    const t = await eventServices({}, {});
    const member = await providerMember(t, "acc-erased", { paying: true });
    await elevate(t, member);
    const deletion = await t.services.events.requestDeletion(member.as("adult"));
    t.clock.advance(15 * DAY_MS);
    await sweep(t);
    const staff = await t.services.events.staff.privacyRequests(member.accountId);
    expect(staff.find((item) => item.id === deletion.id)).toMatchObject({
      status: "completed",
      membership: { status: "ended" },
    });
  });
});

describe("while a deletion is scheduled, the member cannot make the membership renew again", () => {
  const refused = { code: "account_deletion_scheduled" };

  it("resume and a plan change are refused; keeping the account makes resume work at once", async () => {
    const t = await eventServices({}, {});
    const member = await providerMember(t, "acc-guard", { paying: true });
    await elevate(t, member);
    await t.services.events.requestDeletion(member.as("adult"));
    expect(await t.services.seams.accountDeletionScheduled(member.accountId)).toBe(true);
    await expect(t.services.billing.resume(member.accountId)).rejects.toMatchObject(refused);
    await expect(
      t.services.billing.changePlan(member.accountId, { planId: "premium" }),
    ).rejects.toMatchObject(refused);
    // Still set to end, still on its plan, and the privacy state never says "renewing".
    expect(await billingState(t, member)).toMatchObject({
      planId: "basic",
      cancelAtPeriodEnd: true,
    });
    expect((await deletionOf(t, member))?.membership?.status).toBe("ending");
    // Keeping the account lifts the rule at once.
    await t.services.events.cancelDeletion(member.as("adult"));
    expect(await t.services.seams.accountDeletionScheduled(member.accountId)).toBe(false);
    await t.services.billing.resume(member.accountId);
    expect(await billingState(t, member)).toMatchObject({ cancelAtPeriodEnd: false });
  });

  it("a new checkout is refused, and one started before is not confirmed", async () => {
    const t = await eventServices({}, {});
    // Signed up without a card: no membership yet.
    const bare = await createMember(t, "acc-no-card", { membership: false });
    await elevate(t, bare);
    await t.services.events.requestDeletion(bare.as("adult"));
    await expect(
      t.services.billing.startCheckout(bare.as("adult"), { planId: "basic" }),
    ).rejects.toMatchObject(refused);
    // A checkout started before the deletion was asked for creates no subscription meanwhile.
    const early = await createMember(t, "acc-early", { membership: false });
    const started = await t.services.billing.startCheckout(early.as("adult"), { planId: "basic" });
    await t.ports.payments.confirmSetup(started.clientSecret ?? "", "visa");
    await elevate(t, early);
    await t.services.events.requestDeletion(early.as("adult"));
    await expect(
      t.services.billing.confirmCheckout(early.accountId, started.id),
    ).rejects.toMatchObject(refused);
    expect((await billingState(t, early)).status).toBe("none");
    // Kept: the same checkout goes through.
    await t.services.events.cancelDeletion(early.as("adult"));
    const confirmed = await t.services.billing.confirmCheckout(early.accountId, started.id);
    expect(confirmed.status).not.toBe("requires_setup");
  });

  it("staff actions are not refused (deliberate and audited)", async () => {
    const t = await eventServices({}, {});
    const trial = await providerMember(t, "acc-staff-trial");
    const paying = await providerMember(t, "acc-staff-paying", { paying: true });
    for (const member of [trial, paying]) {
      await elevate(t, member);
      await t.services.events.requestDeletion(member.as("adult"));
    }
    await expect(
      t.services.billing.extendTrial({ accountId: trial.accountId, days: 3 }),
    ).resolves.toMatchObject({ status: "trialing" });
    await expect(
      t.services.billing.grantComplimentaryPeriod({ accountId: paying.accountId, days: 7 }),
    ).resolves.toBeTruthy();
  });
});
