/**
 * Shape of the seed data in `@webflix/catalog`. The content engineer writes data that
 * parses with `CatalogSeed`/`DemoAccountSeed`; the backend seeder and `tools/media` read it.
 * Cross-references are checked by the schema itself (unknown ids, duplicate ids, episode
 * numbering), so a seed that parses is safe to load.
 */
import * as z from "zod";
import { Id, JsonValue, LanguageTag, Slug, WholeSeconds } from "./common.ts";
import { SEED_VERSION } from "./constants.ts";
import { MaturityLevel } from "./maturity.ts";
import { PlanId } from "./plans.ts";
import { ProfilePin, ProfileSettings } from "./profiles.ts";
import { RatingValue } from "./titles.ts";

/**
 * Free-form art direction for `tools/media` (palette, typography, photo source...).
 * Opaque to the API; only the media pipeline reads it.
 */
export const ArtDirection = z.record(z.string(), JsonValue);

export const MediaLicense = z.object({
  /** SPDX-like identifier, e.g. "CC-BY-4.0", "CC0-1.0". */
  license: z.string().min(1),
  licenseUrl: z.url(),
  /** Credit line shown in the app and in docs/CREDITS.md. */
  attribution: z.string().min(1),
  sourceUrl: z.url().nullable(),
});
export type MediaLicense = z.output<typeof MediaLicense>;

export const GenreSeed = z.object({
  id: Id,
  slug: Slug,
  name: z.string().min(1),
  description: z.string().nullable(),
});
export type GenreSeed = z.output<typeof GenreSeed>;

export const PersonSeed = z.object({ id: Id, name: z.string().min(1) });
export type PersonSeed = z.output<typeof PersonSeed>;

/**
 * A playable video. `source` tells `tools/media` what to package; `externalHlsUrl` is the
 * fallback the API serves when the asset has not been packaged (blueprint §5).
 */
export const VideoAssetSeed = z.object({
  id: Id,
  /** Internal label, never shown to users. */
  label: z.string().min(1),
  source: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("download"),
      url: z.url(),
      /** Lowercase hex SHA-256 of the downloaded file, to verify and cache. */
      sha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .nullable(),
      license: MediaLicense,
      /** Clip the source: package only `[startSec, startSec + durationSec)`. */
      startSec: WholeSeconds.optional(),
      durationSec: WholeSeconds.optional(),
    }),
    z.object({
      kind: z.literal("synthetic"),
      /** Seconds of generated test-pattern video. */
      durationSec: WholeSeconds.min(1),
    }),
  ]),
  externalHlsUrl: z.url().nullable(),
  subtitleLanguages: z.array(LanguageTag),
});
export type VideoAssetSeed = z.output<typeof VideoAssetSeed>;

export const CreditSeed = z.object({
  personId: Id,
  character: z.string().nullable(),
});

export const EpisodeSeed = z.object({
  id: Id,
  number: z.number().int().positive(),
  name: z.string().min(1),
  synopsis: z.string().min(1),
  runtimeSec: WholeSeconds.min(1),
  videoAssetId: Id,
});
export type EpisodeSeed = z.output<typeof EpisodeSeed>;

export const SeasonSeed = z.object({
  number: z.number().int().positive(),
  name: z.string().min(1),
  releaseYear: z.number().int(),
  episodes: z.array(EpisodeSeed).min(1),
});
export type SeasonSeed = z.output<typeof SeasonSeed>;

