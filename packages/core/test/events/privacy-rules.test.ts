/**
 * The privacy rules of milestone 2 §6.3, one test (or a few) per rule, each failing when the
 * rule is broken. docs/BACKEND.md §9 lists them with the code each one guards.
 */
import { describe, expect, it } from "vitest";
import { createSubjectKeys, DEV_ONLY_PSEUDONYM_KEY } from "../../src/index.ts";
import { clientEvent, createMember, eventServices, lakeEvents, settle } from "./helpers.ts";

const PLAYBACK = {
  playbackSessionId: "0193a1d2-7c4e-7a10-8f00-0000000000aa",
  titleId: "t-orbit",
  episodeId: null,
  positionSec: 10,
  durationSec: 600,
  watchedSec: 10,
};

describe("privacy rule: a restricted profile produces no behavioural events, by any path", () => {
  it("drops every client event of a kids profile, and of a profile with a lowered ceiling", async () => {
    const t = await eventServices();
    const member = await createMember(t);
    for (const profile of ["kids", "teen"] as const) {
      const ack = await t.services.events.ingest({
        auth: member.as(profile),
        events: [clientEvent("impression"), clientEvent("title.open"), clientEvent("rating.set")],
        gpc: false,
        country: null,
      });
      expect(ack).toEqual({ accepted: 0, dropped: 3 });
    }
    await settle(t);
    expect(lakeEvents(t.sink)).toEqual([]);
  });

  it("drops server events (playback, exposure) attributed to a kids profile", async () => {
    const t = await eventServices();
    const member = await createMember(t);
    await t.services.events.emitServerEvent({
      type: "playback.start",
      payload: PLAYBACK,
      accountId: member.accountId,
      profileId: member.profiles.kids.id,
    });
    await t.services.events.emitServerEvent({
      type: "experiment.exposure",
      payload: { experimentKey: "recs.x", variant: "a", unitType: "profile" },
      accountId: member.accountId,
      profileId: member.profiles.teen.id,
    });
    await settle(t);
    expect(lakeEvents(t.sink)).toEqual([]);
  });

  it("drops the kids profile's playback through the real playback service", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t);
    const kids = { session: member.as("kids").session, profile: member.profiles.kids };
    const adult = { session: member.as("adult").session, profile: member.profiles.adult };
    for (const viewer of [kids, adult]) {
      const session = await t.services.playback.start(viewer, { titleId: "t-lanterns" });
      await t.services.playback.end(viewer, session.id);
    }
    await settle(t);
    const keys = createSubjectKeys(DEV_ONLY_PSEUDONYM_KEY);
    const kidsKey = await keys.profile(member.profiles.kids.id);
    const stored = lakeEvents(t.sink);
    expect(stored.length).toBeGreaterThan(0); // the adult's playback is recorded
    expect(stored.some((event) => event.subject.profile === kidsKey)).toBe(false);
  });
});

describe("privacy rule: identities come from the server, never from the client", () => {
  it("stamps the session's subject, whatever the session is", async () => {
    const t = await eventServices();
    const one = await createMember(t, "acc-one");
    const two = await createMember(t, "acc-two");
    await t.services.events.ingest({
      auth: two.as("adult"),
      events: [clientEvent("list.add")],
      gpc: false,
      country: null,
    });
    await settle(t);
    const keys = createSubjectKeys(DEV_ONLY_PSEUDONYM_KEY);
    const [event] = lakeEvents(t.sink);
    expect(event?.subject.account).toBe(await keys.account(two.accountId));
    expect(event?.subject.account).not.toBe(await keys.account(one.accountId));
    // The contract itself refuses a client-supplied subject (ClientEventInput is closed).
  });
});

