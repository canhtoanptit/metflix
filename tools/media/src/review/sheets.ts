/**
 * `webflix-media contact-sheets`: review sheets that show artwork the way the product shows
 * it — browse rows of cards at real size, billboards with the logo over the backdrop, a Top 10
 * row, poster walls, episode lists, logos and avatars — so it can be judged like an art
 * director would, not one file at a time. Plus the footage reviews: previews against their
 * titles, and the boundary frames of every playable asset (where burned-in cards hide).
 */
import { join } from "node:path";
import { CURATED_PREVIEWS, catalog, openFilms } from "@webflix/catalog";
import {
  fillImageTemplate,
  type MediaManifest,
  type MediaProfile,
  type PackagedVideoAsset,
  type TitleSeed,
} from "@webflix/contracts";
import sharp, { type OverlayOptions } from "sharp";
import { containerPath, ffmpeg } from "../docker.ts";
import { MEDIA_ROOT, manifestPath, mediaCacheDir } from "../paths.ts";
import { ensureDir, exists, readJson } from "../util/fs.ts";
import { log } from "../util/log.ts";
import { mapPool } from "../util/pool.ts";

const BG = "#141414";
const esc = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function text(
  x: number,
  y: number,
  value: string,
  size: number,
  options: { weight?: number; color?: string; anchor?: string } = {},
) {
  return `<text x="${x}" y="${y}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${options.weight ?? 400}" fill="${options.color ?? "#e5e5e5"}" text-anchor="${options.anchor ?? "start"}">${esc(value)}</text>`;
}

function wrap(value: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of value.split(" ")) {
    if ((line + word).length > maxChars && line) {
      lines.push(line.trim());
      line = "";
    }
    line += `${word} `;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

/** Wrap and clamp to `maxLines`, ending with an ellipsis like a line-clamped paragraph. */
function clamp(value: string, maxChars: number, maxLines: number): string[] {
  const lines = wrap(value, maxChars);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${(kept[maxLines - 1] ?? "").replace(/[\s,;:—–-]+\S*$/, "")}…`;
  return kept;
}

interface Ctx {
  out: string;
  root: string;
  manifest: MediaManifest;
  titles: Map<string, TitleSeed>;
}

function imagePath(ctx: Ctx, template: string, width: number): string {
  return join(ctx.root, fillImageTemplate(template, width, "webp"));
}

async function card(ctx: Ctx, titleId: string, width: number): Promise<Buffer> {
  const art = ctx.manifest.titleArtwork.find((entry) => entry.titleId === titleId);
  if (!art) throw new Error(`no artwork for ${titleId}`);
  const source =
    art.card.widths.find((w) => w >= width) ?? art.card.widths[art.card.widths.length - 1] ?? 320;
  return sharp(imagePath(ctx, art.card.keyTemplate, source))
    .resize(width, Math.round(width / (16 / 9)))
    .png()
    .toBuffer();
}

async function save(
  ctx: Ctx,
  name: string,
  width: number,
  height: number,
  layers: OverlayOptions[],
): Promise<string> {
  const file = join(ctx.out, name);
  await sharp({ create: { width, height, channels: 3, background: BG } })
    .composite(layers)
    .jpeg({ quality: 86 })
    .toFile(file);
  return file;
}

/** Browse rows: six cards per row with a peek, at desktop size (300 px cards). */
async function rows(ctx: Ctx): Promise<string[]> {
  const cardWidth = 300;
  const gap = 8;
  const rowHeight = 169 + 64;
  const files: string[] = [];
  const byGenre = catalog.genres.map((genre) => ({
    genre,
    titles: catalog.titles
      .filter((title) => title.genreIds.includes(genre.id))
      .sort((a, b) => b.popularity - a.popularity)
      .slice(0, 7),
  }));
  for (let sheet = 0; sheet * 4 < byGenre.length; sheet += 1) {
    const layers: OverlayOptions[] = [];
    const group = byGenre.slice(sheet * 4, sheet * 4 + 4);
    const width = 48 + 6.5 * (cardWidth + gap);
    let svg = "";
    for (const [row, { genre, titles }] of group.entries()) {
      const y = 24 + row * rowHeight;
      svg += text(48, y + 26, genre.name, 22, { weight: 700 });
      for (const [index, title] of titles.entries()) {
        const x = 48 + index * (cardWidth + gap);
        const visible = Math.min(cardWidth, Math.max(0, Math.floor(width - x)));
        if (visible <= 0) continue;
        const image = await card(ctx, title.id, cardWidth);
        layers.push({
          input: await sharp(image)
            .extract({ left: 0, top: 0, width: visible, height: 169 })
            .png()
            .toBuffer(),
          left: Math.round(x),
          top: y + 40,
        });
      }
    }
    const height = 24 + group.length * rowHeight + 16;
    layers.unshift({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${height}">${svg}</svg>`,
      ),
      left: 0,
      top: 0,
    });
    files.push(await save(ctx, `rows-${sheet + 1}.jpg`, Math.ceil(width), height, layers));
  }
  return files;
}

