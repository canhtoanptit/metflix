/**
 * Kysely table types, identical for every dialect (blueprint §2.2). The physical types are
 * chosen so one set of queries works on SQLite, D1 and PostgreSQL:
 *
 * - ids: `text` (UUIDv7 at runtime, stable slugs in seeds)
 * - timestamps: epoch milliseconds, `integer` (SQLite/D1) / `bigint` (Postgres; the pg driver
 *   is configured to return int8 as a JS number, exact up to 2^53)
 * - booleans: `integer` 0/1 everywhere (SQLite has no boolean; one representation keeps
 *   predicates identical). Mapped to `boolean` in exactly one place: `fromBool`/`toBool`.
 * - JSON: `text` everywhere, encoded/decoded by `json`/`parseJson` in the repositories.
 */

import { ADMIN_TABLES, type AdminTables } from "./tables/admin.ts";
import { BILLING_TABLES, type BillingTables } from "./tables/billing.ts";
import { EVENTS_TABLES, type EventsTables } from "./tables/events.ts";
import { EXPERIMENTS_TABLES, type ExperimentsTables } from "./tables/experiments.ts";
import { IDENTITY_TABLES, type IdentityTables } from "./tables/identity.ts";
import { PERSONALISATION_TABLES, type PersonalisationTables } from "./tables/personalisation.ts";

export interface AccountsTable {
  id: string;
  email: string;
  /**
   * PHC string. Milestone 2: the empty string for an account without a password (created through
   * an issuer); the column stays NOT NULL (migration 0002_identity says why).
   */
  password_hash: string;
  created_at: number;
  updated_at: number;
  /** Milestone 2 (identity, 0002). */
  email_verified_at: number | null;
  /**
   * Identity, 0022: when every way in was last proven to be set up by the address's owner;
   * automatic linking requires it (the migration says when it is set and cleared).
   */
  access_proven_at: number | null;
}

export interface SubscriptionsTable {
  account_id: string;
  plan_id: string;
  started_at: number;
  current_period_end: number;
  canceled_at: number | null;
  card_brand: string | null;
  card_last4: string | null;
  card_exp_month: number | null;
  card_exp_year: number | null;
  updated_at: number;
}

export interface SessionsTable {
  id: string;
  token_hash: string;
  account_id: string;
  active_profile_id: string | null;
  device_label: string;
  device_type: string;
  persistent: number;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  /** Milestone 2 (identity, 0002): the account-holder proof holds until then. */
  elevated_until: number | null;
}

export interface ProfilesTable {
  id: string;
  account_id: string;
  name: string;
  avatar_id: string;
  is_kids: number;
  maturity_ceiling: string;
  pin_hash: string | null;
  settings_json: string;
  created_at: number;
  updated_at: number;
}

export interface AvatarGroupsTable {
  id: string;
  name: string;
  position: number;
}

export interface AvatarsTable {
  id: string;
  group_id: string;
  name: string;
  image_url: string;
  position: number;
}

export interface GenresTable {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  position: number;
}

export interface PeopleTable {
  id: string;
  name: string;
}

export interface TitlesTable {
  id: string;
  type: string;
  name: string;
  tagline: string | null;
  synopsis: string;
  release_year: number;
  maturity: string;
  maturity_rank: number;
  maturity_descriptors_json: string;
  moods_json: string;
  is_original: number;
  added_at: number;
  popularity: number;
  runtime_sec: number | null;
  season_count: number | null;
  video_asset_id: string | null;
  attribution_json: string | null;
  audio_languages_json: string;
  subtitle_languages_json: string;
  images_json: string;
  preview_json: string | null;
  is_playable: number;
}

export interface TitleGenresTable {
  title_id: string;
  genre_id: string;
  position: number;
}

export interface CreditsTable {
  title_id: string;
  person_id: string;
  role: string;
  character: string | null;
  position: number;
}

export interface SeasonsTable {
  title_id: string;
  number: number;
  name: string;
  release_year: number | null;
  episode_count: number;
}

export interface EpisodesTable {
  id: string;
  title_id: string;
  season_number: number;
  number: number;
  seq: number;
  name: string;
  synopsis: string;
  runtime_sec: number;
  video_asset_id: string;
  still_json: string | null;
  is_playable: number;
}

export interface VideoAssetsTable {
  id: string;
  label: string;
  kind: string;
  duration_sec: number | null;
  master_key: string | null;
  external_url: string | null;
  max_height: number | null;
  text_tracks_json: string;
  trick_play_json: string | null;
  markers_json: string;
}

export interface MyListTable {
  profile_id: string;
  title_id: string;
  added_at: number;
}

