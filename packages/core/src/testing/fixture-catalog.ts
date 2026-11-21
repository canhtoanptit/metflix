import {
  type CatalogSeed,
  type CatalogSeedInput,
  CatalogSeed as CatalogSeedSchema,
  DEMO_ACCOUNT_EMAIL,
  DEMO_ACCOUNT_PASSWORD,
  type DemoAccountSeed,
  DemoAccountSeed as DemoAccountSeedSchema,
  demoSeedIssues,
  type MaturityLevel,
  type MediaManifest,
  MediaManifest as MediaManifestSchema,
} from "@webflix/contracts";

/**
 * A small, deterministic catalog for tests (the real one lives in `@webflix/catalog` and
 * changes under us): 7 genres, 22 titles (16 movies, 6 series), every maturity level, a few
 * originals and recent arrivals, one packaged asset (see `FIXTURE_MANIFEST`), one external
 * asset, one unavailable asset; plus a demo account with an adult, a kids and a PIN-locked
 * profile.
 */

const LICENSE = {
  license: "CC-BY-4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  attribution: "(c) Blender Foundation | www.blender.org",
  sourceUrl: "https://studio.blender.org/",
};

export const FIXTURE_PACKAGED_ASSET = "v-pkg";
export const FIXTURE_EXTERNAL_ASSET = "v-ext";
export const FIXTURE_UNAVAILABLE_ASSET = "v-none";
export const FIXTURE_EXTERNAL_URL = "https://streams.example.org/fixture/master.m3u8";

interface MovieRow {
  id: string;
  name: string;
  genres: string[];
  maturity: MaturityLevel;
  moods: string[];
  people: string[];
  popularity: number;
  addedDaysAgo: number;
  year: number;
  original?: boolean;
  asset?: string;
}

