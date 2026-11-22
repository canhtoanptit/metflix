/**
 * Milestone 2's D1 migration files applied to a database at the milestone 1 schema, the way
 * `wrangler d1 migrations apply` upgrades a deployment: every milestone 1 row survives.
 */
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("D1 upgrade from milestone 1", () => {
  it("applies 0002+ to a populated milestone 1 database without losing a row", async () => {
    const db = env.DB_UPGRADE;
    const [initial] = env.TEST_MIGRATIONS;
    if (!initial) throw new Error("no migrations");
    await applyD1Migrations(db, [initial]);
    const now = Date.UTC(2026, 10, 1);
    await db.batch([
      db
        .prepare(
          "INSERT INTO accounts (id, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind("acct-m1", "m1@example.test", "$pbkdf2-sha256$i=1000$c2FsdA$aGFzaA", now, now),
      db
        .prepare(
          "INSERT INTO profiles (id, account_id, name, avatar_id, is_kids, maturity_ceiling, pin_hash, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, 0, '18+', NULL, '{}', ?, ?)",
        )
        .bind("prof-m1", "acct-m1", "Me", "av-fox", now, now),
      db
        .prepare(
          "INSERT INTO sessions (id, token_hash, account_id, active_profile_id, device_label, device_type, persistent, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, 'Firefox on macOS', 'desktop', 1, ?, ?, ?)",
        )
        .bind("sess-m1", "hash-m1", "acct-m1", "prof-m1", now, now, now + 86_400_000),
    ]);

    await applyD1Migrations(db, env.TEST_MIGRATIONS);

    const applied = await db
      .prepare("SELECT name FROM d1_migrations ORDER BY id")
      .all<{ name: string }>();
    expect(applied.results.map((row) => row.name)).toEqual(
      env.TEST_MIGRATIONS.map((migration) => migration.name),
    );
    expect(await db.prepare("SELECT id, email_verified_at FROM accounts").all()).toMatchObject({
      results: [{ id: "acct-m1", email_verified_at: null }],
    });
    expect(await db.prepare("SELECT id FROM profiles").all()).toMatchObject({
      results: [{ id: "prof-m1" }],
    });
    expect(await db.prepare("SELECT id, elevated_until FROM sessions").all()).toMatchObject({
      results: [{ id: "sess-m1", elevated_until: null }],
    });
    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .bind("audit_log")
      .all();
    expect(tables.results).toHaveLength(1);
  });
});
