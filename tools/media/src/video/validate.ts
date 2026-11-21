/**
 * Timing checks on packaged media, run after every asset is packaged and by
 * `validate-manifest`: in every rendition the first presented video frame is at 0, audio starts
 * with it (within one AAC frame), and the segment durations add up to the asset's duration.
 * The progressive preview MP4 is held to the same start rules.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PackagedVideoAsset } from "@webflix/contracts";
import { fragmentStarts, progressiveStarts, type TrackStart } from "./mp4.ts";

/** One AAC-LC frame at 48 kHz. */
export const AUDIO_FRAME_SEC = 1024 / 48000;
/** First presented video frame must be this close to 0. */
export const START_TOLERANCE_SEC = 0.001;
/** Segment durations must sum to the asset duration within this. */
export const DURATION_TOLERANCE_SEC = 0.05;

export interface RenditionTiming {
  rendition: string;
  videoStartSec: number | null;
  audioStartSec: number | null;
  durationSec: number;
}

export interface TimingReport {
  renditions: RenditionTiming[];
  preview: { videoStartSec: number | null; audioStartSec: number | null } | null;
  problems: string[];
}

function startOf(starts: readonly TrackStart[], handler: string): number | null {
  return starts.find((start) => start.handler === handler)?.firstPresentationSec ?? null;
}

async function playlistTiming(dir: string): Promise<{ starts: TrackStart[]; durationSec: number }> {
  const playlist = await readFile(join(dir, "index.m3u8"), "utf8");
  const lines = playlist.split("\n");
  const first = lines.find((line) => line && !line.startsWith("#"));
  if (!first) throw new Error(`${dir}/index.m3u8 lists no segments`);
  const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(playlist)?.[1] ?? "init.mp4";
  const durationSec = lines
    .filter((line) => line.startsWith("#EXTINF:"))
    .reduce((total, line) => total + Number(line.slice(8).split(",")[0]), 0);
  const starts = fragmentStarts(await readFile(join(dir, init)), await readFile(join(dir, first)));
  return { starts, durationSec };
}

/** Check one packaged asset laid out under `root` (`vod/…`, `public/previews/…`). */
export async function checkTiming(root: string, asset: PackagedVideoAsset): Promise<TimingReport> {
  const problems: string[] = [];
  const renditions: RenditionTiming[] = [];
  const prefix = (key: string) => join(root, key.slice(0, key.lastIndexOf("/")));
  const dirs = [
    ...asset.renditions.map((rendition) => ({ id: rendition.id, dir: prefix(rendition.playlist) })),
    ...asset.audio.map((audio) => ({ id: audio.id, dir: prefix(audio.playlist) })),
  ];
  let videoStart: number | null = null;
  for (const { id, dir } of dirs) {
    const { starts, durationSec } = await playlistTiming(dir);
    const video = startOf(starts, "vide");
    const audio = startOf(starts, "soun");
    renditions.push({ rendition: id, videoStartSec: video, audioStartSec: audio, durationSec });
    if (video !== null) {
      videoStart ??= video;
      if (Math.abs(video) > START_TOLERANCE_SEC)
        problems.push(`${asset.assetId}/${id}: first video frame at ${video.toFixed(4)} s, not 0`);
    }
    if (audio !== null && Math.abs(audio - (video ?? videoStart ?? 0)) > AUDIO_FRAME_SEC)
      problems.push(
        `${asset.assetId}/${id}: audio starts at ${audio.toFixed(4)} s, more than one AAC frame from video`,
      );
    if (Math.abs(durationSec - asset.durationSec) > DURATION_TOLERANCE_SEC)
      problems.push(
        `${asset.assetId}/${id}: segments add up to ${durationSec.toFixed(3)} s, asset is ${asset.durationSec} s`,
      );
  }
  let preview: TimingReport["preview"] = null;
  if (asset.preview) {
    const starts = progressiveStarts(await readFile(join(root, asset.preview.key)));
    const video = startOf(starts, "vide");
    const audio = startOf(starts, "soun");
    preview = { videoStartSec: video, audioStartSec: audio };
    if (video !== null && Math.abs(video) > START_TOLERANCE_SEC)
      problems.push(`${asset.assetId}/preview.mp4: first video frame at ${video.toFixed(4)} s`);
    if (video !== null && audio !== null && Math.abs(audio - video) > AUDIO_FRAME_SEC)
      problems.push(`${asset.assetId}/preview.mp4: audio starts at ${audio.toFixed(4)} s`);
  }
  return { renditions, preview, problems };
}