export interface RatingsTable {
  profile_id: string;
  title_id: string;
  value: string;
  rated_at: number;
}

export interface WatchProgressTable {
  profile_id: string;
  item_id: string;
  title_id: string;
  episode_id: string | null;
  position_sec: number;
  duration_sec: number;
  completed: number;
  hidden: number;
  updated_at: number;
}

export interface WatchHistoryTable {
  id: string;
  profile_id: string;
  item_id: string;
  title_id: string;
  episode_id: string | null;
  watched_at: number;
}

export interface PlaybackSessionsTable {
  id: string;
  account_id: string;
  profile_id: string;
  session_id: string;
  title_id: string;
  episode_id: string | null;
  asset_id: string | null;
  max_video_height: number;
  started_at: number;
  last_heartbeat_at: number;
  ended_at: number | null;
  position_sec: number;
  duration_sec: number;
  watched_sec: number;
  state: string;
}

export interface TitleStatsTable {
  day: string;
  title_id: string;
  source: string;
  views: number;
  watch_sec: number;
  profiles: number;
}

export interface NotificationsTable {
  id: string;
  kind: string;
  title_id: string | null;
  headline: string;
  body: string;
  image_json: string | null;
  maturity: string;
  maturity_rank: number;
  created_at: number;
  seed_version: string | null;
}

export interface NotificationReadsTable {
  profile_id: string;
  notification_id: string;
  read_at: number;
}

export interface MetaTable {
  key: string;
  value: string;
  updated_at: number;
}

/** Search documents (all dialects). Postgres adds a generated `document` tsvector column. */
export interface SearchDocumentsTable {
  title_id: string;
  type: string;
  maturity_rank: number;
  popularity: number;
  name_norm: string;
  people_norm: string;
  genres_norm: string;
  moods_norm: string;
  synopsis_norm: string;
}

/** SQLite/D1 only: FTS5 virtual table over the normalised fields. */
export interface SearchFtsTable {
  title_id: string;
  name: string;
  people: string;
  genres: string;
  moods: string;
  synopsis: string;
}

/** Suggestion labels (titles, people, genres), one row per (label, title) for maturity filtering. */
export interface SearchLabelsTable {
  kind: string;
  entity_id: string;
  title_id: string;
  label: string;
  label_norm: string;
  maturity_rank: number;
  popularity: number;
}

/**
 * Every table. Milestone 2's areas declare theirs in `tables/<area>.ts` (with their migrations
 * under `migrations/<area>/`), so an area changes its tables without touching another's.
 */
export interface DB
  extends IdentityTables,
    BillingTables,
    EventsTables,
    PersonalisationTables,
    ExperimentsTables,
    AdminTables {
  accounts: AccountsTable;
  subscriptions: SubscriptionsTable;
  sessions: SessionsTable;
  profiles: ProfilesTable;
  avatar_groups: AvatarGroupsTable;
  avatars: AvatarsTable;
  genres: GenresTable;
  people: PeopleTable;
  titles: TitlesTable;
  title_genres: TitleGenresTable;
  credits: CreditsTable;
  seasons: SeasonsTable;
  episodes: EpisodesTable;
  video_assets: VideoAssetsTable;
  my_list: MyListTable;
  ratings: RatingsTable;
  watch_progress: WatchProgressTable;
  watch_history: WatchHistoryTable;
  playback_sessions: PlaybackSessionsTable;
  title_stats: TitleStatsTable;
  notifications: NotificationsTable;
  notification_reads: NotificationReadsTable;
  meta: MetaTable;
  search_documents: SearchDocumentsTable;
  search_fts: SearchFtsTable;
  search_labels: SearchLabelsTable;
}

/**
 * Tables in dependency order (parents first). Used to reset a database in tests and to check
 * schema equivalence across dialects. `search_fts` exists only on SQLite/D1.
 */
export const TABLES = [
  "meta",
  "accounts",
  "subscriptions",
  "profiles",
  "sessions",
  "avatar_groups",
  "avatars",
  "genres",
  "people",
  "titles",
  "title_genres",
  "credits",
  "seasons",
  "episodes",
  "video_assets",
  "my_list",
  "ratings",
  "watch_progress",
  "watch_history",
  "playback_sessions",
  "title_stats",
  "notifications",
  "notification_reads",
  "search_documents",
  "search_labels",
  ...IDENTITY_TABLES,
  ...BILLING_TABLES,
  ...EVENTS_TABLES,
  ...PERSONALISATION_TABLES,
  ...EXPERIMENTS_TABLES,
  ...ADMIN_TABLES,
] as const satisfies readonly (keyof DB)[];
