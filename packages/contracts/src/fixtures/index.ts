/**
 * Typed fixture factories for tests and UI sandboxes. Every factory returns a value that has
 * been parsed by its schema, so fixtures can never drift from the contract. Ids and names are
 * deterministic: call `resetFixtures()` in `beforeEach` for stable snapshots.
 */
import { AuthenticatedSession } from "../account.ts";
import { Billboard, BrowsePage, ContinueWatchingItem, Row, type RowOfLayout } from "../browse.ts";
import { DEFAULT_PROFILE_SETTINGS, type RowLayout } from "../constants.ts";
import { ImageSet, PreviewClip } from "../media.ts";
import { Plan } from "../plans.ts";
import { PlaybackSession } from "../playback.ts";
import { Avatar, Profile } from "../profiles.ts";
import { Episode, Progress, TitleCard, TitleDetail } from "../titles.ts";

import { resetEventFixtures } from "./events.ts";

export { createProblem as makeProblem } from "../errors.ts";
export { makeClientEventInput, makeLakeEvent, SAMPLE_EVENT_PAYLOADS } from "./events.ts";

const FIXTURE_TIME = "2026-01-15T12:00:00.000Z";

const TITLE_NAMES = [
  "The Quiet Orbit",
  "Saltwater Kings",
  "Paper Lanterns",
  "Night Shift at Kestrel Bay",
  "Glasshouse",
  "The Long Thaw",
  "Static Bloom",
  "Copperline",
  "A Map of Small Hours",
  "Ferryman",
  "Lowlands",
  "Neon Harvest",
] as const;

const COLORS = ["#1f2a44", "#5b2333", "#2f4f3a", "#4a3b2a", "#30304f", "#3d2f4f"] as const;

let sequence = 0;

/** Reset id and name sequences (use in `beforeEach` for deterministic output). */
export function resetFixtures(): void {
  sequence = 0;
  resetEventFixtures();
}

function next(): number {
  sequence += 1;
  return sequence;
}

export function fixtureId(prefix: string): string {
  return `${prefix}-${String(next()).padStart(4, "0")}`;
}

function pick<T>(values: readonly T[], index: number): T {
  const value = values[index % values.length];
  if (value === undefined) throw new Error("pick() on an empty list");
  return value;
}

export function makeImageSet(overrides: Partial<ImageSet> = {}): ImageSet {
  const n = next();
  return ImageSet.parse({
    template: `/cdn/img/titles/fixture-${n}/card-{width}.{format}?v=fixture`,
    widths: [320, 640, 1280],
    formats: ["avif", "webp"],
    aspectRatio: 16 / 9,
    dominantColor: pick(COLORS, n),
    thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
    ...overrides,
  });
}

export function makePreviewClip(overrides: Partial<PreviewClip> = {}): PreviewClip {
  return PreviewClip.parse({
    url: `/cdn/previews/${fixtureId("asset")}/preview.mp4`,
    durationSec: 30,
    width: 1280,
    height: 720,
    ...overrides,
  });
}

export function makeProgress(overrides: Partial<Progress> = {}): Progress {
  return Progress.parse({
    positionSec: 1260,
    durationSec: 2700,
    completed: false,
    updatedAt: FIXTURE_TIME,
    ...overrides,
  });
}

export function makeTitleCard(overrides: Partial<TitleCard> = {}): TitleCard {
  const n = next();
  const type = overrides.type ?? (n % 3 === 0 ? "series" : "movie");
  return TitleCard.parse({
    id: `t-fixture-${n}`,
    type,
    name: pick(TITLE_NAMES, n),
    releaseYear: 2015 + (n % 11),
    maturity: pick(["ALL", "7+", "13+", "16+", "18+"] as const, n),
    runtimeSec: type === "movie" ? 5400 + (n % 7) * 300 : null,
    seasonCount: type === "series" ? 1 + (n % 4) : null,
    genres: [
      { slug: "drama", name: "Drama" },
      { slug: "thriller", name: "Thriller" },
    ],
    moods: ["Suspenseful", "Atmospheric"],
    matchScore: 70 + (n % 30),
    isOriginal: n % 4 === 0,
    badge: n % 5 === 0 ? "new" : null,
    images: {
      card: makeImageSet(),
      poster: makeImageSet({ aspectRatio: 2 / 3, widths: [200, 400, 800] }),
      logo: makeImageSet({ aspectRatio: 4, widths: [300, 600] }),
    },
    preview: makePreviewClip(),
    viewer: { inMyList: false, rating: null },
    ...overrides,
  });
}

