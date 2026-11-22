-- GENERATED from packages/db/src/migrations/identity/0002_identity.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

alter table "accounts" add column "email_verified_at" integer;
alter table "sessions" add column "elevated_until" integer;
create table "account_identities" ("provider" text not null, "subject" text not null, "account_id" text not null references "accounts" ("id") on delete cascade, "issuer" text not null, "email_at_link" text, "created_at" integer not null, "last_used_at" integer not null, constraint "account_identities_pkey" primary key ("provider", "subject"));
create index "account_identities_account_idx" on "account_identities" ("account_id");
create table "account_tokens" ("token_hash" text not null primary key, "account_id" text not null references "accounts" ("id") on delete cascade, "purpose" text not null, "email" text not null, "expires_at" integer not null, "used_at" integer, "created_at" integer not null);
create index "account_tokens_account_idx" on "account_tokens" ("account_id", "purpose");
create table "email_outbox" ("id" text not null primary key, "idempotency_key" text not null, "to_address" text not null, "from_address" text not null, "template" text not null, "subject" text not null, "html_body" text, "text_body" text, "status" text not null, "provider_message_id" text, "attempts" integer not null, "last_error" text, "created_at" integer not null, "sent_at" integer, constraint "email_outbox_idempotency_key_key" unique ("idempotency_key"));
create index "email_outbox_recipient_idx" on "email_outbox" ("to_address", "created_at");
create table "email_suppressions" ("address" text not null primary key, "reason" text not null, "source" text not null, "created_at" integer not null);