const MOVIES: MovieRow[] = [
  {
    id: "t-orbit",
    name: "The Quiet Orbit",
    genres: ["g-scifi", "g-drama"],
    maturity: "13+",
    moods: ["Cerebral", "Atmospheric"],
    people: ["p-ana", "p-ivo"],
    popularity: 92,
    addedDaysAgo: 3,
    year: 2025,
    original: true,
    asset: FIXTURE_PACKAGED_ASSET,
  },
  {
    id: "t-saltwater",
    name: "Saltwater Kings",
    genres: ["g-drama"],
    maturity: "16+",
    moods: ["Gritty"],
    people: ["p-bo", "p-cara"],
    popularity: 71,
    addedDaysAgo: 40,
    year: 2021,
  },
  {
    id: "t-lanterns",
    name: "Paper Lanterns",
    genres: ["g-animation", "g-comedy"],
    maturity: "ALL",
    moods: ["Heartfelt", "Whimsical"],
    people: ["p-dev"],
    popularity: 66,
    addedDaysAgo: 8,
    year: 2024,
  },
  {
    id: "t-glasshouse",
    name: "Glasshouse",
    genres: ["g-thriller", "g-drama"],
    maturity: "16+",
    moods: ["Suspenseful", "Tense"],
    people: ["p-eli", "p-ana"],
    popularity: 80,
    addedDaysAgo: 120,
    year: 2020,
  },
  {
    id: "t-thaw",
    name: "The Long Thaw",
    genres: ["g-documentary"],
    maturity: "ALL",
    moods: ["Inspiring"],
    people: ["p-fay"],
    popularity: 35,
    addedDaysAgo: 200,
    year: 2019,
  },
  {
    id: "t-bloom",
    name: "Static Bloom",
    genres: ["g-scifi", "g-thriller"],
    maturity: "16+",
    moods: ["Cerebral", "Tense"],
    people: ["p-ivo", "p-eli"],
    popularity: 74,
    addedDaysAgo: 15,
    year: 2023,
    original: true,
  },
  {
    id: "t-copper",
    name: "Copperline",
    genres: ["g-thriller"],
    maturity: "18+",
    moods: ["Gritty", "Dark"],
    people: ["p-gus"],
    popularity: 58,
    addedDaysAgo: 300,
    year: 2018,
  },
  {
    id: "t-hours",
    name: "A Map of Small Hours",
    genres: ["g-drama", "g-comedy"],
    maturity: "13+",
    moods: ["Heartfelt"],
    people: ["p-cara", "p-hana"],
    popularity: 49,
    addedDaysAgo: 60,
    year: 2022,
  },
  {
    id: "t-ferry",
    name: "Ferryman",
    genres: ["g-horror", "g-thriller"],
    maturity: "18+",
    moods: ["Dark", "Scary"],
    people: ["p-gus", "p-jon"],
    popularity: 63,
    addedDaysAgo: 30,
    year: 2022,
  },
  {
    id: "t-lowlands",
    name: "Lowlands",
    genres: ["g-drama"],
    maturity: "13+",
    moods: ["Atmospheric"],
    people: ["p-hana"],
    popularity: 28,
    addedDaysAgo: 365,
    year: 2016,
  },
  {
    id: "t-harvest",
    name: "Neon Harvest",
    genres: ["g-scifi", "g-comedy"],
    maturity: "13+",
    moods: ["Witty", "Quirky"],
    people: ["p-dev", "p-ivo"],
    popularity: 55,
    addedDaysAgo: 5,
    year: 2025,
    asset: FIXTURE_EXTERNAL_ASSET,
  },
  {
    id: "t-owl",
    name: "Owl and the Moon",
    genres: ["g-animation"],
    maturity: "ALL",
    moods: ["Whimsical", "Heartfelt"],
    people: ["p-dev"],
    popularity: 61,
    addedDaysAgo: 90,
    year: 2021,
  },
  {
    id: "t-pebble",
    name: "Pebble Patrol",
    genres: ["g-animation", "g-comedy"],
    maturity: "7+",
    moods: ["Silly", "Witty"],
    people: ["p-kim"],
    popularity: 52,
    addedDaysAgo: 45,
    year: 2023,
  },
  {
    id: "t-cellar",
    name: "The Cellar Door",
    genres: ["g-horror"],
    maturity: "18+",
    moods: ["Scary"],
    people: ["p-jon"],
    popularity: 44,
    addedDaysAgo: 150,
    year: 2019,
  },
  {
    id: "t-tides",
    name: "Tidesong",
    genres: ["g-documentary", "g-drama"],
    maturity: "7+",
    moods: ["Inspiring", "Atmospheric"],
    people: ["p-fay"],
    popularity: 40,
    addedDaysAgo: 75,
    year: 2020,
    asset: FIXTURE_UNAVAILABLE_ASSET,
  },
  {
    id: "t-grin",
    name: "Grin and Bear It",
    genres: ["g-comedy"],
    maturity: "13+",
    moods: ["Witty", "Silly"],
    people: ["p-kim", "p-cara"],
    popularity: 68,
    addedDaysAgo: 12,
    year: 2024,
    original: true,
  },
];

interface SeriesRow {
  id: string;
  name: string;
  genres: string[];
  maturity: MaturityLevel;
  moods: string[];
  people: string[];
  popularity: number;
  addedDaysAgo: number;
  year: number;
  seasons: number[];
  original?: boolean;
}

