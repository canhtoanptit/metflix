/**
 * Writes one image in every width × format the contract expects, under its blob key, and
 * computes what the `ArtworkImage` carries: dominant colour, ThumbHash and a content version.
 */
import { join } from "node:path";
import { type ArtworkImage, fillImageTemplate } from "@webflix/contracts";
import sharp from "sharp";
import { rgbaToThumbHash } from "thumbhash";
import { writeFileAtomic } from "../util/fs.ts";
import { sha256, shortHash } from "../util/hash.ts";

export const FORMATS = ["avif", "webp"] as const;

export const WIDTHS = {
  backdrop: [640, 1280, 1920],
  card: [320, 480, 640, 960],
  poster: [200, 400, 600, 800],
  logo: [320, 640, 1280],
  still: [320, 640, 960],
} as const;

async function placeholder(master: Buffer): Promise<{ thumbhash: string; dominantColor: string }> {
  const small = await sharp(master)
    .resize(100, 100, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const hash = rgbaToThumbHash(small.info.width, small.info.height, small.data);
  const thumbhash = Buffer.from(hash).toString("base64");
  // Dominant colour of the opaque pixels, nudged dark: it is shown behind light text while
  // the image loads, so a very light swatch would flash.
  const { dominant } = await sharp(master)
    .flatten({ background: "#000000" })
    .resize(64, 64, { fit: "inside" })
    .stats();
  const darken = (value: number) => Math.round(Math.min(value, 200) * 0.85);
  const hex = [dominant.r, dominant.g, dominant.b]
    .map((value) => darken(value).toString(16).padStart(2, "0"))
    .join("");
  return { thumbhash, dominantColor: `#${hex}` };
}

/**
 * Encode `master` (PNG) at each width (never upscaling past the master) into `root` under
 * `keyTemplate`. Returns the manifest entry and the files written.
 */
export async function writeImageSet(
  master: Buffer,
  keyTemplate: string,
  widths: readonly number[],
  root: string,
  options: { alpha?: boolean } = {},
): Promise<{ image: ArtworkImage; files: string[] }> {
  const meta = await sharp(master).metadata();
  const masterWidth = meta.width ?? widths[widths.length - 1] ?? 1;
  const masterHeight = meta.height ?? 1;
  const usable = widths.filter((width) => width <= masterWidth);
  const finalWidths = usable.length > 0 ? usable : [masterWidth];
  const files: string[] = [];
  for (const width of finalWidths) {
    const resized = sharp(master).resize({ width, kernel: "lanczos3" });
    for (const format of FORMATS) {
      const key = fillImageTemplate(keyTemplate, width, format);
      const bytes =
        format === "avif"
          ? await resized
              .clone()
              .avif({ quality: options.alpha ? 60 : 52, effort: 4, chromaSubsampling: "4:2:0" })
              .toBuffer()
          : await resized.clone().webp({ quality: 80, alphaQuality: 90, effort: 4 }).toBuffer();
      const path = join(root, key);
      await writeFileAtomic(path, bytes);
      files.push(path);
    }
  }
  const { thumbhash, dominantColor } = await placeholder(master);
  return {
    image: {
      keyTemplate,
      widths: finalWidths,
      formats: [...FORMATS],
      aspectRatio: Math.round((masterWidth / masterHeight) * 10000) / 10000,
      dominantColor,
      thumbhash,
      version: shortHash(sha256(master)),
    },
    files,
  };
}

/** A single-file avatar (`public/img/avatars/{id}.webp`). */
export async function writeAvatar(
  master: Buffer,
  key: string,
  root: string,
): Promise<{ version: string; file: string }> {
  const bytes = await sharp(master).resize(320, 320).webp({ quality: 85, effort: 5 }).toBuffer();
  const file = join(root, key);
  await writeFileAtomic(file, bytes);
  return { version: shortHash(sha256(bytes)), file };
}