/** Billboards: backdrop, the logo at left, synopsis and buttons, 4 per sheet at half size. */
async function billboards(ctx: Ctx, ids: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  const w = 960;
  const h = 540;
  for (let sheet = 0; sheet * 4 < ids.length; sheet += 1) {
    const layers: OverlayOptions[] = [];
    for (const [index, id] of ids.slice(sheet * 4, sheet * 4 + 4).entries()) {
      const art = ctx.manifest.titleArtwork.find((entry) => entry.titleId === id);
      const title = ctx.titles.get(id);
      if (!art || !title) continue;
      const x = (index % 2) * (w + 16) + 16;
      const y = Math.floor(index / 2) * (h + 16) + 16;
      layers.push({
        input: await sharp(imagePath(ctx, art.backdrop.keyTemplate, 1280))
          .resize(w, h)
          .png()
          .toBuffer(),
        left: x,
        top: y,
      });
      const scrim = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="l" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity="0.75"/><stop offset="0.6" stop-color="#000" stop-opacity="0"/></linearGradient><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0.7" stop-color="${BG}" stop-opacity="0"/><stop offset="1" stop-color="${BG}" stop-opacity="1"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#l)"/><rect width="100%" height="100%" fill="url(#b)"/></svg>`;
      layers.push({ input: Buffer.from(scrim), left: x, top: y });
      if (art.logo) {
        const logo = sharp(imagePath(ctx, art.logo.keyTemplate, 640));
        const meta = await logo.metadata();
        const logoWidth = Math.min(
          w * 0.4,
          ((meta.width ?? 640) / (meta.height ?? 200)) * h * 0.24,
        );
        layers.push({
          input: await logo.resize(Math.round(logoWidth)).png().toBuffer(),
          left: x + 40,
          top: y + 140,
        });
      }
      let svg = "";
      clamp(title.synopsis, 62, 3).forEach((line, i) => {
        svg += text(40, 330 + i * 20, line, 15, { color: "#f2f2f2" });
      });
      svg += `<rect x="40" y="410" width="110" height="38" rx="5" fill="#ffffff"/>${text(95, 435, "▶  Play", 17, { weight: 700, color: "#000", anchor: "middle" })}`;
      svg += `<rect x="162" y="410" width="140" height="38" rx="5" fill="#6d6d6e" fill-opacity="0.7"/>${text(232, 435, "ⓘ  More Info", 17, { weight: 700, color: "#fff", anchor: "middle" })}`;
      svg += `<rect x="${w - 64}" y="414" width="64" height="30" fill="#333" fill-opacity="0.6"/><rect x="${w - 64}" y="414" width="3" height="30" fill="#ddd"/>${text(w - 32, 435, title.maturity, 14, { anchor: "middle" })}`;
      layers.push({
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${svg}</svg>`,
        ),
        left: x,
        top: y,
      });
    }
    files.push(await save(ctx, `billboards-${sheet + 1}.jpg`, w * 2 + 48, h * 2 + 48, layers));
  }
  return files;
}

