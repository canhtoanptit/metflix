import type { Database } from "@webflix/db";
import type {
  FakeClockRecord,
  FakeDocument,
  FakeDocumentKind,
  FakeStore,
  KeyReservation,
} from "./store.ts";

/**
 * `FakeStore` over the billing area's `payments_fake_objects`, `payments_fake_idempotency` and
 * `payments_fake_clocks` tables, on any `@webflix/db` dialect: SQLite in dev, PostgreSQL on
 * Kubernetes, D1 in the Worker. Writes of one operation go in one batch (D1 has no interactive
 * transactions); every statement stays far below the 100-parameter limit.
 */
export function createSqlFakeStore(database: Database): FakeStore {
  const { db } = database;

  const toDocument = (row: {
    kind: string;
    id: string;
    customer_id: string | null;
    data_json: string;
    version: number;
    created_at: number;
    updated_at: number;
  }): FakeDocument => ({
    kind: row.kind as FakeDocumentKind,
    id: row.id,
    customerId: row.customer_id,
    data: JSON.parse(row.data_json) as unknown,
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  });

  return {
    async get(kind, id) {
      const row = await db
        .selectFrom("payments_fake_objects")
        .selectAll()
        .where("kind", "=", kind)
        .where("id", "=", id)
        .executeTakeFirst();
      return row ? toDocument(row) : null;
    },

    async byCustomer(customerId, kinds) {
      if (kinds.length === 0) return [];
      const rows = await db
        .selectFrom("payments_fake_objects")
        .selectAll()
        .where("customer_id", "=", customerId)
        .where("kind", "in", [...kinds])
        .execute();
      return rows.map(toDocument);
    },

    async byKind(kind, options = {}) {
      let query = db
        .selectFrom("payments_fake_objects")
        .selectAll()
        .where("kind", "=", kind)
        .orderBy("created_at", "asc")
        .orderBy("id", "asc");
      if (options.createdAfter !== undefined) {
        query = query.where("created_at", ">", options.createdAfter);
      }
      if (options.limit !== undefined) query = query.limit(options.limit);
      return (await query.execute()).map(toDocument);
    },

    async write(documents) {
      if (documents.length === 0) return;
      await database.batch(
        documents.map((document) =>
          db
            .insertInto("payments_fake_objects")
            .values({
              kind: document.kind,
              id: document.id,
              customer_id: document.customerId,
              data_json: JSON.stringify(document.data),
              version: document.version,
              created_at: document.createdAt,
              updated_at: document.updatedAt,
            })
            .onConflict((oc) =>
              oc.columns(["kind", "id"]).doUpdateSet((eb) => ({
                customer_id: eb.ref("excluded.customer_id"),
                data_json: eb.ref("excluded.data_json"),
                version: eb.ref("excluded.version"),
                updated_at: eb.ref("excluded.updated_at"),
              })),
            ),
        ),
      );
    },

    async delete(keys) {
      if (keys.length === 0) return;
      await database.batch(
        keys.map(({ kind, id }) =>
          db.deleteFrom("payments_fake_objects").where("kind", "=", kind).where("id", "=", id),
        ),
      );
    },

    async reserveKey(key, fingerprint, now): Promise<KeyReservation> {
      const inserted = await db
        .insertInto("payments_fake_idempotency")
        .values({ idempotency_key: key, fingerprint, outcome_json: "", created_at: now })
        .onConflict((oc) => oc.column("idempotency_key").doNothing())
        .executeTakeFirst();
      if (Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0) return { reserved: true };
      const row = await db
        .selectFrom("payments_fake_idempotency")
        .select(["fingerprint", "outcome_json"])
        .where("idempotency_key", "=", key)
        .executeTakeFirst();
      // Released between the two statements: report it in flight; the caller retries.
      if (!row) return { reserved: false, fingerprint, outcome: null };
      return {
        reserved: false,
        fingerprint: row.fingerprint,
        outcome: row.outcome_json === "" ? null : row.outcome_json,
      };
    },

    async settleKey(key, outcome) {
      await db
        .updateTable("payments_fake_idempotency")
        .set({ outcome_json: outcome })
        .where("idempotency_key", "=", key)
        .execute();
    },

    async releaseKey(key) {
      await db.deleteFrom("payments_fake_idempotency").where("idempotency_key", "=", key).execute();
    },

    async clock(customerId): Promise<FakeClockRecord | null> {
      const row = await db
        .selectFrom("payments_fake_clocks")
        .select(["now_ms", "updated_at"])
        .where("customer_id", "=", customerId)
        .executeTakeFirst();
      return row ? { nowMs: Number(row.now_ms), updatedAt: Number(row.updated_at) } : null;
    },

    async setClock(customerId, clock) {
      await db
        .insertInto("payments_fake_clocks")
        .values({ customer_id: customerId, now_ms: clock.nowMs, updated_at: clock.updatedAt })
        .onConflict((oc) =>
          oc
            .column("customer_id")
            .doUpdateSet({ now_ms: clock.nowMs, updated_at: clock.updatedAt }),
        )
        .execute();
    },
  };
}
