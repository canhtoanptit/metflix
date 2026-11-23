/**
 * The privacy review's findings in the events area (H1, H2, M1, M4, M6, M7, L1, L2, L6, L10),
 * each as the rule it now holds: an erasure never strands, exports never outlive their day or
 * their records, staff never grant consent, the export's notes are true, the member is emailed
 * about a deletion, personalisation hears of every answer about its purpose, a download needs a
 * fresh proof, an erased subject's events never come back.
 */
import { makeLakeEvent } from "@webflix/contracts/fixtures";
import { describe, expect, it } from "vitest";
import { appendEventsJob } from "../../src/areas/events/jobs.ts";
import { erasureBackoffMs, exportNotes } from "../../src/areas/events/privacy.ts";
import { createSubjectKeys, DEV_ONLY_PSEUDONYM_KEY, erasedAddress } from "../../src/index.ts";
import {
  clientEvent,
  createMember,
  DAY_MS,
  elevate,
  eventServices,
  lakeEvents,
  type Member,
  settle,
} from "./helpers.ts";

type T = Awaited<ReturnType<typeof eventServices>>;
const keys = createSubjectKeys(DEV_ONLY_PSEUDONYM_KEY);
const MINUTE = 60_000;

/** Schedule a deletion and let its cooling-off end; the erasure's first run happens next. */
async function deletionDue(t: T, member: Member) {
  await elevate(t, member);
  const request = await t.services.events.requestDeletion(member.as("adult"));
  t.clock.advance(14 * DAY_MS + 1);
  return request;
}

async function tick(t: T) {
  await t.services.scheduler.tick();
  await settle(t);
}

/** A lake event of the account (and profile) as ingestion would have stamped it. */
async function stampedEvent(accountId: string, profileId: string, receivedAt: number) {
  return makeLakeEvent("impression", {
    receivedAt: new Date(receivedAt).toISOString(),
    subject: {
      account: await keys.account(accountId),
      profile: await keys.profile(profileId),
      plan: null,
      country: null,
      restricted: false,
      consent: { analytics: true, personalisation: true },
    },
  });
}