describe("privacy rule: consent per account, the latest stamp wins", () => {
  it("drops events once both purposes are withdrawn, keeps them with one purpose granted", async () => {
    const t = await eventServices();
    const member = await createMember(t);
    const auth = member.as("adult");
    await t.services.events.updateConsent(
      auth,
      { purpose: "personalisation", granted: false, source: "settings" },
      { gpc: false },
    );
    let ack = await t.services.events.ingest({
      auth,
      events: [clientEvent("impression")],
      gpc: false,
      country: null,
    });
    expect(ack.accepted).toBe(1);
    await t.services.events.updateConsent(
      auth,
      { purpose: "analytics", granted: false, source: "settings" },
      { gpc: false },
    );
    ack = await t.services.events.ingest({
      auth,
      events: [clientEvent("impression")],
      gpc: false,
      country: null,
    });
    expect(ack).toEqual({ accepted: 0, dropped: 1 });
    await settle(t);
    const behavioural = lakeEvents(t.sink).filter((event) => event.type === "impression");
    expect(behavioural).toHaveLength(1);
    expect(behavioural[0]?.subject.consent).toEqual({ analytics: true, personalisation: false });
  });

  it("applies the account's consent to every session and to server events alike", async () => {
    const t = await eventServices();
    const member = await createMember(t);
    await t.services.events.updateConsent(
      member.as("adult"),
      { purpose: "analytics", granted: false, source: "banner" },
      { gpc: false },
    );
    await t.services.events.updateConsent(
      member.as(null),
      { purpose: "personalisation", granted: false, source: "banner" },
      { gpc: false },
    );
    t.clock.advance(1000);
    await t.services.events.emitServerEvent({
      type: "playback.start",
      payload: PLAYBACK,
      accountId: member.accountId,
      profileId: member.profiles.adult.id,
    });
    await settle(t);
    expect(lakeEvents(t.sink).filter((event) => event.type === "playback.start")).toEqual([]);
  });

  it("emits a consent.change server event carrying the new stamp, even when everything is withdrawn", async () => {
    const t = await eventServices();
    const member = await createMember(t);
    await t.services.events.updateConsent(
      member.as("adult"),
      { purpose: "analytics", granted: false, source: "settings" },
      { gpc: false },
    );
    t.clock.advance(10);
    await t.services.events.updateConsent(
      member.as("adult"),
      { purpose: "personalisation", granted: false, source: "settings" },
      { gpc: false },
    );
    await settle(t);
    const changes = lakeEvents(t.sink).filter((event) => event.type === "consent.change");
    expect(changes.map((event) => event.payload)).toEqual([
      { purpose: "analytics", granted: false, source: "settings" },
      { purpose: "personalisation", granted: false, source: "settings" },
    ]);
    expect(changes.at(-1)?.subject.consent).toEqual({ analytics: false, personalisation: false });
    expect(changes.every((event) => event.subject.profile === null)).toBe(true);
  });

  it("stamps an event with the consent in force at its receipt, not when the queue gets to it", async () => {
    const t = await eventServices();
    const member = await createMember(t);
    await t.services.events.emitServerEvent({
      type: "playback.start",
      payload: PLAYBACK,
      accountId: member.accountId,
      profileId: member.profiles.adult.id,
    });
    t.clock.advance(5000);
    // Withdrawn after the event was received, before it is processed: the event stays as it was.
    await t.services.events.updateConsent(
      member.as("adult"),
      { purpose: "personalisation", granted: false, source: "settings" },
      { gpc: false },
    );
    await settle(t);
    const start = lakeEvents(t.sink).find((event) => event.type === "playback.start");
    expect(start?.subject.consent).toEqual({ analytics: true, personalisation: true });
  });

  it("refuses a consent answer from a restricted profile", async () => {
    const t = await eventServices();
    const member = await createMember(t);
    await expect(
      t.services.events.updateConsent(
        member.as("kids"),
        { purpose: "analytics", granted: true, source: "banner" },
        { gpc: false },
      ),
    ).rejects.toMatchObject({ code: "unrestricted_profile_required" });
  });
});