export function makeTitleDetail(overrides: Partial<TitleDetail> = {}): TitleDetail {
  const card = makeTitleCard(overrides.type ? { type: overrides.type } : {});
  const isSeries = card.type === "series";
  return TitleDetail.parse({
    ...card,
    synopsis:
      "When a lighthouse keeper finds a radio that only picks up tomorrow's weather, she has one season to decide what to save.",
    tagline: "Some storms you can see coming.",
    maturityDescriptors: ["language", "peril"],
    images: { ...card.images, backdrop: makeImageSet({ widths: [640, 1280, 1920, 3840] }) },
    cast: [
      { id: fixtureId("p"), name: "Mara Okonkwo", character: "Ilse" },
      { id: fixtureId("p"), name: "Tomas Varga", character: "Pell" },
    ],
    directors: [{ id: fixtureId("p"), name: "Ines Albescu" }],
    creators: isSeries ? [{ id: fixtureId("p"), name: "June Halloran" }] : [],
    writers: [{ id: fixtureId("p"), name: "June Halloran" }],
    seasons: isSeries
      ? Array.from({ length: card.seasonCount ?? 1 }, (_, index) => ({
          number: index + 1,
          name: `Season ${index + 1}`,
          episodeCount: 8,
          releaseYear: card.releaseYear + index,
        }))
      : [],
    audioLanguages: ["en"],
    subtitleLanguages: ["en", "vi"],
    attribution: null,
    addedAt: FIXTURE_TIME,
    isPlayable: true,
    playTarget: { action: "play", episode: null, positionSec: 0, progress: null },
    viewer: { ...card.viewer, progress: null },
    ...overrides,
  });
}

export function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  const n = next();
  return Episode.parse({
    id: `e-fixture-${n}`,
    titleId: "t-fixture-series",
    seasonNumber: 1,
    number: 1 + (n % 8),
    name: `Chapter ${1 + (n % 8)}`,
    synopsis: "The tide comes in early, and with it a stranger who knows everyone's name.",
    runtimeSec: 2700,
    still: makeImageSet(),
    isPlayable: true,
    progress: null,
    ...overrides,
  });
}

function rowItems(layout: RowLayout, count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => {
    const title = makeTitleCard();
    switch (layout) {
      case "ranked":
        return { rank: index + 1, title };
      case "continue":
        return ContinueWatchingItem.parse({
          title,
          episode:
            title.type === "series"
              ? { id: fixtureId("e"), seasonNumber: 1, number: 2, name: "Chapter 2" }
              : null,
          progress: makeProgress(),
        });
      default:
        return title;
    }
  });
}

const ROW_DEFAULTS = {
  standard: { kind: "trending", title: "Trending Now" },
  tall: { kind: "originals", title: "Only on Webflix" },
  ranked: { kind: "top-10", title: "Top 10 Movies Today" },
  continue: { kind: "continue-watching", title: "Continue Watching for Mara" },
} as const;

export interface MakeRowOptions {
  count?: number;
  overrides?: Partial<Omit<Row, "layout" | "items">>;
}

/** A row of the given layout with `count` items (default 10 for ranked, else 12). */
export function makeRow<L extends RowLayout>(
  layout: L,
  options: MakeRowOptions = {},
): RowOfLayout<L> {
  const count = options.count ?? (layout === "ranked" ? 10 : 12);
  const defaults = ROW_DEFAULTS[layout];
  return Row.parse({
    id: fixtureId(`row-${layout}`),
    kind: defaults.kind,
    title: defaults.title,
    context: { sourceTitle: null, genre: null },
    link: null,
    nextCursor: null,
    ...options.overrides,
    layout,
    items: rowItems(layout, count),
  }) as RowOfLayout<L>;
}

export function makeBillboard(overrides: Partial<Billboard> = {}): Billboard {
  return Billboard.parse({
    title: makeTitleCard({ isOriginal: true }),
    synopsis: "A cartographer maps a city that redraws itself every night.",
    backdrop: makeImageSet({ widths: [640, 1280, 1920, 3840] }),
    maturityDescriptors: ["violence"],
    playTarget: { action: "play", episode: null, positionSec: 0, progress: null },
    ...overrides,
  });
}

