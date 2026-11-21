/**
 * Playground fixtures: `PlaybackSession`s built from the generated test media
 * (`.cache/test-media/assets.json`), shaped exactly like `POST /playback/sessions` responses.
 */
import type { ImageSet, PlaybackSession, TextTrack } from "@webflix/contracts";
import type { EpisodeSummary, EpisodesSource } from "../src/index.ts";

export interface TestAsset {
  assetId: string;
  durationSec: number;
  master: string;
  preview: string;
  previewDurationSec: number;
  still: { keyTemplate: string; widths: number[]; formats: ("webp" | "avif")[] };
  markers: PlaybackSession["markers"];
  textTracks: (Omit<TextTrack, "url"> & { key: string })[];
  trickPlay: Omit<NonNullable<PlaybackSession["trickPlay"]>, "sheets"> & { sheets: string[] };
}

export type ScenarioId = "episode" | "last-episode" | "movie" | "capped" | "expired" | "external";

export const SCENARIOS: { id: ScenarioId; label: string; note: string }[] = [
  {
    id: "episode",
    label: "Series · S1:E1",
    note: "Recap, intro, credits, next episode, episodes panel",
  },
  {
    id: "last-episode",
    label: "Series · S1:E2 (latest)",
    note: "No next episode: end screen with recommendations",
  },
  { id: "movie", label: "Movie", note: "Movie end screen, no episodes" },
  {
    id: "capped",
    label: "Basic plan (720p cap)",
    note: "maxVideoHeight 720: 1080p is never offered or loaded",
  },
  {
    id: "expired",
    label: "Expired token (403)",
    note: "Fatal forbidden error → host recreates the session",
  },
  {
    id: "external",
    label: "Public HLS (external)",
    note: "Third-party test stream; needs network",
  },
];

const media = (token: string, key: string) => `/media/${token}/${key}`;
const cdn = (key: string) => `/cdn/${key.replace(/^public\//, "")}`;

export function stillImageSet(asset: TestAsset, color: string): ImageSet {
  return {
    template: cdn(asset.still.keyTemplate),
    widths: asset.still.widths,
    formats: asset.still.formats,
    aspectRatio: 16 / 9,
    dominantColor: color,
    thumbhash: null,
  };
}

const EPISODES = {
  e1: {
    id: "kestrel-s1e1",
    seasonNumber: 1,
    number: 1,
    name: "The Harbour Lights",
    synopsis:
      "The night the harbour lights fail, a fisherman's daughter finds a ledger that should have gone down with the boat.",
  },
  e2: {
    id: "kestrel-s1e2",
    seasonNumber: 1,
    number: 2,
    name: "The Ledger",
    synopsis: "Every page is a name. Mara works out whose — and why one of them is hers.",
  },
} as const;

export interface ScenarioOptions {
  token?: string;
  sessionSuffix?: string;
  autoplayNext?: boolean;
}

function baseSession(
  asset: TestAsset,
  token: string,
  id: string,
): Omit<PlaybackSession, "display" | "nextEpisode" | "titleId" | "episodeId"> {
  return {
    id,
    manifestUrl: media(token, asset.master),
    expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
    durationSec: asset.durationSec,
    resumePositionSec: 0,
    textTracks: asset.textTracks.map(({ key, ...track }) => ({ ...track, url: media(token, key) })),
    trickPlay: {
      ...asset.trickPlay,
      sheets: asset.trickPlay.sheets.map((key) => media(token, key)),
    },
    markers: asset.markers,
    heartbeatIntervalSec: 10,
    maxVideoHeight: 1080,
    autoplayNextEpisode: true,
  };
}

