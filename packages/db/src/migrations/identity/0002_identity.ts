import type { Kysely } from "kysely";
import type { SqlDialect } from "../../dialect.ts";
import { columnTypes } from "../types.ts";

/**
 * Milestone 2, identity area (docs/BLUEPRINT-M2.md §4, §8.2): linked issuer identities,
 * single-use email tokens, the email outbox and the suppression list, and two new columns.
 *
 * `accounts.password_hash` stays NOT NULL although §4.1 makes it nullable: SQLite and D1 cannot
 * drop NOT NULL without rebuilding the table, and dropping `accounts` deletes every profile,
 * session and subscription through their ON DELETE CASCADE, even with `defer_foreign_keys`
 * (checked against SQLite 3.53; D1 cannot turn foreign keys off). A passwordless account stores
 * the empty string, which no hasher accepts; the repository maps it to `null` (FOUNDATION.md §8).
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was.
export async function up(db: Kysely<any>, dialect: SqlDialect): Promise<void> {
  const t = columnTypes(dialect);

  // §4.3: automatic linking depends on a verified email.
  await db.schema.alterTable("accounts").addColumn("email_verified_at", t.time).execute();
  // §4.2: the account-holder proof (password or a fresh sign-in) lasts 5 minutes.
  await db.schema.alterTable("sessions").addColumn("elevated_until", t.time).execute();

  // §4.1: identities are keyed by (provider, subject) only, never by email.
  await db.schema
    .createTable("account_identities")
    .addColumn("provider", t.text, (c) => c.notNull())
    .addColumn("subject", t.text, (c) => c.notNull())
    .addColumn("account_id", t.text, (c) =>
      c.notNull().references("accounts.id").onDelete("cascade"),
    )
    .addColumn("issuer", t.text, (c) => c.notNull())
    .addColumn("email_at_link", t.text)
    .addColumn("created_at", t.time, (c) => c.notNull())
    .addColumn("last_used_at", t.time, (c) => c.notNull())
    .addPrimaryKeyConstraint("account_identities_pkey", ["provider", "subject"])
    .execute();
  await db.schema
    .createIndex("account_identities_account_idx")
    .on("account_identities")
    .column("account_id")
    .execute();

  // §4.3: verification (24 h) and reset (30 min) tokens, single use, stored only as hashes.
  await db.schema
    .createTable("account_tokens")
    .addColumn("token_hash", t.text, (c) => c.primaryKey().notNull())
    .addColumn("account_id", t.text, (c) =>
      c.notNull().references("accounts.id").onDelete("cascade"),
    )
    .addColumn("purpose", t.text, (c) => c.notNull())
    .addColumn("email", t.text, (c) => c.notNull())
    .addColumn("expires_at", t.time, (c) => c.notNull())
    .addColumn("used_at", t.time)
    .addColumn("created_at", t.time, (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("account_tokens_account_idx")
    .on("account_tokens")
    .columns(["account_id", "purpose"])
    .execute();

  // §8.2: sending is a job with an idempotency key; the D1 outbox of local Cloudflare keeps the
  // rendered bodies for the mailbox API (other senders leave them null).
  await db.schema
    .createTable("email_outbox")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("idempotency_key", t.text, (c) => c.notNull())
    .addColumn("to_address", t.text, (c) => c.notNull())
    .addColumn("from_address", t.text, (c) => c.notNull())
    .addColumn("template", t.text, (c) => c.notNull())
    .addColumn("subject", t.text, (c) => c.notNull())
    .addColumn("html_body", t.text)
    .addColumn("text_body", t.text)
    .addColumn("status", t.text, (c) => c.notNull())
    .addColumn("provider_message_id", t.text)
    .addColumn("attempts", t.int, (c) => c.notNull())
    .addColumn("last_error", t.text)
    .addColumn("created_at", t.time, (c) => c.notNull())
    .addColumn("sent_at", t.time)
    .addUniqueConstraint("email_outbox_idempotency_key_key", ["idempotency_key"])
    .execute();
  await db.schema
    .createIndex("email_outbox_recipient_idx")
    .on("email_outbox")
    .columns(["to_address", "created_at"])
    .execute();

  // §8.2: bounces and complaints suppress further mail to an address.
  await db.schema
    .createTable("email_suppressions")
    .addColumn("address", t.text, (c) => c.primaryKey().notNull())
    .addColumn("reason", t.text, (c) => c.notNull())
    .addColumn("source", t.text, (c) => c.notNull())
    .addColumn("created_at", t.time, (c) => c.notNull())
    .execute();
}
