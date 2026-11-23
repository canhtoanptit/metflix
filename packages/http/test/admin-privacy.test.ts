/**
 * The staff API's part of members' privacy (privacy review M2, M5, M6, L9) and the audit log as
 * the console reads it (UX review 2.17), over HTTP on memory ports: an erased member leaves no
 * identifying trace in the audit log while each entry still says which staff member did what
 * and when; searches never store an address; the log has a retention period; a member's export
 * includes the record of staff access as date and action only; operators see the age of the
 * privacy backlog; reading the log and the operator lists is audited; entries carry a kind, a
 * target label resolved when read, and headline facts.
 */
import { ADMIN_API_BASE_PATH, adminRoutes, createRouteClient } from "@webflix/contracts";
import type { MemoryAdminRepository, MemoryStaffVerifier, MemoryStore } from "@webflix/core/memory";
import { describe, expect, it } from "vitest";
import { createTestApp, type Device, onboard, type TestApp } from "./support.ts";

function staffClient(t: TestApp, roles: string[], subject = "staff-ada", name = "Ada Support") {
  const verifier = t.ports.staff as MemoryStaffVerifier;
  return createRouteClient(adminRoutes, {
    basePath: ADMIN_API_BASE_PATH,
    validateResponses: true,
    headers: async () => ({
      Authorization: `Bearer ${await verifier.mint({
        subject,
        name,
        email: `${subject}@staff.test`,
        clientRoles: { "webflix-admin": roles },
      })}`,
    }),
    fetch: async (url, init) => t.app.request(url, init),
  });
}

const DAY_MS_FOR_TESTS = 24 * 3600 * 1000;
const auditRows = (t: TestApp) => (t.deps.repos.admin as MemoryAdminRepository).audit;

async function accountOf(device: Device): Promise<{ id: string; email: string }> {
  const session = await device.api.getSession({ query: {} });
  if (!session.authenticated) throw new Error("signed out");
  return { id: session.account.id, email: session.account.email };
}

/** A fresh account-holder proof for every session of the account (identity's elevation). */
async function elevate(t: TestApp, accountId: string): Promise<void> {
  const store = (t.deps.repos as unknown as { store: MemoryStore }).store;
  for (const record of store.sessions.values()) {
    if (record.accountId === accountId) {
      await t.deps.repos.identity.elevateSession(
        record.id,
        accountId,
        t.clock.now() + 300_000,
        t.clock.now(),
      );
    }
  }
}

/** Runs the scheduler and every job it leads to (a deletion's sweep, then its erasure). */
async function tick(t: TestApp): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await t.services.scheduler.tick();
    await t.queue.drain();
  }
}

