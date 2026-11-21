/**
 * HLS master playlist. ffmpeg writes the media playlists (fMP4/CMAF segments); we write the
 * master ourselves so BANDWIDTH reflects measured segment sizes, CODECS is exact, and audio is
 * a demuxed rendition group the player can switch independently. Subtitles are deliberately
 * not in the master: the player attaches them as side-car WebVTT tracks (PlaybackSession).
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface MediaPlaylistStats {
  durationSec: number;
  /** Peak bits per second over any single segment (init segment excluded). */
  peakBps: number;
  averageBps: number;
  bytes: number;
  segments: number;
}

/** Measure a media playlist from the segment files it lists. */
export async function measurePlaylist(playlistPath: string): Promise<MediaPlaylistStats> {
  const text = await readFile(playlistPath, "utf8");
  const dir = dirname(playlistPath);
  let pendingDuration: number | null = null;
  let durationSec = 0;
  let peakBps = 0;
  let bytes = 0;
  let segments = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#EXTINF:")) {
      pendingDuration = Number.parseFloat(trimmed.slice("#EXTINF:".length));
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("#") || pendingDuration === null) continue;
    const size = (await stat(join(dir, trimmed))).size;
    bytes += size;
    durationSec += pendingDuration;
    segments += 1;
    // Very short tail segments overstate the peak; measure them over at least one second.
    peakBps = Math.max(peakBps, (size * 8) / Math.max(pendingDuration, 1));
    pendingDuration = null;
  }
  return {
    durationSec,
    peakBps: Math.ceil(peakBps),
    averageBps: durationSec > 0 ? Math.ceil((bytes * 8) / durationSec) : 0,
    bytes,
    segments,
  };
}

export interface MasterVariant {
  uri: string;
  width: number;
  height: number;
  frameRate: number;
  videoCodec: string;
  stats: MediaPlaylistStats;
}

export interface MasterAudio {
  uri: string;
  language: string;
  name: string;
  codec: string;
  channels: number;
  stats: MediaPlaylistStats;
}

/**
 * Master playlist. With `audio`, renditions are video-only and reference the audio group;
 * without it each variant is muxed (preview-only assets).
 */
export function buildMasterPlaylist(
  variants: readonly MasterVariant[],
  audio: MasterAudio | null,
  muxedAudioCodec: string | null,
): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS", ""];
  if (audio) {
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="${audio.name}",LANGUAGE="${audio.language}",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="${audio.channels}",URI="${audio.uri}"`,
      "",
    );
  }
  const sorted = [...variants].sort((a, b) => b.stats.peakBps - a.stats.peakBps);
  for (const variant of sorted) {
    const audioPeak = audio?.stats.peakBps ?? 0;
    const audioAverage = audio?.stats.averageBps ?? 0;
    const codecs = [variant.videoCodec, audio?.codec ?? muxedAudioCodec].filter(Boolean).join(",");
    const attributes = [
      `BANDWIDTH=${variant.stats.peakBps + audioPeak}`,
      `AVERAGE-BANDWIDTH=${variant.stats.averageBps + audioAverage}`,
      `CODECS="${codecs}"`,
      `RESOLUTION=${variant.width}x${variant.height}`,
      `FRAME-RATE=${variant.frameRate.toFixed(3)}`,
      ...(audio ? [`AUDIO="aac"`] : []),
    ];
    lines.push(`#EXT-X-STREAM-INF:${attributes.join(",")}`, variant.uri);
  }
  return `${lines.join("\n")}\n`;
}