describe("H2: an erasure never ends up stranded", () => {
  it("locks the account from its start, whatever later step fails, and stores nothing new for it", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t, "acc-locked");
    Object.assign(t.services.personalisation, {
      eraseAccountData: async () => {
        throw new Error("recommendation store unavailable");
      },
    });
    const request = await deletionDue(t, member);
    const before = await t.deps.repos.accounts.get(member.accountId);
    await tick(t);
    // The step after the lock failed: the request is in progress, the account still exists...
    expect(await t.deps.repos.events.getPrivacyRequest(request.id)).toMatchObject({
      status: "processing",
      attempts: 1,
      lastError: "recommendation store unavailable",
    });
    const locked = await t.deps.repos.accounts.get(member.accountId);
    expect(locked).not.toBeNull();
    // ...but nobody can use it: no session, no password, no address any sign-in could find.
    expect(await t.deps.repos.sessions.listForAccount(member.accountId, t.clock.now())).toEqual([]);
    expect(locked?.account).toMatchObject({
      email: erasedAddress(member.accountId),
      passwordHash: "",
    });
    expect(await t.deps.repos.accounts.findByEmail(before?.account.email ?? "")).toBeNull();
    // Nothing new is stored for it: a late append of its events is refused.
    const event = await stampedEvent(member.accountId, member.profiles.adult.id, t.clock.now());
    await t.queue.publish(appendEventsJob.create({ events: [event] }));
    await settle(t);
    expect(lakeEvents(t.sink).map((stored) => stored.eventId)).not.toContain(event.eventId);
  });

  it("is retried with bounded backoff for as long as it takes, never dead-lettered", async () => {
    expect([1, 2, 3, 4, 7, 8, 30].map(erasureBackoffMs)).toEqual([
      MINUTE,
      2 * MINUTE,
      4 * MINUTE,
      8 * MINUTE,
      60 * MINUTE,
      60 * MINUTE,
      60 * MINUTE,
    ]);
    const t = await eventServices({}, {});
    const member = await createMember(t, "acc-retried");
    let failures = 9;
    Object.assign(t.services.billing, {
      eraseAccountData: async () => {
        if (failures-- > 0) throw new Error("provider unreachable");
      },
    });
    const request = await deletionDue(t, member);
    await tick(t);
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const record = await t.deps.repos.events.getPrivacyRequest(request.id);
      expect(record).toMatchObject({ status: "processing", attempts: attempt });
      // Not before its backoff...
      t.clock.advance(erasureBackoffMs(attempt) - 1000);
      await tick(t);
      expect((await t.deps.repos.events.getPrivacyRequest(request.id))?.attempts).toBe(attempt);
      // ...then again.
      t.clock.advance(1000);
      await tick(t);
    }
    expect(await t.deps.repos.events.getPrivacyRequest(request.id)).toMatchObject({
      status: "completed",
      attempts: 10,
      lastError: null,
    });
    expect(t.queue.deadLetters).toEqual([]);
  });

  it("is visible to an operator while it runs (how long, how many attempts, the last error)", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t, "acc-visible");
    let failing = true;
    Object.assign(t.services.billing, {
      eraseAccountData: async () => {
        if (failing) throw new Error("provider unreachable");
      },
    });
    const request = await deletionDue(t, member);
    await tick(t);
    t.clock.advance(3 * MINUTE);
    await tick(t);
    const [running] = await t.services.events.staff.erasuresInProgress(10);
    expect(running).toMatchObject({
      requestId: request.id,
      accountId: member.accountId,
      attempts: 2,
      lastError: "provider unreachable",
    });
    expect(running?.stuckForSec).toBe(3 * 60);
    // The health summary's backlog counts it, with when it started.
    expect((await t.services.events.staff.privacyBacklog(500)).erasuresInProgress).toEqual({
      count: 1,
      oldestAt: Date.parse(running?.startedAt ?? ""),
    });
    // The member's request says what is happening: being deleted, no longer cancellable.
    expect(
      (await t.services.events.staff.privacyRequests(member.accountId)).find(
        (item) => item.id === request.id,
      )?.status,
    ).toBe("processing");
    failing = false;
    t.clock.advance(4 * MINUTE);
    await tick(t);
    expect(await t.services.events.staff.erasuresInProgress(10)).toEqual([]);
    expect((await t.services.events.staff.privacyBacklog(500)).erasuresInProgress.count).toBe(0);
  });

  it("runs the steps in an order that never leaves the account usable", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t, "acc-order");
    const original = (await t.deps.repos.accounts.get(member.accountId))?.account.email;
    const steps: string[] = [];
    const accountState = async () => {
      const account = await t.deps.repos.accounts.get(member.accountId);
      if (!account) return "gone";
      return account.account.email === original ? "usable" : "locked";
    };
    for (const area of ["identity", "personalisation", "billing"] as const) {
      Object.assign(t.services[area], {
        eraseAccountData: async () => {
          steps.push(`${area}:${await accountState()}`);
        },
      });
    }
    await deletionDue(t, member);
    await tick(t);
    // Identity's own part needs the address (before the lock); the provider is the last step.
    expect(steps).toEqual(["identity:usable", "personalisation:locked", "billing:gone"]);
  });

  it("picks up an erasure left in progress before retries were recorded", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t, "acc-legacy");
    const request = await deletionDue(t, member);
    // As a stranded erasure from before this change looks: processing, nothing to retry it.
    await t.deps.repos.events.transitionPrivacyRequest(request.id, ["scheduled"], {
      status: "processing",
      lastError: "EACCES",
      updatedAt: t.clock.now(),
    });
    await tick(t);
    expect(await t.deps.repos.events.getPrivacyRequest(request.id)).toMatchObject({
      status: "completed",
    });
    expect(await t.deps.repos.accounts.get(member.accountId)).toBeNull();
  });
});

