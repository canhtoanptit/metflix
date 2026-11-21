import { type Kysely, sql } from "kysely";
import type { SqlDialect } from "../dialect.ts";
import { columnTypes } from "./types.ts";

/**
 * Initial schema. Authored once for every dialect; the few differences (int8 vs integer,
 * the search index) are explicit branches. D1 SQL files are generated from this function
 * (`pnpm --filter @webflix/db generate`), never written by hand.
 */
// biome-ignore lint/suspicious/noExplicitAny: migrations run against the schema as it was, not today's `DB`.
export async function up(db: Kysely<any>, dialect: SqlDialect): Promise<void> {
  const t = columnTypes(dialect);

  await db.schema
    .createTable("meta")
    .addColumn("key", t.text, (c) => c.primaryKey().notNull())
    .addColumn("value", t.text, (c) => c.notNull())
    .addColumn("updated_at", t.time, (c) => c.notNull())
    .execute();

  // --- Identity -------------------------------------------------------------------------------
  await db.schema
    .createTable("accounts")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("email", t.text, (c) => c.notNull())
    .addColumn("password_hash", t.text, (c) => c.notNull())
    .addColumn("created_at", t.time, (c) => c.notNull())
    .addColumn("updated_at", t.time, (c) => c.notNull())
    .addUniqueConstraint("accounts_email_key", ["email"])
    .execute();

  await db.schema
    .createTable("subscriptions")
    .addColumn("account_id", t.text, (c) =>
      c.primaryKey().notNull().references("accounts.id").onDelete("cascade"),
    )
    .addColumn("plan_id", t.text, (c) => c.notNull())
    .addColumn("started_at", t.time, (c) => c.notNull())
    .addColumn("current_period_end", t.time, (c) => c.notNull())
    .addColumn("canceled_at", t.time)
    .addColumn("card_brand", t.text)
    .addColumn("card_last4", t.text)
    .addColumn("card_exp_month", t.int)
    .addColumn("card_exp_year", t.int)
    .addColumn("updated_at", t.time, (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("profiles")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("account_id", t.text, (c) =>
      c.notNull().references("accounts.id").onDelete("cascade"),
    )
    .addColumn("name", t.text, (c) => c.notNull())
    .addColumn("avatar_id", t.text, (c) => c.notNull())
    .addColumn("is_kids", t.bool, (c) => c.notNull())
    .addColumn("maturity_ceiling", t.text, (c) => c.notNull())
    .addColumn("pin_hash", t.text)
    .addColumn("settings_json", t.text, (c) => c.notNull())
    .addColumn("created_at", t.time, (c) => c.notNull())
    .addColumn("updated_at", t.time, (c) => c.notNull())
    .execute();
  await db.schema.createIndex("profiles_account_idx").on("profiles").column("account_id").execute();

  await db.schema
    .createTable("sessions")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("token_hash", t.text, (c) => c.notNull())
    .addColumn("account_id", t.text, (c) =>
      c.notNull().references("accounts.id").onDelete("cascade"),
    )
    .addColumn("active_profile_id", t.text, (c) => c.references("profiles.id").onDelete("set null"))
    .addColumn("device_label", t.text, (c) => c.notNull())
    .addColumn("device_type", t.text, (c) => c.notNull())
    .addColumn("persistent", t.bool, (c) => c.notNull())
    .addColumn("created_at", t.time, (c) => c.notNull())
    .addColumn("last_seen_at", t.time, (c) => c.notNull())
    .addColumn("expires_at", t.time, (c) => c.notNull())
    .addUniqueConstraint("sessions_token_hash_key", ["token_hash"])
    .execute();
  await db.schema.createIndex("sessions_account_idx").on("sessions").column("account_id").execute();
  await db.schema
    .createIndex("sessions_profile_idx")
    .on("sessions")
    .column("active_profile_id")
    .execute();

  // --- Catalog (seed-owned; no foreign keys between catalog tables: written atomically) ------
  await db.schema
    .createTable("avatar_groups")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("name", t.text, (c) => c.notNull())
    .addColumn("position", t.int, (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("avatars")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("group_id", t.text, (c) => c.notNull())
    .addColumn("name", t.text, (c) => c.notNull())
    .addColumn("image_url", t.text, (c) => c.notNull())
    .addColumn("position", t.int, (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("genres")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("slug", t.text, (c) => c.notNull())
    .addColumn("name", t.text, (c) => c.notNull())
    .addColumn("description", t.text)
    .addColumn("position", t.int, (c) => c.notNull())
    .addUniqueConstraint("genres_slug_key", ["slug"])
    .execute();

  await db.schema
    .createTable("people")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("name", t.text, (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("titles")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("type", t.text, (c) => c.notNull())
    .addColumn("name", t.text, (c) => c.notNull())
    .addColumn("tagline", t.text)
    .addColumn("synopsis", t.text, (c) => c.notNull())
    .addColumn("release_year", t.int, (c) => c.notNull())
    .addColumn("maturity", t.text, (c) => c.notNull())
    .addColumn("maturity_rank", t.int, (c) => c.notNull())
    .addColumn("maturity_descriptors_json", t.text, (c) => c.notNull())
    .addColumn("moods_json", t.text, (c) => c.notNull())
    .addColumn("is_original", t.bool, (c) => c.notNull())
    .addColumn("added_at", t.time, (c) => c.notNull())
    .addColumn("popularity", t.real, (c) => c.notNull())
    .addColumn("runtime_sec", t.int)
    .addColumn("season_count", t.int)
    .addColumn("video_asset_id", t.text)
    .addColumn("attribution_json", t.text)
    .addColumn("audio_languages_json", t.text, (c) => c.notNull())
    .addColumn("subtitle_languages_json", t.text, (c) => c.notNull())
    .addColumn("images_json", t.text, (c) => c.notNull())
    .addColumn("preview_json", t.text)
    .addColumn("is_playable", t.bool, (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("title_genres")
    .addColumn("title_id", t.text, (c) => c.notNull())
    .addColumn("genre_id", t.text, (c) => c.notNull())
    .addColumn("position", t.int, (c) => c.notNull())
    .addPrimaryKeyConstraint("title_genres_pkey", ["title_id", "genre_id"])
    .execute();
  await db.schema
    .createIndex("title_genres_genre_idx")
    .on("title_genres")
    .column("genre_id")
    .execute();

  await db.schema
    .createTable("credits")
    .addColumn("title_id", t.text, (c) => c.notNull())
    .addColumn("person_id", t.text, (c) => c.notNull())
    .addColumn("role", t.text, (c) => c.notNull())
    .addColumn("character", t.text)
    .addColumn("position", t.int, (c) => c.notNull())
    .addPrimaryKeyConstraint("credits_pkey", ["title_id", "role", "person_id"])
    .execute();
  await db.schema.createIndex("credits_person_idx").on("credits").column("person_id").execute();

  await db.schema
    .createTable("seasons")
    .addColumn("title_id", t.text, (c) => c.notNull())
    .addColumn("number", t.int, (c) => c.notNull())
    .addColumn("name", t.text, (c) => c.notNull())
    .addColumn("release_year", t.int)
    .addColumn("episode_count", t.int, (c) => c.notNull())
    .addPrimaryKeyConstraint("seasons_pkey", ["title_id", "number"])
    .execute();

  await db.schema
    .createTable("episodes")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("title_id", t.text, (c) => c.notNull())
    .addColumn("season_number", t.int, (c) => c.notNull())
    .addColumn("number", t.int, (c) => c.notNull())
    .addColumn("seq", t.int, (c) => c.notNull())
    .addColumn("name", t.text, (c) => c.notNull())
    .addColumn("synopsis", t.text, (c) => c.notNull())
    .addColumn("runtime_sec", t.int, (c) => c.notNull())
    .addColumn("video_asset_id", t.text, (c) => c.notNull())
    .addColumn("still_json", t.text)
    .addColumn("is_playable", t.bool, (c) => c.notNull())
    .addUniqueConstraint("episodes_title_season_number_key", [
      "title_id",
      "season_number",
      "number",
    ])
    .execute();

  await db.schema
    .createTable("video_assets")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("label", t.text, (c) => c.notNull())
    .addColumn("kind", t.text, (c) => c.notNull())
    .addColumn("duration_sec", t.real)
    .addColumn("master_key", t.text)
    .addColumn("external_url", t.text)
    .addColumn("max_height", t.int)
    .addColumn("text_tracks_json", t.text, (c) => c.notNull())
    .addColumn("trick_play_json", t.text)
    .addColumn("markers_json", t.text, (c) => c.notNull())
    .execute();

  await db.schema
    .createTable("notifications")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("kind", t.text, (c) => c.notNull())
    .addColumn("title_id", t.text)
    .addColumn("headline", t.text, (c) => c.notNull())
    .addColumn("body", t.text, (c) => c.notNull())
    .addColumn("image_json", t.text)
    .addColumn("maturity", t.text, (c) => c.notNull())
    .addColumn("maturity_rank", t.int, (c) => c.notNull())
    .addColumn("created_at", t.time, (c) => c.notNull())
    // Catalog version that wrote a seeded notification; re-seeding drops stale ones without
    // deleting (and so un-reading) the ones that still exist.
    .addColumn("seed_version", t.text)
    .execute();
  await db.schema
    .createIndex("notifications_created_idx")
    .on("notifications")
    .column("created_at")
    .execute();

  // --- Library (owned by a profile) ------------------------------------------------------------
  await db.schema
    .createTable("my_list")
    .addColumn("profile_id", t.text, (c) =>
      c.notNull().references("profiles.id").onDelete("cascade"),
    )
    .addColumn("title_id", t.text, (c) => c.notNull())
    .addColumn("added_at", t.time, (c) => c.notNull())
    .addPrimaryKeyConstraint("my_list_pkey", ["profile_id", "title_id"])
    .execute();

  await db.schema
    .createTable("ratings")
    .addColumn("profile_id", t.text, (c) =>
      c.notNull().references("profiles.id").onDelete("cascade"),
    )
    .addColumn("title_id", t.text, (c) => c.notNull())
    .addColumn("value", t.text, (c) => c.notNull())
    .addColumn("rated_at", t.time, (c) => c.notNull())
    .addPrimaryKeyConstraint("ratings_pkey", ["profile_id", "title_id"])
    .execute();

  await db.schema
    .createTable("watch_progress")
    .addColumn("profile_id", t.text, (c) =>
      c.notNull().references("profiles.id").onDelete("cascade"),
    )
    .addColumn("item_id", t.text, (c) => c.notNull())
    .addColumn("title_id", t.text, (c) => c.notNull())
    .addColumn("episode_id", t.text)
    .addColumn("position_sec", t.real, (c) => c.notNull())
    .addColumn("duration_sec", t.real, (c) => c.notNull())
    .addColumn("completed", t.bool, (c) => c.notNull())
    .addColumn("hidden", t.bool, (c) => c.notNull())
    .addColumn("updated_at", t.time, (c) => c.notNull())
    .addPrimaryKeyConstraint("watch_progress_pkey", ["profile_id", "item_id"])
    .execute();

  await db.schema
    .createTable("watch_history")
    .addColumn("id", t.text, (c) => c.notNull())
    .addColumn("profile_id", t.text, (c) =>
      c.notNull().references("profiles.id").onDelete("cascade"),
    )
    .addColumn("item_id", t.text, (c) => c.notNull())
    .addColumn("title_id", t.text, (c) => c.notNull())
    .addColumn("episode_id", t.text)
    .addColumn("watched_at", t.time, (c) => c.notNull())
    .addPrimaryKeyConstraint("watch_history_pkey", ["profile_id", "item_id"])
    .addUniqueConstraint("watch_history_id_key", ["id"])
    .execute();
  await db.schema
    .createIndex("watch_history_recent_idx")
    .on("watch_history")
    .columns(["profile_id", "watched_at"])
    .execute();

  await db.schema
    .createTable("notification_reads")
    .addColumn("profile_id", t.text, (c) =>
      c.notNull().references("profiles.id").onDelete("cascade"),
    )
    .addColumn("notification_id", t.text, (c) =>
      c.notNull().references("notifications.id").onDelete("cascade"),
    )
    .addColumn("read_at", t.time, (c) => c.notNull())
    .addPrimaryKeyConstraint("notification_reads_pkey", ["profile_id", "notification_id"])
    .execute();
  await db.schema
    .createIndex("notification_reads_notification_idx")
    .on("notification_reads")
    .column("notification_id")
    .execute();

  // --- Playback and stats ---------------------------------------------------------------------
  await db.schema
    .createTable("playback_sessions")
    .addColumn("id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("account_id", t.text, (c) =>
      c.notNull().references("accounts.id").onDelete("cascade"),
    )
    .addColumn("profile_id", t.text, (c) =>
      c.notNull().references("profiles.id").onDelete("cascade"),
    )
    .addColumn("session_id", t.text, (c) => c.notNull())
    .addColumn("title_id", t.text, (c) => c.notNull())
    .addColumn("episode_id", t.text)
    .addColumn("asset_id", t.text)
    .addColumn("max_video_height", t.int, (c) => c.notNull())
    .addColumn("started_at", t.time, (c) => c.notNull())
    .addColumn("last_heartbeat_at", t.time, (c) => c.notNull())
    .addColumn("ended_at", t.time)
    .addColumn("position_sec", t.real, (c) => c.notNull())
    .addColumn("duration_sec", t.real, (c) => c.notNull())
    .addColumn("watched_sec", t.real, (c) => c.notNull())
    .addColumn("state", t.text, (c) => c.notNull())
    .execute();
  await db.schema
    .createIndex("playback_sessions_started_idx")
    .on("playback_sessions")
    .column("started_at")
    .execute();
  await db.schema
    .createIndex("playback_sessions_account_idx")
    .on("playback_sessions")
    .column("account_id")
    .execute();
  await db.schema
    .createIndex("playback_sessions_profile_idx")
    .on("playback_sessions")
    .column("profile_id")
    .execute();

  await db.schema
    .createTable("title_stats")
    .addColumn("day", t.text, (c) => c.notNull())
    .addColumn("title_id", t.text, (c) => c.notNull())
    .addColumn("source", t.text, (c) => c.notNull())
    .addColumn("views", t.int, (c) => c.notNull())
    .addColumn("watch_sec", t.real, (c) => c.notNull())
    .addColumn("profiles", t.int, (c) => c.notNull())
    .addPrimaryKeyConstraint("title_stats_pkey", ["day", "title_id", "source"])
    .execute();

  // --- Search ---------------------------------------------------------------------------------
  // Text is normalised in application code (`normalizeSearchText`: lowercase, no diacritics,
  // no punctuation), so both engines index the same tokens.
  await db.schema
    .createTable("search_documents")
    .addColumn("title_id", t.text, (c) => c.primaryKey().notNull())
    .addColumn("type", t.text, (c) => c.notNull())
    .addColumn("maturity_rank", t.int, (c) => c.notNull())
    .addColumn("popularity", t.real, (c) => c.notNull())
    .addColumn("name_norm", t.text, (c) => c.notNull())
    .addColumn("people_norm", t.text, (c) => c.notNull())
    .addColumn("genres_norm", t.text, (c) => c.notNull())
    .addColumn("moods_norm", t.text, (c) => c.notNull())
    .addColumn("synopsis_norm", t.text, (c) => c.notNull())
    .execute();

  if (dialect === "postgres") {
    // Postgres FTS: one weighted tsvector (A name, B people, C genres+moods, D synopsis).
    // The two-argument to_tsvector is immutable, so it can back a stored generated column.
    await sql`
      ALTER TABLE search_documents ADD COLUMN document tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', name_norm), 'A') ||
        setweight(to_tsvector('simple', people_norm), 'B') ||
        setweight(to_tsvector('simple', genres_norm || ' ' || moods_norm), 'C') ||
        setweight(to_tsvector('simple', synopsis_norm), 'D')
      ) STORED
    `.execute(db);
    await sql`CREATE INDEX search_documents_document_idx ON search_documents USING gin (document)`.execute(
      db,
    );
  } else {
    // SQLite and D1: FTS5. `title_id` is stored but not tokenised.
    await sql`
      CREATE VIRTUAL TABLE search_fts USING fts5(
        title_id UNINDEXED, name, people, genres, moods, synopsis,
        tokenize = 'unicode61 remove_diacritics 2'
      )
    `.execute(db);
  }

  await db.schema
    .createTable("search_labels")
    .addColumn("kind", t.text, (c) => c.notNull())
    .addColumn("entity_id", t.text, (c) => c.notNull())
    .addColumn("title_id", t.text, (c) => c.notNull())
    .addColumn("label", t.text, (c) => c.notNull())
    .addColumn("label_norm", t.text, (c) => c.notNull())
    .addColumn("maturity_rank", t.int, (c) => c.notNull())
    .addColumn("popularity", t.real, (c) => c.notNull())
    .addPrimaryKeyConstraint("search_labels_pkey", ["kind", "entity_id", "title_id"])
    .execute();
  await db.schema
    .createIndex("search_labels_title_idx")
    .on("search_labels")
    .column("title_id")
    .execute();
}
