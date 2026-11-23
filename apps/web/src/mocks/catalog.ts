/**
 * Contract DTOs built from the hand-written mock catalogue. Deterministic: the same seed always
 * yields the same ids, artwork URLs, match scores and badges.
 */
import {
  type Attribution,
  type Avatar,
  type AvatarCatalog,
  type Billboard,
  type BrowseView,
  type CardViewerState,
  type Episode,
  type Genre,
  type GenreRef,
  type ImageSet,
  type Plan,
  type Progress,
  type RatingValue,
  type SeasonSummary,
  type TitleBadge,
  type TitleCard,
  type TitleDetail,
  TOP_10_BADGES_PER_LIST,
} from "@webflix/contracts";
import { rgbaToThumbHash } from "thumbhash";
import { type ArtKind, approximateRgba, dominantColor, hashString } from "./artwork.ts";
import { MOCK_AVATAR_NAMES, MOCK_GENRES, MOCK_TITLES } from "./data/catalog.ts";
import type { MockTitleSeed } from "./data/types.ts";

/** Fixed clock so screenshots and tests are stable. */
export const MOCK_NOW = Date.parse("2026-11-20T12:00:00.000Z");
export const iso = (msAgo: number) => new Date(MOCK_NOW - msAgo).toISOString();
const DAY = 86_400_000;

export const titleId = (seed: MockTitleSeed) => `t-${seed.slug}`;
export const seedById = new Map(MOCK_TITLES.map((seed) => [titleId(seed), seed]));
export const seedBySlug = new Map(MOCK_TITLES.map((seed) => [seed.slug, seed]));
export const genreBySlug = new Map(MOCK_GENRES.map((genre) => [genre.slug, genre]));

// --- Images ------------------------------------------------------------------------------------

const WIDTHS: Record<ArtKind, number[]> = {
  card: [320, 480, 640, 960, 1280],
  poster: [200, 300, 400, 600, 800],
  logo: [400, 800, 1200, 1600],
  backdrop: [640, 960, 1280, 1920, 2560, 3840],
  still: [320, 480, 640, 960, 1280],
};
const ASPECT: Record<ArtKind, number> = {
  card: 16 / 9,
  poster: 2 / 3,
  logo: 4,
  backdrop: 16 / 9,
  still: 16 / 9,
};

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const thumbCache = new Map<string, string>();
function thumbhashFor(seed: string, palette: [string, string], kind: ArtKind): string | null {
  if (kind === "logo") return null;
  const key = `${seed}:${kind}`;
  const cached = thumbCache.get(key);
  if (cached) return cached;
  const [w, h] = kind === "poster" ? [20, 30] : [32, 18];
  const hash = toBase64(rgbaToThumbHash(w, h, approximateRgba({ palette, seed }, w, h)));
  thumbCache.set(key, hash);
  return hash;
}

export function titleImage(seed: MockTitleSeed, kind: Exclude<ArtKind, "still">): ImageSet {
  return {
    template: `/cdn/img/titles/${titleId(seed)}/${kind}-{width}.{format}?v=mock`,
    widths: WIDTHS[kind],
    formats: ["avif", "webp"],
    aspectRatio: ASPECT[kind],
    dominantColor: dominantColor({ palette: seed.palette, kind }),
    thumbhash: thumbhashFor(seed.slug, seed.palette, kind),
  };
}

function stillImage(seed: MockTitleSeed, episodeId: string): ImageSet {
  return {
    template: `/cdn/img/episodes/${episodeId}/still-{width}.{format}?v=mock`,
    widths: WIDTHS.still,
    formats: ["avif", "webp"],
    aspectRatio: ASPECT.still,
    dominantColor: dominantColor({ palette: seed.palette, kind: "still" }),
    thumbhash: thumbhashFor(episodeId, seed.palette, "still"),
  };
}

// --- Titles ------------------------------------------------------------------------------------

export const genreRef = (slug: string): GenreRef => ({
  slug,
  name: genreBySlug.get(slug)?.name ?? slug,
});

export function allGenres(): Genre[] {
  return MOCK_GENRES.map((genre) => ({
    id: `g-${genre.slug}`,
    slug: genre.slug,
    name: genre.name,
    description: genre.description,
  }));
}

const TOP_10_MOVIES = MOCK_TITLES.filter((seed) => seed.type === "movie" && !seed.attribution)
  .sort((a, b) => hashString(`top:${a.slug}`) - hashString(`top:${b.slug}`))
  .slice(0, 10);
const TOP_10_SERIES = MOCK_TITLES.filter((seed) => seed.type === "series")
  .sort((a, b) => hashString(`top:${a.slug}`) - hashString(`top:${b.slug}`))
  .slice(0, 10);
const TOP_10_OVERALL = MOCK_TITLES.filter((seed) => !seed.attribution)
  .sort((a, b) => hashString(`top:${a.slug}`) - hashString(`top:${b.slug}`))
  .slice(0, 10);