export function buildSession(
  scenario: ScenarioId,
  assets: readonly TestAsset[],
  options: ScenarioOptions = {},
): PlaybackSession {
  const [ep1, ep2] = assets;
  if (!ep1 || !ep2)
    throw new Error("Test media missing: run `pnpm --filter @webflix/player media`.");
  const token = options.token ?? (scenario === "expired" ? "expired" : "pg-token");
  const suffix = options.sessionSuffix ?? "";
  const seriesDisplay = {
    titleName: "Kestrel Bay",
    titleType: "series" as const,
    maturity: "16+" as const,
    maturityDescriptors: ["language", "violence", "smoking"],
    logo: null,
  };
  switch (scenario) {
    case "episode":
    case "capped":
    case "expired":
      return {
        ...baseSession(ep1, token, `ps-${scenario}${suffix}`),
        titleId: "kestrel-bay",
        episodeId: EPISODES.e1.id,
        maxVideoHeight: scenario === "capped" ? 720 : 1080,
        autoplayNextEpisode: options.autoplayNext ?? true,
        nextEpisode: {
          episode: {
            id: EPISODES.e2.id,
            seasonNumber: 1,
            number: 2,
            name: EPISODES.e2.name,
          },
          synopsis: EPISODES.e2.synopsis,
          runtimeSec: ep2.durationSec,
          still: stillImageSet(ep2, "#2b1240"),
        },
        display: {
          ...seriesDisplay,
          episode: { id: EPISODES.e1.id, seasonNumber: 1, number: 1, name: EPISODES.e1.name },
        },
      };
    case "last-episode":
      return {
        ...baseSession(ep2, token, `ps-last${suffix}`),
        titleId: "kestrel-bay",
        episodeId: EPISODES.e2.id,
        nextEpisode: null,
        autoplayNextEpisode: options.autoplayNext ?? true,
        display: {
          ...seriesDisplay,
          episode: { id: EPISODES.e2.id, seasonNumber: 1, number: 2, name: EPISODES.e2.name },
        },
      };
    case "movie":
      return {
        ...baseSession(ep2, token, `ps-movie${suffix}`),
        titleId: "the-ledger",
        episodeId: null,
        nextEpisode: null,
        display: {
          titleName: "The Ledger",
          titleType: "movie",
          episode: null,
          maturity: "13+",
          maturityDescriptors: ["peril"],
          logo: null,
        },
      };
    case "external":
      return {
        id: `ps-external${suffix}`,
        titleId: "external",
        episodeId: null,
        manifestUrl: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        durationSec: 596,
        resumePositionSec: 0,
        textTracks: [],
        trickPlay: null,
        markers: { intro: null, recap: null, creditsStartSec: null },
        nextEpisode: null,
        heartbeatIntervalSec: 30,
        maxVideoHeight: 1080,
        autoplayNextEpisode: false,
        display: {
          titleName: "Big Buck Bunny (external test stream)",
          titleType: "movie",
          episode: null,
          maturity: "ALL",
          maturityDescriptors: [],
          logo: null,
        },
      };
  }
}

/** The session for an episode id (what the host does on next / select episode). */
export function sessionForEpisode(
  episodeId: string,
  assets: readonly TestAsset[],
  options: ScenarioOptions = {},
): PlaybackSession | null {
  if (episodeId === EPISODES.e1.id) return buildSession("episode", assets, options);
  if (episodeId === EPISODES.e2.id) return buildSession("last-episode", assets, options);
  return null;
}

const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

/** Episodes panel feed: season 1 is real, season 2 is slow, season 3 fails once then loads. */
export function episodesSource(assets: readonly TestAsset[]): EpisodesSource {
  const [ep1, ep2] = assets;
  let season3Attempts = 0;
  const upcoming = (
    season: number,
    number: number,
    name: string,
    synopsis: string,
  ): EpisodeSummary => ({
    id: `kestrel-s${season}e${number}`,
    seasonNumber: season,
    number,
    name,
    synopsis,
    runtimeSec: 2700 + number * 60,
    still: null,
    isPlayable: false,
    progress: null,
  });
  return {
    seasons: [
      { number: 1, name: "Season 1", episodeCount: 4 },
      { number: 2, name: "Season 2", episodeCount: 3 },
      { number: 3, name: "Season 3", episodeCount: 2 },
    ],
    async loadEpisodes(season, signal) {
      if (season === 1) {
        await delay(250, signal);
        return [
          {
            ...EPISODES.e1,
            runtimeSec: ep1?.durationSec ?? 150,
            still: ep1 ? stillImageSet(ep1, "#1b2a55") : null,
            isPlayable: true,
            progress: {
              positionSec: 64,
              durationSec: 150,
              completed: false,
              updatedAt: new Date().toISOString(),
            },
          },
          {
            ...EPISODES.e2,
            runtimeSec: ep2?.durationSec ?? 90,
            still: ep2 ? stillImageSet(ep2, "#2b1240") : null,
            isPlayable: true,
            progress: null,
          },
          upcoming(
            1,
            3,
            "Low Water",
            "The tide goes out further than anyone has seen. Something is left on the sand.",
          ),
          upcoming(1, 4, "Gulls", "A storm closes the bay road and the town turns on itself."),
        ];
      }
      if (season === 2) {
        await delay(1200, signal);
        return [
          upcoming(2, 1, "Return", "A year later, the harbour lights come back on by themselves."),
          upcoming(2, 2, "Salt", "Mara takes the ledger to the one person who can read it."),
          upcoming(2, 3, "Undertow", "Everything the bay took, it gives back at once."),
        ];
      }
      await delay(600, signal);
      season3Attempts += 1;
      if (season3Attempts === 1) throw new Error("Simulated network failure");
      return [
        upcoming(3, 1, "Lighthouse", "The last keeper's log has one entry too many."),
        upcoming(3, 2, "Kestrel", "The final season begins where the first one ended."),
      ];
    },
  };
}
