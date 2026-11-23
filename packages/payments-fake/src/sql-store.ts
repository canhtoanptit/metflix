import type { Database } from "@webflix/db";
import { type SqlBool, sql } from "kysely";
import type {
  FakeClockRecord,
  FakeCommit,
  FakeDocument,
  FakeDocumentKind,
  FakeStore,
  KeyReservation,
} from "./store.ts";

/** Guard rows live beside the documents, under a kind no document has. */
const GUARD_KIND = "guard";

/**
 * `FakeStore` over the billing area's `payments_fake_objects`, `payments_fake_idempotency` and
 * `payments_fake_clocks` tables, on any `@webflix/db` dialect: SQLite in dev, PostgreSQL on
 * Kubernetes, D1 in the Worker. Writes of one operation go in one batch (D1 has no interactive
 * transactions); every statement stays far below the 100-parameter limit.
 *
 * `commit` is a compare-and-set over guard rows, portable to all three (finding K2). Its batch
 * first moves each guard from the version the operation read to the next, writing a token
 * unique to this commit: `UPDATE … WHERE version = <read>` (or an insert that does nothing when
 * the row exists, for a guard never committed). Every later statement of the batch writes only
 * if all guards carry that token, so a lost race writes nothing. On PostgreSQL (read committed)
 * a concurrent update of the same guard waits for the first to commit, then sees the new
 * version and matches no row; SQLite and D1 run batches one at a time. Guards are taken in key
 * order, so two commits never wait on each other in a cycle.
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

    async guardVersions(keys) {
      const versions = new Map<string, number>(keys.map((key) => [key, 0]));
      if (keys.length === 0) return versions;
      const rows = await db
        .selectFrom("payments_fake_objects")
        .select(["id", "version"])
        .where("kind", "=", GUARD_KIND)
        .where("id", "in", [...keys])
        .execute();
      for (const row of rows) versions.set(row.id, Number(row.version));
      return versions;
    },

    async commit({ guards, documents, clocks = [] }: FakeCommit): Promise<boolean> {
      const keys = [...guards.keys()].sort();
      if (keys.length === 0) throw new Error("payments-fake: a commit needs a guard");
      const token = `commit:${crypto.randomUUID()}`;
      const wall = Date.now();
      const claims = keys.map((key) => {
        const version = guards.get(key) ?? 0;
        return version === 0
          ? db
              .insertInto("payments_fake_objects")
              .values({
                kind: GUARD_KIND,
                id: key,
                customer_id: null,
                data_json: token,
                version: 1,
                created_at: wall,
                updated_at: wall,
              })
              .onConflict((oc) => oc.columns(["kind", "id"]).doNothing())
          : db
              .updateTable("payments_fake_objects")
              .set({ data_json: token, version: version + 1, updated_at: wall })
              .where("kind", "=", GUARD_KIND)
              .where("id", "=", key)
              .where("version", "=", version);
      });
      // True only inside the batch that moved every guard.
      const held = sql<SqlBool>`(${db
        .selectFrom("payments_fake_objects")
        .select((eb) => eb.fn.countAll().as("held"))
        .where("kind", "=", GUARD_KIND)
        .where("id", "in", keys)
        .where("data_json", "=", token)}) = ${keys.length}`;
      // Typed casts: PostgreSQL cannot infer a parameter's type from a bare select list.
      const writes = documents.map((document) =>
        db
          .insertInto("payments_fake_objects")
          .columns([
            "kind",
            "id",
            "customer_id",
            "data_json",
            "version",
            "created_at",
            "updated_at",
          ])
          .expression(
            db
              .selectNoFrom([
                sql<string>`cast(${document.kind} as text)`.as("kind"),
                sql<string>`cast(${document.id} as text)`.as("id"),
                sql<string | null>`cast(${document.customerId} as text)`.as("customer_id"),
                sql<string>`cast(${JSON.stringify(document.data)} as text)`.as("data_json"),
                sql<number>`cast(${document.version} as integer)`.as("version"),
                sql<number>`cast(${document.createdAt} as bigint)`.as("created_at"),
                sql<number>`cast(${document.updatedAt} as bigint)`.as("updated_at"),
              ])
              .where(held),
          )
          .onConflict((oc) =>
            oc.columns(["kind", "id"]).doUpdateSet((eb) => ({
              customer_id: eb.ref("excluded.customer_id"),
              data_json: eb.ref("excluded.data_json"),
              version: eb.ref("excluded.version"),
              updated_at: eb.ref("excluded.updated_at"),
            })),
          ),
      );
      const clockWrites = clocks.map(({ customerId, clock }) =>
        db
          .insertInto("payments_fake_clocks")
          .columns(["customer_id", "now_ms", "updated_at"])
          .expression(
            db
              .selectNoFrom([
                sql<string>`cast(${customerId} as text)`.as("customer_id"),
                sql<number>`cast(${clock.nowMs} as bigint)`.as("now_ms"),
                sql<number>`cast(${clock.updatedAt} as bigint)`.as("updated_at"),
              ])
              .where(held),
          )
          .onConflict((oc) =>
            oc.column("customer_id").doUpdateSet((eb) => ({
              now_ms: eb.ref("excluded.now_ms"),
              updated_at: eb.ref("excluded.updated_at"),
            })),
          ),
      );
      const results = await database.batch([...claims, ...writes, ...clockWrites]);
      return results.slice(0, claims.length).every((result) => result.numAffectedRows === 1);
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

    async forget(customerId, fragments) {
      await db.deleteFrom("payments_fake_clocks").where("customer_id", "=", customerId).execute();
      for (const fragment of fragments.filter((value) => value.length >= 8)) {
        // LIKE with its wildcards escaped: ids contain `_`.
        const pattern = `%${fragment.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
        const like = (column: string) =>
          sql<SqlBool>`${sql.ref(column)} like ${pattern} escape '\\'`;
        await db
          .deleteFrom("payments_fake_idempotency")
          .where((eb) =>
            eb.or([like("idempotency_key"), like("fingerprint"), like("outcome_json")]),
          )
          .execute();
      }
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
