/**
 * Member rights (milestone 2 §6.3): "Download your data" completes and is complete; "Delete
 * account" waits out its cooling-off period, then removes what must go and keeps what must be
 * retained.
 */
import { DataExport } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { gunzipJson } from "../../src/areas/events/privacy.ts";
import { createSubjectKeys, DEV_ONLY_PSEUDONYM_KEY } from "../../src/index.ts";
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

async function populated(config: Record<string, string> = {}) {
  const t = await eventServices(config, {});
  const member = await createMember(t);
  const adult = member.profiles.adult.id;
  await t.deps.repos.library.addToMyList(adult, "t-lanterns", t.clock.now());
  await t.deps.repos.library.setRating(adult, "t-thaw", "love", t.clock.now());
  const viewer = { session: member.as("adult").session, profile: member.profiles.adult };
  const playback = await t.services.playback.start(viewer, { titleId: "t-lanterns" });
  t.clock.advance(30_000);
  await t.services.playback.end(viewer, playback.id, {
    positionSec: 30,
    durationSec: playback.durationSec,
    state: "paused",
  });
  await t.services.events.updateConsent(
    member.as("adult"),
    { purpose: "personalisation", granted: true, source: "banner" },
    { gpc: false },
  );
  await t.services.events.ingest({
    auth: member.as("adult"),
    events: [clientEvent("impression"), clientEvent("title.open")],
    gpc: false,
    country: null,
  });
  await settle(t);
  return { t, member };
}

async function exportOf(t: Awaited<ReturnType<typeof eventServices>>, member: Member) {
  await elevate(t, member);
  const request = await t.services.events.requestExport(member.as("adult"));
  expect(request).toMatchObject({ kind: "export", status: "pending", downloadUrl: null });
  await settle(t);
  const [listed] = (await t.services.events.listPrivacyRequests(member.as("adult"))).items;
  return { request, listed };
}

