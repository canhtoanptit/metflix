/**
 * Erasure keeps what the law requires (milestone 2 §6.3, D-M2-6): deleting an account row
 * cascades to everything personal and to nothing that must be retained. Guards the schema, so
 * a foreign key added to a retained table (or removed from a personal one) fails here.
 */
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createRepositories } from "../src/repositories/index.ts";
import { createSqliteHarness } from "./harness.ts";

/** Kept after the account is erased: billing records and the record of the request itself. */
const RETAINED = [
  "billing_customers",
  "billing_operations",
  "provider_events",
  "invoices",
  "refunds",
  "trial_fingerprints",
  "privacy_requests",
];
/** Gone with the account row (their own children cascade from them in turn). */
const ERASED_WITH_ACCOUNT = [
  "sessions",
  "profiles",
  "subscriptions",
  "consents",
  "account_identities",
  "account_tokens",
];

const NOW = 1_800_000_000_000;

describe("erasure and retention (SQLite schema)", () => {
  it("no retained table references accounts; every personal one cascades from it", async () => {
    const { database, cleanup } = await createSqliteHarness();
    try {
      const references = async (table: string) => {
        const { rows } = await sql<{ table: string; on_delete: string }>`
          select * from pragma_foreign_key_list(${table})`.execute(database.db);
        return rows.filter((row) => row.table === "accounts");
      };
      for (const table of RETAINED) expect(await references(table), table).toEqual([]);
      for (const table of ERASED_WITH_ACCOUNT) {
        const fks = await references(table);
        expect(fks.length, table).toBeGreaterThan(0);
        expect(
          fks.every((fk) => fk.on_delete === "CASCADE"),
          table,
        ).toBe(true);
      }
    } finally {
      await cleanup();
    }
  });

  it("deleteAccount removes the account and keeps its invoices and billing customer", async () => {
    const { database, cleanup } = await createSqliteHarness();
    try {
      const { db } = database;
      await db
        .insertInto("accounts")
        .values({
          id: "acc",
          email: "a@example.com",
          password_hash: "x",
          created_at: NOW,
          updated_at: NOW,
        })
        .execute();
      await db
        .insertInto("billing_customers")
        .values({ account_id: "acc", provider: "fake", customer_id: "cus_1", created_at: NOW })
        .execute();
      await db
        .insertInto("invoices")
        .values({
          id: "inv_1",
          account_id: "acc",
          provider: "fake",
          provider_invoice_id: "in_1",
          provider_subscription_id: null,
          number: "W-0001",
          status: "paid",
          currency: "usd",
          total_minor: 1299,
          amount_paid_minor: 1299,
          amount_due_minor: 0,
          amount_refunded_minor: 0,
          billing_reason: "subscription_create",
          period_start: NOW,
          period_end: NOW,
          hosted_url: null,
          pdf_url: null,
          issued_at: NOW,
          paid_at: NOW,
          updated_at: NOW,
        } as never)
        .execute();
      const repos = createRepositories(database);
      expect(await repos.events.deleteAccount("acc")).toBe(true);
      expect(await repos.accounts.get("acc")).toBeNull();
      const kept = await db
        .selectFrom("invoices")
        .select("id")
        .where("account_id", "=", "acc")
        .execute();
      expect(kept).toEqual([{ id: "inv_1" }]);
      const customers = await db
        .selectFrom("billing_customers")
        .select("customer_id")
        .where("account_id", "=", "acc")
        .execute();
      expect(customers).toEqual([{ customer_id: "cus_1" }]);
    } finally {
      await cleanup();
    }
  });
});
