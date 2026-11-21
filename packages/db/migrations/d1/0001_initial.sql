-- GENERATED from packages/db/src/migrations/0001_initial.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

create table "meta" ("key" text not null primary key, "value" text not null, "updated_at" integer not null);
create table "accounts" ("id" text not null primary key, "email" text not null, "password_hash" text not null, "created_at" integer not null, "updated_at" integer not null, constraint "accounts_email_key" unique ("email"));
create table "subscriptions" ("account_id" text not null primary key references "accounts" ("id") on delete cascade, "plan_id" text not null, "started_at" integer not null, "current_period_end" integer not null, "canceled_at" integer, "card_brand" text, "card_last4" text, "card_exp_month" integer, "card_exp_year" integer, "updated_at" integer not null);
create table "profiles" ("id" text not null primary key, "account_id" text not null references "accounts" ("id") on delete cascade, "name" text not null, "avatar_id" text not null, "is_kids" integer not null, "maturity_ceiling" text not null, "pin_hash" text, "settings_json" text not null, "created_at" integer not null, "updated_at" integer not null);
create index "profiles_account_idx" on "profiles" ("account_id");
create table "sessions" ("id" text not null primary key, "token_hash" text not null, "account_id" text not null references "accounts" ("id") on delete cascade, "active_profile_id" text references "profiles" ("id") on delete set null, "device_label" text not null, "device_type" text not null, "persistent" integer not null, "created_at" integer not null, "last_seen_at" integer not null, "expires_at" integer not null, constraint "sessions_token_hash_key" unique ("token_hash"));
create index "sessions_account_idx" on "sessions" ("account_id");
create index "sessions_profile_idx" on "sessions" ("active_profile_id");
create table "avatar_groups" ("id" text not null primary key, "name" text not null, "position" integer not null);
create table "avatars" ("id" text not null primary key, "group_id" text not null, "name" text not null, "image_url" text not null, "position" integer not null);
create table "genres" ("id" text not null primary key, "slug" text not null, "name" text not null, "description" text, "position" integer not null, constraint "genres_slug_key" unique ("slug"));
create table "people" ("id" text not null primary key, "name" text not null);
create table "titles" ("id" text not null primary key, "type" text not null, "name" text not null, "tagline" text, "synopsis" text not null, "release_year" integer not null, "maturity" text not null, "maturity_rank" integer not null, "maturity_descriptors_json" text not null, "moods_json" text not null, "is_original" integer not null, "added_at" integer not null, "popularity" real not null, "runtime_sec" integer, "season_count" integer, "video_asset_id" text, "attribution_json" text, "audio_languages_json" text not null, "subtitle_languages_json" text not null, "images_json" text not null, "preview_json" text, "is_playable" integer not null);
create table "title_genres" ("title_id" text not null, "genre_id" text not null, "position" integer not null, constraint "title_genres_pkey" primary key ("title_id", "genre_id"));
create index "title_genres_genre_idx" on "title_genres" ("genre_id");
create table "credits" ("title_id" text not null, "person_id" text not null, "role" text not null, "character" text, "position" integer not null, constraint "credits_pkey" primary key ("title_id", "role", "person_id"));
create index "credits_person_idx" on "credits" ("person_id");
create table "seasons" ("title_id" text not null, "number" integer not null, "name" text not null, "release_year" integer, "episode_count" integer not null, constraint "seasons_pkey" primary key ("title_id", "number"));
create table "episodes" ("id" text not null primary key, "title_id" text not null, "season_number" integer not null, "number" integer not null, "seq" integer not null, "name" text not null, "synopsis" text not null, "runtime_sec" integer not null, "video_asset_id" text not null, "still_json" text, "is_playable" integer not null, constraint "episodes_title_season_number_key" unique ("title_id", "season_number", "number"));
create table "video_assets" ("id" text not null primary key, "label" text not null, "kind" text not null, "duration_sec" real, "master_key" text, "external_url" text, "max_height" integer, "text_tracks_json" text not null, "trick_play_json" text, "markers_json" text not null);
create table "notifications" ("id" text not null primary key, "kind" text not null, "title_id" text, "headline" text not null, "body" text not null, "image_json" text, "maturity" text not null, "maturity_rank" integer not null, "created_at" integer not null, "seed_version" text);
create index "notifications_created_idx" on "notifications" ("created_at");
create table "my_list" ("profile_id" text not null references "profiles" ("id") on delete cascade, "title_id" text not null, "added_at" integer not null, constraint "my_list_pkey" primary key ("profile_id", "title_id"));
create table "ratings" ("profile_id" text not null references "profiles" ("id") on delete cascade, "title_id" text not null, "value" text not null, "rated_at" integer not null, constraint "ratings_pkey" primary key ("profile_id", "title_id"));
create table "watch_progress" ("profile_id" text not null references "profiles" ("id") on delete cascade, "item_id" text not null, "title_id" text not null, "episode_id" text, "position_sec" real not null, "duration_sec" real not null, "completed" integer not null, "hidden" integer not null, "updated_at" integer not null, constraint "watch_progress_pkey" primary key ("profile_id", "item_id"));
create table "watch_history" ("id" text not null, "profile_id" text not null references "profiles" ("id") on delete cascade, "item_id" text not null, "title_id" text not null, "episode_id" text, "watched_at" integer not null, constraint "watch_history_pkey" primary key ("profile_id", "item_id"), constraint "watch_history_id_key" unique ("id"));
create index "watch_history_recent_idx" on "watch_history" ("profile_id", "watched_at");
create table "notification_reads" ("profile_id" text not null references "profiles" ("id") on delete cascade, "notification_id" text not null references "notifications" ("id") on delete cascade, "read_at" integer not null, constraint "notification_reads_pkey" primary key ("profile_id", "notification_id"));
create index "notification_reads_notification_idx" on "notification_reads" ("notification_id");
create table "playback_sessions" ("id" text not null primary key, "account_id" text not null references "accounts" ("id") on delete cascade, "profile_id" text not null references "profiles" ("id") on delete cascade, "session_id" text not null, "title_id" text not null, "episode_id" text, "asset_id" text, "max_video_height" integer not null, "started_at" integer not null, "last_heartbeat_at" integer not null, "ended_at" integer, "position_sec" real not null, "duration_sec" real not null, "watched_sec" real not null, "state" text not null);
create index "playback_sessions_started_idx" on "playback_sessions" ("started_at");
create index "playback_sessions_account_idx" on "playback_sessions" ("account_id");
create index "playback_sessions_profile_idx" on "playback_sessions" ("profile_id");
create table "title_stats" ("day" text not null, "title_id" text not null, "source" text not null, "views" integer not null, "watch_sec" real not null, "profiles" integer not null, constraint "title_stats_pkey" primary key ("day", "title_id", "source"));
create table "search_documents" ("title_id" text not null primary key, "type" text not null, "maturity_rank" integer not null, "popularity" real not null, "name_norm" text not null, "people_norm" text not null, "genres_norm" text not null, "moods_norm" text not null, "synopsis_norm" text not null);
CREATE VIRTUAL TABLE search_fts USING fts5(
        title_id UNINDEXED, name, people, genres, moods, synopsis,
        tokenize = 'unicode61 remove_diacritics 2'
      );
create table "search_labels" ("kind" text not null, "entity_id" text not null, "title_id" text not null, "label" text not null, "label_norm" text not null, "maturity_rank" integer not null, "popularity" real not null, constraint "search_labels_pkey" primary key ("kind", "entity_id", "title_id"));
create index "search_labels_title_idx" on "search_labels" ("title_id");
