import { readdir, readFile } from "node:fs/promises";
import { type Kysely, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { describe, expect, it } from "vitest";
import type { Database } from "../src/database.ts";
import {
  compileMigration,
  d1MigrationFile,
  MIGRATIONS,
  migrateToLatest,
} from "../src/migrations/index.ts";
import {
  createPostgresHarness,
  createSqliteHarness,
  dialectHarnesses,
  postgresAvailable,
} from "./harness.ts";

const d1Dir = new URL("../migrations/d1/", import.meta.url);

/** Pretend a release ran migration `name` (Kysely's bookkeeping table, current schema). */
async function recordMigration(database: Database, name: string): Promise<void> {
  await sql`INSERT INTO kysely_migration (name, timestamp) VALUES (${name}, ${new Date().toISOString()})`.execute(
    database.db,
  );
}

describe("generated D1 migration files", () => {
  it.each(MIGRATIONS.map((migration) => [migration.name, migration] as const))(
    "%s.sql matches its TypeScript source",
    async (name, migration) => {
      const onDisk = await readFile(new URL(`${name}.sql`, d1Dir), "utf8").catch(() => "");
      expect(
        onDisk,
        `migrations/d1/${name}.sql is stale or missing: run \`pnpm --filter @webflix/db generate\``,
      ).toBe(await d1MigrationFile(migration));
    },
  );

  it("has no SQL file without a TypeScript source", async () => {
    const files = (await readdir(d1Dir)).filter((file) => file.endsWith(".sql")).sort();
    expect(files).toEqual(MIGRATIONS.map((migration) => `${migration.name}.sql`));
  });
});

for (const harness of dialectHarnesses) {
  describe.skipIf(harness.skip)(`migrations on ${harness.label}`, () => {
    it("applies every migration once; running again is a no-op", async () => {
      const { database, cleanup } = await harness.create();
      try {
        // The harness already migrated: nothing left to apply.
        expect((await migrateToLatest(database)).applied).toEqual([]);
        expect((await migrateToLatest(database)).applied).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    // `helm rollback` runs the previous release's migrate against a schema a newer release
    // already moved forward: that must succeed (schemas are backward compatible by one
    // release), reporting what it does not know.
    it("succeeds when a newer release already applied migrations this one does not know", async () => {
      const { database, cleanup } = await harness.create();
      try {
        await recordMigration(database, "9999_added_by_newer_release");
        expect(await migrateToLatest(database)).toEqual({
          applied: [],
          ahead: ["9999_added_by_newer_release"],
        });
      } finally {
        await cleanup();
      }
    });

    it("still refuses an unknown migration that is not newer than every known one", async () => {
      const { database, cleanup } = await harness.create();
      try {
        await recordMigration(database, "0000_from_another_branch");
        await expect(migrateToLatest(database)).rejects.toThrow(/0000_from_another_branch/);
      } finally {
        await cleanup();
      }
    });

    it("still refuses newer migrations when a known one was never applied", async () => {
      const { database, cleanup } = await harness.create();
      try {
        const [first] = MIGRATIONS;
        if (!first) throw new Error("no migrations");
        await sql`DELETE FROM kysely_migration WHERE name = ${first.name}`.execute(database.db);
        await recordMigration(database, "9999_added_by_newer_release");
        await expect(migrateToLatest(database)).rejects.toThrow(/9999_added_by_newer_release/);
      } finally {
        await cleanup();
      }
    });
  });
}

type TypeFamily = "text" | "integer" | "real" | "other";

/** Physical types differ by name across dialects; what must match is the family. */
function typeFamily(dataType: string): TypeFamily {
  const type = dataType.toLowerCase();
  if (type === "text" || type === "varchar") return "text";
  if (["integer", "int", "int2", "int4", "int8", "bigint", "smallint"].includes(type)) {
    return "integer";
  }
  if (["real", "float4", "float8", "double precision"].includes(type)) return "real";
  return "other";
}

/** Engine-specific search structures that intentionally exist on one side only. */
const DIALECT_SPECIFIC_TABLE = /^search_fts(?:_|$)/;
const DIALECT_SPECIFIC_COLUMN = new Set(["search_documents.document"]);

async function describeSchema(database: Database, schema?: string) {
  const tables = await database.db.introspection.getTables();
  return tables
    .filter((table) => !table.isView)
    .filter((table) => schema === undefined || table.schema === schema)
    .filter((table) => !DIALECT_SPECIFIC_TABLE.test(table.name))
    .map((table) => ({
      table: table.name,
      columns: table.columns
        .filter((column) => !DIALECT_SPECIFIC_COLUMN.has(`${table.name}.${column.name}`))
        .map((column) => ({
          name: column.name,
          type: typeFamily(column.dataType),
          nullable: column.isNullable,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.table.localeCompare(b.table));
}

describe.skipIf(!postgresAvailable)("schema equivalence (SQLite/D1 vs Postgres)", () => {
  it("has the same tables, columns, type families and nullability", async () => {
    const sqlite = await createSqliteHarness();
    const postgres = await createPostgresHarness();
    try {
      const pgSchema = (
        await postgres.database.db
          .selectNoFrom((eb) => eb.fn<string>("current_schema", []).as("schema"))
          .executeTakeFirstOrThrow()
      ).schema;
      const left = await describeSchema(sqlite.database);
      const right = await describeSchema(postgres.database, pgSchema);
      expect(left.length).toBeGreaterThan(20);
      expect(left.flatMap((table) => table.columns).some((c) => c.type === "other")).toBe(false);
      expect(right).toEqual(left);
    } finally {
      await sqlite.cleanup();
      await postgres.cleanup();
    }
  });
});

// --- Milestone 2 ---------------------------------------------------------------------------

describe("migration list", () => {
  it("is sorted by unique names, area migrations named after their area", () => {
    const names = MIGRATIONS.map((migration) => migration.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(names);
    for (const name of names) expect(name).toMatch(/^\d{4}_[a-z0-9_]+$/);
    expect(names).toEqual(
      expect.arrayContaining([
        "0002_identity",
        "0003_billing",
        "0004_events",
        "0005_personalisation",
        "0006_experiments",
        "0007_admin",
      ]),
    );
  });

  it("adds columns to milestone 1 tables only as nullable ADD COLUMN (no table rebuild)", async () => {
    for (const migration of MIGRATIONS.slice(1)) {
      for (const statement of await compileMigration(migration, "d1")) {
        // A rebuild (drop + rename) of a parent table cascades deletes through its children on
        // SQLite and D1, whatever defer_foreign_keys says: see 0002_identity.
        expect(statement, migration.name).not.toMatch(/^\s*(drop table|alter table \S+ rename)/i);
        const added = /^alter table "(\w+)" add column "(\w+)" (\w+)(.*)$/i.exec(statement);
        if (added) expect(added[4] ?? "", `${added[1]}.${added[2]}`).not.toMatch(/not null/i);
      }
    }
  });
});

const PREVIOUS_RELEASE = MIGRATIONS.filter((migration) => migration.name === "0001_initial");

/** Seed one account of milestone 1 (account, membership, profile, session, list entry). */
async function seedMilestone1(database: Database): Promise<void> {
  const now = Date.UTC(2026, 10, 1);
  await database.batch([
    database.db.insertInto("accounts").values({
      id: "acct-m1",
      email: "m1@example.test",
      password_hash: "$pbkdf2-sha256$i=1000$c2FsdA$aGFzaA",
      created_at: now,
      updated_at: now,
    }),
    database.db.insertInto("subscriptions").values({
      account_id: "acct-m1",
      plan_id: "standard",
      started_at: now,
      current_period_end: now + 30 * 86_400_000,
      canceled_at: null,
      card_brand: "visa",
      card_last4: "4242",
      card_exp_month: 12,
      card_exp_year: 2030,
      updated_at: now,
    }),
    database.db.insertInto("profiles").values({
      id: "prof-m1",
      account_id: "acct-m1",
      name: "Me",
      avatar_id: "av-fox",
      is_kids: 0,
      maturity_ceiling: "18+",
      pin_hash: null,
      settings_json: "{}",
      created_at: now,
      updated_at: now,
    }),
    database.db.insertInto("sessions").values({
      id: "sess-m1",
      token_hash: "hash-m1",
      account_id: "acct-m1",
      active_profile_id: "prof-m1",
      device_label: "Firefox on macOS",
      device_type: "desktop",
      persistent: 1,
      created_at: now,
      last_seen_at: now,
      expires_at: now + 86_400_000,
    }),
    database.db
      .insertInto("my_list")
      .values({ profile_id: "prof-m1", title_id: "t-sintel", added_at: now }),
  ]);
}

/** What a milestone 1 database holds for the seeded account, and its new columns. */
async function milestone1Rows(database: Database) {
  const db = database.db;
  return {
    accounts: await db.selectFrom("accounts").select(["id", "email_verified_at"]).execute(),
    profiles: await db.selectFrom("profiles").select("id").execute(),
    sessions: await db.selectFrom("sessions").select(["id", "elevated_until"]).execute(),
    subscriptions: await db.selectFrom("subscriptions").select("account_id").execute(),
    myList: await db.selectFrom("my_list").select("title_id").execute(),
  };
}

for (const harness of dialectHarnesses) {
  describe.skipIf(harness.skip)(`milestone 2 migrations on ${harness.label}`, () => {
    it("upgrade a milestone 1 database without touching its rows", async () => {
      const { database, cleanup } = await harness.create();
      try {
        // Back to the milestone 1 schema: a fresh database migrated by the previous release.
        await resetToPreviousRelease(database);
        await seedMilestone1(database);
        const applied = (await migrateToLatest(database)).applied;
        expect(applied).toEqual(MIGRATIONS.slice(1).map((migration) => migration.name));
        expect(await milestone1Rows(database)).toEqual({
          accounts: [{ id: "acct-m1", email_verified_at: null }],
          profiles: [{ id: "prof-m1" }],
          sessions: [{ id: "sess-m1", elevated_until: null }],
          subscriptions: [{ account_id: "acct-m1" }],
          myList: [{ title_id: "t-sintel" }],
        });
        // The new tables exist and accept rows that reference milestone 1 data.
        await database.db
          .insertInto("account_identities")
          .values({
            provider: "google",
            subject: "1234567890",
            account_id: "acct-m1",
            issuer: "https://accounts.google.com",
            email_at_link: "m1@example.test",
            created_at: 1,
            last_used_at: 1,
          })
          .execute();
        await database.db.deleteFrom("accounts").where("id", "=", "acct-m1").execute();
        expect(await database.db.selectFrom("account_identities").selectAll().execute()).toEqual(
          [],
        );
      } finally {
        await cleanup();
      }
    });
  });
}

/**
 * Drop everything a harness migrated and migrate again with the previous release's list only, so
 * the test starts from exactly the milestone 1 schema.
 */
async function resetToPreviousRelease(database: Database): Promise<void> {
  if (database.dialect === "postgres") {
    await sql`DROP SCHEMA IF EXISTS ${sql.raw(await currentSchemaName(database))} CASCADE`.execute(
      database.db,
    );
    await sql`CREATE SCHEMA ${sql.raw(await currentSchemaName(database))}`.execute(database.db);
  } else {
    await sql`PRAGMA foreign_keys = OFF`.execute(database.db);
    const tables = await sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_fts_%'`.execute(
      database.db,
    );
    for (const { name } of tables.rows) {
      await sql`DROP TABLE IF EXISTS ${sql.table(name)}`.execute(database.db);
    }
    await sql`PRAGMA foreign_keys = ON`.execute(database.db);
  }
  const migrator = new Migrator({
    db: database.db,
    provider: {
      async getMigrations() {
        return Object.fromEntries(
          PREVIOUS_RELEASE.map((migration) => [
            migration.name,
            { up: (db: Kysely<unknown>) => migration.up(db, database.dialect) },
          ]),
        );
      },
    },
  });
  const { error } = await migrator.migrateToLatest();
  if (error) throw error;
}

async function currentSchemaName(database: Database): Promise<string> {
  const result = await sql<{ schema: string }>`SELECT current_schema() AS schema`.execute(
    database.db,
  );
  return result.rows[0]?.schema ?? "public";
}