describe("M1: an export never outlives its day, nor any object its record", () => {
  async function batchWaiting(t: T, member: Member) {
    await elevate(t, member);
    const request = await t.services.events.requestExport(member.as("adult"));
    await settle(t);
    expect((await t.services.events.staff.pendingExports(10)).requests).toHaveLength(1);
    return request;
  }

  for (const how of ["failed by the pipeline", "never picked up"] as const) {
    it(`a batch export ${how} is given up after a day, its partial deleted, and can be asked again`, async () => {
      const t = await eventServices({ WEBFLIX_EXPORT_EVENTS: "batch" }, {});
      const member = await createMember(t, "acc-batch");
      const request = await batchWaiting(t, member);
      if (how === "failed by the pipeline") {
        const [listed] = (await t.services.events.staff.pendingExports(10)).requests;
        await t.services.events.staff.recordExportResults({
          format: "webflix.export-events-results",
          formatVersion: 1,
          generatedAt: new Date(t.clock.now()).toISOString(),
          results: [
            {
              requestId: request.id,
              status: "failed",
              from: listed?.from ?? "",
              to: listed?.to ?? "",
              error: "simulated read failure",
            },
          ],
        });
      }
      // Within the day: still listed, still waiting.
      t.clock.advance(23 * 3600_000);
      await tick(t);
      expect((await t.services.events.staff.pendingExports(10)).requests).toHaveLength(1);
      // After it: given up, nothing left behind, the member may ask again.
      t.clock.advance(2 * 3600_000);
      await tick(t);
      expect(await t.deps.repos.events.getPrivacyRequest(request.id)).toMatchObject({
        status: "failed",
        exportBlobKey: null,
      });
      expect(t.sink.documentKeys()).toEqual([]);
      expect(await t.services.events.staff.pendingExports(10)).toEqual({ requests: [] });
      await elevate(t, member);
      await expect(t.services.events.requestExport(member.as("adult"))).resolves.toMatchObject({
        status: "pending",
      });
    });
  }

  it("records the document before emailing it: a failed email leaves no unnamed document", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t, "acc-mailfail");
    const send = t.deps.email.send.bind(t.deps.email);
    let failures = 1;
    Object.assign(t.deps.email, {
      send: async (...args: Parameters<typeof send>) => {
        if (failures-- > 0) throw new Error("email provider down");
        return send(...args);
      },
    });
    await elevate(t, member);
    const request = await t.services.events.requestExport(member.as("adult"));
    await settle(t);
    const record = await t.deps.repos.events.getPrivacyRequest(request.id);
    // The document exists and its record names it.
    expect(record?.status).toBe("processing");
    expect(t.sink.documentKeys()).toEqual([record?.exportBlobKey]);
    // The lost job is queued again and finishes: emailed once, completed.
    t.clock.advance(16 * MINUTE);
    await tick(t);
    expect(await t.deps.repos.events.getPrivacyRequest(request.id)).toMatchObject({
      status: "completed",
      emailStatus: "sent",
    });
    expect(t.ports.email.mailbox()).toHaveLength(1);
  });

  it("erasing an account removes every export object of it, whether or not a record names it", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t, "acc-orphans");
    await elevate(t, member);
    const request = await t.services.events.requestExport(member.as("adult"));
    await settle(t);
    // As an interrupted attempt could leave them: a record without a key, objects under its id.
    await t.deps.repos.events.transitionPrivacyRequest(request.id, ["completed"], {
      exportBlobKey: null,
      updatedAt: t.clock.now(),
    });
    await t.sink.putDocument(`exports/${request.id}.partial.json.gz`, new Uint8Array([1]));
    await t.sink.putDocument(`export-events/${request.id}/manifest.json`, new Uint8Array([2]));
    expect(t.sink.documentKeys()).toHaveLength(3);
    await deletionDue(t, member);
    await tick(t);
    expect(t.sink.documentKeys()).toEqual([]);
  });
});

