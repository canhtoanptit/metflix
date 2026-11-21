/**
 * Photo curation (a development tool; the build only reads the resulting lock file).
 *
 * - `photos auto [titleId…]`: for titles in `sources/photo-queries.json` without photos yet,
 *   search Wikimedia Commons (quality images first) and pin the best-ranked acceptable result
 *   as key art, plus a few related photos for series' episode stills.
 * - `photos search "<query>"`: a numbered candidate sheet to eyeball (`.cache/media/curation`).
 * - `photos pick <photoId> "<query>" <n>`: pin candidate n of a search under `photoId`.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { MEDIA_ROOT, TOOL_ROOT } from "../paths.ts";
import { ensureDir, writeJson } from "../util/fs.ts";
import { sha256 } from "../util/hash.ts";
import { log } from "../util/log.ts";
import { downloadFile, fetchJson } from "../util/net.ts";
import {
  type PhotoCandidate,
  type PhotoRecord,
  readPhotoLibrary,
  resolveNasaUrl,
  searchCommons,
  searchNasa,
  writePhotoLibrary,
} from "./photos.ts";

interface QueryPlan {
  /** Searched in order until a key photo is found. */
  key: string[];
  /** Extra searches for series episode stills. */
  stills?: string[];
  /** How many still photos to pin (series only). */
  stillCount?: number;
}

const QUERIES_FILE = join(TOOL_ROOT, "sources", "photo-queries.json");
const CURATION_DIR = join(MEDIA_ROOT, "curation");
const QUALITY = "incategory:Quality_images";

async function readQueries(): Promise<Record<string, QueryPlan>> {
  return JSON.parse(await readFile(QUERIES_FILE, "utf8")) as Record<string, QueryPlan>;
}

/** Cache searches so re-running curation never repeats a request. */
async function cachedSearch(query: string): Promise<PhotoCandidate[]> {
  const file = join(CURATION_DIR, "searches", `${encodeURIComponent(query).slice(0, 180)}.json`);
  try {
    return JSON.parse(await readFile(file, "utf8")) as PhotoCandidate[];
  } catch {
    const results = query.startsWith("nasa:")
      ? await searchNasa(query.slice("nasa:".length).trim())
      : await searchCommons(query);
    await writeJson(file, results);
    return results;
  }
}

const baseId = (titleId: string) => titleId.replace(/^t-/, "");

function acceptable(candidate: PhotoCandidate, minWidth: number, used: Set<string>): boolean {
  const aspect = candidate.width / candidate.height;
  return candidate.width >= minWidth && aspect >= 1.2 && aspect <= 2.6 && !used.has(candidate.file);
}

function toRecord(candidate: PhotoCandidate, id: string): PhotoRecord {
  const { thumbUrl: _thumb, rank: _rank, ...record } = candidate;
  return { ...record, id };
}

export async function autoPick(onlyTitles: readonly string[] = []): Promise<number> {
  const queries = await readQueries();
  const library = await readPhotoLibrary();
  const used = new Set(library.map((record) => record.file));
  const have = new Set(library.map((record) => record.id));
  let added = 0;
  for (const [titleId, plan] of Object.entries(queries)) {
    if (onlyTitles.length > 0 && !onlyTitles.includes(titleId)) continue;
    const base = baseId(titleId);
    const pool: PhotoCandidate[] = [];
    if (!have.has(`${base}-1`)) {
      let key: PhotoCandidate | undefined;
      for (const query of plan.key) {
        for (const [q, minWidth] of [
          [`${query} ${QUALITY}`, 3000],
          [query, 2400],
        ] as const) {
          const results = await cachedSearch(q);
          pool.push(...results);
          key = results.find((candidate) => acceptable(candidate, minWidth, used));
          if (key) break;
        }
        if (key) break;
      }
      if (!key) {
        log.warn(`${titleId}: no acceptable key photo (procedural art will be used)`);
        continue;
      }
      library.push(toRecord(key, `${base}-1`));
      used.add(key.file);
      added += 1;
    }
    const stillCount = plan.stillCount ?? 0;
    for (const query of plan.stills ?? []) {
      pool.push(...(await cachedSearch(`${query} ${QUALITY}`)));
    }
    for (let n = 2; n <= stillCount + 1; n += 1) {
      if (have.has(`${base}-${n}`)) continue;
      const still = pool.find((candidate) => acceptable(candidate, 1600, used));
      if (!still) break;
      library.push(toRecord(still, `${base}-${n}`));
      used.add(still.file);
      added += 1;
    }
    await writePhotoLibrary(library);
  }
  log.info(`photo library: ${library.length} photos (${added} added)`);
  return 0;
}