describe("data export", () => {
  it("needs a fresh account-holder proof, and is refused on the demo account", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t);
    await expect(t.services.events.requestExport(member.as("adult"))).rejects.toMatchObject({
      code: "reauthentication_required",
    });
    const demo = { ...member.as("adult") };
    demo.session = { ...demo.session, accountId: "demo-account" };
    await expect(t.services.events.requestExport(demo)).rejects.toMatchObject({
      code: "demo_account_protected",
    });
  });

  it("completes, emails a signed link, and holds everything the account has", async () => {
    const { t, member } = await populated();
    const { request, listed } = await exportOf(t, member);
    expect(listed).toMatchObject({ id: request.id, status: "completed" });
    expect(listed?.downloadUrl).toMatch(
      new RegExp(`^/api/v1/privacy/exports/${request.id}\\?token=[A-Za-z0-9_.%-]+$`),
    );
    const [mail] = t.ports.email.mailbox();
    expect(mail?.template).toBe("data-export-ready");
    expect(mail?.to).toBe(`${member.accountId}@example.com`);
    expect(mail?.text).toContain(`/api/v1/privacy/exports/${request.id}?token=`);

    const token = new URL(`http://x${listed?.downloadUrl}`).searchParams.get("token") ?? "";
    const document = await t.services.events.downloadExport(member.as("adult"), request.id, token);
    expect(DataExport.safeParse(document).success).toBe(true);
    expect(document.account).toMatchObject({
      id: member.accountId,
      email: `${member.accountId}@example.com`,
    });
    // The membership and invoices are billing's part, the sign-in methods identity's.
    expect(document.areas.billing).toMatchObject({ invoices: [] });
    expect(document.areas.identity).toMatchObject({ linkedIdentities: [] });
    expect(document.profiles.map((profile) => profile.id).sort()).toEqual(
      Object.values(member.profiles)
        .map((profile) => profile.id)
        .sort(),
    );
    expect(document.devices.map((device) => device.id)).toEqual([member.sessionId]);
    const adult = document.library.find((entry) => entry.profileId === member.profiles.adult.id);
    expect(adult?.myList.map((entry) => entry.titleId)).toEqual(["t-lanterns"]);
    expect(adult?.ratings).toMatchObject([{ titleId: "t-thaw", value: "love" }]);
    expect(adult?.progress.map((entry) => entry.titleId)).toEqual(["t-lanterns"]);
    expect(adult?.history.map((entry) => entry.titleId)).toEqual(["t-lanterns"]);
    expect(document.consents).toMatchObject([
      { purpose: "personalisation", granted: true, source: "banner" },
    ]);
    expect(document.privacyRequests.map((entry) => entry.id)).toEqual([request.id]);
    // Every lake event of the account, once each.
    const keys = createSubjectKeys(DEV_ONLY_PSEUDONYM_KEY);
    const accountKey = await keys.account(member.accountId);
    const inLake = lakeEvents(t.sink).filter((event) => event.subject.account === accountKey);
    expect(inLake.length).toBeGreaterThanOrEqual(5); // start, abandon, consent.change, 2 client
    expect(document.events.map((event) => event.eventId).sort()).toEqual(
      inLake.map((event) => event.eventId).sort(),
    );
    // No credential or secret leaves: no password hash, PIN hash or session token.
    const text = JSON.stringify(document);
    expect(text).not.toMatch(/pbkdf2|scrypt|tokenHash|pinHash|passwordHash/);
  });

  it("includes playback events still waiting in the outbox", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t);
    const viewer = { session: member.as("adult").session, profile: member.profiles.adult };
    const playback = await t.services.playback.start(viewer, { titleId: "t-lanterns" });
    await t.services.playback.end(viewer, playback.id);
    await elevate(t, member);
    const request = await t.services.events.requestExport(member.as("adult"));
    await t.queue.drain(); // the export job only: no scheduler tick has drained the outbox
    const [listed] = (await t.services.events.listPrivacyRequests(member.as("adult"))).items;
    const token = new URL(`http://x${listed?.downloadUrl}`).searchParams.get("token") ?? "";
    const document = await t.services.events.downloadExport(member.as("adult"), request.id, token);
    expect(document.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["playback.start", "playback.abandon"]),
    );
  });

  it("includes each other area's part through its export hook", async () => {
    const { t, member } = await populated();
    Object.assign(t.services.identity, {
      exportAccountData: async (accountId: string) => ({ linkedIdentities: [], accountId }),
    });
    const { request, listed } = await exportOf(t, member);
    const token = new URL(`http://x${listed?.downloadUrl}`).searchParams.get("token") ?? "";
    const document = await t.services.events.downloadExport(member.as("adult"), request.id, token);
    expect(document.areas.identity).toEqual({ linkedIdentities: [], accountId: member.accountId });
  });

  it("serves the download only to its account, with its own valid token, until it expires", async () => {
    const { t, member } = await populated({ WEBFLIX_EXPORT_LINK_TTL_SEC: "3600" });
    const other = await createMember(t, "acc-other");
    const { request, listed } = await exportOf(t, member);
    const token = new URL(`http://x${listed?.downloadUrl}`).searchParams.get("token") ?? "";
    const download = (auth: ReturnType<Member["as"]>, id: string, value: string) =>
      t.services.events.downloadExport(auth, id, value);
    await expect(download(other.as("adult"), request.id, token)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(download(member.as("adult"), request.id, `${token}x`)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(download(member.as("adult"), "pr-other", token)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(download(member.as("adult"), request.id, token)).resolves.toBeTruthy();
    // Expired: the link and then the document go.
    t.clock.advance(3601_000);
    await expect(download(member.as("adult"), request.id, token)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(t.sink.documentKeys()).toHaveLength(1);
    await t.services.scheduler.tick();
    await settle(t);
    expect(t.sink.documentKeys()).toEqual([]);
    const [after] = (await t.services.events.listPrivacyRequests(member.as("adult"))).items;
    expect(after).toMatchObject({ status: "completed", downloadUrl: null, expiresAt: null });
  });

  it("allows one export in progress at a time", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t);
    await elevate(t, member);
    await t.services.events.requestExport(member.as("adult"));
    await expect(t.services.events.requestExport(member.as("adult"))).rejects.toMatchObject({
      code: "privacy_request_pending",
    });
    await settle(t);
    await expect(t.services.events.requestExport(member.as("adult"))).resolves.toMatchObject({
      status: "pending",
    });
  });
});