export const top10 = { movies: TOP_10_MOVIES, series: TOP_10_SERIES, overall: TOP_10_OVERALL };

/**
 * The Top 10 list a card's rank refers to on `view`: its "Top 10 ... Today" row. Overall on Home
 * (and on genre pages, search, My List, More Like This, details), by type on Series and Movies,
 * the title's own type on New & Popular (docs/RECOMMENDATIONS.md, Badges).
 */
function top10ListFor(seed: MockTitleSeed, view: BrowseView): readonly MockTitleSeed[] {
  if (view === "series") return TOP_10_SERIES;
  if (view === "movies") return TOP_10_MOVIES;
  if (view === "new-popular") return seed.type === "movie" ? TOP_10_MOVIES : TOP_10_SERIES;
  return TOP_10_OVERALL;
}

export function top10RankOf(seed: MockTitleSeed, view: BrowseView): number | null {
  const index = top10ListFor(seed, view).indexOf(seed);
  return index < 0 ? null : index + 1;
}

/** Badges that are not about popularity. Like the server, the mock never says `leaving-soon`. */
function statusBadge(seed: MockTitleSeed): "new-episodes" | "new" | null {
  if (seed.year < 2026) return null;
  return seed.type === "series" && (seed.seasons?.length ?? 1) > 1 ? "new-episodes" : "new";
}

/**
 * Where a list of cards sits, as the server decides badges: `single` (billboard, details) earns
 * any badge, `list` (rows, grids) gives Top 10 to its first `TOP_10_BADGES_PER_LIST` ranked
 * cards, `progress` (Continue Watching) and `ranked` rows never show it.
 */
export type BadgeSurface = "single" | "list" | "progress" | "ranked";

/** One badge per card of a list, decided over the whole list in order (as the server does). */
export function surfaceBadges(
  seeds: readonly MockTitleSeed[],
  view: BrowseView,
  surface: BadgeSurface,
): Map<string, TitleBadge | null> {
  let top10Left =
    surface === "single"
      ? Number.POSITIVE_INFINITY
      : surface === "list"
        ? TOP_10_BADGES_PER_LIST
        : 0;
  const badges = new Map<string, TitleBadge | null>();
  for (const seed of seeds) {
    const id = titleId(seed);
    if (badges.has(id)) continue;
    const status = statusBadge(seed);
    let badge: TitleBadge | null = status;
    if (status !== "new-episodes" && top10Left > 0 && top10RankOf(seed, view) !== null) {
      badge = "top-10";
      top10Left -= 1;
    }
    badges.set(id, badge);
  }
  return badges;
}

export function titleCard(
  seed: MockTitleSeed,
  viewer: CardViewerState,
  placement: { view?: BrowseView; badge?: TitleBadge | null } = {},
): TitleCard {
  const view = placement.view ?? "home";
  const rank = top10RankOf(seed, view);
  const badge =
    placement.badge !== undefined
      ? placement.badge
      : (surfaceBadges([seed], view, "single").get(titleId(seed)) ?? null);
  return {
    id: titleId(seed),
    type: seed.type,
    name: seed.name,
    releaseYear: seed.year,
    maturity: seed.maturity,
    runtimeSec: seed.type === "movie" ? (seed.runtimeMin ?? 90) * 60 : null,
    seasonCount: seed.type === "series" ? (seed.seasons?.length ?? 1) : null,
    genres: seed.genres.slice(0, 3).map(genreRef),
    moods: seed.moods.slice(0, 3),
    matchScore: 72 + (hashString(`match:${seed.slug}`) % 27),
    isOriginal: seed.original,
    badge,
    ...(rank === null ? {} : { top10Rank: rank }),
    // Mock media is not packaged; Originals claim 4K so the quality badge has both cases.
    bestVideoQuality: seed.original ? "4k" : "full-hd",
    images: {
      card: titleImage(seed, "card"),
      poster: titleImage(seed, "poster"),
      logo: titleImage(seed, "logo"),
    },
    preview: null,
    viewer,
  };
}

const personId = (name: string) =>
  `p-${name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)}`;

export function episodeId(seed: MockTitleSeed, season: number, number: number): string {
  return `e-${seed.slug}-s${season}e${number}`.slice(0, 64);
}

const EPISODE_LINES = [
  "A routine errand turns into a reckoning nobody planned for.",
  "Old loyalties are tested when an unexpected visitor arrives with a warning.",
  "The truth surfaces at the worst possible moment, and someone has to choose.",
  "A quiet night shatters, and the town wakes to a new set of rules.",
  "Two rivals are forced to work together, and neither enjoys it.",
  "A secret kept for years finally finds its way into the open.",
  "Everything hinges on one conversation, and time is running out.",
  "An unlikely ally changes the odds, at a price.",
  "The plan works perfectly — until it doesn't.",
  "What was lost comes back, though not in the way anyone hoped.",
];