const titleSeedBase = {
  id: Id,
  name: z.string().min(1),
  tagline: z.string().nullable(),
  synopsis: z.string().min(1),
  releaseYear: z.number().int().min(1888),
  maturity: MaturityLevel,
  maturityDescriptors: z.array(z.string()),
  genreIds: z.array(Id).min(1),
  moods: z.array(z.string().min(1)),
  cast: z.array(CreditSeed),
  directorIds: z.array(Id),
  creatorIds: z.array(Id),
  writerIds: z.array(Id),
  isOriginal: z.boolean(),
  /** Days before seeding that the title "arrived" (drives New Releases and badges). */
  addedDaysAgo: z.number().int().nonnegative(),
  /** 0-100 baseline popularity; the seeder derives view counters (Trending, Top 10) from it. */
  popularity: z.number().min(0).max(100),
  audioLanguages: z.array(LanguageTag).min(1),
  /** Asset used for hover/billboard preview clips; defaults to the main/first-episode asset. */
  previewAssetId: Id.nullable(),
  /** Credit for real open films; null for originals. */
  license: MediaLicense.nullable(),
  art: ArtDirection.optional(),
};

export const MovieSeed = z.object({
  ...titleSeedBase,
  type: z.literal("movie"),
  runtimeSec: WholeSeconds.min(1),
  videoAssetId: Id,
});

export const SeriesSeed = z.object({
  ...titleSeedBase,
  type: z.literal("series"),
  seasons: z.array(SeasonSeed).min(1),
});

export const TitleSeed = z.discriminatedUnion("type", [MovieSeed, SeriesSeed]);
export type TitleSeed = z.output<typeof TitleSeed>;

export const AvatarSeed = z.object({
  id: Id,
  name: z.string().min(1),
  groupId: Id,
  art: ArtDirection.optional(),
});
export type AvatarSeed = z.output<typeof AvatarSeed>;

export const AvatarGroupSeed = z.object({ id: Id, name: z.string().min(1) });

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

export const CatalogSeed = z
  .object({
    version: z.literal(SEED_VERSION),
    genres: z.array(GenreSeed),
    people: z.array(PersonSeed),
    videoAssets: z.array(VideoAssetSeed),
    titles: z.array(TitleSeed),
    avatarGroups: z.array(AvatarGroupSeed),
    avatars: z.array(AvatarSeed),
  })
  .superRefine((seed, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });

    const episodes = seed.titles.flatMap((title) =>
      title.type === "series" ? title.seasons.flatMap((season) => season.episodes) : [],
    );
    for (const [name, ids] of [
      ["genre id", seed.genres.map((genre) => genre.id)],
      ["genre slug", seed.genres.map((genre) => genre.slug)],
      ["person id", seed.people.map((person) => person.id)],
      ["video asset id", seed.videoAssets.map((asset) => asset.id)],
      ["title/episode id", [...seed.titles.map((title) => title.id), ...episodes.map((e) => e.id)]],
      ["avatar group id", seed.avatarGroups.map((group) => group.id)],
      ["avatar id", seed.avatars.map((avatar) => avatar.id)],
    ] as const) {
      for (const duplicate of findDuplicates(ids)) issue([], `Duplicate ${name}: ${duplicate}`);
    }

    const genres = new Set(seed.genres.map((genre) => genre.id));
    const people = new Set(seed.people.map((person) => person.id));
    const assets = new Set(seed.videoAssets.map((asset) => asset.id));
    const groups = new Set(seed.avatarGroups.map((group) => group.id));

    seed.titles.forEach((title, t) => {
      const at = (...path: (string | number)[]) => ["titles", t, ...path];
      title.genreIds.forEach((id, i) => {
        if (!genres.has(id)) issue(at("genreIds", i), `Unknown genre ${id}`);
      });
      const personRefs: [string, readonly string[]][] = [
        ["cast", title.cast.map((credit) => credit.personId)],
        ["directorIds", title.directorIds],
        ["creatorIds", title.creatorIds],
        ["writerIds", title.writerIds],
      ];
      for (const [field, ids] of personRefs) {
        ids.forEach((id, i) => {
          if (!people.has(id)) issue(at(field, i), `Unknown person ${id}`);
        });
      }
      if (title.previewAssetId !== null && !assets.has(title.previewAssetId)) {
        issue(at("previewAssetId"), `Unknown video asset ${title.previewAssetId}`);
      }
      if (title.type === "movie") {
        if (!assets.has(title.videoAssetId)) {
          issue(at("videoAssetId"), `Unknown video asset ${title.videoAssetId}`);
        }
        return;
      }
      title.seasons.forEach((season, s) => {
        if (season.number !== s + 1) {
          issue(at("seasons", s, "number"), `Seasons must be numbered 1..n (got ${season.number})`);
        }
        season.episodes.forEach((episode, e) => {
          if (episode.number !== e + 1) {
            issue(
              at("seasons", s, "episodes", e, "number"),
              `Episodes must be numbered 1..n (got ${episode.number})`,
            );
          }
          if (!assets.has(episode.videoAssetId)) {
            issue(
              at("seasons", s, "episodes", e, "videoAssetId"),
              `Unknown video asset ${episode.videoAssetId}`,
            );
          }
        });
      });
    });

    seed.avatars.forEach((avatar, a) => {
      if (!groups.has(avatar.groupId)) {
        issue(["avatars", a, "groupId"], `Unknown avatar group ${avatar.groupId}`);
      }
    });
  });
