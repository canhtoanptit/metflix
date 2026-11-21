/** Just enough HLS playlist parsing to walk master → variant → segment like a player does. */

export interface Variant {
  uri: string;
  bandwidth: number | null;
  width: number | null;
  height: number | null;
  attributes: Record<string, string>;
}

export interface MasterPlaylist {
  variants: Variant[];
  /** URIs of EXT-X-MEDIA renditions (audio, subtitles). */
  media: { type: string; uri: string; language: string | null }[];
  iFrameVariants: Variant[];
}

export interface MediaPlaylist {
  segments: { uri: string; durationSec: number }[];
  /** EXT-X-MAP init segment (fMP4/CMAF). */
  map: string | null;
  targetDurationSec: number | null;
  endList: boolean;
}

/** Parse an attribute list: `A=1,B="x,y",C=0x1F`. */
export function parseAttributes(list: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  for (const match of list.matchAll(pattern)) {
    const [, key, raw] = match;
    if (key === undefined || raw === undefined) continue;
    out[key] = raw.startsWith('"') ? raw.slice(1, -1) : raw;
  }
  return out;
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function variantOf(attributes: Record<string, string>, uri: string): Variant {
  const resolution = /^(\d+)x(\d+)$/.exec(attributes.RESOLUTION ?? "");
  const bandwidth = Number(attributes.BANDWIDTH);
  return {
    uri,
    bandwidth: Number.isFinite(bandwidth) ? bandwidth : null,
    width: resolution ? Number(resolution[1]) : null,
    height: resolution ? Number(resolution[2]) : null,
    attributes,
  };
}

export function isPlaylist(text: string): boolean {
  return text.trimStart().startsWith("#EXTM3U");
}

export function parseMaster(text: string): MasterPlaylist {
  const all = lines(text);
  const variants: Variant[] = [];
  const iFrameVariants: Variant[] = [];
  const media: MasterPlaylist["media"] = [];
  for (let index = 0; index < all.length; index += 1) {
    const line = all[index] ?? "";
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attributes = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
      const uri = all[index + 1];
      if (uri && !uri.startsWith("#")) {
        variants.push(variantOf(attributes, uri));
        index += 1;
      }
    } else if (line.startsWith("#EXT-X-I-FRAME-STREAM-INF:")) {
      const attributes = parseAttributes(line.slice("#EXT-X-I-FRAME-STREAM-INF:".length));
      if (attributes.URI) iFrameVariants.push(variantOf(attributes, attributes.URI));
    } else if (line.startsWith("#EXT-X-MEDIA:")) {
      const attributes = parseAttributes(line.slice("#EXT-X-MEDIA:".length));
      if (attributes.URI) {
        media.push({
          type: attributes.TYPE ?? "",
          uri: attributes.URI,
          language: attributes.LANGUAGE ?? null,
        });
      }
    }
  }
  return { variants, media, iFrameVariants };
}

export function parseMediaPlaylist(text: string): MediaPlaylist {
  const all = lines(text);
  const segments: MediaPlaylist["segments"] = [];
  let map: string | null = null;
  let targetDurationSec: number | null = null;
  let pending: number | null = null;
  let endList = false;
  for (const line of all) {
    if (line.startsWith("#EXTINF:")) {
      pending = Number.parseFloat(line.slice("#EXTINF:".length));
    } else if (line.startsWith("#EXT-X-MAP:")) {
      map = parseAttributes(line.slice("#EXT-X-MAP:".length)).URI ?? null;
    } else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDurationSec = Number(line.slice("#EXT-X-TARGETDURATION:".length));
    } else if (line === "#EXT-X-ENDLIST") {
      endList = true;
    } else if (!line.startsWith("#") && pending !== null) {
      segments.push({ uri: line, durationSec: pending });
      pending = null;
    }
  }
  return { segments, map, targetDurationSec, endList };
}

/** Resolve a playlist-relative URI the way a player does (relative to the playlist URL). */
export function resolveUri(playlistUrl: string, uri: string): string {
  const resolved = new URL(uri, new URL(playlistUrl, "http://placeholder.invalid"));
  return resolved.origin === "http://placeholder.invalid"
    ? `${resolved.pathname}${resolved.search}`
    : resolved.toString();
}