const SERIES: SeriesRow[] = [
  {
    id: "t-kestrel",
    name: "Night Shift at Kestrel Bay",
    genres: ["g-thriller", "g-drama"],
    maturity: "16+",
    moods: ["Suspenseful", "Atmospheric"],
    people: ["p-eli", "p-bo"],
    popularity: 88,
    addedDaysAgo: 20,
    year: 2024,
    seasons: [3, 2],
    original: true,
  },
  {
    id: "t-starlings",
    name: "The Starlings",
    genres: ["g-comedy"],
    maturity: "13+",
    moods: ["Witty"],
    people: ["p-hana", "p-kim"],
    popularity: 77,
    addedDaysAgo: 180,
    year: 2019,
    seasons: [2, 2],
  },
  {
    id: "t-meadow",
    name: "Meadow Friends",
    genres: ["g-animation"],
    maturity: "ALL",
    moods: ["Whimsical"],
    people: ["p-dev"],
    popularity: 57,
    addedDaysAgo: 10,
    year: 2025,
    seasons: [3],
  },
  {
    id: "t-signal",
    name: "Lost Signal",
    genres: ["g-scifi", "g-thriller"],
    maturity: "16+",
    moods: ["Cerebral", "Tense"],
    people: ["p-ivo", "p-gus"],
    popularity: 82,
    addedDaysAgo: 60,
    year: 2023,
    seasons: [2, 3],
  },
  {
    id: "t-wild",
    name: "Wild Coasts",
    genres: ["g-documentary"],
    maturity: "ALL",
    moods: ["Inspiring"],
    people: ["p-fay"],
    popularity: 46,
    addedDaysAgo: 220,
    year: 2018,
    seasons: [3],
  },
  {
    id: "t-hollow",
    name: "Hollow Pines",
    genres: ["g-horror", "g-drama"],
    maturity: "18+",
    moods: ["Dark", "Scary"],
    people: ["p-jon", "p-cara"],
    popularity: 69,
    addedDaysAgo: 25,
    year: 2024,
    seasons: [2],
  },
];

const PEOPLE = [
  ["p-ana", "Ana Ruiz"],
  ["p-bo", "Bo Lindqvist"],
  ["p-cara", "Cara Mbeki"],
  ["p-dev", "Dev Anand Rao"],
  ["p-eli", "Eli Sandström"],
  ["p-fay", "Fay Okafor"],
  ["p-gus", "Gus Halvorsen"],
  ["p-hana", "Hana Kimura"],
  ["p-ivo", "Ivo Petrović"],
  ["p-jon", "Jon Ashgrove"],
  ["p-kim", "Kim Nguyễn"],
] as const;

function credits(people: string[]) {
  const [director, ...cast] = people;
  return {
    cast: (cast.length > 0 ? cast : people).map((personId, index) => ({
      personId,
      character: `Character ${index + 1}`,
    })),
    directorIds: director ? [director] : [],
  };
}