describe("privacy rule: consent modes behave as configured", () => {
  it("opt-in collects nothing until the member grants a purpose", async () => {
    const t = await eventServices({ WEBFLIX_CONSENT_MODE: "opt-in" });
    const member = await createMember(t);
    const auth = member.as("adult");
    const before = await t.services.events.getConsent(auth, { gpc: false });
    expect(before.promptRequired).toBe(true);
    expect(before.purposes.analytics).toEqual({ granted: false, source: null, updatedAt: null });
    expect(
      await t.services.events.ingest({
        auth,
        events: [clientEvent("impression")],
        gpc: false,
        country: null,
      }),
    ).toEqual({ accepted: 0, dropped: 1 });
    await t.services.events.updateConsent(
      auth,
      { purpose: "analytics", granted: true, source: "banner" },
      { gpc: false },
    );
    expect(
      await t.services.events.ingest({
        auth,
        events: [clientEvent("impression")],
        gpc: false,
        country: null,
      }),
    ).toEqual({ accepted: 1, dropped: 0 });
    // Signed out: only the device's own answer counts.
    expect(
      await t.services.events.ingest({
        auth: null,
        events: [clientEvent("impression")],
        gpc: false,
        country: null,
      }),
    ).toEqual({ accepted: 0, dropped: 1 });
    expect(
      await t.services.events.ingest({
        auth: null,
        events: [clientEvent("impression")],
        consent: { analytics: true, personalisation: false },
        gpc: false,
        country: null,
      }),
    ).toEqual({ accepted: 1, dropped: 0 });
  });

  it("off collects nothing at all, server events included", async () => {
    const t = await eventServices({ WEBFLIX_CONSENT_MODE: "off" });
    const member = await createMember(t);
    expect(
      await t.services.events.ingest({
        auth: member.as("adult"),
        events: [clientEvent("impression")],
        consent: { analytics: true, personalisation: true },
        gpc: false,
        country: null,
      }),
    ).toEqual({ accepted: 0, dropped: 1 });
    await t.services.events.emitServerEvent({
      type: "playback.start",
      payload: PLAYBACK,
      accountId: member.accountId,
      profileId: member.profiles.adult.id,
    });
    await settle(t);
    expect(lakeEvents(t.sink)).toEqual([]);
  });

  it("opt-out honours Global Privacy Control as a recorded withdrawal (server events stop too)", async () => {
    const t = await eventServices({ WEBFLIX_CONSENT_MODE: "opt-out" });
    const member = await createMember(t);
    const auth = member.as("adult");
    const ack = await t.services.events.ingest({
      auth,
      events: [clientEvent("impression")],
      gpc: true,
      country: null,
    });
    expect(ack).toEqual({ accepted: 0, dropped: 1 });
    const state = await t.services.events.getConsent(auth, { gpc: false });
    expect(state.purposes.analytics).toMatchObject({ granted: false, source: "gpc" });
    expect(state.purposes.personalisation).toMatchObject({ granted: false, source: "gpc" });
    t.clock.advance(1000);
    await t.services.events.emitServerEvent({
      type: "playback.start",
      payload: PLAYBACK,
      accountId: member.accountId,
      profileId: member.profiles.adult.id,
    });
    await settle(t);
    const stored = lakeEvents(t.sink);
    expect(stored.filter((event) => event.type === "playback.start")).toEqual([]);
    expect(stored.filter((event) => event.type === "consent.change")).toHaveLength(2);
    // An explicit grant afterwards is the member's own choice: the latest stamp wins.
    await t.services.events.updateConsent(
      auth,
      { purpose: "analytics", granted: true, source: "settings" },
      { gpc: true },
    );
    const again = await t.services.events.ingest({
      auth,
      events: [clientEvent("impression")],
      gpc: true,
      country: null,
    });
    expect(again.accepted).toBe(1);
    // Signed out with GPC and no answer of the device's own: nothing collected.
    expect(
      await t.services.events.ingest({
        auth: null,
        events: [clientEvent("impression")],
        gpc: true,
        country: null,
      }),
    ).toEqual({ accepted: 0, dropped: 1 });
  });
});

describe("the emitServerEvent seam", () => {
  it("never fails the caller: a refused queue is logged and swallowed", async () => {
    const t = await eventServices();
    t.queue.publish = async () => {
      throw new Error("queue down");
    };
    await expect(
      t.services.seams.emitServerEvent({
        type: "auth.signin",
        payload: { method: "password", outcome: "success" },
        accountId: "acc-x",
        profileId: null,
      }),
    ).resolves.toBeUndefined();
    expect(t.logger.records.some((record) => record.msg === "events.server_event_failed")).toBe(
      true,
    );
  });

  it("never fails the caller on a malformed payload either (a bug in the producer)", async () => {
    const t = await eventServices();
    await expect(
      t.services.seams.emitServerEvent({
        type: "billing.transition",
        payload: { from: "nonsense", to: "active", planId: null } as never,
        accountId: "acc-x",
        profileId: null,
        deviceId: "not a device id!",
      }),
    ).resolves.toBeUndefined();
  });

  it("stores other areas' events as they call it today, without any change on their side", async () => {
    const t = await eventServices();
    const member = await createMember(t);
    await t.services.seams.emitServerEvent({
      type: "auth.signin",
      payload: { method: "password", outcome: "success" },
      accountId: member.accountId,
      profileId: member.profiles.adult.id, // ignored: a sign-in carries no profile
    });
    await t.services.seams.emitServerEvent({
      type: "billing.transition",
      payload: { from: "trialing", to: "active", planId: "premium" },
      accountId: member.accountId,
      profileId: null,
    });
    await t.services.seams.emitServerEvent({
      type: "experiment.exposure",
      payload: {
        experimentKey: "recs.learned-vs-rules",
        variant: "treatment",
        unitType: "profile",
      },
      accountId: member.accountId,
      profileId: member.profiles.adult.id,
      context: { experiments: { "recs.learned-vs-rules": "treatment" } },
    });
    await settle(t);
    const stored = lakeEvents(t.sink);
    expect(stored.map((event) => event.type)).toEqual([
      "auth.signin",
      "billing.transition",
      "experiment.exposure",
    ]);
    expect(stored[0]?.subject.profile).toBeNull();
    expect(stored[2]?.context.experiments).toEqual({ "recs.learned-vs-rules": "treatment" });
    expect(stored.every((event) => event.source === "server" && event.sessionSeq === null)).toBe(
      true,
    );
  });

  it("drops an event whose account was erased before it was processed", async () => {
    const t = await eventServices();
    await t.services.events.emitServerEvent({
      type: "billing.transition",
      payload: { from: "active", to: "canceled", planId: null },
      accountId: "acc-never-existed",
      profileId: null,
    });
    await settle(t);
    expect(lakeEvents(t.sink)).toEqual([]);
  });
});
