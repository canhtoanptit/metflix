import type {
  Attribution,
  CARD_BRANDS,
  DEVICE_TYPES,
  ImageSet,
  MaturityLevel,
  NotificationKind,
  PlanId,
  PlaybackState,
  PreviewClip,
  ProfileSettings,
  RatingValue,
  TextTrackFile,
  TimeRange,
  TitleType,
  TrickPlayFiles,
} from "@webflix/contracts";

/**
 * Persistence records: what repositories read and write. Times are epoch milliseconds,
 * booleans are booleans (the SQL adapters map them to 0/1 in one place). Records are plain
 * data; services turn them into contract DTOs.
 */

export type CardBrand = (typeof CARD_BRANDS)[number];
export type DeviceType = (typeof DEVICE_TYPES)[number];

// --- Identity ---------------------------------------------------------------------------------

export interface AccountRecord {
  id: string;
  /** Normalised (trimmed, lowercased) by the contract schema before it gets here. */
  email: string;
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
}

/** What the mock billing provider keeps of a card (never the number or CVC). */
export interface StoredCard {
  brand: CardBrand;
  last4: string;
  expMonth: number;
  expYear: number;
}

/**
 * One membership per account. Status is derived, never stored: see `subscriptionStatus` in
 * the subscription service (active / canceling until `currentPeriodEnd` / ended).
 */
export interface SubscriptionRecord {
  accountId: string;
  planId: PlanId;
  startedAt: number;
  currentPeriodEnd: number;
  canceledAt: number | null;
  card: StoredCard | null;
  updatedAt: number;
}

