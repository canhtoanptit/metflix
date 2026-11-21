import type { ImageSet } from "@webflix/contracts";
import { DEFAULT_PROFILE_SETTINGS } from "@webflix/contracts";
import type {
  AccountRecord,
  CatalogWrite,
  EpisodeRecord,
  ProfileRow,
  SessionRecord,
  SubscriptionRecord,
  TitleRecord,
} from "../repositories/records.ts";

/** Record builders for repository and service tests. Deterministic; override what matters. */

export const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);
export const DAY_MS = 24 * 60 * 60 * 1000;

export function testImage(path: string, aspectRatio = 16 / 9): ImageSet {
  return {
    template: `/cdn/img/${path}-{width}.{format}`,
    widths: [320, 640],
    formats: ["avif", "webp"],
    aspectRatio,
    dominantColor: "#223344",
    thumbhash: null,
  };
}

export function makeAccountRecord(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return {
    id: "acc-1",
    email: "viewer@example.com",
    passwordHash: "$pbkdf2-sha256$i=1$c2FsdA$aGFzaA",
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function makeSubscriptionRecord(
  overrides: Partial<SubscriptionRecord> = {},
): SubscriptionRecord {
  return {
    accountId: "acc-1",
    planId: "standard",
    startedAt: T0,
    currentPeriodEnd: T0 + 30 * DAY_MS,
    canceledAt: null,
    card: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 },
    updatedAt: T0,
    ...overrides,
  };
}

export function makeSessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "ses-1",
    tokenHash: "hash-1",
    accountId: "acc-1",
    activeProfileId: null,
    deviceLabel: "Firefox on Linux",
    deviceType: "desktop",
    persistent: true,
    createdAt: T0,
    lastSeenAt: T0,
    expiresAt: T0 + 30 * DAY_MS,
    ...overrides,
  };
}

