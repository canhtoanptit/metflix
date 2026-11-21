import type { PlaybackState, RatingValue } from "@webflix/contracts";
import type {
  AccountRecord,
  AccountWrite,
  AvatarGroupRecord,
  AvatarRecord,
  CatalogSnapshotData,
  CatalogWrite,
  DailyViews,
  EpisodeRecord,
  HistoryRecord,
  NotificationRecord,
  PlaybackSessionRecord,
  ProfilePatch,
  ProfileRecord,
  ProfileRow,
  ProfileSignals,
  SessionRecord,
  SubscriptionRecord,
  TitleDayStats,
  TitleStatRecord,
  VideoAssetRecord,
} from "./records.ts";

/**
 * Repository ports. Implemented by `@webflix/db` (SQLite, PostgreSQL, D1) and by
 * `@webflix/core/memory` (tests); every implementation passes `describeRepositoryContract`.
 *
 * Shaped by D1, the most constrained backend:
 * - No interactive transactions. A method that must be atomic is ONE method, implemented as an
 *   atomic batch (D1 `batch()`, a Postgres transaction, a SQLite transaction) of statements
 *   that never depend on values read inside the batch. Conditions live in SQL (`WHERE`,
 *   `ON CONFLICT`), not in application code between statements.
 * - Every call is a round trip, so hot read paths are single methods that load everything in
 *   one batch (`loadSignals`, `loadSnapshot`).
 * - At most 100 bound parameters per statement: bulk writes are chunked by the adapter, and
 *   no method takes an unbounded id list into an `IN (...)`.
 */

/** A unique constraint rejected a write (e.g. an email that is already registered). */
export class UniqueViolationError extends Error {
  override readonly name = "UniqueViolationError";
  /** The logical field, e.g. `email`. */
  readonly field: string;

  constructor(field: string, options?: { cause?: unknown }) {
    super(`Unique constraint violated: ${field}`, options);
    this.field = field;
  }
}

export interface AccountRepository {
  emailExists(email: string): Promise<boolean>;
  findByEmail(email: string): Promise<AccountRecord | null>;
  /** Account and subscription in one query. */
  get(
    accountId: string,
  ): Promise<{ account: AccountRecord; subscription: SubscriptionRecord } | null>;
  /** Sign-up: account, membership and first session atomically. Throws `UniqueViolationError("email")`. */
  createWithSession(input: {
    account: AccountRecord;
    subscription: SubscriptionRecord;
    session: SessionRecord;
  }): Promise<void>;
  /** Throws `UniqueViolationError("email")`. */
  updateEmail(accountId: string, email: string, now: number): Promise<void>;
  /** Rehash on login (algorithm upgrade); sessions untouched. */
  updatePasswordHash(accountId: string, passwordHash: string, now: number): Promise<void>;
  /** Password change: new hash and every other session revoked, atomically. */
  changePassword(input: {
    accountId: string;
    passwordHash: string;
    keepSessionId: string;
    now: number;
  }): Promise<void>;
  saveSubscription(subscription: SubscriptionRecord): Promise<void>;
}

export interface ActiveSession {
  session: SessionRecord;
  /** The active profile, only if it still exists and belongs to the session's account. */
  profile: ProfileRecord | null;
}

export interface SessionRepository {
  create(session: SessionRecord): Promise<void>;
  /** The live (unexpired) session for a token hash, with its active profile, in one query. */
  findActive(tokenHash: string, now: number): Promise<ActiveSession | null>;
  /** Record activity. Callers throttle it; it is a write. */
  touch(sessionId: string, now: number): Promise<void>;
  /** False when the profile does not belong to the session's account (or the session is gone). */
  setActiveProfile(
    sessionId: string,
    accountId: string,
    profileId: string | null,
  ): Promise<boolean>;
  /** Live sessions, most recently seen first. */
  listForAccount(accountId: string, now: number): Promise<SessionRecord[]>;
  /** False when no such session exists in the account. */
  delete(accountId: string, sessionId: string): Promise<boolean>;
  deleteAllForAccount(accountId: string): Promise<void>;
  /**
   * Deletes up to `limit` sessions that expired at or before `now` (oldest first) in one
   * statement; returns how many. Callers repeat while a full batch comes back.
   */
  deleteExpired(now: number, limit: number): Promise<number>;
}

