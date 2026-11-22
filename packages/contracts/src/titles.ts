import * as z from "zod";
import { Id, IsoDateTime, LanguageTag, Seconds, Slug, WholeSeconds } from "./common.ts";
import {
  RATING_VALUES,
  SHOWCASE_SIZE,
  TITLE_BADGES,
  TITLE_TYPES,
  VIDEO_QUALITY_TIERS,
} from "./constants.ts";
import { MaturityLevel } from "./maturity.ts";
import { ImageSet, PreviewClip } from "./media.ts";

export const TitleType = z.enum(TITLE_TYPES).meta({ id: "TitleType" });
export type TitleType = z.output<typeof TitleType>;

export const RatingValue = z.enum(RATING_VALUES).meta({ id: "RatingValue" });
export type RatingValue = z.output<typeof RatingValue>;

export const TitleBadge = z.enum(TITLE_BADGES).meta({ id: "TitleBadge" });
export type TitleBadge = z.output<typeof TitleBadge>;

/** Ordered lowest first; label with `videoQualityLabel` (`media-helpers.ts`). */
export const VideoQualityTier = z.enum(VIDEO_QUALITY_TIERS).meta({ id: "VideoQualityTier" });
export type VideoQualityTier = z.output<typeof VideoQualityTier>;

export const GenreRef = z.object({ slug: Slug, name: z.string() }).meta({ id: "GenreRef" });
export type GenreRef = z.output<typeof GenreRef>;

export const Genre = z
  .object({
    id: Id,
    slug: Slug,
    name: z.string(),
    description: z.string().nullable(),
  })
  .meta({ id: "Genre" });
export type Genre = z.output<typeof Genre>;

export const GenreList = z.object({ items: z.array(Genre) }).meta({ id: "GenreList" });
export type GenreList = z.output<typeof GenreList>;

export const PersonRef = z.object({ id: Id, name: z.string() }).meta({ id: "PersonRef" });
export type PersonRef = z.output<typeof PersonRef>;

export const CastMember = PersonRef.extend({ character: z.string().nullable() }).meta({
  id: "CastMember",
});
export type CastMember = z.output<typeof CastMember>;

/** Credit and licence for freely licensed media (e.g. Blender Studio open movies). */
export const Attribution = z
  .object({
    text: z.string().meta({ description: 'e.g. "(c) Blender Foundation | durian.blender.org"' }),
    license: z.string().meta({ description: 'SPDX-like name, e.g. "CC-BY-4.0".' }),
    licenseUrl: z.url(),
    sourceUrl: z.url().nullable(),
  })
  .meta({ id: "Attribution" });
export type Attribution = z.output<typeof Attribution>;

/** How far the active profile got. `completed` is decided by the server (credits reached). */
export const Progress = z
  .object({
    positionSec: Seconds,
    durationSec: Seconds,
    completed: z.boolean(),
    updatedAt: IsoDateTime,
  })
  .meta({ id: "Progress" });
export type Progress = z.output<typeof Progress>;

/** Per-profile state carried on every card so hover actions render without another request. */
export const CardViewerState = z
  .object({
    inMyList: z.boolean(),
    rating: RatingValue.nullable(),
  })
  .meta({ id: "CardViewerState" });
export type CardViewerState = z.output<typeof CardViewerState>;

export const EpisodeRef = z
  .object({
    id: Id,
    seasonNumber: z.number().int().positive(),
    number: z.number().int().positive(),
    name: z.string(),
  })
  .meta({ id: "EpisodeRef" });
export type EpisodeRef = z.output<typeof EpisodeRef>;

/**
 * What the primary "Play" button does for the active profile: start from the beginning
 * (first episode for series) or resume where they left off.
 */
export const PlayTarget = z
  .object({
    action: z.enum(["play", "resume"]),
    episode: EpisodeRef.nullable(),
    positionSec: Seconds,
    progress: Progress.nullable(),
  })
  .meta({ id: "PlayTarget" });
export type PlayTarget = z.output<typeof PlayTarget>;

/**
 * Everything a row card and its hover preview need. Cards are personalised (viewer state,
 * match score) and already filtered by the active profile's maturity ceiling.
 */
export const TitleCard = z
  .object({
    id: Id,
    type: TitleType,
    name: z.string(),
    releaseYear: z.number().int(),
    maturity: MaturityLevel,
    /**
     * Movies only: the playable duration of the title's packaged media (the same base as
     * `PlaybackSession.durationSec` and progress), or the catalogue runtime for external
     * fallback media. Series show `seasonCount` instead; nothing sums episode runtimes.
     */
    runtimeSec: WholeSeconds.nullable(),
    /** Series only. */
    seasonCount: z.number().int().positive().nullable(),
    /** Up to three, most relevant first. */
    genres: z.array(GenreRef).max(3),
    /** Up to three mood tags, e.g. "Witty", "Suspenseful". */
    moods: z.array(z.string()).max(3),
    /** 0-100 predicted match for the active profile; null when unknown. */
    matchScore: z.number().int().min(0).max(100).nullable(),
    isOriginal: z.boolean(),
    /**
     * The one status badge to draw on this card, chosen per surface by the server: never Top 10
     * in Continue Watching or the ranked row, at most two Top 10 badges per list.
     */
    badge: TitleBadge.nullable(),
    /**
     * Rank (1-10) in today's Top 10 list of the surface's view (the "Top 10 ... Today" row a
     * member can open there; the overall list outside browse views), whether or not the card
     * carries the badge: for "#3 on Webflix Today" in previews and detail. Absent when not
     * ranked.
     */
    top10Rank: z.number().int().min(1).max(10).optional(),
    /**
     * Best video quality the title's packaged media offers. The plan may cap it: show
     * `effectiveVideoQuality(bestVideoQuality, plan.maxVideoHeight)`. Absent when unknown
     * (titles that only stream from an external fallback).
     */
    bestVideoQuality: VideoQualityTier.optional(),
    images: z.object({
      /** 16:9 landscape card with the title treatment composited in. */
      card: ImageSet,
      /** 2:3 portrait poster (ranked and tall rows). */
      poster: ImageSet,
      /** Transparent title logo; null when the title has none. */
      logo: ImageSet.nullable(),
    }),
    preview: PreviewClip.nullable(),
    viewer: CardViewerState,
  })
  .meta({ id: "TitleCard" });