export const FIXTURE_CATALOG_INPUT: CatalogSeedInput = {
  version: 1,
  genres: [
    { id: "g-drama", slug: "drama", name: "Dramas", description: "Stories that stay with you." },
    { id: "g-comedy", slug: "comedy", name: "Comedies", description: null },
    { id: "g-thriller", slug: "thriller", name: "Thrillers", description: null },
    { id: "g-scifi", slug: "sci-fi", name: "Sci-Fi", description: null },
    { id: "g-animation", slug: "animation", name: "Animation", description: null },
    { id: "g-documentary", slug: "documentary", name: "Documentaries", description: null },
    { id: "g-horror", slug: "horror", name: "Horror", description: null },
  ],
  people: PEOPLE.map(([id, name]) => ({ id, name })),
  videoAssets: [
    {
      id: FIXTURE_PACKAGED_ASSET,
      label: "Packaged fixture",
      source: {
        kind: "download",
        url: "https://example.org/fixture.mp4",
        sha256: null,
        license: LICENSE,
      },
      externalHlsUrl: FIXTURE_EXTERNAL_URL,
      subtitleLanguages: ["en"],
    },
    {
      id: FIXTURE_EXTERNAL_ASSET,
      label: "External fallback",
      source: { kind: "synthetic", durationSec: 600 },
      externalHlsUrl: FIXTURE_EXTERNAL_URL,
      subtitleLanguages: [],
    },
    {
      id: FIXTURE_UNAVAILABLE_ASSET,
      label: "Not packaged, no fallback",
      source: { kind: "synthetic", durationSec: 60 },
      externalHlsUrl: null,
      subtitleLanguages: [],
    },
  ],
  titles: [
    ...MOVIES.map((movie) => ({
      id: movie.id,
      type: "movie" as const,
      name: movie.name,
      tagline: movie.original ? "Only on Webflix." : null,
      synopsis: `${movie.name}: a ${movie.moods.join(", ").toLowerCase()} story.`,
      releaseYear: movie.year,
      maturity: movie.maturity,
      maturityDescriptors: movie.maturity === "18+" ? ["violence", "language"] : [],
      genreIds: movie.genres,
      moods: movie.moods,
      ...credits(movie.people),
      creatorIds: [],
      writerIds: [],
      isOriginal: movie.original ?? false,
      addedDaysAgo: movie.addedDaysAgo,
      popularity: movie.popularity,
      audioLanguages: ["en"],
      previewAssetId: null,
      license: movie.asset === FIXTURE_PACKAGED_ASSET ? LICENSE : null,
      runtimeSec: 5400,
      videoAssetId: movie.asset ?? FIXTURE_EXTERNAL_ASSET,
    })),
    ...SERIES.map((series) => ({
      id: series.id,
      type: "series" as const,
      name: series.name,
      tagline: null,
      synopsis: `${series.name}: a ${series.moods.join(", ").toLowerCase()} series.`,
      releaseYear: series.year,
      maturity: series.maturity,
      maturityDescriptors: series.maturity === "18+" ? ["violence"] : [],
      genreIds: series.genres,
      moods: series.moods,
      cast: series.people.map((personId) => ({ personId, character: null })),
      directorIds: [],
      creatorIds: series.people.slice(0, 1),
      writerIds: [],
      isOriginal: series.original ?? false,
      addedDaysAgo: series.addedDaysAgo,
      popularity: series.popularity,
      audioLanguages: ["en"],
      previewAssetId: null,
      license: null,
      seasons: series.seasons.map((episodes, s) => ({
        number: s + 1,
        name: `Season ${s + 1}`,
        releaseYear: series.year + s,
        episodes: Array.from({ length: episodes }, (_, e) => ({
          id: `${series.id}-s${s + 1}e${e + 1}`,
          number: e + 1,
          name: `Episode ${e + 1}`,
          synopsis: `Season ${s + 1}, episode ${e + 1} of ${series.name}.`,
          runtimeSec: 1800,
          videoAssetId: series.id === "t-kestrel" ? FIXTURE_PACKAGED_ASSET : FIXTURE_EXTERNAL_ASSET,
        })),
      })),
    })),
  ],
  avatarGroups: [
    { id: "ag-classics", name: "Classics" },
    { id: "ag-kids", name: "Kids" },
  ],
  avatars: [
    { id: "av-fox", name: "Fox", groupId: "ag-classics" },
    { id: "av-owl", name: "Owl", groupId: "ag-classics" },
    { id: "av-robot", name: "Robot", groupId: "ag-kids" },
  ],
};

export const FIXTURE_CATALOG: CatalogSeed = CatalogSeedSchema.parse(FIXTURE_CATALOG_INPUT);

/** Demo profiles: `pr-demo` (adult, rich history), `pr-kids` (kids), `pr-locked` (PIN 1234). */
export const FIXTURE_DEMO_ACCOUNT: DemoAccountSeed = (() => {
  const demo = DemoAccountSeedSchema.parse({
    email: DEMO_ACCOUNT_EMAIL,
    password: DEMO_ACCOUNT_PASSWORD,
    planId: "premium",
    profiles: [
      {
        id: "pr-demo",
        name: "Demo",
        avatarId: "av-fox",
        isKids: false,
        maturityCeiling: "18+",
        pin: null,
        myList: ["t-glasshouse", "t-starlings", "t-lanterns"],
        ratings: [
          { titleId: "t-orbit", value: "love" },
          { titleId: "t-copper", value: "dislike" },
          { titleId: "t-lowlands", value: "like" },
        ],
        viewing: [
          { titleId: "t-orbit", episodeId: null, daysAgo: 6, progress: 1, completed: true },
          { titleId: "t-saltwater", episodeId: null, daysAgo: 1, progress: 0.42, completed: false },
          {
            titleId: "t-kestrel",
            episodeId: "t-kestrel-s1e1",
            daysAgo: 3,
            progress: 1,
            completed: true,
          },
          {
            titleId: "t-kestrel",
            episodeId: "t-kestrel-s1e2",
            daysAgo: 2,
            progress: 0.3,
            completed: false,
          },
          {
            titleId: "t-signal",
            episodeId: "t-signal-s1e2",
            daysAgo: 4,
            progress: 1,
            completed: true,
          },
          { titleId: "t-bloom", episodeId: null, daysAgo: 10, progress: 1, completed: true },
        ],
      },
      {
        id: "pr-kids",
        name: "Kids",
        avatarId: "av-robot",
        isKids: true,
        maturityCeiling: "7+",
        pin: null,
        myList: ["t-meadow"],
        ratings: [{ titleId: "t-owl", value: "love" }],
        viewing: [
          {
            titleId: "t-meadow",
            episodeId: "t-meadow-s1e1",
            daysAgo: 1,
            progress: 0.5,
            completed: false,
          },
        ],
      },
      {
        id: "pr-locked",
        name: "Grown-ups",
        avatarId: "av-owl",
        isKids: false,
        maturityCeiling: "18+",
        pin: "1234",
        myList: [],
        ratings: [],
        viewing: [],
      },
    ],
  });
  const issues = demoSeedIssues(demo, FIXTURE_CATALOG);
  if (issues.length > 0) throw new Error(`Invalid fixture demo account: ${issues.join("; ")}`);
  return demo;
})();