describe("M4: staff record a withdrawal only", () => {
  it("refuses a grant with its own code, and records a withdrawal", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t, "acc-staff");
    await expect(
      t.services.events.staff.setConsent(member.accountId, "personalisation", true),
    ).rejects.toMatchObject({ code: "consent_grant_member_only", status: 403 });
    const state = await t.services.events.staff.setConsent(member.accountId, "analytics", false);
    expect(state.purposes.analytics).toMatchObject({ granted: false, source: "support" });
  });

  it("a support grant already recorded is not the member's answer: GPC and the prompt apply", async () => {
    for (const mode of ["opt-out", "opt-in"] as const) {
      const t = await eventServices({ WEBFLIX_CONSENT_MODE: mode }, {});
      const member = await createMember(t, `acc-${mode}`);
      // As recorded before staff could only withdraw.
      for (const purpose of ["analytics", "personalisation"] as const) {
        await t.deps.repos.events.addConsent({
          id: `0193a1d2-0000-7000-8000-00000000000${purpose === "analytics" ? 1 : 2}`,
          accountId: member.accountId,
          purpose,
          granted: true,
          source: "support",
          createdAt: t.clock.now(),
        });
      }
      const state = await t.services.events.getConsent(member.as("adult"), {
        gpc: mode === "opt-out",
      });
      if (mode === "opt-out") {
        // Global Privacy Control withdraws what the member never answered themselves.
        expect(state.purposes.personalisation).toMatchObject({ granted: false, source: "gpc" });
      } else {
        expect(state.promptRequired).toBe(true);
        expect(state.purposes.personalisation.granted).toBe(false);
      }
      const ack = await t.services.events.ingest({
        auth: member.as("adult"),
        events: [clientEvent("impression")],
        gpc: mode === "opt-out",
        country: null,
      });
      expect(ack).toEqual({ accepted: 0, dropped: 1 });
    }
  });
});

describe("M6: the export's notes are true of the document", () => {
  it("describe the parts present, say what is held but not included, and square with the card", () => {
    const two = exportNotes(["identity", "billing"], 396).join("\n");
    expect(two).not.toMatch(/not stored as separate personal data/);
    expect(two).not.toMatch(/never by Webflix;/);
    expect(two).toMatch(/brand, last four digits and expiry/);
    expect(two).toMatch(/recommendation lists computed for your profiles; this copy does not/);
    expect(two).toMatch(/record of staff access .* does not include it/);
    const four = exportNotes(["admin", "billing", "identity", "personalisation"], 396).join("\n");
    expect(four).toMatch(/areas.personalisation: the recommendation lists stored/);
    expect(four).toMatch(/areas.admin: the record of Webflix staff access .*staffAccess/);
    expect(four).not.toMatch(/does not include/);
    expect(four).toMatch(/under areas.<name>: admin, billing, identity, personalisation/);
  });
});

describe("M7: a deletion is announced, and so is keeping the account", () => {
  it("emails the date and how to keep it; billing's cancel sees the deletion recorded already", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t, "acc-emails");
    const seen: boolean[] = [];
    const cancel = t.services.billing.cancel.bind(t.services.billing);
    let failures = 1;
    Object.assign(t.services.billing, {
      cancel: async (accountId: string) => {
        seen.push(await t.services.seams.accountDeletionScheduled(accountId));
        if (failures-- > 0) throw new Error("provider briefly unavailable");
        return cancel(accountId);
      },
    });
    await elevate(t, member);
    const request = await t.services.events.requestDeletion(member.as("adult"));
    expect(request.email).toBe("sent");
    await tick(t); // the sweep's retry of the renewals
    expect(seen).toEqual([true, true]);
    const [mail] = t.ports.email.mailbox();
    expect(mail).toMatchObject({ template: "account-deletion-scheduled" });
    expect(mail?.text).toContain("Keep my account");
    expect(mail?.text).toContain(`${t.deps.config.publicOrigin}/account/privacy`);
    expect(t.ports.email.mailbox().map((item) => item.template)).not.toContain("cancellation");
  });

  it("emails that nothing will be deleted, whether the member or staff kept it", async () => {
    for (const by of ["member", "staff"] as const) {
      const t = await eventServices({}, {});
      const member = await createMember(t, `acc-kept-${by}`);
      await elevate(t, member);
      await t.services.events.requestDeletion(member.as("adult"));
      if (by === "member") await t.services.events.cancelDeletion(member.as("adult"));
      else await t.services.events.staff.cancelDeletion(member.accountId);
      expect(t.ports.email.mailbox().map((item) => item.template)).toEqual([
        "account-deletion-scheduled",
        "account-deletion-canceled",
      ]);
    }
  });
});

