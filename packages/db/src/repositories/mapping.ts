import type {
  AvatarRecord,
  EpisodeRecord,
  EpisodeSummary,
  ProfileRecord,
  ProfileRow,
  ProgressRecord,
  SessionRecord,
  SubscriptionRecord,
  TitleRecord,
  VideoAssetRecord,
} from "@webflix/core";
import { maturityRank } from "@webflix/core";
import { type Expression, type ExpressionBuilder, type RawBuilder, sql } from "kysely";
import type { SqlDialect } from "../dialect.ts";
import { columnTypes } from "../migrations/types.ts";
import type {
  AvatarsTable,
  EpisodesTable,
  ProfilesTable,
  SessionsTable,
  SubscriptionsTable,
  TitlesTable,
  VideoAssetsTable,
  WatchProgressTable,
} from "../schema.ts";

// --- The one place booleans and JSON are mapped ----------------------------------------------

export const toBool = (value: number | null | undefined): boolean => value === 1;
export const fromBool = (value: boolean): number => (value ? 1 : 0);
export const json = (value: unknown): string => JSON.stringify(value);
export const jsonOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value);
export function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
export function parseJsonOrNull<T>(value: string | null): T | null {
  return value === null ? null : (JSON.parse(value) as T);
}

/** `LEAST`/`GREATEST` are spelled `min`/`max` (scalar, multi-argument) in SQLite. */
export function least(dialect: SqlDialect, ...values: Expression<number>[]): RawBuilder<number> {
  const name = dialect === "postgres" ? sql.raw("least") : sql.raw("min");
  return sql<number>`${name}(${sql.join(values)})`;
}

export function greatest(dialect: SqlDialect, ...values: Expression<number>[]): RawBuilder<number> {
  const name = dialect === "postgres" ? sql.raw("greatest") : sql.raw("max");
  return sql<number>`${name}(${sql.join(values)})`;
}

/**
 * A bound value with an explicit column type. Postgres types a parameter in an
 * `INSERT ... SELECT` projection as text unless told otherwise; SQLite and D1 accept the cast.
 */
export function typed(
  dialect: SqlDialect,
  value: string | number | null,
  type: keyof ReturnType<typeof columnTypes>,
): RawBuilder<unknown> {
  return sql`cast(${value} as ${sql.raw(columnTypes(dialect)[type])})`;
}

// --- Row mappers ------------------------------------------------------------------------------

export function toSubscription(row: SubscriptionsTable): SubscriptionRecord {
  return {
    accountId: row.account_id,
    planId: row.plan_id as SubscriptionRecord["planId"],
    startedAt: row.started_at,
    currentPeriodEnd: row.current_period_end,
    canceledAt: row.canceled_at,
    card:
      row.card_brand !== null &&
      row.card_last4 !== null &&
      row.card_exp_month !== null &&
      row.card_exp_year !== null
        ? {
            brand: row.card_brand as NonNullable<SubscriptionRecord["card"]>["brand"],
            last4: row.card_last4,
            expMonth: row.card_exp_month,
            expYear: row.card_exp_year,
          }
        : null,
    updatedAt: row.updated_at,
  };
}

export function fromSubscription(record: SubscriptionRecord): SubscriptionsTable {
  return {
    account_id: record.accountId,
    plan_id: record.planId,
    started_at: record.startedAt,
    current_period_end: record.currentPeriodEnd,
    canceled_at: record.canceledAt,
    card_brand: record.card?.brand ?? null,
    card_last4: record.card?.last4 ?? null,
    card_exp_month: record.card?.expMonth ?? null,
    card_exp_year: record.card?.expYear ?? null,
    updated_at: record.updatedAt,
  };
}

export function toSession(row: SessionsTable): SessionRecord {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    accountId: row.account_id,
    activeProfileId: row.active_profile_id,
    deviceLabel: row.device_label,
    deviceType: row.device_type as SessionRecord["deviceType"],
    persistent: toBool(row.persistent),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
  };
}