export interface ProfileRepository {
  /** Oldest first (the order of the "Who's watching?" gate). */
  list(accountId: string): Promise<ProfileRecord[]>;
  get(accountId: string, profileId: string): Promise<ProfileRecord | null>;
  /** Inserts only while the account has fewer than `maxProfiles`; atomic. False when full. */
  createWithinLimit(profile: ProfileRow, maxProfiles: number): Promise<boolean>;
  /**
   * Writes the patched fields of a profile in one statement; false when it does not exist.
   * With `unbindSessionsExcept`, every other session bound to the profile is sent back to the
   * profile gate in the same atomic batch (a new PIN must be entered on every device).
   */
  update(
    accountId: string,
    profileId: string,
    patch: ProfilePatch,
    options?: { unbindSessionsExcept?: string },
  ): Promise<boolean>;
  /**
   * Deletes the profile and everything it owns (list, ratings, progress, history, reads),
   * unless it is the account's last profile. Sessions using it fall back to no profile.
   */
  deleteUnlessLast(accountId: string, profileId: string): Promise<"deleted" | "not_found" | "last">;
}

export interface CatalogRepository {
  /** Titles, genres, credits, seasons and episode summaries in one round trip. */
  loadSnapshot(): Promise<CatalogSnapshotData>;
  listEpisodes(titleId: string, seasonNumber: number): Promise<EpisodeRecord[]>;
  /** What playback needs: the asset and up to a few episodes, in one round trip. */
  loadPlaybackMedia(input: {
    assetId: string;
    episodeIds: readonly string[];
  }): Promise<{ asset: VideoAssetRecord | null; episodes: EpisodeRecord[] }>;
  listAvatars(): Promise<{ groups: AvatarGroupRecord[]; avatars: AvatarRecord[] }>;
  getAvatar(avatarId: string): Promise<AvatarRecord | null>;
  listTitleIds(): Promise<string[]>;
}

export interface HistoryPageRequest {
  /** Keyset: entries strictly older than this (watchedAt desc, id desc). */
  before?: { watchedAt: number; id: string };
  limit: number;
}

export interface LibraryRepository {
  /** My List, ratings and progress of a profile, in one round trip. */
  loadSignals(profileId: string): Promise<ProfileSignals>;
  /** Idempotent; keeps the original `addedAt`. */
  addToMyList(profileId: string, titleId: string, now: number): Promise<void>;
  removeFromMyList(profileId: string, titleId: string): Promise<void>;
  setRating(profileId: string, titleId: string, value: RatingValue, now: number): Promise<void>;
  clearRating(profileId: string, titleId: string): Promise<void>;
  /** Hides every progress row of the title until it is watched again. */
  hideFromContinueWatching(profileId: string, titleId: string): Promise<void>;
  listHistory(profileId: string, page: HistoryPageRequest): Promise<HistoryRecord[]>;
  /** Removes the entry and the item's progress. False when no such entry. */
  deleteHistoryEntry(profileId: string, entryId: string): Promise<boolean>;
}

export interface HeartbeatWrite {
  playbackSessionId: string;
  profileId: string;
  titleId: string;
  episodeId: string | null;
  positionSec: number;
  durationSec: number;
  state: PlaybackState;
  completed: boolean;
  now: number;
  /** Cap on the watched time credited by one heartbeat (seconds). */
  maxCreditSec: number;
  /** Used only when this is the item's first history entry. */
  historyId: string;
  /** The session's final report (a release that carries its position): also end the session. */
  ends: boolean;
}

/**
 * Wall-clock slack a heartbeat may carry into the next one: time that passed but was not
 * credited (the report claimed less, or arrived early through network jitter) stays available
 * for up to this long, so jitter costs nothing; it never accumulates beyond it.
 */
