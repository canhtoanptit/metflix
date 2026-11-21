import { describe, expect, it } from "vitest";
import {
  CatalogSeed,
  type CatalogSeedInput,
  DEMO_ACCOUNT_EMAIL,
  DEMO_ACCOUNT_PASSWORD,
  DemoAccountSeed,
  demoSeedIssues,
  MediaManifest,
} from "../src/index.ts";

const license = {
  license: "CC-BY-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  attribution: "(c) Blender Foundation | durian.blender.org",
  sourceUrl: "https://durian.blender.org/",
};

function validSeed(): CatalogSeedInput {
  const base = {
    tagline: null,
    synopsis: "A synopsis.",
    releaseYear: 2010,
    maturity: "13+" as const,
    maturityDescriptors: [],
    genreIds: ["g-fantasy"],
    moods: ["Epic"],
    cast: [{ personId: "p-1", character: "Sintel" }],
    directorIds: ["p-1"],
    creatorIds: [],
    writerIds: [],
    isOriginal: false,
    addedDaysAgo: 3,
    popularity: 80,
    audioLanguages: ["en"],
    previewAssetId: null,
    license,
  };
  return {
    version: 1,
    genres: [{ id: "g-fantasy", slug: "fantasy", name: "Fantasy", description: null }],
    people: [{ id: "p-1", name: "Halina Reijn" }],
    videoAssets: [
      {
        id: "v-sintel",
        label: "Sintel",
        source: { kind: "download", url: "https://example.org/sintel.mp4", sha256: null, license },
        externalHlsUrl: null,
        subtitleLanguages: ["en"],
      },
      {
        id: "v-synthetic",
        label: "Synthetic",
        source: { kind: "synthetic", durationSec: 60 },
        externalHlsUrl: null,
        subtitleLanguages: [],
      },
    ],
    titles: [
      {
        ...base,
        id: "t-sintel",
        name: "Sintel",
        type: "movie",
        runtimeSec: 888,
        videoAssetId: "v-sintel",
      },
      {
        ...base,
        id: "t-tides",
        name: "Tides",
        type: "series",
        license: null,
        seasons: [
          {
            number: 1,
            name: "Season 1",
            releaseYear: 2024,
            episodes: [
              {
                id: "e-tides-1",
                number: 1,
                name: "One",
                synopsis: "S.",
                runtimeSec: 60,
                videoAssetId: "v-synthetic",
              },
              {
                id: "e-tides-2",
                number: 2,
                name: "Two",
                synopsis: "S.",
                runtimeSec: 60,
                videoAssetId: "v-synthetic",
              },
            ],
          },
        ],
      },
    ],
    avatarGroups: [{ id: "classics", name: "Classics" }],
    avatars: [{ id: "a-comet", name: "Comet", groupId: "classics" }],
  };
}

describe("CatalogSeed", () => {
  it("accepts a consistent catalog", () => {
    expect(CatalogSeed.safeParse(validSeed()).success).toBe(true);
  });

  it("reports unknown references, duplicates and numbering gaps", () => {
    const seed = validSeed();
    const [movie, series] = seed.titles;
    if (movie?.type !== "movie" || series?.type !== "series") throw new Error("fixture shape");
    movie.genreIds = ["g-missing"];
    movie.videoAssetId = "v-missing";
    movie.directorIds = ["p-missing"];
    const episode = series.seasons[0]?.episodes[1];
    if (!episode) throw new Error("fixture shape");
    episode.number = 3;
    seed.avatars.push({ id: "a-comet", name: "Dup", groupId: "nope" });

    const result = CatalogSeed.safeParse(seed);
    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((issue) => issue.message) ?? [];
    expect(messages).toEqual(
      expect.arrayContaining([
        "Unknown genre g-missing",
        "Unknown video asset v-missing",
        "Unknown person p-missing",
        "Episodes must be numbered 1..n (got 3)",
        "Duplicate avatar id: a-comet",
        "Unknown avatar group nope",
      ]),
    );
  });
});

describe("DemoAccountSeed", () => {
  it("cross-checks against the catalog", () => {
    const catalog = CatalogSeed.parse(validSeed());
    const demo = DemoAccountSeed.parse({
      email: DEMO_ACCOUNT_EMAIL,
      password: DEMO_ACCOUNT_PASSWORD,
      planId: "premium",
      profiles: [
        {
          id: "pr-mara",
          name: "Mara",
          avatarId: "a-comet",
          isKids: false,
          maturityCeiling: "18+",
          pin: null,
          myList: ["t-sintel"],
          ratings: [{ titleId: "t-sintel", value: "love" }],
          viewing: [
            {
              titleId: "t-tides",
              episodeId: "e-tides-2",
              daysAgo: 1,
              progress: 0.4,
              completed: false,
            },
            {
              titleId: "t-sintel",
              episodeId: "e-tides-1",
              daysAgo: 2,
              progress: 1,
              completed: true,
            },
            { titleId: "t-gone", episodeId: null, daysAgo: 2, progress: 1, completed: true },
          ],
        },
      ],
    });
    expect(demoSeedIssues(demo, catalog)).toEqual([
      "profile pr-mara: unknown title t-gone",
      "profile pr-mara: movie t-sintel viewed with an episode id",
    ]);
  });
});

describe("MediaManifest", () => {
  it("accepts a packaged asset", () => {
    const manifest = {
      version: 1,
      profile: "fast",
      generatedAt: "2026-11-21T10:00:00.000Z",
      videoAssets: [
        {
          assetId: "v-sintel",
          synthetic: false,
          durationSec: 52.5,
          master: "vod/v-sintel/master.m3u8",
          renditions: [
            {
              id: "720p",
              width: 1280,
              height: 720,
              bandwidth: 3_000_000,
              codecs: "avc1.64001f,mp4a.40.2",
              frameRate: 24,
              playlist: "vod/v-sintel/720p/index.m3u8",
            },
          ],
          audio: [],
          textTracks: [
            {
              id: "en",
              language: "en",
              label: "English",
              kind: "subtitles",
              default: false,
              forced: false,
              key: "vod/v-sintel/subs/en.vtt",
            },
          ],
          trickPlay: null,
          preview: {
            key: "public/previews/v-sintel/preview.mp4",
            durationSec: 20,
            width: 1280,
            height: 720,
          },
          markers: { intro: { startSec: 0, endSec: 12 }, recap: null, creditsStartSec: 48 },
          bytes: 12_345_678,
        },
      ],
      titleArtwork: [],
      episodeStills: [],
      avatars: [],
    };
    expect(MediaManifest.safeParse(manifest).success).toBe(true);
    const broken = structuredClone(manifest);
    const asset = broken.videoAssets[0];
    if (asset) asset.markers.intro = { startSec: 12, endSec: 3 };
    expect(MediaManifest.safeParse(broken).success).toBe(false);
  });
});