/** One signed-in device. The cookie carries a random token; only its SHA-256 is stored. */
export interface SessionRecord {
  id: string;
  tokenHash: string;
  accountId: string;
  activeProfileId: string | null;
  deviceLabel: string;
  deviceType: DeviceType;
  /** False for "remember me: off" sign-ins (browser-session cookie). */
  persistent: boolean;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface AvatarRecord {
  id: string;
  name: string;
  groupId: string;
  imageUrl: string;
  position: number;
}

export interface AvatarGroupRecord {
  id: string;
  name: string;
  position: number;
}

/** A profile as written. */
export interface ProfileRow {
  id: string;
  accountId: string;
  name: string;
  avatarId: string;
  isKids: boolean;
  maturityCeiling: MaturityLevel;
  /** PHC hash of the 4-digit PIN; null when the profile is not locked. */
  pinHash: string | null;
  settings: ProfileSettings;
  createdAt: number;
  updatedAt: number;
}

/**
 * The fields a profile update writes; absent fields keep what is stored, so two concurrent
 * updates of different fields both land. `settings` holds only the settings that change.
 */
export interface ProfilePatch {
  name?: string;
  avatarId?: string;
  isKids?: boolean;
  maturityCeiling?: MaturityLevel;
  pinHash?: string | null;
  settings?: Partial<ProfileSettings>;
  updatedAt: number;
}

/** A profile as read: joined with its avatar (null if the catalog no longer has it). */
export interface ProfileRecord extends ProfileRow {
  avatar: AvatarRecord | null;
}

// --- Catalog ----------------------------------------------------------------------------------

export interface GenreRecord {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  position: number;
}

export interface PersonRecord {
  id: string;
  name: string;
}

export const CREDIT_ROLES = ["cast", "director", "creator", "writer"] as const;
export type CreditRole = (typeof CREDIT_ROLES)[number];

export interface CreditRecord {
  titleId: string;
  personId: string;
  role: CreditRole;
  character: string | null;
  /** Billing order within the role. */
  position: number;
}

/** Credit joined with the person's name (what the catalog snapshot carries). */
export interface NamedCreditRecord extends CreditRecord {
  personName: string;
}

export interface TitleImages {
  card: ImageSet;
  poster: ImageSet;
  logo: ImageSet | null;
  backdrop: ImageSet;
}

export interface TitleRecord {
  id: string;
  type: TitleType;
  name: string;
  tagline: string | null;
  synopsis: string;
  releaseYear: number;
  maturity: MaturityLevel;
  maturityDescriptors: string[];
  /** Genre ids, most relevant first. */
  genreIds: string[];
  moods: string[];
  isOriginal: boolean;
  addedAt: number;
  /** 0-100 baseline popularity from the seed. */
  popularity: number;
  /** Movies only. */
  runtimeSec: number | null;
  /** Series only. */
  seasonCount: number | null;
  /** Movies only. */
  videoAssetId: string | null;
  attribution: Attribution | null;
  audioLanguages: string[];
  subtitleLanguages: string[];
  images: TitleImages;
  preview: PreviewClip | null;
  isPlayable: boolean;
}

export interface SeasonRecord {
  titleId: string;
  number: number;
  name: string;
  releaseYear: number | null;
  episodeCount: number;
}

/** The part of an episode every browse computation needs (kept in the catalog snapshot). */
export interface EpisodeSummary {
  id: string;
  titleId: string;
  seasonNumber: number;
  number: number;
  /** 1-based position across the whole series (next-episode lookups). */
  seq: number;
  name: string;
  runtimeSec: number;
  videoAssetId: string;
  isPlayable: boolean;
}

export interface EpisodeRecord extends EpisodeSummary {
  synopsis: string;
  still: ImageSet | null;
}

export const VIDEO_ASSET_KINDS = ["packaged", "external", "unavailable"] as const;
export type VideoAssetKind = (typeof VIDEO_ASSET_KINDS)[number];

export interface PlaybackMarkersRecord {
  intro: TimeRange | null;
  recap: TimeRange | null;
  creditsStartSec: number | null;
}

/**
 * A playable video. `packaged`: HLS in our blob store (`masterKey`); `external`: an absolute
 * HLS URL used when media has not been packaged; `unavailable`: neither.
 */
export interface VideoAssetRecord {
  id: string;
  label: string;
  kind: VideoAssetKind;
  durationSec: number | null;
  masterKey: string | null;
  externalUrl: string | null;
  /**
   * Nominal height of the best packaged rendition (`nominalVideoHeight`: the 16:9 frame it
   * fills, so a 1920×800 encode is 1080): what the title's quality badge is named after.
   */
  maxHeight: number | null;
  textTracks: TextTrackFile[];
  trickPlay: TrickPlayFiles | null;
  markers: PlaybackMarkersRecord;
}

export interface NotificationRecord {
  id: string;
  kind: NotificationKind;
  titleId: string | null;
  headline: string;
  body: string;
  image: ImageSet | null;
  /** Hidden from profiles whose ceiling is below this. */
  maturity: MaturityLevel;
  createdAt: number;
}

/** A packaged video asset as browse sees it: only how good its best rendition is. */
export interface PackagedAssetSummary {
  id: string;
  /** `VideoAssetRecord.maxHeight`. */
  maxHeight: number;
}

/** Everything browse needs from the catalog, loaded in one round trip and cached. */
export interface CatalogSnapshotData {
  /** Changes whenever the catalog is re-seeded. */
  version: string;
  genres: GenreRecord[];
  titles: TitleRecord[];
  credits: NamedCreditRecord[];
  seasons: SeasonRecord[];
  episodes: EpisodeSummary[];
  /** Packaged assets with a known best rendition (external and unavailable ones are absent). */
  packagedAssets: PackagedAssetSummary[];
}

// --- Library ----------------------------------------------------------------------------------

export interface MyListEntry {
  titleId: string;
  addedAt: number;
}

export interface RatingEntry {
  titleId: string;
  value: RatingValue;
  ratedAt: number;
}

/**
 * Resume state per watchable item: the episode for series, the title itself for movies
 * (`itemId` is the episode id or the title id).
 */
export interface ProgressRecord {
  profileId: string;
  itemId: string;
  titleId: string;
  episodeId: string | null;
  positionSec: number;
  durationSec: number;
  completed: boolean;
  /** Hidden from Continue Watching until the item is watched again. */
  hidden: boolean;
  updatedAt: number;
}

/** One line of "Viewing activity": each item once, at its most recent watch. */
export interface HistoryRecord {
  id: string;
  profileId: string;
  itemId: string;
  titleId: string;
  episodeId: string | null;
  watchedAt: number;
}

/** A profile's library state: the inputs of personalisation, loaded in one round trip. */
export interface ProfileSignals {
  myList: MyListEntry[];
  ratings: RatingEntry[];
  progress: ProgressRecord[];
}

// --- Playback and stats -----------------------------------------------------------------------

export interface PlaybackSessionRecord {
  id: string;
  accountId: string;
  profileId: string;
  /** The auth session (device) that started playback. */
  sessionId: string;
  titleId: string;
  episodeId: string | null;
  /** Null for external (non-packaged) media. */
  assetId: string | null;
  /** Plan cap at start; the master playlist is filtered to it. */
  maxVideoHeight: number;
  startedAt: number;
  /**
   * The session's credit clock: wall-clock time up to which watching has been credited. Each
   * heartbeat moves it forward by what it credits, and never leaves it more than a few seconds
   * behind the heartbeat (`HEARTBEAT_CARRY_SEC`), so it is the last heartbeat's arrival time
   * minus the slack carried into the next one.
   */
  lastHeartbeatAt: number;
  endedAt: number | null;
  positionSec: number;
  durationSec: number;
  /** Seconds of watching credited (see `PlaybackRepository.recordHeartbeat`). */
  watchedSec: number;
  state: PlaybackState;
}

export const TITLE_STAT_SOURCES = ["seed", "playback"] as const;
export type TitleStatSource = (typeof TITLE_STAT_SOURCES)[number];

/** Daily counters per title. `seed` rows are the synthetic baseline; `playback` rows are real. */
export interface TitleStatRecord {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  titleId: string;
  source: TitleStatSource;
  views: number;
  watchSec: number;
  profiles: number;
}

export interface DailyViews {
  day: string;
  titleId: string;
  views: number;
}

/** One title's counters for one day, per source (diagnostics). */
export interface TitleDayStats {
  day: string;
  baselineViews: number;
  playbackViews: number;
  playbackWatchSec: number;
  playbackProfiles: number;
}

// --- Seeding ----------------------------------------------------------------------------------

/** The whole catalog, written atomically by the seeder (replaces what was there). */
export interface CatalogWrite {
  version: string;
  genres: GenreRecord[];
  people: PersonRecord[];
  titles: TitleRecord[];
  credits: CreditRecord[];
  seasons: SeasonRecord[];
  episodes: EpisodeRecord[];
  videoAssets: VideoAssetRecord[];
  avatarGroups: AvatarGroupRecord[];
  avatars: AvatarRecord[];
  notifications: NotificationRecord[];
}

/** One account with everything it owns, written atomically (replaces an account with the same email). */
export interface AccountWrite {
  account: AccountRecord;
  subscription: SubscriptionRecord;
  profiles: ProfileRow[];
  myList: (MyListEntry & { profileId: string })[];
  ratings: (RatingEntry & { profileId: string })[];
  progress: ProgressRecord[];
  history: HistoryRecord[];
}