export function makeProfileRow(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    id: "pro-1",
    accountId: "acc-1",
    name: "Alex",
    avatarId: "av-1",
    isKids: false,
    maturityCeiling: "18+",
    pinHash: null,
    settings: { ...DEFAULT_PROFILE_SETTINGS },
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function makeTitleRecord(overrides: Partial<TitleRecord> = {}): TitleRecord {
  const id = overrides.id ?? "t-1";
  return {
    id,
    type: "movie",
    name: `Title ${id}`,
    tagline: null,
    synopsis: `Synopsis of ${id}.`,
    releaseYear: 2020,
    maturity: "13+",
    maturityDescriptors: ["violence"],
    genreIds: ["g-drama"],
    moods: ["Tense"],
    isOriginal: false,
    addedAt: T0 - 10 * DAY_MS,
    popularity: 50,
    runtimeSec: 5400,
    seasonCount: null,
    videoAssetId: "v-1",
    attribution: null,
    audioLanguages: ["en"],
    subtitleLanguages: ["en"],
    images: {
      card: testImage(`titles/${id}/card`),
      poster: testImage(`titles/${id}/poster`, 2 / 3),
      logo: null,
      backdrop: testImage(`titles/${id}/backdrop`),
    },
    preview: null,
    isPlayable: true,
    ...overrides,
  };
}

export function makeEpisodeRecord(overrides: Partial<EpisodeRecord> = {}): EpisodeRecord {
  return {
    id: "e-1",
    titleId: "t-series",
    seasonNumber: 1,
    number: 1,
    seq: 1,
    name: "Pilot",
    runtimeSec: 1800,
    videoAssetId: "v-1",
    isPlayable: true,
    synopsis: "It begins.",
    still: null,
    ...overrides,
  };
}

/** A small catalog: 3 movies (ALL, 13+, 18+), one series with two seasons, two avatars. */
export function makeCatalogWrite(overrides: Partial<CatalogWrite> = {}): CatalogWrite {
  const episodes = [
    makeEpisodeRecord({ id: "e-s1e1", seasonNumber: 1, number: 1, seq: 1, name: "One" }),
    makeEpisodeRecord({ id: "e-s1e2", seasonNumber: 1, number: 2, seq: 2, name: "Two" }),
    makeEpisodeRecord({ id: "e-s2e1", seasonNumber: 2, number: 1, seq: 3, name: "Three" }),
  ];
  return {
    version: "v1",
    genres: [
      { id: "g-drama", slug: "drama", name: "Drama", description: null, position: 0 },
      { id: "g-comedy", slug: "comedy", name: "Comedy", description: "Laughs", position: 1 },
    ],
    people: [
      { id: "p-ana", name: "Ana Ruiz" },
      { id: "p-bo", name: "Bo Lind" },
    ],
    titles: [
      makeTitleRecord({ id: "t-all", maturity: "ALL", genreIds: ["g-comedy"], popularity: 30 }),
      makeTitleRecord({
        id: "t-teen",
        maturity: "13+",
        genreIds: ["g-drama", "g-comedy"],
        popularity: 80,
        preview: {
          url: "/cdn/previews/v-1/preview.mp4",
          durationSec: 30,
          width: 1280,
          height: 720,
        },
      }),
      makeTitleRecord({ id: "t-adult", maturity: "18+", isOriginal: true, popularity: 60 }),
      makeTitleRecord({
        id: "t-series",
        type: "series",
        maturity: "16+",
        runtimeSec: null,
        seasonCount: 2,
        videoAssetId: null,
        attribution: {
          text: "(c) Somebody",
          license: "CC-BY-4.0",
          licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
          sourceUrl: null,
        },
      }),
    ],
    credits: [
      { titleId: "t-teen", personId: "p-ana", role: "cast", character: "Lead", position: 0 },
      { titleId: "t-teen", personId: "p-bo", role: "director", character: null, position: 0 },
      { titleId: "t-series", personId: "p-bo", role: "creator", character: null, position: 0 },
    ],
    seasons: [
      { titleId: "t-series", number: 1, name: "Season 1", releaseYear: 2021, episodeCount: 2 },
      { titleId: "t-series", number: 2, name: "Season 2", releaseYear: null, episodeCount: 1 },
    ],
    episodes,
    videoAssets: [
      {
        id: "v-1",
        label: "Asset one",
        kind: "packaged",
        durationSec: 5400.5,
        masterKey: "vod/v-1/master.m3u8",
        externalUrl: null,
        maxHeight: 1080,
        textTracks: [
          {
            id: "en",
            language: "en",
            label: "English",
            kind: "subtitles",
            default: true,
            forced: false,
            key: "vod/v-1/subs/en.vtt",
          },
        ],
        trickPlay: null,
        markers: { intro: { startSec: 10, endSec: 40 }, recap: null, creditsStartSec: 5300 },
      },
      {
        id: "v-ext",
        label: "External",
        kind: "external",
        durationSec: null,
        masterKey: null,
        externalUrl: "https://example.org/stream.m3u8",
        maxHeight: null,
        textTracks: [],
        trickPlay: null,
        markers: { intro: null, recap: null, creditsStartSec: null },
      },
    ],
    avatarGroups: [{ id: "ag-1", name: "Classics", position: 0 }],
    avatars: [
      {
        id: "av-1",
        groupId: "ag-1",
        name: "Fox",
        imageUrl: "/cdn/img/avatars/av-1.webp",
        position: 0,
      },
      {
        id: "av-2",
        groupId: "ag-1",
        name: "Owl",
        imageUrl: "/cdn/img/avatars/av-2.webp",
        position: 1,
      },
    ],
    notifications: [
      {
        id: "n-1",
        kind: "new-arrival",
        titleId: "t-all",
        headline: "New Arrival",
        body: "Title t-all",
        image: null,
        maturity: "ALL",
        createdAt: T0 - DAY_MS,
      },
      {
        id: "n-2",
        kind: "new-arrival",
        titleId: "t-adult",
        headline: "New Arrival",
        body: "Title t-adult",
        image: testImage("titles/t-adult/card"),
        maturity: "18+",
        createdAt: T0 - 2 * DAY_MS,
      },
    ],
    ...overrides,
  };
}
