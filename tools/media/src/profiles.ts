import type { MediaProfile } from "@webflix/contracts";

/**
 * One rung of the ABR ladder. Widths are fixed and heights follow the source's aspect ratio
 * (the open films are mostly 2.39:1), so `id` names the 16:9-equivalent class.
 */
export interface Rung {
  id: string;
  width: number;
  /** Peak video bitrate (x264 VBV maxrate), kbit/s. */
  maxrateKbps: number;
  crf: number;
  /** H.264 level, e.g. 4.0 → CODECS avc1.640028. */
  level: string;
}

export interface ProfileConfig {
  ladder: readonly Rung[];
  /** Ladder for feature cuts (what fictional movies play) when it differs from `ladder`. */
  featureLadder?: readonly Rung[];
  /** x264 preset: speed/size trade-off. */
  preset: string;
  segmentSec: number;
  audioKbps: number;
  /**
   * Longest clip packaged per asset role (seconds); `null` keeps the whole window. `film` is a
   * complete open film (its own title), `feature` a text-free cut fictional movies play.
   */
  maxSec: { film: number | null; feature: number | null; episode: number | null; preview: number };
  preview: { width: number; height: number; maxrateKbps: number; crf: number; audioKbps: number };
  trickPlay: { tileWidth: number; columns: number; rows: number };
  /** Concurrent ffmpeg containers. Each one is multi-threaded already. */
  jobs: number;
}

export const PROFILES: Record<MediaProfile, ProfileConfig> = {
  // Minutes on a laptop: short clips, a three-rung ladder. Only the ten feature cuts (what
  // every fictional movie plays) are longer and carry a 1080p rung, so Continue Watching,
  // viewing history and the Basic plan's 720p cap can all be exercised on fast media.
  fast: {
    ladder: [
      { id: "720p", width: 1280, maxrateKbps: 2800, crf: 23, level: "3.1" },
      { id: "480p", width: 854, maxrateKbps: 1200, crf: 24, level: "3.0" },
      { id: "270p", width: 480, maxrateKbps: 450, crf: 26, level: "3.0" },
    ],
    featureLadder: [
      { id: "1080p", width: 1920, maxrateKbps: 4000, crf: 24, level: "4.0" },
      { id: "720p", width: 1280, maxrateKbps: 2800, crf: 23, level: "3.1" },
      { id: "480p", width: 854, maxrateKbps: 1200, crf: 24, level: "3.0" },
      { id: "270p", width: 480, maxrateKbps: 450, crf: 26, level: "3.0" },
    ],
    preset: "veryfast",
    segmentSec: 4,
    audioKbps: 128,
    maxSec: { film: 150, feature: 210, episode: 75, preview: 24 },
    preview: { width: 960, height: 540, maxrateKbps: 1800, crf: 25, audioKbps: 96 },
    trickPlay: { tileWidth: 240, columns: 10, rows: 10 },
    jobs: 4,
  },
  // Complete films with a full ladder.
  full: {
    ladder: [
      { id: "1080p", width: 1920, maxrateKbps: 5500, crf: 21, level: "4.0" },
      { id: "720p", width: 1280, maxrateKbps: 3000, crf: 22, level: "3.1" },
      { id: "540p", width: 960, maxrateKbps: 1700, crf: 23, level: "3.1" },
      { id: "360p", width: 640, maxrateKbps: 800, crf: 24, level: "3.0" },
      { id: "240p", width: 426, maxrateKbps: 400, crf: 26, level: "3.0" },
    ],
    preset: "faster",
    segmentSec: 4,
    audioKbps: 160,
    maxSec: { film: null, feature: null, episode: null, preview: 30 },
    preview: { width: 1280, height: 720, maxrateKbps: 2600, crf: 23, audioKbps: 128 },
    trickPlay: { tileWidth: 320, columns: 10, rows: 10 },
    jobs: 3,
  },
};

/** `avc1.PPCCLL` for High profile at `level`. */
export function avcCodecString(level: string): string {
  const levelIdc = Math.round(Number(level) * 10);
  return `avc1.6400${levelIdc.toString(16).padStart(2, "0")}`;
}

export const AAC_LC = "mp4a.40.2";
