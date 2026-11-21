/**
 * The photo library: every photograph used in artwork, pinned in `sources/photos.json` with
 * its author and licence (and listed in docs/CREDITS.md). Photos come from Wikimedia Commons
 * and are limited to public domain, CC0, CC BY and CC BY-SA. Downloads are cached under
 * `.cache/media/downloads/photos`; when one cannot be fetched the renderer falls back to
 * procedural art, so the pipeline still completes offline.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DOWNLOADS_DIR, TOOL_ROOT } from "../paths.ts";
import { exists, readJson, writeJson } from "../util/fs.ts";
import { log } from "../util/log.ts";
import { downloadFile, fetchJson, isOffline } from "../util/net.ts";

export const PHOTOS_FILE = join(TOOL_ROOT, "sources", "photos.json");

export interface PhotoRecord {
  /** Stable id referenced from art direction, e.g. `saltmarsh-1`. */
  id: string;
  /** Commons file name without the `File:` prefix. */
  file: string;
  /** Description page (attribution link). */
  page: string;
  width: number;
  height: number;
  author: string;
  /** SPDX-like: CC0-1.0, Public-Domain, CC-BY-4.0, CC-BY-SA-3.0… */
  license: string;
  licenseUrl: string;
  /** What the photo shows (Commons object name), for credits. */
  caption: string;
  /** Direct image URL for providers other than Commons (NASA's image library). */
  url?: string;
}

export async function readPhotoLibrary(): Promise<PhotoRecord[]> {
  try {
    return JSON.parse(await readFile(PHOTOS_FILE, "utf8")) as PhotoRecord[];
  } catch {
    return [];
  }
}

export async function writePhotoLibrary(records: readonly PhotoRecord[]): Promise<void> {
  await writeJson(
    PHOTOS_FILE,
    [...records].sort((a, b) => a.id.localeCompare(b.id)),
  );
}

/** Wikimedia only serves thumbnails at standard widths; 1920 and 3840 are among them. */
function downloadUrl(record: PhotoRecord, maxWidth: number): { url: string; width: number } {
  if (record.url) return { url: record.url, width: record.width };
  const name = record.file.replaceAll(" ", "_");
  const md5 = md5Hex(name);
  const path = `${md5.slice(0, 1)}/${md5.slice(0, 2)}/${encodeURIComponent(name)}`;
  if (record.width > maxWidth) {
    // TIFFs are thumbnailed as JPEG (`…tif.jpg`); PNG and JPEG keep their name.
    const thumbName = /\.tiff?$/i.test(name)
      ? `${encodeURIComponent(name)}.jpg`
      : encodeURIComponent(name);
    return {
      url: `https://upload.wikimedia.org/wikipedia/commons/thumb/${path}/${maxWidth}px-${thumbName}`,
      width: maxWidth,
    };
  }
  return { url: `https://upload.wikimedia.org/wikipedia/commons/${path}`, width: record.width };
}