async function posters(ctx: Ctx): Promise<string[]> {
  const files: string[] = [];
  const perSheet = 40;
  const w = 180;
  const h = 270;
  const titles = [...catalog.titles].sort((a, b) => a.name.localeCompare(b.name));
  for (let sheet = 0; sheet * perSheet < titles.length; sheet += 1) {
    const chunk = titles.slice(sheet * perSheet, sheet * perSheet + perSheet);
    const layers: OverlayOptions[] = [];
    for (const [index, title] of chunk.entries()) {
      const art = ctx.manifest.titleArtwork.find((entry) => entry.titleId === title.id);
      if (!art) continue;
      layers.push({
        input: await sharp(imagePath(ctx, art.poster.keyTemplate, 200))
          .resize(w, h)
          .png()
          .toBuffer(),
        left: 16 + (index % 10) * (w + 10),
        top: 16 + Math.floor(index / 10) * (h + 10),
      });
    }
    files.push(
      await save(
        ctx,
        `posters-${sheet + 1}.jpg`,
        16 + 10 * (w + 10),
        16 + Math.ceil(chunk.length / 10) * (h + 10) + 6,
        layers,
      ),
    );
  }
  return files;
}

/** Top 10: oversized outlined rank numerals with posters, as the ranked row draws them. */
async function topTen(ctx: Ctx): Promise<string> {
  const top = [...catalog.titles].sort((a, b) => b.popularity - a.popularity).slice(0, 10);
  const posterW = 150;
  const posterH = 225;
  const slot = 270;
  const layers: OverlayOptions[] = [];
  let svg = text(48, 40, "Top 10 Today", 24, { weight: 700 });
  for (const [index, title] of top.entries()) {
    // "10" is two numerals wide: its slot is pushed right so the "1" is not hidden by #9.
    const x = 48 + index * slot + (index === 9 ? 120 : 0);
    svg += `<text x="${x + 110}" y="${60 + posterH}" font-family="Helvetica Neue, Arial Black, sans-serif" font-weight="900" font-size="250" fill="${BG}" stroke="#595959" stroke-width="5" text-anchor="end" letter-spacing="-20">${index + 1}</text>`;
    const art = ctx.manifest.titleArtwork.find((entry) => entry.titleId === title.id);
    if (art)
      layers.push({
        input: await sharp(imagePath(ctx, art.poster.keyTemplate, 200))
          .resize(posterW, posterH)
          .png()
          .toBuffer(),
        left: x + 110,
        top: 60,
      });
  }
  const width = 48 + 10 * slot + 120;
  layers.unshift({
    input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="320">${svg}</svg>`,
    ),
    left: 0,
    top: 0,
  });
  return save(ctx, "top-10.jpg", width, 320, layers);
}

/** Episode list for a series, as the detail modal shows it. */
async function episodes(ctx: Ctx, titleId: string): Promise<string | null> {
  const title = ctx.titles.get(titleId);
  if (title?.type !== "series") return null;
  const list = title.seasons[0]?.episodes.slice(0, 6) ?? [];
  const layers: OverlayOptions[] = [];
  let svg = text(32, 44, `${title.name} — ${title.seasons[0]?.name ?? "Season 1"}`, 24, {
    weight: 700,
  });
  for (const [index, episode] of list.entries()) {
    const y = 72 + index * 128;
    svg += text(40, y + 60, String(index + 1), 28, { color: "#9a9a9a", anchor: "middle" });
    const still = ctx.manifest.episodeStills.find((entry) => entry.episodeId === episode.id);
    if (still)
      layers.push({
        input: await sharp(imagePath(ctx, still.still.keyTemplate, 320))
          .resize(192, 108)
          .png()
          .toBuffer(),
        left: 72,
        top: y,
      });
    svg += text(284, y + 24, episode.name, 17, { weight: 700 });
    svg += text(880, y + 24, `${Math.round(episode.runtimeSec / 60)}m`, 16, { anchor: "end" });
    clamp(episode.synopsis, 78, 3).forEach((line, i) => {
      svg += text(284, y + 50 + i * 19, line, 14, { color: "#bcbcbc" });
    });
  }
  const height = 72 + list.length * 128;
  layers.unshift({
    input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${height}">${svg}</svg>`,
    ),
    left: 0,
    top: 0,
  });
  return save(ctx, `episodes-${titleId}.jpg`, 900, height, layers);
}