export function fromSession(record: SessionRecord): SessionsTable {
  return {
    id: record.id,
    token_hash: record.tokenHash,
    account_id: record.accountId,
    active_profile_id: record.activeProfileId,
    device_label: record.deviceLabel,
    device_type: record.deviceType,
    persistent: fromBool(record.persistent),
    created_at: record.createdAt,
    last_seen_at: record.lastSeenAt,
    expires_at: record.expiresAt,
  };
}

export function fromProfile(row: ProfileRow): ProfilesTable {
  return {
    id: row.id,
    account_id: row.accountId,
    name: row.name,
    avatar_id: row.avatarId,
    is_kids: fromBool(row.isKids),
    maturity_ceiling: row.maturityCeiling,
    pin_hash: row.pinHash,
    settings_json: json(row.settings),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/** Profile columns and its avatar's, aliased so they can share a row with other tables. */
export type ProfileJoinRow = { [K in keyof ProfilesTable as `p_${K}`]: ProfilesTable[K] } & {
  [K in keyof AvatarsTable as `av_${K}`]: AvatarsTable[K] | null;
};

export const PROFILE_JOIN_COLUMNS = [
  "p.id as p_id",
  "p.account_id as p_account_id",
  "p.name as p_name",
  "p.avatar_id as p_avatar_id",
  "p.is_kids as p_is_kids",
  "p.maturity_ceiling as p_maturity_ceiling",
  "p.pin_hash as p_pin_hash",
  "p.settings_json as p_settings_json",
  "p.created_at as p_created_at",
  "p.updated_at as p_updated_at",
  "av.id as av_id",
  "av.group_id as av_group_id",
  "av.name as av_name",
  "av.image_url as av_image_url",
  "av.position as av_position",
] as const;

export function toProfile(row: ProfileJoinRow): ProfileRecord {
  return {
    id: row.p_id,
    accountId: row.p_account_id,
    name: row.p_name,
    avatarId: row.p_avatar_id,
    isKids: toBool(row.p_is_kids),
    maturityCeiling: row.p_maturity_ceiling as ProfileRecord["maturityCeiling"],
    pinHash: row.p_pin_hash,
    settings: parseJson(row.p_settings_json),
    createdAt: row.p_created_at,
    updatedAt: row.p_updated_at,
    avatar:
      row.av_id === null
        ? null
        : {
            id: row.av_id,
            groupId: row.av_group_id ?? "",
            name: row.av_name ?? "",
            imageUrl: row.av_image_url ?? "",
            position: row.av_position ?? 0,
          },
  };
}

export function toAvatar(row: AvatarsTable): AvatarRecord {
  return {
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    imageUrl: row.image_url,
    position: row.position,
  };
}

export function fromTitle(record: TitleRecord): TitlesTable {
  return {
    id: record.id,
    type: record.type,
    name: record.name,
    tagline: record.tagline,
    synopsis: record.synopsis,
    release_year: record.releaseYear,
    maturity: record.maturity,
    maturity_rank: maturityRank(record.maturity),
    maturity_descriptors_json: json(record.maturityDescriptors),
    moods_json: json(record.moods),
    is_original: fromBool(record.isOriginal),
    added_at: record.addedAt,
    popularity: record.popularity,
    runtime_sec: record.runtimeSec,
    season_count: record.seasonCount,
    video_asset_id: record.videoAssetId,
    attribution_json: jsonOrNull(record.attribution),
    audio_languages_json: json(record.audioLanguages),
    subtitle_languages_json: json(record.subtitleLanguages),
    images_json: json(record.images),
    preview_json: jsonOrNull(record.preview),
    is_playable: fromBool(record.isPlayable),
  };
}

export function toTitle(row: TitlesTable, genreIds: string[]): TitleRecord {
  return {
    id: row.id,
    type: row.type as TitleRecord["type"],
    name: row.name,
    tagline: row.tagline,
    synopsis: row.synopsis,
    releaseYear: row.release_year,
    maturity: row.maturity as TitleRecord["maturity"],
    maturityDescriptors: parseJson(row.maturity_descriptors_json),
    genreIds,
    moods: parseJson(row.moods_json),
    isOriginal: toBool(row.is_original),
    addedAt: row.added_at,
    popularity: row.popularity,
    runtimeSec: row.runtime_sec,
    seasonCount: row.season_count,
    videoAssetId: row.video_asset_id,
    attribution: parseJsonOrNull(row.attribution_json),
    audioLanguages: parseJson(row.audio_languages_json),
    subtitleLanguages: parseJson(row.subtitle_languages_json),
    images: parseJson(row.images_json),
    preview: parseJsonOrNull(row.preview_json),
    isPlayable: toBool(row.is_playable),
  };
}

export function fromEpisode(record: EpisodeRecord): EpisodesTable {
  return {
    id: record.id,
    title_id: record.titleId,
    season_number: record.seasonNumber,
    number: record.number,
    seq: record.seq,
    name: record.name,
    synopsis: record.synopsis,
    runtime_sec: record.runtimeSec,
    video_asset_id: record.videoAssetId,
    still_json: jsonOrNull(record.still),
    is_playable: fromBool(record.isPlayable),
  };
}

export function toEpisodeSummary(
  row: Omit<EpisodesTable, "synopsis" | "still_json">,
): EpisodeSummary {
  return {
    id: row.id,
    titleId: row.title_id,
    seasonNumber: row.season_number,
    number: row.number,
    seq: row.seq,
    name: row.name,
    runtimeSec: row.runtime_sec,
    videoAssetId: row.video_asset_id,
    isPlayable: toBool(row.is_playable),
  };
}

export function toEpisode(row: EpisodesTable): EpisodeRecord {
  return {
    ...toEpisodeSummary(row),
    synopsis: row.synopsis,
    still: parseJsonOrNull(row.still_json),
  };
}

export function fromVideoAsset(record: VideoAssetRecord): VideoAssetsTable {
  return {
    id: record.id,
    label: record.label,
    kind: record.kind,
    duration_sec: record.durationSec,
    master_key: record.masterKey,
    external_url: record.externalUrl,
    max_height: record.maxHeight,
    text_tracks_json: json(record.textTracks),
    trick_play_json: jsonOrNull(record.trickPlay),
    markers_json: json(record.markers),
  };
}

export function toVideoAsset(row: VideoAssetsTable): VideoAssetRecord {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind as VideoAssetRecord["kind"],
    durationSec: row.duration_sec,
    masterKey: row.master_key,
    externalUrl: row.external_url,
    maxHeight: row.max_height,
    textTracks: parseJson(row.text_tracks_json),
    trickPlay: parseJsonOrNull(row.trick_play_json),
    markers: parseJson(row.markers_json),
  };
}

export function toProgress(row: WatchProgressTable): ProgressRecord {
  return {
    profileId: row.profile_id,
    itemId: row.item_id,
    titleId: row.title_id,
    episodeId: row.episode_id,
    positionSec: row.position_sec,
    durationSec: row.duration_sec,
    completed: toBool(row.completed),
    hidden: toBool(row.hidden),
    updatedAt: row.updated_at,
  };
}

export function fromProgress(record: ProgressRecord): WatchProgressTable {
  return {
    profile_id: record.profileId,
    item_id: record.itemId,
    title_id: record.titleId,
    episode_id: record.episodeId,
    position_sec: record.positionSec,
    duration_sec: record.durationSec,
    completed: fromBool(record.completed),
    hidden: fromBool(record.hidden),
    updated_at: record.updatedAt,
  };
}

/** `excluded.<column>` for upserts (same spelling on SQLite and Postgres). */
// biome-ignore lint/suspicious/noExplicitAny: `excluded` is a pseudo-table Kysely types loosely.
export function excluded(eb: ExpressionBuilder<any, any>, column: string) {
  return eb.ref(`excluded.${column}`);
}