/** A numbered contact sheet of candidates for one query. */
export async function searchSheet(query: string): Promise<number> {
  const results = await cachedSearch(query);
  const cellWidth = 480;
  const cellHeight = 320;
  const columns = 4;
  const shown = results.slice(0, 20);
  const rows = Math.ceil(shown.length / columns);
  const tiles = await Promise.all(
    shown.map(async (candidate, index) => {
      const thumb = join(CURATION_DIR, "thumbs", `${sha256(candidate.thumbUrl).slice(0, 16)}.jpg`);
      await downloadFile(candidate.thumbUrl, thumb);
      const image = await sharp(thumb)
        .resize(cellWidth, cellHeight - 40, { fit: "contain", background: "#111" })
        .toBuffer();
      const label = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellWidth}" height="40"><rect width="100%" height="100%" fill="#111"/><text x="8" y="27" font-family="Helvetica" font-size="20" fill="#eee">${index}: ${candidate.width}×${candidate.height} · ${candidate.license}</text></svg>`;
      return [
        {
          input: image,
          left: (index % columns) * cellWidth,
          top: Math.floor(index / columns) * cellHeight,
        },
        {
          input: Buffer.from(label),
          left: (index % columns) * cellWidth,
          top: Math.floor(index / columns) * cellHeight + cellHeight - 40,
        },
      ];
    }),
  );
  const target = join(
    await ensureDir(CURATION_DIR),
    `${encodeURIComponent(query).slice(0, 80)}.jpg`,
  );
  await sharp({
    create: {
      width: cellWidth * columns,
      height: cellHeight * Math.max(1, rows),
      channels: 3,
      background: "#000",
    },
  })
    .composite(tiles.flat())
    .jpeg({ quality: 80 })
    .toFile(target);
  console.log(target);
  return 0;
}

export async function pick(photoId: string, query: string, index: number): Promise<number> {
  const results = await cachedSearch(query);
  const candidate = results[index];
  if (!candidate) throw new Error(`No candidate ${index} for "${query}"`);
  const library = (await readPhotoLibrary()).filter((record) => record.id !== photoId);
  const record = toRecord(candidate, photoId);
  if (record.url?.includes("images-assets.nasa.gov"))
    record.url = await resolveNasaUrl(record.file);
  library.push(record);
  await writePhotoLibrary(library);
  log.info(`pinned ${photoId}: ${candidate.file} (${candidate.license}, ${candidate.author})`);
  return 0;
}

/** Re-check a pinned photo's licence on Commons (used by tests and audits). */
export async function fetchLicense(file: string): Promise<string | null> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    titles: `File:${file}`,
    prop: "imageinfo",
    iiprop: "extmetadata",
    iiextmetadatafilter: "LicenseShortName",
  });
  const data = await fetchJson<{
    query?: {
      pages?: { imageinfo?: { extmetadata?: { LicenseShortName?: { value: string } } }[] }[];
    };
  }>(`https://commons.wikimedia.org/w/api.php?${params}`);
  return data.query?.pages?.[0]?.imageinfo?.[0]?.extmetadata?.LicenseShortName?.value ?? null;
}