function md5Hex(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

/** Photos are fetched at Wikimedia's standard 1920 px thumbnail size (usually cached). */
/**
 * Photos are fetched at Wikimedia's standard thumbnail sizes (usually cached): 1920 px for key
 * art (backdrops are 1920 wide), 960 px for episode-still sources (stills are 960 wide).
 */
export const PHOTO_WIDTHS = { key: 1920, still: 960 } as const;
export type PhotoRole = keyof typeof PHOTO_WIDTHS;

function photoPath(record: PhotoRecord, width: number): string {
  const extension = /\.png$/i.test(record.file) ? "png" : "jpg";
  return join(DOWNLOADS_DIR, "photos", `${record.id}-${width}.${extension}`);
}

/** The cached copy of a photo (from its currently pinned source), or null. */
export async function cachedPhoto(
  record: PhotoRecord,
  role: PhotoRole = "key",
): Promise<string | null> {
  // A larger copy serves a smaller role too.
  const widths = role === "key" ? [PHOTO_WIDTHS.key] : [PHOTO_WIDTHS.key, PHOTO_WIDTHS.still];
  for (const width of widths) {
    const path = photoPath(record, width);
    const download = await readJson<{ url: string }>(`${path}.download.json`);
    if (download?.url === downloadUrl(record, width).url && (await exists(path))) return path;
  }
  return null;
}

/**
 * Fetch photos one at a time, politely, until `budgetMs` runs out. Wikimedia throttles bulk
 * thumbnail traffic, so a first build may not get every photo: titles without theirs render
 * with procedural art and are re-rendered by a later run once the photo is cached.
 */
export async function fetchPhotos(
  requests: readonly { record: PhotoRecord; role: PhotoRole }[],
  budgetMs: number,
): Promise<{ fetched: number; cached: number; pending: string[] }> {
  const deadline = Date.now() + budgetMs;
  let fetched = 0;
  let cached = 0;
  const pending: string[] = [];
  // CDN-hosted photos (NASA) first: they are never throttled, Wikimedia's often are.
  const ordered = [
    ...requests.filter(({ record }) => record.url),
    ...requests.filter(({ record }) => !record.url),
  ];
  for (const { record, role } of ordered) {
    if (await cachedPhoto(record, role)) {
      cached += 1;
      continue;
    }
    if (Date.now() > deadline || isOffline()) {
      pending.push(record.id);
      continue;
    }
    const width = PHOTO_WIDTHS[role];
    try {
      await downloadFile(downloadUrl(record, width).url, photoPath(record, width), null, {
        attempts: 4,
        parallel: false,
      });
      fetched += 1;
      if (fetched % 20 === 0) log.info(`photos: ${fetched} fetched`);
    } catch (error) {
      log.warn(`photo ${record.id} not fetched: ${(error as Error).message}`);
      pending.push(record.id);
    }
  }
  return { fetched, cached, pending };
}

// --- Commons search (curation) ------------------------------------------------------------

interface CommonsPage {
  title: string;
  index: number;
  imageinfo?: {
    url: string;
    descriptionurl: string;
    thumburl?: string;
    width: number;
    height: number;
    mime: string;
    extmetadata?: Record<string, { value: string } | undefined>;
  }[];
}

export interface PhotoCandidate extends PhotoRecord {
  thumbUrl: string;
  rank: number;
}

const stripHtml = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Normalise a Commons licence name; null for anything we do not accept. */
export function normaliseLicense(
  shortName: string,
): { license: string; licenseUrl: string } | null {
  const name = shortName.trim();
  if (/^CC0/i.test(name)) {
    return { license: "CC0-1.0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/" };
  }
  if (/^public domain/i.test(name) || /^PD\b/i.test(name)) {
    return {
      license: "Public-Domain",
      licenseUrl: "https://creativecommons.org/publicdomain/mark/1.0/",
    };
  }
  const by = /^CC BY (\d\.\d)$/i.exec(name);
  if (by) {
    return {
      license: `CC-BY-${by[1]}`,
      licenseUrl: `https://creativecommons.org/licenses/by/${by[1]}/`,
    };
  }
  const bySa = /^CC BY-SA (\d\.\d)$/i.exec(name);
  if (bySa) {
    return {
      license: `CC-BY-SA-${bySa[1]}`,
      licenseUrl: `https://creativecommons.org/licenses/by-sa/${bySa[1]}/`,
    };
  }
  return null;
}

interface NasaItem {
  href: string;
  data?: {
    nasa_id: string;
    title: string;
    center?: string;
    photographer?: string;
    secondary_creator?: string;
  }[];
  links?: { href: string; render?: string }[];
}

/**
 * Search NASA's image library (public domain under NASA's media guidelines; served from a
 * CDN that tolerates bulk downloads). Used for the space titles.
 */
export async function searchNasa(query: string, limit = 24): Promise<PhotoCandidate[]> {
  const params = new URLSearchParams({ q: query, media_type: "image", page_size: String(limit) });
  const data = await fetchJson<{ collection?: { items?: NasaItem[] } }>(
    `https://images-api.nasa.gov/search?${params}`,
  );
  const out: PhotoCandidate[] = [];
  for (const [rank, item] of (data.collection?.items ?? []).entries()) {
    const meta = item.data?.[0];
    const thumb = item.links?.find((link) => link.render === "image")?.href;
    if (!meta || !thumb) continue;
    out.push({
      id: "",
      file: meta.nasa_id,
      page: `https://images.nasa.gov/details/${encodeURIComponent(meta.nasa_id)}`,
      width: 1920,
      height: 1080,
      author: (
        meta.photographer ??
        meta.secondary_creator ??
        `NASA${meta.center ? ` ${meta.center}` : ""}`
      ).slice(0, 120),
      license: "Public-Domain",
      licenseUrl: "https://www.nasa.gov/nasa-brand-center/images-and-media/",
      caption: meta.title.slice(0, 140),
      url: `https://images-assets.nasa.gov/image/${encodeURIComponent(meta.nasa_id)}/${encodeURIComponent(meta.nasa_id)}~large.jpg`,
      thumbUrl: thumb,
      rank,
    });
  }
  return out;
}

/**
 * The best published rendition of a NASA asset: `~large` when it exists (about 1920 px),
 * otherwise the original. Read from the asset's own file list.
 */
export async function resolveNasaUrl(nasaId: string): Promise<string> {
  const files = await fetchJson<string[]>(
    `https://images-assets.nasa.gov/image/${encodeURIComponent(nasaId)}/collection.json`,
  );
  const pick = (suffix: string) => files.find((file) => file.endsWith(suffix));
  const url = pick("~large.jpg") ?? pick("~orig.jpg") ?? pick("~medium.jpg");
  if (!url) throw new Error(`No image rendition for NASA asset ${nasaId}`);
  return url.replace(/^http:/, "https:");
}

/** Search Commons bitmaps; returns acceptable-licence candidates in search-rank order. */
export async function searchCommons(query: string, limit = 40): Promise<PhotoCandidate[]> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "search",
    gsrnamespace: "6",
    gsrlimit: String(limit),
    gsrsearch: `${query} filetype:bitmap`,
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiurlwidth: "500",
    iiextmetadatafilter: "LicenseShortName|Artist|ObjectName",
  });
  const data = await fetchJson<{ query?: { pages?: CommonsPage[] } }>(
    `https://commons.wikimedia.org/w/api.php?${params}`,
  );
  const out: PhotoCandidate[] = [];
  for (const page of data.query?.pages ?? []) {
    const info = page.imageinfo?.[0];
    if (!info || !/^image\/(jpeg|png|tiff)$/.test(info.mime)) continue;
    const meta = info.extmetadata ?? {};
    const license = normaliseLicense(stripHtml(meta.LicenseShortName?.value ?? ""));
    if (!license) continue;
    const file = page.title.replace(/^File:/, "");
    out.push({
      id: "",
      file,
      page: info.descriptionurl,
      width: info.width,
      height: info.height,
      author: stripHtml(meta.Artist?.value ?? "Unknown author").slice(0, 120) || "Unknown author",
      ...license,
      caption: stripHtml(meta.ObjectName?.value ?? file.replace(/\.[a-z]+$/i, "")).slice(0, 140),
      thumbUrl: info.thumburl ?? info.url,
      rank: page.index,
    });
  }
  return out.sort((a, b) => a.rank - b.rank);
}