export type CatalogSeed = z.output<typeof CatalogSeed>;
export type CatalogSeedInput = z.input<typeof CatalogSeed>;

// --- Demo account (blueprint §8: seeded in every mode) ----------------------------------------

/**
 * The demo account. Times are relative (`daysAgo`) so the home page looks fresh whenever it
 * is seeded. `completed: false` entries feed Continue Watching.
 */
export const DemoAccountSeed = z.object({
  email: z.email(),
  password: z.string().min(8),
  planId: PlanId,
  profiles: z
    .array(
      z.object({
        id: Id,
        name: z.string().min(1).max(30),
        avatarId: Id,
        isKids: z.boolean(),
        maturityCeiling: MaturityLevel,
        pin: ProfilePin.nullable(),
        settings: ProfileSettings.partial().optional(),
        myList: z.array(Id),
        ratings: z.array(z.object({ titleId: Id, value: RatingValue })),
        viewing: z.array(
          z.object({
            titleId: Id,
            episodeId: Id.nullable(),
            daysAgo: z.number().nonnegative(),
            /** Fraction of the runtime watched, 0-1. */
            progress: z.number().min(0).max(1),
            completed: z.boolean(),
          }),
        ),
      }),
    )
    .min(1)
    .max(5),
});
export type DemoAccountSeed = z.output<typeof DemoAccountSeed>;

/**
 * Cross-checks the demo account against the catalog (unknown titles, episodes, avatars).
 * Returns human-readable problems; empty means consistent.
 */
export function demoSeedIssues(demo: DemoAccountSeed, catalog: CatalogSeed): string[] {
  const titles = new Map(catalog.titles.map((title) => [title.id, title]));
  const avatars = new Set(catalog.avatars.map((avatar) => avatar.id));
  const issues: string[] = [];
  for (const profile of demo.profiles) {
    const where = `profile ${profile.id}`;
    if (!avatars.has(profile.avatarId)) issues.push(`${where}: unknown avatar ${profile.avatarId}`);
    const titleIds = [
      ...profile.myList,
      ...profile.ratings.map((rating) => rating.titleId),
      ...profile.viewing.map((entry) => entry.titleId),
    ];
    for (const titleId of titleIds) {
      if (!titles.has(titleId)) issues.push(`${where}: unknown title ${titleId}`);
    }
    for (const entry of profile.viewing) {
      const title = titles.get(entry.titleId);
      if (!title) continue;
      if (title.type === "movie" && entry.episodeId !== null) {
        issues.push(`${where}: movie ${title.id} viewed with an episode id`);
      }
      if (title.type === "series") {
        const episodeIds = title.seasons.flatMap((season) => season.episodes.map((e) => e.id));
        if (entry.episodeId === null || !episodeIds.includes(entry.episodeId)) {
          issues.push(`${where}: series ${title.id} needs a valid episodeId`);
        }
      }
    }
  }
  return issues;
}
