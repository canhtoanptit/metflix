/**
 * Colour grading on raw RGB pixels: white balance and exposure in linear light, then a filmic
 * S-curve, saturation, split toning (shadows and highlights pushed toward two colours), lifted
 * blacks, vignette and seeded film grain. This is what turns a stock photograph into key art
 * that belongs to a genre: teal-and-orange thrillers, bleached period pieces, neon sci-fi.
 */

export interface Grade {
  /** Stops of exposure (linear light). */
  exposure: number;
  /** -1 cool … +1 warm. */
  temperature: number;
  /** -1 green … +1 magenta. */
  tint: number;
  /** 0 … 1: strength of the filmic S-curve. */
  contrast: number;
  /** Saturation multiplier. */
  saturation: number;
  shadows: string;
  highlights: string;
  /** 0 … 1: split-toning strength. */
  split: number;
  /** Lifted blacks, 0 … 0.2. */
  fade: number;
  /** 0 … 1. */
  vignette: number;
  /** 0 … 1. */
  grain: number;
  /** Map luminance onto [dark, light] (duotone), applied at `duotoneMix`. */
  duotone?: readonly [string, string];
  duotoneMix?: number;
}

const NEUTRAL: Grade = {
  exposure: 0,
  temperature: 0,
  tint: 0,
  contrast: 0.25,
  saturation: 1,
  shadows: "#808080",
  highlights: "#808080",
  split: 0,
  fade: 0,
  vignette: 0.25,
  grain: 0.15,
};

/** Named looks; art direction picks one and may override any field. */
export const GRADES = {
  natural: {},
  "teal-orange": {
    temperature: 0.1,
    contrast: 0.45,
    saturation: 0.95,
    shadows: "#1f5a6e",
    highlights: "#f0a35e",
    split: 0.55,
    vignette: 0.4,
  },
  noir: {
    saturation: 0.05,
    contrast: 0.65,
    exposure: -0.2,
    shadows: "#2a3340",
    highlights: "#d9d2c4",
    split: 0.25,
    vignette: 0.55,
    grain: 0.35,
  },
  "cold-steel": {
    temperature: -0.45,
    contrast: 0.45,
    saturation: 0.55,
    shadows: "#14283c",
    highlights: "#cfe3f0",
    split: 0.45,
    vignette: 0.45,
    exposure: -0.15,
  },
  "warm-gold": {
    temperature: 0.45,
    contrast: 0.35,
    saturation: 1.05,
    shadows: "#4a2a1a",
    highlights: "#ffd58a",
    split: 0.45,
    vignette: 0.35,
  },
  bleach: {
    saturation: 0.4,
    contrast: 0.6,
    fade: 0.04,
    shadows: "#24302c",
    highlights: "#eae4d6",
    split: 0.3,
    vignette: 0.45,
    grain: 0.3,
  },
  neon: {
    temperature: -0.15,
    tint: 0.35,
    contrast: 0.55,
    saturation: 1.35,
    shadows: "#24104a",
    highlights: "#ff5fc4",
    split: 0.6,
    vignette: 0.45,
    exposure: -0.1,
  },
  sepia: {
    saturation: 0.25,
    contrast: 0.4,
    temperature: 0.35,
    shadows: "#3a2616",
    highlights: "#f4dfb4",
    split: 0.65,
    fade: 0.05,
    vignette: 0.5,
    grain: 0.35,
  },
  pastel: {
    contrast: 0.12,
    saturation: 0.85,
    fade: 0.08,
    exposure: 0.15,
    shadows: "#6a5a8a",
    highlights: "#ffe6d0",
    split: 0.35,
    vignette: 0.15,
    grain: 0.1,
  },
  verdant: {
    temperature: -0.1,
    tint: -0.15,
    contrast: 0.5,
    saturation: 0.75,
    shadows: "#10291f",
    highlights: "#d8e6b0",
    split: 0.45,
    vignette: 0.5,
    exposure: -0.15,
  },
  crimson: {
    contrast: 0.6,
    saturation: 0.7,
    shadows: "#2a0608",
    highlights: "#ff8a6a",
    split: 0.55,
    vignette: 0.6,
    exposure: -0.25,
    grain: 0.3,
  },
  dusk: {
    temperature: 0.05,
    tint: 0.2,
    contrast: 0.4,
    saturation: 1.05,
    shadows: "#2b1e4f",
    highlights: "#ffb37a",
    split: 0.55,
    vignette: 0.4,
  },
  arctic: {
    temperature: -0.6,
    contrast: 0.3,
    saturation: 0.6,
    shadows: "#18344d",
    highlights: "#eef7ff",
    split: 0.4,
    exposure: 0.05,
    vignette: 0.35,
  },
  ember: {
    temperature: 0.55,
    contrast: 0.6,
    saturation: 1.1,
    shadows: "#1a0804",
    highlights: "#ffb04a",
    split: 0.55,
    vignette: 0.6,
    exposure: -0.2,
    grain: 0.25,
  },
  ocean: {
    temperature: -0.3,
    contrast: 0.4,
    saturation: 1.1,
    shadows: "#03223a",
    highlights: "#9fe8ff",
    split: 0.45,
    vignette: 0.4,
  },
  vivid: {
    contrast: 0.35,
    saturation: 1.3,
    shadows: "#3b2a6b",
    highlights: "#ffe08a",
    split: 0.25,
    vignette: 0.2,
    grain: 0.05,
  },
  "desert-amber": {
    temperature: 0.4,
    contrast: 0.45,
    saturation: 0.9,
    shadows: "#3a1d10",
    highlights: "#ffcf8a",
    split: 0.45,
    vignette: 0.35,
  },
  moonlit: {
    temperature: -0.5,
    contrast: 0.5,
    saturation: 0.45,
    shadows: "#0a1630",
    highlights: "#a9c4ff",
    split: 0.5,
    exposure: -0.35,
    vignette: 0.55,
    grain: 0.25,
  },
} satisfies Record<string, Partial<Grade>>;

