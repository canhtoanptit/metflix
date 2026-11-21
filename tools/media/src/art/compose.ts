/**
 * Composes the artwork for one title from its source image: a clean graded backdrop, a 16:9
 * card and a 2:3 poster with the title treatment set into a darkened area, a transparent
 * logo, and episode stills cut from the series' photo set.
 */
import sharp from "sharp";
import { applyGrade, type Grade } from "./grade.ts";
import { buildTreatment, type TreatmentStyle } from "./treatment.ts";

export interface RasterImage {
  /** RGB, 8-bit, row-major. */
  data: Uint8Array;
  width: number;
  height: number;
}

export const MASTER = {
  // Sources top out at 1920 px (film frames, Wikimedia's standard thumbnail size).
  backdrop: { width: 1920, height: 1080 },
  card: { width: 960, height: 540 },
  poster: { width: 800, height: 1200 },
  still: { width: 960, height: 540 },
  logoMaxWidth: 1280,
} as const;

export async function loadRaster(path: string, maxWidth = 3840): Promise<RasterImage> {
  const { data, info } = await sharp(path, { limitInputPixels: 300_000_000 })
    .rotate()
    .resize({ width: maxWidth, withoutEnlargement: true })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}

function rawSharp(image: RasterImage) {
  return sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
    raw: { width: image.width, height: image.height, channels: 3 },
  });
}

/**
 * The largest crop of `aspect` that puts `focus` (source fraction) as close as possible to
 * `place` (fraction within the crop), optionally zoomed in.
 */
export function cropRect(
  width: number,
  height: number,
  aspect: number,
  focus: readonly [number, number],
  place: readonly [number, number],
  zoom = 1,
): { left: number; top: number; width: number; height: number } {
  let cropWidth = Math.min(width, height * aspect) / zoom;
  let cropHeight = cropWidth / aspect;
  cropWidth = Math.max(16, Math.floor(cropWidth));
  cropHeight = Math.max(9, Math.floor(cropHeight));
  const left = Math.round(
    Math.min(Math.max(focus[0] * width - place[0] * cropWidth, 0), width - cropWidth),
  );
  const top = Math.round(
    Math.min(Math.max(focus[1] * height - place[1] * cropHeight, 0), height - cropHeight),
  );
  return { left, top, width: cropWidth, height: cropHeight };
}

/** Crop, resize and grade into a new raster. */
export async function cropGrade(
  source: RasterImage,
  target: { width: number; height: number },
  focus: readonly [number, number],
  place: readonly [number, number],
  grade: Grade,
  seed: number,
  options: { zoom?: number; flip?: boolean } = {},
): Promise<RasterImage> {
  const rect = cropRect(
    source.width,
    source.height,
    target.width / target.height,
    focus,
    place,
    options.zoom ?? 1,
  );
  let pipeline = rawSharp(source)
    .extract(rect)
    .resize(target.width, target.height, { kernel: "lanczos3" });
  if (options.flip) pipeline = pipeline.flop();
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  applyGrade(pixels, info.width, info.height, info.channels, grade, seed);
  return { data: pixels, width: info.width, height: info.height };
}

export async function toPng(image: RasterImage): Promise<Buffer> {
  return rawSharp(image).png({ compressionLevel: 3 }).toBuffer();
}

type CardPlacement = "bottom-left" | "bottom-center" | "center" | "left";
type PosterPlacement = "bottom" | "top" | "center";