export type TitleCard = z.output<typeof TitleCard>;

export const TitleCardList = z.object({ items: z.array(TitleCard) }).meta({ id: "TitleCardList" });
export type TitleCardList = z.output<typeof TitleCardList>;

export const SeasonSummary = z
  .object({
    number: z.number().int().positive(),
    name: z.string(),
    episodeCount: z.number().int().nonnegative(),
    releaseYear: z.number().int().nullable(),
  })
  .meta({ id: "SeasonSummary" });
export type SeasonSummary = z.output<typeof SeasonSummary>;

export const Episode = z
  .object({
    id: Id,
    titleId: Id,
    seasonNumber: z.number().int().positive(),
    number: z.number().int().positive(),
    name: z.string(),
    synopsis: z.string(),
    /** The playable duration of the episode's packaged media, else the catalogue runtime. */
    runtimeSec: WholeSeconds,
    /** 16:9 still; null falls back to the title backdrop. */
    still: ImageSet.nullable(),
    isPlayable: z.boolean(),
    progress: Progress.nullable(),
  })
  .meta({ id: "Episode" });
export type Episode = z.output<typeof Episode>;

export const SeasonEpisodes = z
  .object({
    titleId: Id,
    season: SeasonSummary,
    items: z.array(Episode),
  })
  .meta({ id: "SeasonEpisodes" });
export type SeasonEpisodes = z.output<typeof SeasonEpisodes>;

/** Full detail for the detail modal. Extends the card; `images` adds the backdrop. */
export const TitleDetail = TitleCard.extend({
  synopsis: z.string(),
  tagline: z.string().nullable(),
  /** All genres (the card carries at most three). */
  genres: z.array(GenreRef),
  /** All mood tags. */
  moods: z.array(z.string()),
  maturityDescriptors: z
    .array(z.string())
    .meta({ description: 'Content advisories, e.g. ["violence", "language"].' }),
  images: z.object({
    card: ImageSet,
    poster: ImageSet,
    logo: ImageSet.nullable(),
    /** 16:9 full-bleed hero, no text. */
    backdrop: ImageSet,
  }),
  cast: z.array(CastMember),
  directors: z.array(PersonRef),
  creators: z.array(PersonRef),
  writers: z.array(PersonRef),
  /** Empty for movies. */
  seasons: z.array(SeasonSummary),
  audioLanguages: z.array(LanguageTag),
  subtitleLanguages: z.array(LanguageTag),
  attribution: Attribution.nullable(),
  addedAt: IsoDateTime,
  isPlayable: z.boolean(),
  /** Null when nothing is playable. */
  playTarget: PlayTarget.nullable(),
  viewer: CardViewerState.extend({ progress: Progress.nullable() }),
}).meta({ id: "TitleDetail" });
export type TitleDetail = z.output<typeof TitleDetail>;

// --- Marketing showcase -----------------------------------------------------------------------

/** Artwork of one title for signed-out marketing surfaces: public, nothing personal. */
export const ShowcaseTitle = z
  .object({
    id: Id,
    name: z.string(),
    type: TitleType,
    images: TitleDetail.shape.images,
  })
  .meta({ id: "ShowcaseTitle" });
export type ShowcaseTitle = z.output<typeof ShowcaseTitle>;

/**
 * The curated showcase (`GET /showcase`): the most popular titles rated at most
 * `SHOWCASE_MATURITY_CEILING`, best first, with versioned (immutable) artwork URLs.
 */
export const Showcase = z
  .object({ items: z.array(ShowcaseTitle).max(SHOWCASE_SIZE) })
  .meta({ id: "Showcase" });
export type Showcase = z.output<typeof Showcase>;

// --- Popularity (non-production diagnostics) --------------------------------------------------

export const TitlePopularityDay = z
  .object({
    /** UTC day. */
    day: z.iso.date(),
    /** Synthetic baseline views (keeps Trending and Top 10 meaningful). */
    baselineViews: z.number().int().nonnegative(),
    /** Views from real playback: profiles credited with at least 60 s of watching that day. */
    playbackViews: z.number().int().nonnegative(),
    /** Seconds of real watching credited that day, every profile together. */
    playbackWatchSec: z.number().nonnegative(),
    /** Profiles that played the title that day, however briefly. */
    playbackProfiles: z.number().int().nonnegative(),
  })
  .meta({ id: "TitlePopularityDay" });
export type TitlePopularityDay = z.output<typeof TitlePopularityDay>;

/**
 * The daily counters Top 10 and Trending are computed from, newest day first, as stored (the
 * browse pages read them through a cache of a few minutes).
 */
export const TitlePopularity = z
  .object({ titleId: Id, days: z.array(TitlePopularityDay) })
  .meta({ id: "TitlePopularity" });
export type TitlePopularity = z.output<typeof TitlePopularity>;
