-- GENERATED from packages/db/src/migrations/events/0011_events_privacy_open.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

create unique index "privacy_requests_open_idx" on "privacy_requests" ("account_id", "kind") where "status" in ('pending', 'scheduled', 'processing');
