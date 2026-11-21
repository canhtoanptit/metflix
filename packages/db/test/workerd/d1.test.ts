/**
 * D1 inside workerd: the generated migration files apply, `Database.batch` is atomic, the
 * parameter cap holds, interactive transactions are refused, and the portable entry points
 * load in the Workers runtime (no `node:` or `pg` imports).
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/database.ts";
import { isUniqueViolation, TooManyParametersError } from "../../src/database.ts";
import { MAX_BOUND_PARAMETERS } from "../../src/dialect.ts";
import { TABLES } from "../../src/schema.ts";
import { freshD1Database } from "./setup.ts";

const keys = (count: number) => Array.from({ length: count }, (_, index) => `k${index}`);

describe("D1", () => {
  let database: Database;
  beforeEach(async () => {
    database = await freshD1Database();
  });
  const meta = () => database.db.selectFrom("meta").selectAll().orderBy("key").execute();

  it("is migrated by the generated SQL files", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const names = tables.results.map((row) => row.name);
    for (const table of TABLES) expect(names).toContain(table);
    expect(names).toContain("search_fts");
    expect(names).toContain("d1_migrations");
  });

  it("runs a batch atomically: a failing statement rolls back the earlier ones", async () => {
    const { db } = database;
    await db.insertInto("meta").values({ key: "existing", value: "x", updated_at: 1 }).execute();
    await expect(
      database.batch([
        db.insertInto("meta").values({ key: "first", value: "x", updated_at: 1 }),
        db.updateTable("meta").set({ value: "changed" }).where("key", "=", "existing"),
        db.insertInto("meta").values({ key: "existing", value: "y", updated_at: 1 }),
      ]),
    ).rejects.toSatisfy(isUniqueViolation);
    expect(await meta()).toEqual([{ key: "existing", value: "x", updated_at: 1 }]);
  });

  it("returns positional results and affected-row counts from a batch", async () => {
    const { db } = database;
    const [insert, update, select] = await database.batch([
      db.insertInto("meta").values({ key: "a", value: "1", updated_at: 1 }),
      db.updateTable("meta").set({ value: "2" }).where("key", "=", "a"),
      db.selectFrom("meta").select(["key", "value"]),
    ]);
    expect(insert.numAffectedRows).toBe(1);
    expect(update.numAffectedRows).toBe(1);
    expect(select.rows).toEqual([{ key: "a", value: "2" }]);
    expect(database.stats.queries).toBeGreaterThan(0);
  });

  it(`caps statements at ${MAX_BOUND_PARAMETERS} bound parameters`, async () => {
    const { db } = database;
    await expect(
      db.selectFrom("meta").select("key").where("key", "in", keys(MAX_BOUND_PARAMETERS)).execute(),
    ).resolves.toEqual([]);
    await expect(
      db
        .selectFrom("meta")
        .select("key")
        .where("key", "in", keys(MAX_BOUND_PARAMETERS + 1))
        .execute(),
    ).rejects.toBeInstanceOf(TooManyParametersError);
    await expect(
      database.batch([db.deleteFrom("meta").where("key", "in", keys(MAX_BOUND_PARAMETERS + 1))]),
    ).rejects.toBeInstanceOf(TooManyParametersError);
  });

  it("enforces foreign keys (profile deletes cascade through them)", async () => {
    const { db } = database;
    const profile = {
      id: "p1",
      account_id: "missing",
      name: "x",
      avatar_id: "a",
      is_kids: 0,
      maturity_ceiling: "18+",
      pin_hash: null,
      settings_json: "{}",
      created_at: 1,
      updated_at: 1,
    };
    await expect(db.insertInto("profiles").values(profile).execute()).rejects.toThrow(
      /FOREIGN KEY/i,
    );
    await database.batch([
      db
        .insertInto("accounts")
        .values({ id: "a1", email: "a@x.dev", password_hash: "h", created_at: 1, updated_at: 1 }),
      db.insertInto("profiles").values({ ...profile, account_id: "a1" }),
      db.insertInto("my_list").values({ profile_id: "p1", title_id: "t1", added_at: 1 }),
    ]);
    await db.deleteFrom("accounts").where("id", "=", "a1").execute();
    expect(await db.selectFrom("my_list").selectAll().execute()).toEqual([]);
  });

  it("refuses interactive transactions", async () => {
    await expect(
      database.db.transaction().execute(async (trx) => {
        await trx.selectFrom("meta").selectAll().execute();
      }),
    ).rejects.toThrow(/no interactive transactions/);
  });

  it("loads the portable entry points in workerd", async () => {
    const main = await import("../../src/index.ts");
    const d1 = await import("../../src/d1.ts");
    expect(typeof main.createRepositories).toBe("function");
    expect(typeof main.createSqlSearchIndex).toBe("function");
    expect(typeof d1.createD1Database).toBe("function");
  });
});