describe("L10: the request says whether an email will come", () => {
  it("pending then sent, or suppressed from the start for an address that bounced", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t, "acc-mailed");
    await elevate(t, member);
    expect((await t.services.events.requestExport(member.as("adult"))).email).toBe("pending");
    await settle(t);
    const [done] = (await t.services.events.listPrivacyRequests(member.as("adult"))).items;
    expect(done).toMatchObject({ status: "completed", email: "sent" });

    const bounced = await createMember(t, "acc-bounced");
    await t.deps.repos.identity.suppress({
      address: `${bounced.accountId}@example.com`,
      reason: "bounce",
      source: "test",
      createdAt: t.clock.now(),
    } as never);
    await elevate(t, bounced);
    expect((await t.services.events.requestExport(bounced.as("adult"))).email).toBe("suppressed");
    expect((await t.services.events.requestDeletion(bounced.as("adult"))).email).toBe("suppressed");
  });
});

describe("L2: a download needs a fresh account-holder proof", () => {
  it("after the token is checked: a foreign or bad link is still not found", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t, "acc-proof");
    await elevate(t, member);
    const request = await t.services.events.requestExport(member.as("adult"));
    await settle(t);
    const [listed] = (await t.services.events.listPrivacyRequests(member.as("adult"))).items;
    const token = new URL(`http://x${listed?.downloadUrl}`).searchParams.get("token") ?? "";
    await expect(
      t.services.events.downloadExport(member.as("adult"), request.id, token),
    ).resolves.toMatchObject({ requestId: request.id });
    t.clock.advance(10 * MINUTE); // the proof lapses
    await expect(
      t.services.events.downloadExport(member.as("adult"), request.id, token),
    ).rejects.toMatchObject({ code: "reauthentication_required" });
    await expect(
      t.services.events.downloadExport(member.as("adult"), request.id, `${token.slice(0, -2)}AA`),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("L1: personalisation hears of every answer about its purpose", () => {
  it("withdrawn (by the member, GPC or support) and granted again; a failure never fails the answer", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t, "acc-recs");
    const told: { accountId: string; granted: boolean }[] = [];
    let broken = false;
    Object.assign(t.services.personalisation, {
      personalisationConsentChanged: async (input: { accountId: string; granted: boolean }) => {
        if (broken) throw new Error("personalisation down");
        told.push({ accountId: input.accountId, granted: input.granted });
      },
    });
    const auth = member.as("adult");
    await t.services.events.updateConsent(
      auth,
      { purpose: "personalisation", granted: false, source: "settings" },
      { gpc: false },
    );
    await t.services.events.updateConsent(
      auth,
      { purpose: "personalisation", granted: true, source: "settings" },
      { gpc: false },
    );
    // An answer about the other purpose says nothing to personalisation.
    await t.services.events.updateConsent(
      auth,
      { purpose: "analytics", granted: false, source: "settings" },
      { gpc: false },
    );
    // Global Privacy Control withdraws what another member never answered (opt-out default).
    const other = await createMember(t, "acc-recs-gpc");
    await t.services.events.getConsent(other.as("adult"), { gpc: true });
    expect(told).toEqual([
      { accountId: member.accountId, granted: false },
      { accountId: member.accountId, granted: true },
      { accountId: other.accountId, granted: false },
    ]);
    broken = true;
    await expect(
      t.services.events.staff.setConsent(member.accountId, "personalisation", false),
    ).resolves.toMatchObject({ purposes: { personalisation: { source: "support" } } });
  });
});

describe("L6: an erased subject's events are never stored again", () => {
  it("drops a late replay of an erased account's events and of a restricted profile's older ones", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t, "acc-replay");
    const before = t.clock.now();
    const old = await stampedEvent(member.accountId, member.profiles.adult.id, before);
    // A profile erased on its own (it became restricted): its earlier events go, later ones stay.
    await t.services.events.forgetProfileBehaviour({
      accountId: member.accountId,
      profileId: member.profiles.adult.id,
    });
    t.clock.advance(1000);
    const later = await stampedEvent(member.accountId, member.profiles.adult.id, t.clock.now());
    await t.queue.publish(appendEventsJob.create({ events: [old, later] }));
    await settle(t);
    expect(lakeEvents(t.sink).map((event) => event.eventId)).toEqual([later.eventId]);
    // The account erased: every event of it goes, whenever it was received.
    await deletionDue(t, member);
    await tick(t);
    const replay = await stampedEvent(member.accountId, member.profiles.teen.id, before);
    await t.queue.publish(appendEventsJob.create({ events: [replay] }));
    await settle(t);
    expect(lakeEvents(t.sink).map((event) => event.eventId)).toEqual([later.eventId]);
  });
});