export type GradeName = keyof typeof GRADES;

export function resolveGrade(name: string, overrides: Partial<Grade> = {}): Grade {
  const preset = (GRADES as Record<string, Partial<Grade>>)[name] ?? {};
  return { ...NEUTRAL, ...preset, ...overrides };
}

export function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

const TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i += 1) {
  const c = i / 255;
  TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const TO_SRGB_STEPS = 4096;
const TO_SRGB = new Float32Array(TO_SRGB_STEPS + 1);
for (let i = 0; i <= TO_SRGB_STEPS; i += 1) {
  const c = i / TO_SRGB_STEPS;
  TO_SRGB[i] = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

function toSrgb(linear: number): number {
  const clamped = linear <= 0 ? 0 : Math.min(linear, 1);
  return TO_SRGB[Math.round(clamped * TO_SRGB_STEPS)] ?? clamped;
}

/** Deterministic per-pixel hash noise in [0, 1). */
function hashNoise(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Grade `pixels` (RGB or RGBA, 8-bit) in place. */
export function applyGrade(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
  grade: Grade,
  seed = 1,
): void {
  const gain = 2 ** grade.exposure;
  const wbR = gain * (1 + 0.12 * grade.temperature) * (1 + 0.04 * grade.tint);
  const wbG = gain * (1 - 0.08 * grade.tint);
  const wbB = gain * (1 - 0.14 * grade.temperature) * (1 + 0.04 * grade.tint);
  const [sr, sg, sb] = hexToRgb(grade.shadows);
  const [hr, hg, hb] = hexToRgb(grade.highlights);
  const duo = grade.duotone ? grade.duotone.map(hexToRgb) : null;
  const duoMix = grade.duotoneMix ?? 1;
  const cx = width / 2;
  const cy = height / 2;
  const maxR = Math.hypot(cx, cy);
  const contrast = grade.contrast;
  const fade = grade.fade;
  const grainAmp = grade.grain * 0.09;
  const split = grade.split * 0.55;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * channels;
      let r = toSrgb((TO_LINEAR[pixels[i] ?? 0] ?? 0) * wbR);
      let g = toSrgb((TO_LINEAR[pixels[i + 1] ?? 0] ?? 0) * wbG);
      let b = toSrgb((TO_LINEAR[pixels[i + 2] ?? 0] ?? 0) * wbB);

      let l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = l + (r - l) * grade.saturation;
      g = l + (g - l) * grade.saturation;
      b = l + (b - l) * grade.saturation;

      // Filmic S-curve, blended by strength.
      const curve = (v: number) => {
        const c = v < 0 ? 0 : Math.min(v, 1);
        return c + (c * c * (3 - 2 * c) - c) * contrast * 1.6;
      };
      r = curve(r);
      g = curve(g);
      b = curve(b);

      l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (split > 0) {
        const ws = (1 - l) * (1 - l) * split;
        const wh = l * l * split;
        r += (sr - 0.5) * ws + (hr - 0.5) * wh;
        g += (sg - 0.5) * ws + (hg - 0.5) * wh;
        b += (sb - 0.5) * ws + (hb - 0.5) * wh;
      }
      if (duo) {
        const [dark, light] = duo as [[number, number, number], [number, number, number]];
        const t = l < 0 ? 0 : Math.min(l, 1);
        r += (dark[0] + (light[0] - dark[0]) * t - r) * duoMix;
        g += (dark[1] + (light[1] - dark[1]) * t - g) * duoMix;
        b += (dark[2] + (light[2] - dark[2]) * t - b) * duoMix;
      }
      if (fade > 0) {
        r = fade + r * (1 - fade);
        g = fade + g * (1 - fade);
        b = fade * 1.1 + b * (1 - fade * 1.1);
      }
      if (grade.vignette > 0) {
        const d = Math.hypot((x - cx) * 0.85, y - cy) / maxR;
        const t = d < 0.45 ? 0 : d > 1.05 ? 1 : (d - 0.45) / 0.6;
        const v = 1 - grade.vignette * t * t * (3 - 2 * t);
        r *= v;
        g *= v;
        b *= v;
      }
      if (grainAmp > 0) {
        // Grain is stronger in the midtones, like film.
        const n = (hashNoise(x, y, seed) - 0.5) * grainAmp * (0.4 + 2.4 * l * (1 - l));
        r += n;
        g += n;
        b += n;
      }
      pixels[i] = r <= 0 ? 0 : r >= 1 ? 255 : Math.round(r * 255);
      pixels[i + 1] = g <= 0 ? 0 : g >= 1 ? 255 : Math.round(g * 255);
      pixels[i + 2] = b <= 0 ? 0 : b >= 1 ? 255 : Math.round(b * 255);
    }
  }
}