describe("account deletion", () => {
  it("needs a fresh proof, waits out the cooling-off period and can be cancelled meanwhile", async () => {
    const { t, member } = await populated();
    await expect(t.services.events.requestDeletion(member.as("adult"))).rejects.toMatchObject({
      code: "reauthentication_required",
    });
    await elevate(t, member);
    const request = await t.services.events.requestDeletion(member.as("adult"));
    expect(request.status).toBe("scheduled");
    expect(Date.parse(request.scheduledFor ?? "")).toBe(t.clock.now() + 14 * DAY_MS);
    await expect(t.services.events.requestDeletion(member.as("adult"))).rejects.toMatchObject({
      code: "privacy_request_pending",
    });
    // Not due: the sweep leaves it.
    t.clock.advance(13 * DAY_MS);
    await t.services.scheduler.tick();
    await settle(t);
    expect(await t.deps.repos.accounts.get(member.accountId)).not.toBeNull();
    await t.services.events.cancelDeletion(member.as("adult"));
    t.clock.advance(2 * DAY_MS);
    await t.services.scheduler.tick();
    await settle(t);
    expect(await t.deps.repos.accounts.get(member.accountId)).not.toBeNull();
    const [canceled] = (await t.services.events.listPrivacyRequests(member.as("adult"))).items;
    expect(canceled?.status).toBe("canceled");
    await expect(t.services.events.cancelDeletion(member.as("adult"))).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("erases what must go, keeps what must be retained, and lists the subject for compaction", async () => {
    const { t, member } = await populated();
    await elevate(t, member);
    const keys = createSubjectKeys(DEV_ONLY_PSEUDONYM_KEY);
    // An export that is still downloadable: its document must go with the account.
    await t.services.events.requestExport(member.as("adult"));
    await settle(t);
    expect(t.sink.documentKeys()).toHaveLength(1);
    const request = await t.services.events.requestDeletion(member.as("adult"));
    // Another member is untouched.
    const other = await createMember(t, "acc-bystander");
    t.clock.advance(14 * DAY_MS + 1);
    await t.services.scheduler.tick();
    await settle(t);
    const repos = t.deps.repos;
    // Gone: the account, its sessions, profiles and library, consents, the export document.
    expect(await repos.accounts.get(member.accountId)).toBeNull();
    expect(await repos.profiles.list(member.accountId)).toEqual([]);
    expect(await repos.sessions.listForAccount(member.accountId, t.clock.now())).toEqual([]);
    expect(await repos.library.loadSignals(member.profiles.adult.id)).toEqual({
      myList: [],
      ratings: [],
      progress: [],
    });
    expect(await repos.events.listConsents(member.accountId)).toEqual([]);
    expect(t.sink.documentKeys()).toEqual([]);
    // Kept: the record of the request itself (it has no foreign key), now completed.
    const done = await repos.events.getPrivacyRequest(request.id);
    expect(done).toMatchObject({ status: "completed", accountId: member.accountId });
    // The lake keeps the events until compaction erases them: the subject is listed for it.
    const pending = await t.services.events.staff.pendingErasures(100);
    expect(pending).toEqual([await keys.account(member.accountId)]);
    const all = await repos.events.pendingErasures(100);
    expect(all.map((record) => record.subjectKey).sort()).toEqual(
      (
        await Promise.all([
          keys.account(member.accountId),
          ...Object.values(member.profiles).map((profile) => keys.profile(profile.id)),
        ])
      ).sort(),
    );
    await t.services.events.staff.confirmErasures(pending);
    expect(await t.services.events.staff.pendingErasures(100)).toEqual([]);
    // Events emitted for the erased account afterwards are not stored.
    const lakeBefore = lakeEvents(t.sink).length;
    await t.services.events.emitServerEvent({
      type: "billing.transition",
      payload: { from: "active", to: "canceled", planId: null },
      accountId: member.accountId,
      profileId: null,
    });
    await settle(t);
    expect(lakeEvents(t.sink)).toHaveLength(lakeBefore);
    expect(await repos.accounts.get(other.accountId)).not.toBeNull();
  });

  it("runs every other area's erasure hook before the account row goes", async () => {
    const { t, member } = await populated();
    const calls: string[] = [];
    Object.assign(t.services.personalisation, {
      eraseAccountData: async (accountId: string) => {
        calls.push(accountId);
        // Still there: the hook may read what it must erase.
        expect(await t.deps.repos.accounts.get(accountId)).not.toBeNull();
      },
    });
    await elevate(t, member);
    await t.services.events.requestDeletion(member.as("adult"));
    t.clock.advance(14 * DAY_MS + 1);
    await t.services.scheduler.tick();
    await settle(t);
    expect(calls).toEqual([member.accountId]);
  });

  it("retries an erasure that failed half-way and completes it (idempotent steps)", async () => {
    const { t, member } = await populated();
    let failures = 1;
    Object.assign(t.services.billing, {
      eraseAccountData: async () => {
        if (failures-- > 0) throw new Error("provider unreachable");
      },
    });
    await elevate(t, member);
    const request = await t.services.events.requestDeletion(member.as("adult"));
    t.clock.advance(14 * DAY_MS + 1);
    await t.services.scheduler.tick();
    await settle(t);
    expect(await t.deps.repos.events.getPrivacyRequest(request.id)).toMatchObject({
      status: "processing",
      lastError: "provider unreachable",
    });
    expect(await t.deps.repos.accounts.get(member.accountId)).not.toBeNull();
    t.clock.advance(60_000); // the retry's backoff
    await settle(t);
    expect(await t.deps.repos.events.getPrivacyRequest(request.id)).toMatchObject({
      status: "completed",
      lastError: null,
    });
    expect(await t.deps.repos.accounts.get(member.accountId)).toBeNull();
  });

  it("refuses the demo account", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t);
    const demo = { ...member.as("adult") };
    demo.session = { ...demo.session, accountId: "demo-account" };
    await expect(t.services.events.requestDeletion(demo)).rejects.toMatchObject({
      code: "demo_account_protected",
    });
  });
});

describe("export documents", () => {
  it("are gzip JSON", async () => {
    const { t, member } = await populated();
    await exportOf(t, member);
    const [key] = t.sink.documentKeys();
    const bytes = await t.sink.getDocument(key ?? "");
    expect(bytes?.[0]).toBe(0x1f);
    expect(bytes?.[1]).toBe(0x8b);
    expect(DataExport.safeParse(await gunzipJson(bytes ?? new Uint8Array())).success).toBe(true);
  });
});
