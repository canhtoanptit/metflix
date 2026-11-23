import { describe, expect, it } from "vitest";
import type { AuditLogRecord, DeadLetterRecord } from "../../areas/admin/repository.ts";
import type { Repositories } from "../../repositories/ports.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "../harness.ts";

export interface AdminRepositoryHarness extends HarnessBase {
  repos: Repositories;
}

const T0 = Date.UTC(2026, 10, 22, 12, 0, 0);

function audit(overrides: Partial<AuditLogRecord> & { id: string }): AuditLogRecord {
  return {
    actor: { type: "staff", id: "staff-1", name: "Ada" },
    action: "billing.refund",
    target: { type: "member", id: "acct-1" },
    before: { request: { invoiceId: "inv-1", amount: null } },
    after: null,
    reason: "Member asked on the support line",
    requestId: "req-1",
    createdAt: T0,
    outcome: "pending",
    completedAt: null,
    idempotencyKey: null,
    ...overrides,
  };
}

function deadLetter(overrides: Partial<DeadLetterRecord> & { id: string }): DeadLetterRecord {
  return {
    jobType: "billing.provider-event",
    payload: { provider: "fake", eventId: "evt_1" },
    attempts: 5,
    lastError: null,
    failedAt: T0,
    replayedAt: null,
    ...overrides,
  };
}

/**
 * Contract of the admin area's repository (`repos.admin`), run against memory, SQLite,
 * PostgreSQL and D1: the write-ahead audit entries, their idempotency keys and outcomes, one log
 * shared with the areas that write their own rows, and dead letters.
 */
