import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isUniqueViolation, TooManyParametersError } from "../src/database.ts";
import { MAX_BOUND_PARAMETERS } from "../src/dialect.ts";
import { type DatabaseHarness, dialectHarnesses } from "./harness.ts";

const keys = (count: number) => Array.from({ length: count }, (_, index) => `k${index}`);

for (const harness of dialectHarnesses) {
  describe.skipIf(harness.skip)(`Database on ${harness.label}`, () => {
    let current: DatabaseHarness;
    beforeEach(async () => {
      current = await harness.create();
    });
    afterEach(async () => {
      await current.cleanup();
    });
    const meta = () => current.database.db.selectFrom("meta").selectAll().orderBy("key").execute();

    it("runs a batch in order and returns typed, positional results", async () => {
      const { db } = current.database;
      const [insert, update, select] = await current.database.batch([
        db.insertInto("meta").values({ key: "a", value: "1", updated_at: 1 }),
        db.updateTable("meta").set({ value: "2" }).where("key", "=", "a"),
        db.selectFrom("meta").select(["key", "value"]),
      ]);
      expect(insert.numAffectedRows).toBe(1);
      expect(update.numAffectedRows).toBe(1);
      expect(select.rows).toEqual([{ key: "a", value: "2" }]);
    });

    it("rolls back the whole batch when one statement fails", async () => {
      const { db } = current.database;
      await db.insertInto("meta").values({ key: "existing", value: "x", updated_at: 1 }).execute();
      await expect(
        current.database.batch([
          db.insertInto("meta").values({ key: "first", value: "x", updated_at: 1 }),
          db.updateTable("meta").set({ value: "changed" }).where("key", "=", "existing"),
          // Duplicate primary key: fails after two statements already ran.
          db.insertInto("meta").values({ key: "existing", value: "y", updated_at: 1 }),
        ]),
      ).rejects.toSatisfy(isUniqueViolation);
      expect(await meta()).toEqual([{ key: "existing", value: "x", updated_at: 1 }]);
      // The connection is usable afterwards (no transaction left open).
      await current.database.batch([
        db.insertInto("meta").values({ key: "after", value: "ok", updated_at: 2 }),
      ]);
      expect((await meta()).map((row) => row.key)).toEqual(["after", "existing"]);
    });

    it(`allows ${MAX_BOUND_PARAMETERS} bound parameters and rejects more, before executing`, async () => {
      const { db } = current.database;
      await expect(
        db
          .selectFrom("meta")
          .select("key")
          .where("key", "in", keys(MAX_BOUND_PARAMETERS))
          .execute(),
      ).resolves.toEqual([]);
      await expect(
        db
          .selectFrom("meta")
          .select("key")
          .where("key", "in", keys(MAX_BOUND_PARAMETERS + 1))
          .execute(),
      ).rejects.toBeInstanceOf(TooManyParametersError);
      await expect(
        current.database.batch([
          db.insertInto("meta").values({ key: "written", value: "x", updated_at: 1 }),
          db.deleteFrom("meta").where("key", "in", keys(MAX_BOUND_PARAMETERS + 1)),
        ]),
      ).rejects.toBeInstanceOf(TooManyParametersError);
      expect(await meta()).toEqual([]);
    });

    it("counts one round trip per query and per batch", async () => {
      const { db, stats } = current.database;
      const before = { ...stats };
      await db.selectFrom("meta").selectAll().execute();
      await current.database.batch([
        db.insertInto("meta").values({ key: "a", value: "1", updated_at: 1 }),
        db.insertInto("meta").values({ key: "b", value: "1", updated_at: 1 }),
        db.selectFrom("meta").selectAll(),
      ]);
      expect(stats.queries - before.queries).toBe(2);
      expect(stats.statements - before.statements).toBe(4);
    });

    it("recognises unique violations and nothing else", async () => {
      const { db } = current.database;
      await db.insertInto("meta").values({ key: "k", value: "v", updated_at: 1 }).execute();
      const duplicate = await db
        .insertInto("meta")
        .values({ key: "k", value: "v", updated_at: 1 })
        .execute()
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(isUniqueViolation(duplicate)).toBe(true);
      expect(isUniqueViolation(new Error("wrapper", { cause: duplicate }))).toBe(true);

      const notNull = await db
        .insertInto("meta")
        // biome-ignore lint/suspicious/noExplicitAny: deliberately violating NOT NULL.
        .values({ key: "n", value: null as any, updated_at: 1 })
        .execute()
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(notNull).not.toBeNull();
      expect(isUniqueViolation(notNull)).toBe(false);
    });
  });
}