export const HEARTBEAT_CARRY_SEC = 5;

export interface PlaybackRepository {
  create(session: PlaybackSessionRecord): Promise<void>;
  get(playbackSessionId: string): Promise<PlaybackSessionRecord | null>;
  /**
   * Atomically (one batch): credit watching to the playback session, store the position and
   * state, upsert the item's progress (un-hiding it) and its history entry, and end the
   * session when `ends`. Nothing at all is written once the session has ended: a report that
   * lands after the release cannot overwrite the final position it carried.
   *
   * Credit, computed from the session's previous values: the position advance (never negative),
   * but only when the session was playing or buffering since the last report (a paused interval
   * earns nothing: a seek while paused is not watching), at most the wall-clock time since the
   * credit clock (`lastHeartbeatAt`) and at most `maxCreditSec`. The clock then moves forward
   * by the credit, and up to `now - HEARTBEAT_CARRY_SEC` if it lags further. However many
   * heartbeats arrive and whatever positions they claim, a session is never credited more than
   * the wall-clock time it existed.
   */
  recordHeartbeat(write: HeartbeatWrite): Promise<void>;
  /** Idempotent. */
  end(playbackSessionId: string, now: number): Promise<void>;
  /** Housekeeping: drop sessions that started before `cutoff`. */
  deleteStartedBefore(cutoff: number): Promise<number>;
}

export interface StatsRepository {
  /**
   * Recompute the `playback` counters of one UTC day from playback sessions started in
   * `[fromMs, toMs)`. Idempotent (a recomputation, not an increment), so at-least-once job
   * delivery is safe.
   */
  rollupPlaybackDay(day: string, fromMs: number, toMs: number): Promise<void>;
  /** Insert-or-replace `seed` rows (synthetic baseline). */
  upsertBaseline(rows: readonly TitleStatRecord[]): Promise<void>;
  hasBaseline(day: string): Promise<boolean>;
  /** Views per title and day for days >= `fromDay`, all sources summed. */
  dailyViews(fromDay: string): Promise<DailyViews[]>;
  /** One title's counters per day for days >= `fromDay`, newest first (diagnostics). */
  titleDays(titleId: string, fromDay: string): Promise<TitleDayStats[]>;
}

export interface NotificationView extends NotificationRecord {
  readAt: number | null;
}

export interface NotificationQuery {
  profileId: string;
  /** Rank of the profile's maturity ceiling (`maturityRank`). */
  maxMaturityRank: number;
  /** Only notifications created at or after this time. */
  since: number;
  limit: number;
}

export interface NotificationRepository {
  /** Newest first, with this profile's read state. */
  listForProfile(query: NotificationQuery): Promise<NotificationView[]>;
  /** Mark the given ids (or every visible notification, `"all"`) read. Idempotent. */
  markRead(
    query: Omit<NotificationQuery, "limit">,
    ids: readonly string[] | "all",
    now: number,
  ): Promise<void>;
}

export interface MetaRepository {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, now: number): Promise<void>;
}

/** Bulk writes used only by the seeder. Each method is atomic. */
export interface SeedRepository {
  replaceCatalog(catalog: CatalogWrite): Promise<void>;
  /** Deletes any account with the same email (and everything it owns), then writes this one. */
  replaceAccount(account: AccountWrite): Promise<void>;
  /** Replaces every `seed` stats row. */
  replaceBaselineStats(rows: readonly TitleStatRecord[]): Promise<void>;
}

/** Every repository over one database. */
export interface Repositories {
  accounts: AccountRepository;
  sessions: SessionRepository;
  profiles: ProfileRepository;
  catalog: CatalogRepository;
  library: LibraryRepository;
  playback: PlaybackRepository;
  stats: StatsRepository;
  notifications: NotificationRepository;
  meta: MetaRepository;
  seed: SeedRepository;
  /** Readiness probe: one trivial round trip. */
  ping(): Promise<void>;
}