const PKG = FIXTURE_PACKAGED_ASSET;

/** Media manifest for the packaged fixture asset and artwork for `t-orbit`. */
export const FIXTURE_MANIFEST: MediaManifest = MediaManifestSchema.parse({
  version: 1,
  profile: "fast",
  generatedAt: "2026-06-01T00:00:00.000Z",
  videoAssets: [
    {
      assetId: PKG,
      synthetic: true,
      durationSec: 5400,
      master: `vod/${PKG}/master.m3u8`,
      renditions: [
        {
          id: "480p",
          width: 854,
          height: 480,
          bandwidth: 900000,
          codecs: "avc1.64001e",
          frameRate: 24,
          playlist: `vod/${PKG}/480p/index.m3u8`,
        },
        {
          id: "720p",
          width: 1280,
          height: 720,
          bandwidth: 2500000,
          codecs: "avc1.64001f",
          frameRate: 24,
          playlist: `vod/${PKG}/720p/index.m3u8`,
        },
        {
          id: "1080p",
          width: 1920,
          height: 1080,
          bandwidth: 5000000,
          codecs: "avc1.640028",
          frameRate: 24,
          playlist: `vod/${PKG}/1080p/index.m3u8`,
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
          key: `vod/${PKG}/subs/en.vtt`,
        },
      ],
      trickPlay: {
        intervalSec: 10,
        tileWidth: 160,
        tileHeight: 90,
        columns: 10,
        rows: 10,
        count: 540,
        sheets: [`vod/${PKG}/trickplay/0.webp`],
      },
      preview: {
        key: `public/previews/${PKG}/preview.mp4`,
        durationSec: 20,
        width: 1280,
        height: 720,
      },
      markers: { intro: { startSec: 5, endSec: 35 }, recap: null, creditsStartSec: 5200 },
      bytes: 1234,
    },
  ],
  titleArtwork: [
    {
      titleId: "t-orbit",
      ...Object.fromEntries(
        (["backdrop", "card", "poster"] as const).map((kind) => [
          kind,
          {
            keyTemplate: `public/img/titles/t-orbit/${kind}-{width}.{format}`,
            widths: [320, 640],
            formats: ["avif", "webp"],
            aspectRatio: kind === "poster" ? 2 / 3 : 16 / 9,
            dominantColor: "#203040",
            thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
            version: "abc123",
          },
        ]),
      ),
      logo: null,
    },
  ],
  episodeStills: [],
  avatars: [{ avatarId: "av-fox", key: "public/img/avatars/av-fox.webp", version: "fox001" }],
});

/** The master playlist the fixture's blob store holds (three renditions). */
export const FIXTURE_MASTER_PLAYLIST = [
  "#EXTM3U",
  "#EXT-X-VERSION:7",
  '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480,CODECS="avc1.64001e"',
  "480p/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f"',
  "720p/index.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028"',
  "1080p/index.m3u8",
  "",
].join("\n");