async function logos(ctx: Ctx): Promise<string[]> {
  const files: string[] = [];
  const perSheet = 24;
  const cellW = 400;
  const cellH = 170;
  const titles = [...catalog.titles].sort((a, b) => a.name.localeCompare(b.name));
  for (let sheet = 0; sheet * perSheet < titles.length; sheet += 1) {
    const layers: OverlayOptions[] = [];
    for (const [index, title] of titles
      .slice(sheet * perSheet, sheet * perSheet + perSheet)
      .entries()) {
      const art = ctx.manifest.titleArtwork.find((entry) => entry.titleId === title.id);
      if (!art?.logo) continue;
      const x = 12 + (index % 4) * (cellW + 12);
      const y = 12 + Math.floor(index / 4) * (cellH + 12);
      // Logos sit on a slice of their own backdrop, as on the billboard.
      layers.push({
        input: await sharp(imagePath(ctx, art.backdrop.keyTemplate, 640))
          .resize(cellW, cellH)
          .modulate({ brightness: 0.7 })
          .png()
          .toBuffer(),
        left: x,
        top: y,
      });
      const logo = await sharp(imagePath(ctx, art.logo.keyTemplate, 640))
        .resize(cellW - 40, cellH - 30, { fit: "inside" })
        .png()
        .toBuffer();
      const meta = await sharp(logo).metadata();
      layers.push({
        input: logo,
        left: x + Math.round((cellW - (meta.width ?? 0)) / 2),
        top: y + Math.round((cellH - (meta.height ?? 0)) / 2),
      });
    }
    files.push(
      await save(
        ctx,
        `logos-${sheet + 1}.jpg`,
        12 + 4 * (cellW + 12),
        12 + 6 * (cellH + 12),
        layers,
      ),
    );
  }
  return files;
}

async function avatars(ctx: Ctx): Promise<string> {
  const layers: OverlayOptions[] = [];
  let svg = "";
  for (const [index, avatar] of ctx.manifest.avatars.entries()) {
    const x = 24 + (index % 7) * 150;
    const y = 24 + Math.floor(index / 7) * 170;
    layers.push({
      input: await sharp(join(ctx.root, avatar.key)).resize(128, 128).png().toBuffer(),
      left: x,
      top: y,
    });
    const name =
      catalog.avatars.find((entry) => entry.id === avatar.avatarId)?.name ?? avatar.avatarId;
    svg += text(x + 64, y + 150, name, 14, { anchor: "middle", color: "#bbb" });
  }
  const height = 24 + Math.ceil(ctx.manifest.avatars.length / 7) * 170;
  layers.push({
    input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${24 + 7 * 150}" height="${height}">${svg}</svg>`,
    ),
    left: 0,
    top: 0,
  });
  return save(ctx, "avatars.jpg", 24 + 7 * 150, height, layers);
}

/**
 * Preview review: per title, its card next to three frames of its preview clip (start, middle,
 * end), with genres, the source asset and how the clip was chosen (own film / curated match /
 * motion art from the key art), so a clip that contradicts its title is caught at a glance.
 */