export function seasonsOf(seed: MockTitleSeed): SeasonSummary[] {
  return (seed.seasons ?? []).map((episodes, index) => ({
    number: index + 1,
    name: `Season ${index + 1}`,
    episodeCount: episodes.length,
    releaseYear: seed.year + index,
  }));
}

export function episodesOf(
  seed: MockTitleSeed,
  season: number,
  progressFor: (episodeId: string) => Progress | null,
): Episode[] {
  const names = seed.seasons?.[season - 1] ?? [];
  return names.map((name, index) => {
    const id = episodeId(seed, season, index + 1);
    return {
      id,
      titleId: titleId(seed),
      seasonNumber: season,
      number: index + 1,
      name,
      synopsis: EPISODE_LINES[hashString(id) % EPISODE_LINES.length] ?? "",
      runtimeSec: (38 + (hashString(`rt:${id}`) % 20)) * 60,
      still: stillImage(seed, id),
      isPlayable: true,
      progress: progressFor(id),
    };
  });
}

export function titleDetail(
  seed: MockTitleSeed,
  viewer: CardViewerState & { progress: Progress | null },
): TitleDetail {
  const card = titleCard(seed, viewer);
  const firstEpisode =
    seed.type === "series" && seed.seasons?.[0]?.[0]
      ? { id: episodeId(seed, 1, 1), seasonNumber: 1, number: 1, name: seed.seasons[0][0] }
      : null;
  const attribution: Attribution | null = seed.attribution ?? null;
  return {
    ...card,
    synopsis: seed.synopsis,
    tagline: seed.tagline,
    genres: seed.genres.map(genreRef),
    moods: seed.moods,
    maturityDescriptors: seed.maturityDescriptors,
    images: { ...card.images, backdrop: titleImage(seed, "backdrop") },
    cast: seed.cast.map((member) => ({
      id: personId(member.name),
      name: member.name,
      character: member.character,
    })),
    directors: seed.directors.map((name) => ({ id: personId(name), name })),
    creators: (seed.creators ?? []).map((name) => ({ id: personId(name), name })),
    writers: (seed.creators ?? seed.directors).map((name) => ({ id: personId(name), name })),
    seasons: seasonsOf(seed),
    audioLanguages: ["en"],
    subtitleLanguages: ["en", "es", "vi"],
    attribution,
    addedAt: iso((hashString(`added:${seed.slug}`) % 120) * DAY),
    isPlayable: true,
    playTarget: viewer.progress
      ? {
          action: "resume",
          episode: firstEpisode,
          positionSec: viewer.progress.positionSec,
          progress: viewer.progress,
        }
      : { action: "play", episode: firstEpisode, positionSec: 0, progress: null },
    viewer,
  };
}

export function billboardFor(
  seed: MockTitleSeed,
  viewer: CardViewerState,
  view: BrowseView = "home",
): Billboard {
  return {
    title: titleCard(seed, viewer, { view }),
    synopsis: seed.synopsis,
    backdrop: titleImage(seed, "backdrop"),
    maturityDescriptors: seed.maturityDescriptors,
    playTarget: { action: "play", episode: null, positionSec: 0, progress: null },
  };
}

// --- Account data ------------------------------------------------------------------------------

export const PLANS: Plan[] = [
  {
    id: "basic",
    name: "Basic",
    monthlyPrice: { amountMinor: 799, currency: "USD" },
    maxStreams: 1,
    maxQuality: "720p",
    maxVideoHeight: 720,
    features: ["HD video", "1 screen at a time", "Unlimited movies and series"],
    highlighted: false,
  },
  {
    id: "standard",
    name: "Standard",
    monthlyPrice: { amountMinor: 1549, currency: "USD" },
    maxStreams: 2,
    maxQuality: "1080p",
    maxVideoHeight: 1080,
    features: ["Full HD video", "2 screens at a time", "Unlimited movies and series"],
    highlighted: true,
  },
  {
    id: "premium",
    name: "Premium",
    monthlyPrice: { amountMinor: 2299, currency: "USD" },
    maxStreams: 4,
    maxQuality: "2160p",
    maxVideoHeight: 2160,
    features: ["4K video", "4 screens at a time", "Unlimited movies and series"],
    highlighted: false,
  },
];

export function avatarCatalog(): AvatarCatalog {
  const avatars: Avatar[] = MOCK_AVATAR_NAMES.map((name, index) => {
    const id = `avatar-${String(index + 1).padStart(2, "0")}-${name.toLowerCase()}`;
    return {
      id,
      name,
      imageUrl: `/cdn/img/avatars/${id}.webp`,
      groupId: index < 8 ? "classics" : "creatures",
    };
  });
  return {
    groups: [
      { id: "classics", name: "The Classics", avatars: avatars.slice(0, 8) },
      { id: "creatures", name: "Creatures", avatars: avatars.slice(8) },
    ],
  };
}

export function avatarById(id: string): Avatar | undefined {
  return avatarCatalog()
    .groups.flatMap((group) => group.avatars)
    .find((avatar) => avatar.id === id);
}

export type { RatingValue };