describe("H1: retention, and an export window that covers everything held", () => {
  it("an inline export holds an event older than the retention period while the lake still holds it", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t, "acc-old");
    const ancient = await stampedEvent(
      member.accountId,
      member.profiles.adult.id,
      t.clock.now() - 500 * DAY_MS,
    );
    await t.sink.append([ancient]);
    await elevate(t, member);
    const request = await t.services.events.requestExport(member.as("adult"));
    await settle(t);
    const [listed] = (await t.services.events.listPrivacyRequests(member.as("adult"))).items;
    const token = new URL(`http://x${listed?.downloadUrl}`).searchParams.get("token") ?? "";
    const document = await t.services.events.downloadExport(member.as("adult"), request.id, token);
    expect(document.events.map((event) => event.eventId)).toContain(ancient.eventId);
  });

  it("prunes finished exports and settled erasures past the raw retention, at most hourly", async () => {
    const t = await eventServices({ WEBFLIX_EVENTS_RETENTION_DAYS: "30" }, {});
    const member = await createMember(t, "acc-prune");
    await elevate(t, member);
    const request = await t.services.events.requestExport(member.as("adult"));
    await settle(t);
    await t.services.events.staff.confirmErasures([]);
    await t.deps.repos.events.addErasures([
      {
        subjectKey: "settledSettledSettled0",
        kind: "profile",
        accountKey: null,
        requestedAt: t.clock.now(),
        compactedAt: null,
      },
    ]);
    await t.deps.repos.events.markErasuresCompacted(["settledSettledSettled0"], t.clock.now());
    await tick(t); // the first sweep runs retention: nothing is old enough yet
    t.clock.advance(31 * DAY_MS);
    await tick(t);
    expect(await t.deps.repos.events.getPrivacyRequest(request.id)).toBeNull();
    expect(await t.deps.repos.events.erasuresOf(["settledSettledSettled0"])).toEqual([]);
    // A deletion request is the record of the request: kept.
    const other = await eventServices({ WEBFLIX_EVENTS_RETENTION_DAYS: "30" }, {});
    const leaving = await createMember(other, "acc-prune-leaving");
    const deletion = await deletionDue(other, leaving);
    await tick(other);
    other.clock.advance(400 * DAY_MS);
    await tick(other);
    expect(await other.deps.repos.events.getPrivacyRequest(deletion.id)).toMatchObject({
      status: "completed",
    });
  });
});

describe("a deleted profile's behaviour is erased like a restricted one's", () => {
  it("queues the profile's key (listed, confirmed like any other), never for the last profile", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t, "acc-profiles");
    const auth = member.as("adult");
    const teenKey = await keys.profile(member.profiles.teen.id);
    await t.services.profiles.remove(auth, member.profiles.teen.id, {}, async () => {});
    expect(await t.deps.repos.profiles.get(member.accountId, member.profiles.teen.id)).toBeNull();
    // Listed for the pipeline's erase job on its own, though the profile no longer exists...
    expect(await t.services.events.staff.pendingErasures(100)).toEqual([teenKey]);
    // ...and settled by its confirmation like any other key.
    await t.services.events.staff.confirmErasures([teenKey]);
    expect(await t.services.events.staff.pendingErasures(100)).toEqual([]);
    expect((await t.deps.repos.events.erasuresOf([teenKey]))[0]?.compactedAt).not.toBeNull();
    // A late replay of its earlier events is refused.
    const old = await stampedEvent(member.accountId, member.profiles.teen.id, t.clock.now() - 1000);
    await t.queue.publish(appendEventsJob.create({ events: [old] }));
    await settle(t);
    expect(lakeEvents(t.sink).map((event) => event.eventId)).not.toContain(old.eventId);
    // The last profile is never deleted, so nothing is queued for it.
    await t.services.profiles.remove(auth, member.profiles.kids.id, {}, async () => {});
    const before = await t.services.events.staff.pendingErasures(100);
    await expect(
      t.services.profiles.remove(auth, member.profiles.adult.id, {}, async () => {}),
    ).rejects.toMatchObject({ code: "profile_last_remaining" });
    expect(await t.services.events.staff.pendingErasures(100)).toEqual(before);
  });
});