export function describeAdminRepositoryContract(
  name: string,
  factory: HarnessFactory<AdminRepositoryHarness>,
): void {
  describe(`AdminRepository contract: ${name}`, () => {
    const h = useHarness(factory);
    const repo = () => h().repos.admin;

    it("writes a pending entry and reads it back exactly", async () => {
      const record = audit({ id: "a-1", idempotencyKey: "key-aaaaaaaaaaaaaaaa1" });
      expect(await repo().beginAudit(record)).toBe(true);
      expect(await repo().getAudit("a-1")).toEqual(record);
      expect(await repo().getAuditByIdempotencyKey("key-aaaaaaaaaaaaaaaa1")).toEqual(record);
      expect(await repo().getAudit("missing")).toBeNull();
      expect(await repo().getAuditByIdempotencyKey("missing-key-00000000")).toBeNull();
    });

    it("lets only one entry claim an idempotency key, also when two race", async () => {
      const key = "key-bbbbbbbbbbbbbbbb2";
      const results = await Promise.all([
        repo().beginAudit(audit({ id: "b-1", idempotencyKey: key })),
        repo().beginAudit(audit({ id: "b-2", idempotencyKey: key })),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await repo().beginAudit(audit({ id: "b-3", idempotencyKey: key }))).toBe(false);
      // The losers wrote nothing.
      const written = await repo().listAudit({}, { before: null, limit: 10 });
      expect(written.map((row) => row.id).filter((id) => id.startsWith("b-"))).toHaveLength(1);
      // Entries without a key never collide.
      expect(await repo().beginAudit(audit({ id: "b-4" }))).toBe(true);
      expect(await repo().beginAudit(audit({ id: "b-5" }))).toBe(true);
    });

    it("settles an open entry once, and a swept one late", async () => {
      await repo().beginAudit(audit({ id: "c-1" }));
      const settled = { outcome: "succeeded" as const, after: { id: "re-1" }, completedAt: T0 + 5 };
      expect(await repo().settleAudit("c-1", settled)).toBe(true);
      expect(await repo().getAudit("c-1")).toMatchObject({
        outcome: "succeeded",
        after: { id: "re-1" },
        completedAt: T0 + 5,
      });
      // A settled entry is final.
      expect(
        await repo().settleAudit("c-1", { outcome: "failed", after: null, completedAt: T0 + 6 }),
      ).toBe(false);
      expect((await repo().getAudit("c-1"))?.outcome).toBe("succeeded");
      expect(await repo().settleAudit("missing", settled)).toBe(false);

      // Swept to `unknown`, then the answer arrives after all: it lands.
      await repo().beginAudit(audit({ id: "c-2", createdAt: T0 }));
      expect(await repo().expirePendingAudit(T0 + 1, T0 + 2, 10)).toBe(1);
      expect(await repo().getAudit("c-2")).toMatchObject({
        outcome: "unknown",
        completedAt: T0 + 2,
      });
      expect(
        await repo().settleAudit("c-2", { outcome: "succeeded", after: null, completedAt: T0 + 3 }),
      ).toBe(true);
      expect((await repo().getAudit("c-2"))?.outcome).toBe("succeeded");
    });

    it("sweeps only pending entries older than the cutoff, at most the limit", async () => {
      await repo().beginAudit(audit({ id: "d-1", createdAt: T0 - 3 }));
      await repo().beginAudit(audit({ id: "d-2", createdAt: T0 - 2 }));
      await repo().beginAudit(audit({ id: "d-3", createdAt: T0 + 10 }));
      await repo().appendAudit(audit({ id: "d-4", createdAt: T0 - 5, outcome: "succeeded" }));
      expect(await repo().expirePendingAudit(T0, T0 + 20, 1)).toBe(1);
      expect(await repo().expirePendingAudit(T0, T0 + 20, 10)).toBe(1);
      expect(await repo().expirePendingAudit(T0, T0 + 20, 10)).toBe(0);
      const outcomes = Object.fromEntries(
        await Promise.all(
          ["d-1", "d-2", "d-3", "d-4"].map(async (id) => [
            id,
            (await repo().getAudit(id))?.outcome,
          ]),
        ),
      );
      expect(outcomes).toEqual({
        "d-1": "unknown",
        "d-2": "unknown",
        "d-3": "pending",
        "d-4": "succeeded",
      });
    });

    it("lists newest first, filtered, a page at a time", async () => {
      const rows = [
        audit({ id: "e-1", createdAt: T0 + 1, outcome: "succeeded", completedAt: T0 + 1 }),
        audit({
          id: "e-2",
          createdAt: T0 + 2,
          actor: { type: "staff", id: "staff-2", name: null },
        }),
        audit({ id: "e-3", createdAt: T0 + 2, target: { type: "plan_price", id: "basic.USD" } }),
        audit({ id: "e-4", createdAt: T0 + 3, outcome: "unknown", completedAt: T0 + 9 }),
      ];
      for (const row of rows) await repo().appendAudit(row);
      const all = await repo().listAudit({}, { before: null, limit: 10 });
      expect(all.map((row) => row.id)).toEqual(["e-4", "e-3", "e-2", "e-1"]);
      const first = await repo().listAudit({}, { before: null, limit: 2 });
      expect(first.map((row) => row.id)).toEqual(["e-4", "e-3"]);
      const last = first.at(-1);
      if (!last) throw new Error("a page");
      const next = await repo().listAudit(
        {},
        { before: { createdAt: last.createdAt, id: last.id }, limit: 2 },
      );
      expect(next.map((row) => row.id)).toEqual(["e-2", "e-1"]);
      const by = async (filter: Parameters<Repositories["admin"]["listAudit"]>[0]) =>
        (await repo().listAudit(filter, { before: null, limit: 10 })).map((row) => row.id);
      expect(await by({ actorId: "staff-2" })).toEqual(["e-2"]);
      expect(await by({ targetType: "plan_price" })).toEqual(["e-3"]);
      expect(await by({ targetType: "member", targetId: "acct-1" })).toEqual(["e-4", "e-2", "e-1"]);
      expect(await by({ outcome: "unknown" })).toEqual(["e-4"]);
      expect(await by({ outcome: "pending" })).toEqual(["e-3", "e-2"]);
      expect(await by({ requestId: "req-1" })).toEqual(["e-4", "e-3", "e-2", "e-1"]);
      await repo().appendAudit(audit({ id: "e-5", createdAt: T0 + 4, requestId: "req-2" }));
      expect(await by({ requestId: "req-2" })).toEqual(["e-5"]);
      expect(await by({ requestId: "req-2", actorId: "staff-2" })).toEqual([]);
    });

    it("is one log with the rows other areas write in their own batches (outcome succeeded)", async () => {
      await h().repos.personalisation.setBillboard(
        { view: "home", titleIds: [], updatedAt: T0, updatedBy: "staff-9" },
        {
          id: "f-1",
          actor: { type: "staff", id: "staff-9", name: "Eve" },
          action: "editorial.billboard_set",
          target: { type: "billboard", id: "home" },
          before: [],
          after: [],
          reason: "Holiday campaign",
          requestId: null,
          createdAt: T0,
        },
      );
      const [row] = await repo().listAudit({ actorId: "staff-9" }, { before: null, limit: 10 });
      expect(row).toMatchObject({
        id: "f-1",
        action: "editorial.billboard_set",
        outcome: "succeeded",
        completedAt: null,
        idempotencyKey: null,
      });
    });

    it("deletes entries older than a cutoff, a bounded batch at a time", async () => {
      for (let index = 0; index < 5; index += 1) {
        await repo().appendAudit(
          audit({ id: `r-${index}`, createdAt: T0 + index, outcome: "succeeded" }),
        );
      }
      expect(await repo().deleteAuditBefore(T0 + 3, 2)).toBe(2);
      expect(await repo().deleteAuditBefore(T0 + 3, 10)).toBe(1);
      expect(await repo().deleteAuditBefore(T0 + 3, 10)).toBe(0);
      const left = await repo().listAudit({}, { before: null, limit: 10 });
      expect(left.map((row) => row.id)).toEqual(["r-4", "r-3"]);
    });

    it("erases a member from the log: who did what and when stay, nothing identifies them", async () => {
      const member = { type: "member", id: "acct-erased-1" };
      await repo().appendAudit(
        audit({
          id: "x-1",
          action: "billing.refund",
          target: member,
          before: { request: { invoiceId: "inv-9", amount: null } },
          after: { id: "re-1", invoiceId: "inv-9" },
          reason: "Asked by Jane Doe (jane@example.test)",
          outcome: "succeeded",
          idempotencyKey: "refund-for-acct-erased-1",
        }),
      );
      await repo().appendAudit(
        audit({
          id: "x-2",
          action: "member.signed_out_everywhere",
          target: member,
          before: { request: null },
          after: { error: "demo_account_protected" },
          outcome: "failed",
        }),
      );
      await repo().appendAudit(
        audit({
          id: "x-3",
          action: "audit.read",
          target: { type: "audit_log", id: "all" },
          before: null,
          after: { filters: { targetId: "acct-erased-1" }, results: 2 },
          reason: null,
          outcome: "succeeded",
        }),
      );
      await repo().appendAudit(
        audit({
          id: "x-4",
          action: "privacy.export_events_recorded",
          target: { type: "event_lake", id: "exports" },
          before: { request: { results: [{ requestId: "req-erased-9", status: "complete" }] } },
          after: { completed: ["req-erased-9"], erased: [], kept: [], ignored: [] },
          reason: "Run for JANE@EXAMPLE.TEST",
          outcome: "succeeded",
        }),
      );
      await repo().appendAudit(
        audit({
          id: "x-5",
          target: { type: "member", id: "acct-other" },
          outcome: "succeeded",
          idempotencyKey: "kept-key-0000000001",
        }),
      );
      await repo().appendAudit(
        audit({
          id: "x-6",
          action: "billing.plans_synced",
          target: { type: "plan_catalogue", id: "all" },
          outcome: "succeeded",
          idempotencyKey: "key-jane@example.test",
        }),
      );
      const erasure = {
        target: member,
        identifiers: ["acct-erased-1", "jane@example.test", "req-erased-9"],
        marker: "erased:m-1",
      };
      expect(await repo().eraseAuditSubject(erasure)).toBe(5);
      const all = await repo().listAudit({}, { before: null, limit: 20 });
      const text = JSON.stringify(all).toLowerCase();
      for (const identifier of [...erasure.identifiers, "jane doe", "inv-9"]) {
        expect(text, identifier).not.toContain(identifier);
      }
      const byId = Object.fromEntries(all.map((row) => [row.id, row]));
      expect(byId["x-1"]).toMatchObject({
        action: "billing.refund",
        actor: { type: "staff", id: "staff-1", name: "Ada" },
        target: { type: "member", id: "erased:m-1" },
        before: null,
        after: null,
        reason: null,
        createdAt: T0,
        outcome: "succeeded",
      });
      expect(byId["x-2"]).toMatchObject({
        target: { type: "member", id: "erased:m-1" },
        after: { error: "demo_account_protected" },
      });
      expect(byId["x-3"]?.after).toEqual({ filters: { targetId: "erased:m-1" }, results: 2 });
      expect(byId["x-4"]?.after).toMatchObject({ completed: ["erased:m-1"] });
      expect(byId["x-4"]?.reason).toBe("Run for erased:m-1");
      expect(byId["x-5"]).toMatchObject({
        target: { type: "member", id: "acct-other" },
        idempotencyKey: "kept-key-0000000001",
      });
      // A key that names the member is dropped (keys are unique: no marker in its place).
      expect(byId["x-1"]?.idempotencyKey).toBeNull();
      expect(byId["x-6"]?.idempotencyKey).toBeNull();
      // Idempotent: a second run finds nothing left to change.
      expect(await repo().eraseAuditSubject({ ...erasure, marker: "erased:m-2" })).toBe(0);
    });

    it("deletes the dead letters that mention an erased member", async () => {
      await repo().saveDeadLetter(
        deadLetter({ id: "dl-1", payload: { email: "Jane@Example.test" } }),
      );
      await repo().saveDeadLetter(deadLetter({ id: "dl-2", payload: { requestId: "req-9" } }));
      expect(await repo().deleteDeadLettersMentioning(["jane@example.test", "acct-x"])).toBe(1);
      expect(await repo().getDeadLetter("dl-1")).toBeNull();
      expect(await repo().getDeadLetter("dl-2")).not.toBeNull();
    });

    it("keeps dead letters once per delivery, newest first, and replays each once", async () => {
      await repo().saveDeadLetter(deadLetter({ id: "g-1", failedAt: T0 }));
      await repo().saveDeadLetter(deadLetter({ id: "g-1", failedAt: T0 + 50, attempts: 9 }));
      await repo().saveDeadLetter(deadLetter({ id: "g-2", failedAt: T0 + 1, payload: { n: [1] } }));
      expect(await repo().getDeadLetter("g-1")).toEqual(deadLetter({ id: "g-1", failedAt: T0 }));
      expect(await repo().getDeadLetter("missing")).toBeNull();
      expect((await repo().listDeadLetters({ before: null, limit: 10 })).map((d) => d.id)).toEqual([
        "g-2",
        "g-1",
      ]);
      expect(
        (await repo().listDeadLetters({ before: { failedAt: T0 + 1, id: "g-2" }, limit: 10 })).map(
          (d) => d.id,
        ),
      ).toEqual(["g-1"]);
      expect(await repo().countDeadLetters()).toBe(2);

      const both = await Promise.all([
        repo().claimDeadLetterReplay("g-1", T0 + 100),
        repo().claimDeadLetterReplay("g-1", T0 + 101),
      ]);
      expect(both.filter(Boolean)).toHaveLength(1);
      expect(await repo().countDeadLetters()).toBe(1);
      const claimedAt = (await repo().getDeadLetter("g-1"))?.replayedAt;
      if (claimedAt == null) throw new Error("claimed");
      // Releasing with another time changes nothing; with the claim's own, it reopens it.
      await repo().releaseDeadLetterReplay("g-1", claimedAt + 1);
      expect((await repo().getDeadLetter("g-1"))?.replayedAt).toBe(claimedAt);
      await repo().releaseDeadLetterReplay("g-1", claimedAt);
      expect((await repo().getDeadLetter("g-1"))?.replayedAt).toBeNull();
      expect(await repo().claimDeadLetterReplay("missing", T0)).toBe(false);
    });
  });
}
