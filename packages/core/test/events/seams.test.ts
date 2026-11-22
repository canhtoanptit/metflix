/**
 * The events area at its seams with the other areas: the plan from billing, a member without a
 * membership (milestone 2's sign-up without a card), the export email through identity's
 * templates, availability at playback start, and the abandonment of a session nobody released.
 */
import type { LakeEvent } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import type { StaffAction } from "../../src/index.ts";
import { createSubjectKeys, DEV_ONLY_PSEUDONYM_KEY, type Viewer } from "../../src/index.ts";
import {
  clientEvent,
  createMember,
  DAY_MS,
  elevate,
  eventServices,
  lakeEvents,
  settle,
} from "./helpers.ts";

const STAFF: StaffAction = {
  actor: { type: "staff", id: "staff-1", name: "Ada" },
  reason: "Licence window ended",
  requestId: "req-1",
};

describe("the plan on a subject comes from billing", () => {
  it("stamps billing's current plan, client and server events alike", async () => {
    const t = await eventServices();
    const member = await createMember(t);
    let asked = 0;
    const billing = t.services.billing;
    const original = billing.currentPlan.bind(billing);
    billing.currentPlan = async (accountId) => {
      asked += 1;
      expect(accountId).toBe(member.accountId);
      return (await original(accountId)) === "premium" ? "basic" : null;
    };
    await t.services.events.ingest({
      auth: member.as("adult"),
      events: [clientEvent("impression")],
      gpc: false,
      country: null,
    });
    await t.services.events.emitServerEvent({
      type: "billing.transition",
      payload: { from: "active", to: "active", planId: "basic" },
      accountId: member.accountId,
      profileId: null,
    });
    await settle(t);
    expect(asked).toBe(2);
    expect(lakeEvents(t.sink).map((event) => event.subject.plan)).toEqual(["basic", "basic"]);
  });
});

describe("a member without a membership", () => {
  async function bare() {
    const t = await eventServices({}, {});
    const member = await createMember(t, "acc-bare", { membership: false });
    expect(await t.deps.repos.accounts.get(member.accountId)).toBeNull(); // no milestone 1 row
    return { t, member };
  }

  it("has its events stamped, with no plan rather than an invented one", async () => {
    const { t, member } = await bare();
    const ack = await t.services.events.ingest({
      auth: member.as("adult"),
      events: [clientEvent("title.open")],
      gpc: false,
      country: null,
    });
    expect(ack).toEqual({ accepted: 1, dropped: 0 });
    await t.services.events.emitServerEvent({
      type: "auth.signin",
      payload: { method: "password", outcome: "success" },
      accountId: member.accountId,
      profileId: null,
    });
    await settle(t);
    const keys = createSubjectKeys(DEV_ONLY_PSEUDONYM_KEY);
    const stored = lakeEvents(t.sink);
    expect(stored.map((event) => event.type)).toEqual(["title.open", "auth.signin"]);
    for (const event of stored) {
      expect(event.subject.account).toBe(await keys.account(member.accountId));
      expect(event.subject.plan).toBeNull();
    }
  });

  it("gets a complete export", async () => {
    const { t, member } = await bare();
    await t.deps.repos.library.addToMyList(member.profiles.adult.id, "t-lanterns", t.clock.now());
    await elevate(t, member);
    const request = await t.services.events.requestExport(member.as("adult"));
    await settle(t);
    const [listed] = (await t.services.events.listPrivacyRequests(member.as("adult"))).items;
    expect(listed?.status).toBe("completed");
    const token = new URL(`http://x${listed?.downloadUrl}`).searchParams.get("token") ?? "";
    const document = await t.services.events.downloadExport(member.as("adult"), request.id, token);
    expect(document.account).toMatchObject({ id: member.accountId, email: "acc-bare@example.com" });
    expect(document.profiles).toHaveLength(3);
    expect(document.devices.map((device) => device.id)).toEqual([member.sessionId]);
    expect(
      document.library.find((entry) => entry.profileId === member.profiles.adult.id)?.myList,
    ).toMatchObject([{ titleId: "t-lanterns" }]);
    expect(document.areas.billing).toMatchObject({ membership: null, invoices: [] });
    expect(document.areas.identity).toMatchObject({ hasPassword: false, linkedIdentities: [] });
  });

  it("can delete its account, and the erasure completes", async () => {
    const { t, member } = await bare();
    await elevate(t, member);
    const request = await t.services.events.requestDeletion(member.as("adult"));
    t.clock.advance(14 * DAY_MS + 1);
    await t.services.scheduler.tick();
    await settle(t);
    expect(await t.deps.repos.events.getPrivacyRequest(request.id)).toMatchObject({
      status: "completed",
    });
    expect(await t.deps.repos.identity.getAccount(member.accountId)).toBeNull();
    expect(await t.deps.repos.profiles.list(member.accountId)).toEqual([]);
    expect(await t.services.events.staff.pendingErasures(10)).toHaveLength(1);
  });

  it("is told a membership is required at playback start, not that it is signed out", async () => {
    const { t, member } = await bare();
    const viewer: Viewer = { session: member.as("adult").session, profile: member.profiles.adult };
    await expect(
      t.services.playback.start(viewer, { titleId: "t-lanterns" }),
    ).rejects.toMatchObject({
      code: "subscription_required",
    });
  });
});