/** A home page with one row of each layout. */
export function makeBrowsePage(overrides: Partial<BrowsePage> = {}): BrowsePage {
  return BrowsePage.parse({
    view: "home",
    billboard: makeBillboard(),
    rows: [
      makeRow("continue", { count: 4 }),
      makeRow("standard"),
      makeRow("ranked"),
      makeRow("tall"),
    ],
    nextCursor: null,
    ...overrides,
  });
}

export function makePlaybackSession(overrides: Partial<PlaybackSession> = {}): PlaybackSession {
  const assetId = fixtureId("asset");
  const token = "fixture-token";
  return PlaybackSession.parse({
    id: fixtureId("ps"),
    titleId: "t-fixture-series",
    episodeId: "e-fixture-1",
    manifestUrl: `/media/${token}/vod/${assetId}/master.m3u8`,
    expiresAt: "2026-01-15T18:00:00.000Z",
    durationSec: 2700,
    resumePositionSec: 0,
    textTracks: [
      {
        id: "en",
        language: "en",
        label: "English",
        kind: "subtitles",
        url: `/media/${token}/vod/${assetId}/subs/en.vtt`,
        default: false,
        forced: false,
      },
    ],
    trickPlay: {
      intervalSec: 10,
      tileWidth: 240,
      tileHeight: 135,
      columns: 10,
      rows: 10,
      count: 270,
      sheets: [0, 1, 2].map((sheet) => `/media/${token}/vod/${assetId}/trickplay/${sheet}.webp`),
    },
    markers: { intro: { startSec: 30, endSec: 95 }, recap: null, creditsStartSec: 2610 },
    nextEpisode: {
      episode: { id: "e-fixture-2", seasonNumber: 1, number: 2, name: "Chapter 2" },
      synopsis: "The stranger's ledger turns up in the wrong hands.",
      runtimeSec: 2650,
      still: makeImageSet(),
    },
    heartbeatIntervalSec: 30,
    maxVideoHeight: 1080,
    autoplayNextEpisode: true,
    display: {
      titleName: "Night Shift at Kestrel Bay",
      titleType: "series",
      episode: { id: "e-fixture-1", seasonNumber: 1, number: 1, name: "Chapter 1" },
      maturity: "13+",
      maturityDescriptors: ["language"],
      logo: null,
    },
    ...overrides,
  });
}

export function makeAvatar(overrides: Partial<Avatar> = {}): Avatar {
  const id = fixtureId("avatar");
  return Avatar.parse({
    id,
    name: "Comet",
    imageUrl: `/cdn/img/avatars/${id}.webp`,
    groupId: "classics",
    ...overrides,
  });
}

export function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return Profile.parse({
    id: fixtureId("profile"),
    name: "Mara",
    avatar: makeAvatar(),
    isKids: false,
    maturityCeiling: "18+",
    isLocked: false,
    settings: DEFAULT_PROFILE_SETTINGS,
    createdAt: FIXTURE_TIME,
    ...overrides,
  });
}

export function makePlan(overrides: Partial<Plan> = {}): Plan {
  return Plan.parse({
    id: "standard",
    name: "Standard",
    monthlyPrice: { amountMinor: 1299, currency: "USD" },
    maxStreams: 2,
    maxQuality: "1080p",
    maxVideoHeight: 1080,
    features: ["Full HD", "Watch on 2 devices at a time"],
    highlighted: true,
    ...overrides,
  });
}

export function makeAuthenticatedSession(
  overrides: Partial<AuthenticatedSession> = {},
): AuthenticatedSession {
  const profiles = [
    makeProfile(),
    makeProfile({ name: "Kids", isKids: true, maturityCeiling: "7+" }),
  ];
  return AuthenticatedSession.parse({
    authenticated: true,
    account: { id: fixtureId("acct"), email: "demo@webflix.dev", createdAt: FIXTURE_TIME },
    subscription: {
      planId: "standard",
      status: "active",
      startedAt: FIXTURE_TIME,
      currentPeriodEnd: "2026-02-15T12:00:00.000Z",
      canceledAt: null,
    },
    plan: makePlan(),
    profiles,
    activeProfile: profiles[0] ?? null,
    ...overrides,
  });
}
