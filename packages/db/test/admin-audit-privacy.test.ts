/**
 * Migration 0023_admin_audit_privacy (privacy review M5) on SQLite: what earlier code wrote to
 * the audit log and must not keep. A member search kept the full address typed: masked to its
 * first character. An erasure confirmation kept the erased subject keys: dropped (the count stays
 * in `after`). The D1 file of the same migration is applied by the workerd suites.
 */
import { describe, expect, it } from "vitest";
import { up } from "../src/migrations/admin/0023_admin_audit_privacy.ts";
import { createSqliteHarness } from "./harness.ts";

const NOW = 1_800_000_000_000;

function row(id: string, action: string, targetId: string, before: unknown, after: unknown) {
  return {
    id,
    actor_type: "staff",
    actor_id: "staff-1",
    actor_name: "Ada",
    action,
    target_type: action === "member.searched" ? "member_search" : "event_lake",
    target_id: targetId,
    before_json: before === null ? null : JSON.stringify(before),
    after_json: after === null ? null : JSON.stringify(after),
    reason: null,
    request_id: null,
    created_at: NOW,
    outcome: "succeeded",
    completed_at: NOW,
    idempotency_key: null,
  };
}

describe("migration 0023_admin_audit_privacy (SQLite)", () => {
  it("masks stored member searches and drops stored erasure keys, and changes nothing else", async () => {
    const { database, cleanup } = await createSqliteHarness();
    try {
      await database.db
        .insertInto("audit_log")
        .values([
          row("a-1", "member.searched", "jane.doe@example.test", null, { results: 1 }),
          row("a-2", "member.searched", "j***@e***", null, { results: 1 }),
          row(
            "a-3",
            "privacy.erasures_confirmed",
            "erasures",
            { request: { subjectKeys: ["k3Jx9QvT0bYzA1c2D3e4F5"] } },
            { confirmed: 1 },
          ),
          row("a-4", "member.viewed", "acct-1", null, null),
        ])
        .execute();
      await up(database.db, database.dialect);
      const rows = await database.db
        .selectFrom("audit_log")
        .select(["id", "target_id", "before_json", "after_json"])
        .orderBy("id")
        .execute();
      expect(rows).toEqual([
        { id: "a-1", target_id: "j***", before_json: null, after_json: '{"results":1}' },
        { id: "a-2", target_id: "j***@e***", before_json: null, after_json: '{"results":1}' },
        { id: "a-3", target_id: "erasures", before_json: null, after_json: '{"confirmed":1}' },
        { id: "a-4", target_id: "acct-1", before_json: null, after_json: null },
      ]);
      expect(JSON.stringify(rows)).not.toContain("jane.doe");
      expect(JSON.stringify(rows)).not.toContain("k3Jx9QvT0bYzA1c2D3e4F5");
    } finally {
      await cleanup();
    }
  });
});