describe("an erased member in the audit log (review M5)", () => {
  it("keeps who did what and when, and nothing that identifies the member", async () => {
    const t = await createTestApp({ config: { WEBFLIX_DELETION_COOLING_OFF_SEC: "30" } });
    const { device, profileId } = await onboard(t, { email: "jane.doe@example.test" });
    const member = await accountOf(device);
    const support = staffClient(t, ["support"]);
    const admin = staffClient(t, ["admin"], "staff-root", "Root Admin");
    // Staff look the member up by their address and by id, read and act on them.
    await support.searchMembers({ query: { q: member.email } });
    await support.searchMembers({ query: { q: member.id } });
    await support.getMember({ params: { accountId: member.id } });
    await support.getMemberPrivacy({ params: { accountId: member.id } });
    await support.setMemberConsent({
      params: { accountId: member.id },
      body: { purpose: "analytics", granted: false, reason: "Jane Doe asked by phone" },
    });
    await support.removeProfilePin({
      params: { accountId: member.id, profileId },
      body: { reason: `PIN reset for ${member.email}` },
    });
    await admin.listAuditLog({ query: { targetId: member.id } });
    // Another member, untouched by this erasure.
    const { device: other } = await onboard(t, { email: "someone.else@example.test" });
    const bystander = await accountOf(other);
    await support.getMember({ params: { accountId: bystander.id } });

    // The member deletes their account; the cooling-off passes; the erasure runs.
    await elevate(t, member.id);
    await device.api.requestAccountDeletion();
    t.clock.advance(31_000);
    await tick(t);

    const rows = auditRows(t);
    const text = JSON.stringify(rows).toLowerCase();
    for (const trace of [member.id, member.email, profileId, "jane doe", "jane.doe"]) {
      expect(text, trace).not.toContain(trace.toLowerCase());
    }
    const theirs = rows.filter((row) => row.target.id.startsWith("erased:"));
    expect(new Set(theirs.map((row) => row.target.id)).size).toBe(1);
    expect(theirs.map((row) => [row.action, row.actor.id, row.outcome]).sort()).toEqual(
      [
        ["member.pin_removed", "staff-ada", "succeeded"],
        ["member.privacy_viewed", "staff-ada", "succeeded"],
        ["member.viewed", "staff-ada", "succeeded"],
        ["privacy.consent_recorded", "staff-ada", "succeeded"],
      ].sort(),
    );
    for (const row of theirs) {
      expect(row).toMatchObject({ before: null, reason: null });
      expect(row.createdAt).toBeGreaterThan(0);
    }
    // The bystander's entry is as it was.
    expect(
      rows.some((row) => row.action === "member.viewed" && row.target.id === bystander.id),
    ).toBe(true);
    // Read back: the target says the member was erased.
    const log = await admin.listAuditLog({ query: { targetType: "member", kind: "action" } });
    expect(log.items.find((item) => item.action === "member.pin_removed")).toMatchObject({
      targetLabel: "Erased member",
      actor: { id: "staff-ada" },
    });
  });

  it("never stores the address a member search was made with", async () => {
    const t = await createTestApp();
    await onboard(t, { email: "kept.private@example.test" });
    const support = staffClient(t, ["support"]);
    const found = await support.searchMembers({ query: { q: "Kept.Private@Example.test" } });
    expect(found.items).toHaveLength(1);
    await support.searchMembers({ query: { q: "kept.pri" } });
    const searches = auditRows(t).filter((row) => row.action === "member.searched");
    expect(searches.map((row) => row.target.id)).toEqual(["k***@e***", "kep***"]);
    expect(JSON.stringify(auditRows(t))).not.toContain("kept.private");
  });
});

describe("audit retention", () => {
  it("deletes entries older than the configured period on the scheduler's sweep", async () => {
    const t = await createTestApp({ config: { WEBFLIX_AUDIT_RETENTION_DAYS: "30" } });
    const support = staffClient(t, ["support"]);
    await support.searchMembers({ query: { q: "first" } });
    t.clock.advance(20 * DAY_MS_FOR_TESTS);
    await support.searchMembers({ query: { q: "second" } });
    t.clock.advance(11 * DAY_MS_FOR_TESTS);
    await t.services.scheduler.tick();
    await t.queue.drain();
    expect(auditRows(t).map((row) => row.target.id)).toEqual(["sec***"]);
  });

  it("keeps a year and a month by default", async () => {
    const t = await createTestApp();
    expect(t.deps.config.admin.auditRetentionDays).toBe(396);
  });
});

describe("a member's export (review M6)", () => {
  it("includes the record of staff access to the account, as date and action only", async () => {
    const t = await createTestApp({ config: { WEBFLIX_CONSENT_MODE: "opt-out" } });
    const { device } = await onboard(t, { email: "curious@example.test" });
    const member = await accountOf(device);
    const support = staffClient(t, ["support"]);
    await support.getMember({ params: { accountId: member.id } });
    t.clock.advance(1000);
    await support.setMemberConsent({
      params: { accountId: member.id },
      body: { purpose: "analytics", granted: false, reason: "Asked on the phone, ticket 991" },
    });
    await elevate(t, member.id);
    await device.api.requestDataExport();
    await t.queue.drain();
    const [request] = (await device.api.listPrivacyRequests()).items;
    const download = await device.request(request?.downloadUrl ?? "");
    const document = (await download.json()) as { areas: { admin?: unknown } };
    expect(document.areas.admin).toEqual({
      staffAccess: [
        { at: expect.any(String), action: "member.viewed" },
        { at: expect.any(String), action: "privacy.consent_recorded" },
      ],
    });
    const part = JSON.stringify(document.areas.admin);
    for (const withheld of ["staff-ada", "Ada", "ticket 991"]) {
      expect(part, withheld).not.toContain(withheld);
    }
  });
});