/** Darkening behind the treatment so it reads at thumbnail size on any image. */
function scrimSvg(
  width: number,
  height: number,
  placement: CardPlacement | PosterPlacement,
  strength: number,
): string {
  const a = (value: number) => Math.min(1, value * strength).toFixed(3);
  let shapes: string;
  switch (placement) {
    case "bottom-left":
      shapes = `<linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop offset="0.35" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${a(0.78)}"/></linearGradient><linearGradient id="h" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity="${a(0.5)}"/><stop offset="0.6" stop-color="#000" stop-opacity="0"/></linearGradient>`;
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs>${shapes}</defs><rect width="100%" height="100%" fill="url(#v)"/><rect width="100%" height="100%" fill="url(#h)"/></svg>`;
    case "left":
      shapes = `<linearGradient id="h" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity="${a(0.8)}"/><stop offset="0.65" stop-color="#000" stop-opacity="0"/></linearGradient>`;
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs>${shapes}</defs><rect width="100%" height="100%" fill="url(#h)"/></svg>`;
    case "top":
      shapes = `<linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="${a(0.8)}"/><stop offset="0.5" stop-color="#000" stop-opacity="0"/></linearGradient>`;
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs>${shapes}</defs><rect width="100%" height="100%" fill="url(#v)"/></svg>`;
    case "center":
      shapes = `<radialGradient id="r" cx="0.5" cy="0.5" r="0.6"><stop offset="0" stop-color="#000" stop-opacity="${a(0.55)}"/><stop offset="1" stop-color="#000" stop-opacity="${a(0.2)}"/></radialGradient>`;
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs>${shapes}</defs><rect width="100%" height="100%" fill="url(#r)"/></svg>`;
    default:
      shapes = `<linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop offset="0.4" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${a(0.85)}"/></linearGradient>`;
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs>${shapes}</defs><rect width="100%" height="100%" fill="url(#v)"/></svg>`;
  }
}

/** Box (px) the treatment is fitted into, and how it is anchored inside the box. */
function treatmentBox(
  width: number,
  height: number,
  placement: CardPlacement | PosterPlacement,
): {
  x: number;
  y: number;
  w: number;
  h: number;
  anchor: "left-bottom" | "center-bottom" | "center" | "center-top" | "left-center";
} {
  switch (placement) {
    case "bottom-left":
      return {
        x: width * 0.055,
        y: height * 0.4,
        w: width * 0.68,
        h: height * 0.49,
        anchor: "left-bottom",
      };
    case "bottom-center":
      return {
        x: width * 0.08,
        y: height * 0.42,
        w: width * 0.84,
        h: height * 0.48,
        anchor: "center-bottom",
      };
    case "left":
      return {
        x: width * 0.06,
        y: height * 0.2,
        w: width * 0.55,
        h: height * 0.6,
        anchor: "left-center",
      };
    case "center":
      return {
        x: width * 0.12,
        y: height * 0.22,
        w: width * 0.76,
        h: height * 0.56,
        anchor: "center",
      };
    case "top":
      return {
        x: width * 0.07,
        y: height * 0.05,
        w: width * 0.86,
        h: height * 0.3,
        anchor: "center-top",
      };
    default:
      // Poster bottom.
      return {
        x: width * 0.05,
        y: height * 0.6,
        w: width * 0.9,
        h: height * 0.34,
        anchor: "center-bottom",
      };
  }
}

/** Render a treatment to fit `box`, returning PNG and its top-left position. */
async function placeTreatment(
  name: string,
  style: TreatmentStyle,
  box: ReturnType<typeof treatmentBox>,
): Promise<{ input: Buffer; left: number; top: number }> {
  const treatment = buildTreatment(name, style, box.w, box.h);
  const scale = Math.min(1, (box.w + 40) / treatment.width, (box.h + 40) / treatment.height);
  const width = Math.max(1, Math.round(treatment.width * scale));
  const height = Math.max(1, Math.round(treatment.height * scale));
  const input = await sharp(Buffer.from(treatment.svg), { density: 72 * scale })
    .resize(width, height)
    .png()
    .toBuffer();
  let left: number;
  let top: number;
  switch (box.anchor) {
    case "left-bottom":
      left = box.x;
      top = box.y + box.h - height;
      break;
    case "center-bottom":
      left = box.x + (box.w - width) / 2;
      top = box.y + box.h - height;
      break;
    case "center-top":
      left = box.x + (box.w - width) / 2;
      top = box.y;
      break;
    case "left-center":
      left = box.x;
      top = box.y + (box.h - height) / 2;
      break;
    default:
      left = box.x + (box.w - width) / 2;
      top = box.y + (box.h - height) / 2;
  }
  return { input, left: Math.max(0, Math.round(left)), top: Math.max(0, Math.round(top)) };
}

/**
 * Cards and posters are seen at thumbnail size: thin faces get a hairline of extra weight and
 * very wide letter-spacing is reined in, so a title reads at 300 px. Logos keep the full style.
 */
function forSmallSizes(style: TreatmentStyle, width: number): TreatmentStyle {
  const thin = [
    "cormorant",
    "italiana",
    "poiret",
    "josefin",
    "great-vibes",
    "parisienne",
    "bodoni",
    "michroma",
    "monoton",
    "major-mono",
    "marcellus",
  ].includes(style.font);
  const tracking = Math.min(style.tracking, 0.12);
  if (!thin || style.stroke) return { ...style, tracking };
  const color =
    style.fill.kind === "solid" ? style.fill.color : (style.fill.stops[0]?.[1] ?? "#ffffff");
  return { ...style, tracking, stroke: { color, width: width < 1000 ? 0.014 : 0.007 } };
}

export async function composeWithTitle(
  background: RasterImage,
  name: string,
  style: TreatmentStyle,
  placement: CardPlacement | PosterPlacement,
  scrimStrength = 1,
): Promise<Buffer> {
  const { width, height } = background;
  const box = treatmentBox(width, height, placement);
  const treatment = await placeTreatment(name, forSmallSizes(style, width), box);
  return rawSharp(background)
    .composite([
      { input: Buffer.from(scrimSvg(width, height, placement, scrimStrength)) },
      treatment,
    ])
    .png({ compressionLevel: 3 })
    .toBuffer();
}

/** Transparent logo, trimmed to its ink plus effects. */
export async function composeLogo(name: string, style: TreatmentStyle): Promise<Buffer> {
  const treatment = buildTreatment(name, style, 1500, 620);
  const scale = Math.min(1.5, MASTER.logoMaxWidth / treatment.width);
  return sharp(Buffer.from(treatment.svg), { density: 72 * scale })
    .resize(Math.round(treatment.width * scale))
    .png()
    .toBuffer();
}