describe("the export email", () => {
  it("goes through identity's data-export-ready template, once per export", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t);
    await elevate(t, member);
    const request = await t.services.events.requestExport(member.as("adult"));
    await settle(t);
    const mail = t.ports.email.mailbox(`${member.accountId}@example.com`);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({
      template: "data-export-ready",
      subject: "Your Webflix data is ready to download",
      idempotencyKey: `privacy-export:${request.id}`,
    });
    expect(mail[0]?.html).toContain(`/api/v1/privacy/exports/${request.id}?token=`);
  });

  it("is not sent to a suppressed address; the export still completes and is listed", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t);
    await t.deps.repos.identity.suppress({
      address: `${member.accountId}@example.com`,
      reason: "bounce",
      source: "test",
      createdAt: t.clock.now(),
    });
    await elevate(t, member);
    await t.services.events.requestExport(member.as("adult"));
    await settle(t);
    expect(t.ports.email.mailbox()).toEqual([]);
    const [listed] = (await t.services.events.listPrivacyRequests(member.as("adult"))).items;
    expect(listed).toMatchObject({ status: "completed" });
    expect(listed?.downloadUrl).not.toBeNull();
  });
});

describe("availability at playback start", () => {
  it("refuses a title staff switched off, answering as the detail page does", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t);
    const viewer: Viewer = { session: member.as("adult").session, profile: member.profiles.adult };
    await t.services.personalisation.setTitleAvailability(
      "t-lanterns",
      { available: false },
      STAFF,
    );
    await expect(t.services.browse.getTitle(viewer, "t-lanterns")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      t.services.playback.start(viewer, { titleId: "t-lanterns" }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    // Back on: playable again.
    await t.services.personalisation.setTitleAvailability("t-lanterns", { available: true }, STAFF);
    await expect(
      t.services.playback.start(viewer, { titleId: "t-lanterns" }),
    ).resolves.toMatchObject({
      titleId: "t-lanterns",
    });
  });

  it("refuses a title outside its availability window", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t);
    const viewer: Viewer = { session: member.as("adult").session, profile: member.profiles.adult };
    await t.services.personalisation.setTitleAvailability(
      "t-lanterns",
      { available: true, availableFrom: new Date(t.clock.now() + DAY_MS).toISOString() },
      STAFF,
    );
    await expect(
      t.services.playback.start(viewer, { titleId: "t-lanterns" }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("a playback session nobody released", () => {
  const abandons = (events: LakeEvent[]) =>
    events.filter((event) => event.type === "playback.abandon");

  it("is ended once its slot lapsed, with one playback.abandon (expired)", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t);
    const viewer: Viewer = { session: member.as("adult").session, profile: member.profiles.adult };
    const session = await t.services.playback.start(viewer, { titleId: "t-lanterns" });
    t.clock.advance(30_000);
    await t.services.playback.heartbeat(viewer, session.id, {
      positionSec: 30,
      durationSec: session.durationSec,
      state: "playing",
    });
    const lastReport = t.clock.now();
    // The tab is killed: no release, no more reports. Not yet expired a minute later.
    t.clock.advance(60_000);
    await t.services.scheduler.tick();
    await settle(t);
    expect(abandons(lakeEvents(t.sink))).toEqual([]);
    expect((await t.deps.repos.playback.get(session.id))?.endedAt).toBeNull();
    // Well past the slot's lapse: ended, abandoned once.
    t.clock.advance(10 * 60_000);
    await t.services.scheduler.tick();
    await settle(t);
    await t.services.scheduler.tick();
    await settle(t);
    const [abandon, ...more] = abandons(lakeEvents(t.sink));
    expect(more).toEqual([]);
    expect(abandon?.payload).toMatchObject({
      playbackSessionId: session.id,
      reason: "expired",
      positionSec: 30,
    });
    expect(Date.parse(abandon?.occurredAt ?? "")).toBeGreaterThanOrEqual(lastReport - 5_000);
    expect((await t.deps.repos.playback.get(session.id))?.endedAt).not.toBeNull();
    // A report that comes back later is refused like any ended session.
    await expect(
      t.services.playback.heartbeat(viewer, session.id, {
        positionSec: 40,
        durationSec: session.durationSec,
        state: "playing",
      }),
    ).rejects.toMatchObject({ code: "playback_session_ended" });
  });

  it("is left alone while its slot is still held, and writes nothing for a kids profile", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t);
    const kids: Viewer = { session: member.as("kids").session, profile: member.profiles.kids };
    const kidSession = await t.services.playback.start(kids, { titleId: "t-lanterns" });
    t.clock.advance(15 * 60_000);
    await t.services.scheduler.tick();
    await settle(t);
    expect((await t.deps.repos.playback.get(kidSession.id))?.endedAt).not.toBeNull();
    expect(abandons(lakeEvents(t.sink))).toEqual([]);

    const adult: Viewer = { session: member.as("adult").session, profile: member.profiles.adult };
    const held = await t.services.playback.start(adult, { titleId: "t-thaw" });
    // The slot is renewed (as the player's reports would), though the credit clock is old.
    await t.gate.renew(member.accountId, held.id, 3600);
    t.clock.advance(15 * 60_000);
    await t.gate.renew(member.accountId, held.id, 3600);
    await t.services.scheduler.tick();
    await settle(t);
    expect((await t.deps.repos.playback.get(held.id))?.endedAt).toBeNull();
  });
});