async function previews(ctx: Ctx): Promise<string[]> {
  const assets = new Map(ctx.manifest.videoAssets.map((asset) => [asset.assetId, asset]));
  const genres = new Map(catalog.genres.map((genre) => [genre.id, genre.name]));
  const strips = join(ctx.out, "..", "..", "work", "preview-strips", ctx.manifest.profile);
  await ensureDir(strips);
  const titles = [...catalog.titles];
  // Three evenly spaced frames of each preview, tiled into one strip (cached per preview file).
  const stripFor = new Map<string, string>();
  await mapPool(titles, 4, async (title) => {
    const asset = assets.get(title.previewAssetId ?? "");
    if (!asset?.preview) return;
    const source = join(ctx.root, asset.preview.key);
    const target = join(strips, `${asset.assetId}-${asset.bytes}.jpg`);
    if (!(await exists(target))) {
      await ffmpeg([
        "-i",
        containerPath(source),
        "-vf",
        `fps=3/${asset.preview.durationSec},scale=320:180,tile=3x1`,
        "-frames:v",
        "1",
        "-q:v",
        "4",
        containerPath(target),
      ]);
    }
    stripFor.set(title.id, target);
  });
  const perSheet = 10;
  const rowHeight = 232;
  const width = 24 + 320 + 16 + 960 + 24;
  const files: string[] = [];
  for (let sheet = 0; sheet * perSheet < titles.length; sheet += 1) {
    const chunk = titles.slice(sheet * perSheet, sheet * perSheet + perSheet);
    const layers: OverlayOptions[] = [];
    let svg = "";
    for (const [index, title] of chunk.entries()) {
      const y = 16 + index * rowHeight;
      const kind = title.license
        ? "own footage"
        : CURATED_PREVIEWS[title.id]
          ? "curated match"
          : "motion art (key art)";
      const label = `${title.name} · ${title.genreIds.map((id) => genres.get(id) ?? id).join(", ")} · ${title.maturity} · ${title.previewAssetId} · ${kind}`;
      svg += text(24, y + 18, label, 15, { weight: 600 });
      layers.push({ input: await card(ctx, title.id, 320), left: 24, top: y + 30 });
      const strip = stripFor.get(title.id);
      if (strip)
        layers.push({ input: await sharp(strip).toBuffer(), left: 24 + 320 + 16, top: y + 30 });
    }
    const height = 16 + chunk.length * rowHeight;
    layers.unshift({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${svg}</svg>`,
      ),
      left: 0,
      top: 0,
    });
    files.push(await save(ctx, `previews-${sheet + 1}.jpg`, width, height, layers));
  }
  return files;
}

/** Offsets of the boundary frames: first, +0.5 s, +1 s, +3 s, middle, −3 s, −1 s, last. */
export function boundaryTimes(durationSec: number): { label: string; at: number }[] {
  const end = durationSec;
  return [
    { label: "first", at: 0 },
    { label: "+0.5 s", at: Math.min(0.5, end) },
    { label: "+1 s", at: Math.min(1, end) },
    { label: "+3 s", at: Math.min(3, end) },
    { label: "middle", at: end / 2 },
    { label: "−3 s", at: Math.max(0, end - 3) },
    { label: "−1 s", at: Math.max(0, end - 1) },
    { label: "last", at: end },
  ];
}

const TILE_W = 240;
const TILE_H = 135;

/**
 * Eight boundary frames of one packaged clip, side by side (decoded from what members get:
 * the HLS rendition nearest 480 p, or the preview MP4). The last tile is the clip's final
 * frame: the tail is decoded and reversed, and its first frame kept.
 */
async function boundaryStrip(input: string, durationSec: number, target: string): Promise<void> {
  const times = boundaryTimes(durationSec);
  const args: string[] = [];
  const filters: string[] = [];
  times.forEach(({ at }, index) => {
    const last = index === times.length - 1;
    const seek = last ? Math.max(0, durationSec - 0.25) : at;
    if (seek > 0) args.push("-ss", seek.toFixed(3));
    args.push("-i", containerPath(input));
    filters.push(
      `[${index}:v]${last ? "reverse," : ""}trim=end_frame=1,setpts=PTS-STARTPTS,scale=${TILE_W}:${TILE_H},setsar=1,format=yuv420p[f${index}]`,
    );
  });
  filters.push(
    `${times.map((_, index) => `[f${index}]`).join("")}hstack=inputs=${times.length}[row]`,
  );
  await ffmpeg([
    ...args,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[row]",
    "-frames:v",
    "1",
    containerPath(target),
  ]);
}

interface PlayableClip {
  asset: PackagedVideoAsset;
  /** "complete film", "feature cut", "episode chapter", "preview: own footage" … */
  kind: string;
  order: number;
  file: string;
  durationSec: number;
  playsUnder: string[];
  source: string;
}

/** Every clip a member can be shown, with the titles it plays under and where it comes from. */
function playableClips(ctx: Ctx): PlayableClip[] {
  const seeds = new Map(catalog.videoAssets.map((seed) => [seed.id, seed]));
  const uses = new Map<string, { main: string[]; preview: string[]; roles: Set<string> }>();
  const use = (assetId: string) => {
    let entry = uses.get(assetId);
    if (!entry) {
      entry = { main: [], preview: [], roles: new Set() };
      uses.set(assetId, entry);
    }
    return entry;
  };
  for (const title of catalog.titles) {
    if (title.previewAssetId) use(title.previewAssetId).preview.push(title.name);
    if (title.type === "movie") {
      const entry = use(title.videoAssetId);
      entry.main.push(title.name);
      entry.roles.add(title.license ? "complete film" : "feature cut");
    } else {
      for (const season of title.seasons)
        for (const episode of season.episodes) {
          const entry = use(episode.videoAssetId);
          entry.main.push(`${title.name} S${season.number}:E${episode.number}`);
          entry.roles.add(title.license ? "complete film" : "episode chapter");
        }
    }
  }
  const order = ["complete film", "feature cut", "episode chapter"];
  const clips: PlayableClip[] = [];
  for (const asset of ctx.manifest.videoAssets) {
    const entry = uses.get(asset.assetId);
    const seed = seeds.get(asset.assetId);
    const source = seed?.source;
    const film =
      source?.kind === "download"
        ? openFilms.find((candidate) => candidate.source.url === source.url)
        : undefined;
    const sourceLabel = film
      ? `${film.name}${source?.kind === "download" && source.startSec !== undefined ? `, ${source.startSec}–${source.startSec + (source.durationSec ?? 0)} s` : ", complete"}`
      : "motion art from the title's own key art";
    const list = (names: string[]) =>
      names.length > 4 ? [...names.slice(0, 4), `+${names.length - 4} more`] : names;
    if (entry && entry.main.length > 0) {
      const kind = [...entry.roles][0] ?? "episode chapter";
      const rendition =
        [...asset.renditions].sort((a, b) => a.height - b.height).find((r) => r.height >= 400) ??
        asset.renditions[0];
      if (rendition)
        clips.push({
          asset,
          kind,
          order: order.indexOf(kind),
          file: join(ctx.root, rendition.playlist),
          durationSec: asset.durationSec,
          playsUnder: list(entry.main),
          source: sourceLabel,
        });
    }
    if (asset.preview && entry && entry.preview.length > 0) {
      const titleIds = catalog.titles.filter((title) => title.previewAssetId === asset.assetId);
      const kind = titleIds.some((title) => title.license)
        ? "preview: own footage"
        : asset.preview.kind === "motion"
          ? "preview: motion art"
          : "preview: curated footage";
      clips.push({
        asset,
        kind,
        order:
          3 +
          ["preview: own footage", "preview: curated footage", "preview: motion art"].indexOf(kind),
        file: join(ctx.root, asset.preview.key),
        durationSec: asset.preview.durationSec,
        playsUnder: list(entry.preview.map((name) => `${name} (preview)`)),
        source: sourceLabel,
      });
    }
  }
  return clips.sort((a, b) => a.order - b.order || a.asset.assetId.localeCompare(b.asset.assetId));
}

/**
 * Boundary review: one row per playable clip (complete films, feature cuts, episode chapters,
 * previews) with its first frame, +0.5 s, +1 s, +3 s, middle, −3 s, −1 s and last frame,
 * labelled with every title it plays under and its source film and window. No row of a
 * fictional title may show a source film's title, credits, studio card or watermark; a
 * chapter's first frames are its recap. Text detection is visual (OCR proved unreliable on
 * these cards), so these sheets are rebuilt with every build and looked at whenever cuts change.
 */
async function boundaries(ctx: Ctx): Promise<string[]> {
  const clips = playableClips(ctx);
  const strips = join(ctx.out, "..", "..", "work", "boundary-strips", ctx.manifest.profile);
  await ensureDir(strips);
  const stripOf = new Map<PlayableClip, string>();
  await mapPool(clips, 6, async (clip) => {
    const target = join(
      strips,
      `${clip.asset.assetId}-${clip.file.endsWith(".mp4") ? "preview" : "main"}-${clip.asset.bytes}.png`,
    );
    if (!(await exists(target))) await boundaryStrip(clip.file, clip.durationSec, target);
    stripOf.set(clip, target);
  });
  const perSheet = 12;
  const labelW = 380;
  const rowH = TILE_H + 12;
  const width = labelW + 8 * TILE_W + 24;
  const files: string[] = [];
  for (let sheet = 0; sheet * perSheet < clips.length; sheet += 1) {
    const chunk = clips.slice(sheet * perSheet, sheet * perSheet + perSheet);
    const layers: OverlayOptions[] = [];
    let svg = "";
    boundaryTimes(10).forEach(({ label }, index) => {
      svg += text(labelW + index * TILE_W + TILE_W / 2, 22, label, 15, {
        weight: 700,
        anchor: "middle",
        color: "#9a9a9a",
      });
    });
    for (const [index, clip] of chunk.entries()) {
      const y = 32 + index * rowH;
      const lines = [
        { value: clip.asset.assetId, strong: true },
        { value: `${clip.kind} · ${clip.durationSec.toFixed(1)} s`, strong: true },
        ...clamp(`plays under: ${clip.playsUnder.join(", ")}`, 46, 2),
        ...clamp(`source: ${clip.source}`, 46, 2),
      ].map((line) => (typeof line === "string" ? { value: line, strong: false } : line));
      lines.forEach((line, i) => {
        svg += text(12, y + 16 + i * 17, line.value, 13, {
          weight: line.strong ? 700 : 400,
          color: line.strong ? "#f2f2f2" : "#bdbdbd",
        });
      });
      const strip = stripOf.get(clip);
      if (strip) layers.push({ input: await sharp(strip).toBuffer(), left: labelW, top: y });
    }
    const height = 32 + chunk.length * rowH + 8;
    layers.unshift({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${svg}</svg>`,
      ),
      left: 0,
      top: 0,
    });
    files.push(
      await save(
        ctx,
        `boundaries-${String(sheet + 1).padStart(2, "0")}.jpg`,
        width,
        height,
        layers,
      ),
    );
  }
  log.info(`boundary review: ${clips.length} playable clips on ${files.length} sheets`);
  return files;
}