describe("operators see whether privacy work is being done (review M2)", () => {
  it("reports the pending erasures and waiting exports with the age of the oldest", async () => {
    const t = await createTestApp({
      config: { WEBFLIX_DELETION_COOLING_OFF_SEC: "30", WEBFLIX_EXPORT_EVENTS: "batch" },
    });
    const admin = staffClient(t, ["admin"]);
    expect((await admin.getSystemHealth()).privacy).toEqual({
      pendingErasures: 0,
      oldestPendingErasureAt: null,
      oldestPendingErasureAgeSec: null,
      waitingExports: 0,
      oldestWaitingExportAt: null,
      oldestWaitingExportAgeSec: null,
      erasuresInProgress: 0,
      oldestErasureInProgressAt: null,
      oldestErasureInProgressAgeSec: null,
    });
    const { device: leaving } = await onboard(t, { email: "leaving@example.test" });
    const gone = await accountOf(leaving);
    await elevate(t, gone.id);
    await leaving.api.requestAccountDeletion();
    t.clock.advance(31_000);
    await tick(t);
    const { device: asking } = await onboard(t, { email: "asking@example.test" });
    const asker = await accountOf(asking);
    await elevate(t, asker.id);
    await asking.api.requestDataExport();
    await t.queue.drain();
    t.clock.advance(3_600_000);
    const health = await admin.getSystemHealth();
    expect(health.privacy).toMatchObject({ pendingErasures: 1, waitingExports: 1 });
    expect(health.privacy.oldestPendingErasureAgeSec).toBeGreaterThanOrEqual(3600);
    expect(health.privacy.oldestWaitingExportAgeSec).toBe(3600);
    expect(health.privacy.oldestPendingErasureAt).not.toBeNull();
  });
});

describe("staff reads of the log and the operator lists are audited (review L9)", () => {
  it("records who read the log, with what filters, and who read each list, by count only", async () => {
    const t = await createTestApp();
    const admin = staffClient(t, ["admin"], "staff-root");
    await admin.listAuditLog({ query: { outcome: "unknown" } });
    await admin.listPendingErasures({ query: {} });
    await admin.listPendingExports({ query: {} });
    expect(auditRows(t).map((row) => [row.action, row.actor.id, row.after])).toEqual([
      ["audit.read", "staff-root", { filters: { outcome: "unknown" }, results: 0 }],
      ["privacy.erasures_listed", "staff-root", { count: 0 }],
      ["privacy.exports_listed", "staff-root", { count: 0 }],
    ]);
  });
});

describe("the audit log at a glance (UX review 2.17)", () => {
  it("lists actions without reads, labels targets when read, and gives the headline facts", async () => {
    const t = await createTestApp();
    const { device } = await onboard(t, { email: "labelled@example.test" });
    const member = await accountOf(device);
    const support = staffClient(t, ["support"]);
    const content = staffClient(t, ["content"]);
    await support.getMember({ params: { accountId: member.id } });
    await support.setMemberConsent({
      params: { accountId: member.id },
      body: { purpose: "personalisation", granted: false, reason: "Member asked" },
    });
    await content.setTitleAvailability({
      params: { titleId: "t-orbit" },
      body: { available: false, reason: "Licence ended" },
    });
    const admin = staffClient(t, ["admin"]);
    const actions = await admin.listAuditLog({ query: { kind: "action" } });
    expect(
      actions.items.map((item) => [item.action, item.kind, item.targetLabel, item.facts]),
    ).toEqual([
      ["editorial.availability_set", "action", "The Quiet Orbit", { available: false }],
      [
        "privacy.consent_recorded",
        "action",
        member.email,
        { purpose: "personalisation", granted: false },
      ],
    ]);
    const reads = await admin.listAuditLog({ query: { kind: "read" } });
    expect(reads.items.map((item) => [item.action, item.kind])).toContainEqual([
      "member.viewed",
      "read",
    ]);
    expect(reads.items.every((item) => item.kind === "read")).toBe(true);
    // Nothing of this was stored: the entries hold the id, the label is the address now.
    expect(JSON.stringify(auditRows(t))).not.toContain(member.email);
    // One's own entries: no member address without a role that reads members, no facts.
    const own = await staffClient(t, ["content"], "staff-ada").listOwnAuditLog({ query: {} });
    expect(own.items.find((item) => item.action === "privacy.consent_recorded")).toMatchObject({
      targetLabel: null,
      facts: {},
    });
    const ownWithSupport = await staffClient(t, ["support"], "staff-ada").listOwnAuditLog({
      query: { kind: "action" },
    });
    expect(
      ownWithSupport.items.find((item) => item.action === "privacy.consent_recorded")?.targetLabel,
    ).toBe(member.email);
  });
});
