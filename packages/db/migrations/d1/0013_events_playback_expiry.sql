-- GENERATED from packages/db/src/migrations/events/0013_events_playback_expiry.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

create index "playback_sessions_open_idx" on "playback_sessions" ("last_heartbeat_at") where "ended_at" is null;