export async function contactSheets(
  profile: MediaProfile,
  only?: readonly string[],
): Promise<number> {
  const manifest = await readJson<MediaManifest>(manifestPath(profile));
  if (!manifest) throw new Error(`No manifest for ${profile}; run build first`);
  const out = await ensureDir(join(MEDIA_ROOT, "review", profile));
  const ctx: Ctx = {
    out,
    root: mediaCacheDir(profile),
    manifest,
    titles: new Map(catalog.titles.map((title) => [title.id, title])),
  };
  const files: string[] = [];
  const wants = (name: string) => !only || only.includes(name);
  if (wants("rows")) files.push(...(await rows(ctx)));
  if (wants("billboards")) {
    const featured = [...catalog.titles]
      .sort((a, b) => b.popularity - a.popularity)
      .slice(0, 16)
      .map((title) => title.id);
    files.push(...(await billboards(ctx, featured)));
  }
  if (wants("top10")) files.push(await topTen(ctx));
  if (wants("posters")) files.push(...(await posters(ctx)));
  if (wants("logos")) files.push(...(await logos(ctx)));
  if (wants("episodes")) {
    for (const series of catalog.titles.filter((title) => title.type === "series").slice(0, 6)) {
      const file = await episodes(ctx, series.id);
      if (file) files.push(file);
    }
  }
  if (wants("avatars")) files.push(await avatars(ctx));
  if (wants("previews")) files.push(...(await previews(ctx)));
  if (wants("boundaries")) files.push(...(await boundaries(ctx)));
  for (const file of files) log.info(file);
  return 0;
}
