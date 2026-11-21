/**
 * Procedural placeholder artwork for mock mode: deterministic SVG key art per title (backdrop,
 * landscape card with the title treatment, portrait poster, transparent logo), episode stills and
 * avatars. Pure string functions with no DOM or Node APIs: the Vite mock-media plugin serves
 * them as `/cdn/img/...`, and the mock data derives dominant colours and ThumbHashes from the
 * same inputs, so placeholders and blur-ups match the art.
 */
import type { MockMotif } from "./data/types.ts";

export type ArtKind = "backdrop" | "card" | "poster" | "logo" | "still";

export interface ArtInput {
  seed: string;
  name: string;
  palette: [string, string];
  motif: MockMotif;
  /** First genre slug: picks the title typography. */
  genre: string;
  kind: ArtKind;
  /** Episode stills vary the composition. */
  variant?: number;
}

// --- Deterministic randomness ------------------------------------------------------------------

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function random(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Colour ------------------------------------------------------------------------------------

type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const clean = hex.replace("#", "");
  return [0, 2, 4].map((offset) => Number.parseInt(clean.slice(offset, offset + 2), 16)) as Rgb;
}

export function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b]
    .map((channel) =>
      Math.round(Math.min(255, Math.max(0, channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export function mix(a: string, b: string, amount: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex([0, 1, 2].map((i) => (ca[i] ?? 0) * (1 - amount) + (cb[i] ?? 0) * amount) as Rgb);
}

const shade = (hex: string, amount: number) => mix(hex, "#000000", amount);
const tint = (hex: string, amount: number) => mix(hex, "#ffffff", amount);

/** Dominant colour reported in the ImageSet (what the blur-up shows first). */
export function dominantColor(input: Pick<ArtInput, "palette" | "kind">): string {
  const [a, b] = input.palette;
  return input.kind === "logo" ? "#000000" : shade(mix(a, b, 0.55), 0.35);
}

/**
 * Coarse RGBA approximation of the art (sky gradient, glow and darker ground) for ThumbHash
 * encoding, without rasterising the SVG.
 */
export function approximateRgba(
  input: Pick<ArtInput, "palette" | "seed">,
  width: number,
  height: number,
): Uint8Array {
  const rand = random(hashString(input.seed));
  const [a, b] = input.palette;
  const top = hexToRgb(tint(a, 0.12));
  const bottom = hexToRgb(shade(b, 0.55));
  const glow = hexToRgb(tint(a, 0.45));
  const gx = 0.2 + rand() * 0.6;
  const gy = 0.2 + rand() * 0.3;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = y / Math.max(1, height - 1);
      const dx = x / width - gx;
      const dy = y / height - gy;
      const g = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 2.2) * 0.6;
      const ground = t > 0.68 ? 0.35 : 0;
      const offset = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const base = (top[c] ?? 0) * (1 - t) + (bottom[c] ?? 0) * t;
        out[offset + c] = Math.round((base * (1 - g) + (glow[c] ?? 0) * g) * (1 - ground));
      }
      out[offset + 3] = 255;
    }
  }
  return out;
}

// --- Typography by genre -----------------------------------------------------------------------

interface TitleStyle {
  family: string;
  weight: number;
  uppercase: boolean;
  tracking: number;
  italic?: boolean;
  /** Width of a glyph relative to the font size, for line fitting. */
  advance: number;
}

const SERIF = "Georgia, 'Times New Roman', serif";
const DIDONE = "Didot, 'Bodoni 72', 'Bodoni MT', Georgia, serif";
const CONDENSED = "'Avenir Next Condensed', 'Helvetica Neue', 'Arial Narrow', Arial, sans-serif";
const GEOMETRIC = "Futura, 'Avenir Next', 'Century Gothic', 'Trebuchet MS', sans-serif";
const ROUNDED = "'Avenir Next', 'Arial Rounded MT Bold', 'Trebuchet MS', sans-serif";
const GROTESK = "'Helvetica Neue', Helvetica, Arial, sans-serif";

function titleStyle(genre: string): TitleStyle {
  switch (genre) {
    case "drama":
    case "romance":
    case "history":
      return { family: SERIF, weight: 400, uppercase: false, tracking: 0.01, advance: 0.5 };
    case "fantasy":
    case "international":
      return { family: DIDONE, weight: 700, uppercase: true, tracking: 0.06, advance: 0.66 };
    case "thriller":
    case "crime":
    case "mystery":
    case "horror":
      return { family: CONDENSED, weight: 700, uppercase: true, tracking: 0.04, advance: 0.5 };
    case "action":
      return {
        family: CONDENSED,
        weight: 800,
        uppercase: true,
        tracking: 0,
        italic: true,
        advance: 0.52,
      };
    case "sci-fi":
      return { family: GEOMETRIC, weight: 500, uppercase: true, tracking: 0.18, advance: 0.78 };
    case "comedy":
    case "family":
    case "animation":
      return { family: ROUNDED, weight: 800, uppercase: false, tracking: -0.01, advance: 0.56 };
    case "documentary":
    case "music":
      return { family: GROTESK, weight: 300, uppercase: true, tracking: 0.14, advance: 0.68 };
    default:
      return { family: GROTESK, weight: 700, uppercase: false, tracking: -0.01, advance: 0.55 };
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Greedy line breaking to at most `maxLines` lines of roughly `maxChars`. */
function breakLines(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines - 1), lines.slice(maxLines - 1).join(" ")];
}

function titleTreatment(
  input: ArtInput,
  box: { x: number; y: number; width: number; height: number },
  align: "start" | "middle",
  color: string,
): string {
  const style = titleStyle(input.genre);
  const text = style.uppercase ? input.name.toUpperCase() : input.name;
  const perChar = style.advance + style.tracking;
  const lines = breakLines(text, Math.max(8, Math.round(text.length / 2) + 2), 3);
  const longest = Math.max(...lines.map((line) => line.length));
  const byWidth = box.width / (longest * perChar);
  const byHeight = box.height / (lines.length * 1.05);
  const size = Math.min(byWidth, byHeight);
  const lineHeight = size * 1.02;
  const x = align === "middle" ? box.x + box.width / 2 : box.x;
  const firstBaseline = box.y + box.height - (lines.length - 1) * lineHeight - size * 0.12;
  const tspans = lines
    .map(
      (line, index) =>
        `<tspan x="${x.toFixed(1)}" y="${(firstBaseline + index * lineHeight).toFixed(1)}">${escapeXml(line)}</tspan>`,
    )
    .join("");
  return `<text font-family="${style.family}" font-weight="${style.weight}" font-size="${size.toFixed(1)}" letter-spacing="${(style.tracking * size).toFixed(1)}" text-anchor="${align}" fill="${color}"${style.italic ? ' font-style="italic"' : ""} filter="url(#shadow)">${tspans}</text>`;
}

// --- Motifs ------------------------------------------------------------------------------------

interface Canvas {
  width: number;
  height: number;
  rand: () => number;
  light: string;
  mid: string;
  dark: string;
  deep: string;
  accent: string;
}

function ridge(
  c: Canvas,
  baseline: number,
  amplitude: number,
  segments: number,
  fill: string,
): string {
  let d = `M0 ${c.height} L0 ${baseline}`;
  for (let i = 1; i <= segments; i += 1) {
    const x = (c.width / segments) * i;
    const y = baseline - c.rand() * amplitude;
    d += ` L${x.toFixed(0)} ${y.toFixed(0)}`;
  }
  return `<path d="${d} L${c.width} ${c.height} Z" fill="${fill}"/>`;
}

function figure(c: Canvas, x: number, ground: number, scale: number): string {
  const h = c.height * 0.16 * scale;
  const w = h * 0.28;
  return `<g fill="${shade(c.deep, 0.5)}"><circle cx="${x}" cy="${ground - h * 0.9}" r="${w * 0.32}"/><path d="M${x - w / 2} ${ground} L${x - w * 0.36} ${ground - h * 0.78} Q${x} ${ground - h * 0.86} ${x + w * 0.36} ${ground - h * 0.78} L${x + w / 2} ${ground} Z"/></g>`;
}

function stars(c: Canvas, count: number, maxY: number): string {
  let out = "";
  for (let i = 0; i < count; i += 1) {
    out += `<circle cx="${(c.rand() * c.width).toFixed(0)}" cy="${(c.rand() * maxY).toFixed(0)}" r="${(0.8 + c.rand() * 2.2).toFixed(1)}" fill="#ffffff" opacity="${(0.3 + c.rand() * 0.6).toFixed(2)}"/>`;
  }
  return out;
}

function motifLayer(motif: MockMotif, c: Canvas): string {
  const { width: w, height: h, rand } = c;
  switch (motif) {
    case "mountains":
      return [
        `<circle cx="${w * (0.25 + rand() * 0.5)}" cy="${h * 0.32}" r="${h * 0.12}" fill="${tint(c.light, 0.6)}" opacity="0.85"/>`,
        ridge(c, h * 0.62, h * 0.28, 7, c.mid),
        ridge(c, h * 0.74, h * 0.22, 9, c.dark),
        ridge(c, h * 0.86, h * 0.14, 12, c.deep),
        figure(c, w * (0.3 + rand() * 0.4), h * 0.9, 0.6),
      ].join("");
    case "city": {
      let out = `<rect x="0" y="${h * 0.9}" width="${w}" height="${h * 0.1}" fill="${c.deep}"/>`;
      let x = -10;
      while (x < w) {
        const bw = w * (0.04 + rand() * 0.07);
        const bh = h * (0.25 + rand() * 0.5);
        out += `<rect x="${x.toFixed(0)}" y="${(h * 0.92 - bh).toFixed(0)}" width="${bw.toFixed(0)}" height="${bh.toFixed(0)}" fill="${rand() > 0.5 ? c.dark : c.deep}"/>`;
        for (let wy = h * 0.92 - bh + 14; wy < h * 0.88; wy += 22) {
          for (let wx = x + 8; wx < x + bw - 8; wx += 16) {
            if (rand() > 0.72) {
              out += `<rect x="${wx.toFixed(0)}" y="${wy.toFixed(0)}" width="6" height="9" fill="${tint(c.accent, 0.5)}" opacity="${(0.5 + rand() * 0.5).toFixed(2)}"/>`;
            }
          }
        }
        x += bw + 2;
      }
      return out;
    }
    case "forest": {
      let out = ridge(c, h * 0.7, h * 0.05, 6, c.mid);
      for (let layer = 0; layer < 3; layer += 1) {
        const color = [c.mid, c.dark, c.deep][layer] ?? c.deep;
        const base = h * (0.72 + layer * 0.1);
        for (let i = 0; i < 16; i += 1) {
          const tx = rand() * w;
          const th = h * (0.25 + rand() * 0.25) * (1 + layer * 0.2);
          const tw = th * 0.32;
          out += `<path d="M${tx} ${base - th} L${tx - tw / 2} ${base} L${tx + tw / 2} ${base} Z" fill="${color}"/>`;
        }
        out += `<rect x="0" y="${base}" width="${w}" height="${h - base}" fill="${color}"/>`;
      }
      return out;
    }
    case "desert": {
      const sunX = w * (0.55 + rand() * 0.3);
      return [
        `<circle cx="${sunX}" cy="${h * 0.42}" r="${h * 0.2}" fill="${tint(c.accent, 0.35)}" opacity="0.9"/>`,
        `<path d="M0 ${h * 0.7} Q${w * 0.3} ${h * 0.55} ${w * 0.6} ${h * 0.68} T${w} ${h * 0.62} L${w} ${h} L0 ${h} Z" fill="${c.mid}"/>`,
        `<path d="M0 ${h * 0.82} Q${w * 0.4} ${h * 0.7} ${w * 0.75} ${h * 0.8} T${w} ${h * 0.78} L${w} ${h} L0 ${h} Z" fill="${c.dark}"/>`,
        figure(c, w * (0.2 + rand() * 0.3), h * 0.78, 0.7),
      ].join("");
    }
    case "waves": {
      let out = "";
      for (let i = 0; i < 5; i += 1) {
        const y = h * (0.5 + i * 0.1);
        const amp = h * (0.03 + rand() * 0.03);
        const color = mix(c.mid, c.deep, i / 4);
        let d = `M0 ${y}`;
        for (let x = 0; x <= w; x += w / 8) {
          d += ` Q${x + w / 16} ${y - amp * (rand() > 0.5 ? 1 : -1)} ${x + w / 8} ${y}`;
        }
        out += `<path d="${d} L${w} ${h} L0 ${h} Z" fill="${color}"/>`;
      }
      return out;
    }
    case "orbit": {
      const cx = w * (0.55 + rand() * 0.25);
      const cy = h * 0.55;
      const r = h * 0.34;
      return [
        stars(c, 90, h),
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#planet)"/>`,
        `<ellipse cx="${cx}" cy="${cy}" rx="${r * 1.8}" ry="${r * 0.32}" fill="none" stroke="${tint(c.light, 0.5)}" stroke-width="${h * 0.012}" opacity="0.7" transform="rotate(-14 ${cx} ${cy})"/>`,
      ].join("");
    }
    case "space": {
      let out = stars(c, 160, h);
      for (let i = 0; i < 4; i += 1) {
        out += `<circle cx="${rand() * w}" cy="${rand() * h}" r="${h * (0.18 + rand() * 0.2)}" fill="${i % 2 ? c.light : c.accent}" opacity="0.32" filter="url(#soft)"/>`;
      }
      return out;
    }
    case "neon": {
      const horizon = h * 0.58;
      let out = `<circle cx="${w / 2}" cy="${horizon}" r="${h * 0.24}" fill="url(#sun)"/>`;
      out += `<rect x="0" y="${horizon}" width="${w}" height="${h - horizon}" fill="${c.deep}"/>`;
      for (let i = 0; i <= 18; i += 1) {
        const x = (w / 18) * i;
        out += `<line x1="${w / 2 + (x - w / 2) * 0.08}" y1="${horizon}" x2="${(x - w / 2) * 2.2 + w / 2}" y2="${h}" stroke="${c.accent}" stroke-width="2" opacity="0.55"/>`;
      }
      for (let i = 1; i < 9; i += 1) {
        const y = horizon + (h - horizon) * (i / 9) ** 1.8;
        out += `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="${c.accent}" stroke-width="2" opacity="0.5"/>`;
      }
      return `${out}<line x1="0" y1="${horizon}" x2="${w}" y2="${horizon}" stroke="${tint(c.accent, 0.4)}" stroke-width="4"/>`;
    }
    case "storm": {
      let out = "";
      for (let i = 0; i < 9; i += 1) {
        out += `<ellipse cx="${rand() * w}" cy="${h * (0.1 + rand() * 0.3)}" rx="${w * (0.15 + rand() * 0.2)}" ry="${h * 0.12}" fill="${i % 2 ? c.dark : c.mid}" opacity="0.75" filter="url(#soft)"/>`;
      }
      const lx = w * (0.3 + rand() * 0.4);
      out += `<polyline points="${lx},${h * 0.3} ${lx - 40},${h * 0.5} ${lx + 10},${h * 0.52} ${lx - 50},${h * 0.8}" fill="none" stroke="${tint(c.light, 0.8)}" stroke-width="7" stroke-linejoin="round"/>`;
      return out + ridge(c, h * 0.86, h * 0.08, 10, c.deep);
    }
    case "sunset": {
      const horizon = h * 0.64;
      let out = `<circle cx="${w * (0.35 + rand() * 0.3)}" cy="${horizon}" r="${h * 0.28}" fill="url(#sun)"/>`;
      for (let i = 0; i < 5; i += 1) {
        out += `<rect x="0" y="${horizon - h * 0.04 * (i + 1) - 4}" width="${w}" height="${3 + i}" fill="${c.mid}" opacity="0.65"/>`;
      }
      out += `<rect x="0" y="${horizon}" width="${w}" height="${h - horizon}" fill="${shade(c.mid, 0.35)}"/>`;
      for (let i = 0; i < 12; i += 1) {
        out += `<rect x="${w * (0.3 + rand() * 0.4)}" y="${horizon + 10 + i * 18}" width="${w * (0.05 + rand() * 0.15)}" height="4" fill="${tint(c.accent, 0.3)}" opacity="0.4"/>`;
      }
      return out;
    }
    case "grid": {
      let out = "";
      const size = h / 6;
      for (let gx = 0; gx < w / size; gx += 1) {
        for (let gy = 0; gy < 6; gy += 1) {
          if (rand() > 0.55) {
            out += `<rect x="${gx * size + 6}" y="${gy * size + 6}" width="${size - 12}" height="${size - 12}" fill="${rand() > 0.7 ? c.accent : c.mid}" opacity="${(0.25 + rand() * 0.5).toFixed(2)}" transform="rotate(${(rand() * 8 - 4).toFixed(1)} ${gx * size + size / 2} ${gy * size + size / 2})"/>`;
          }
        }
      }
      return out;
    }
    case "bloom": {
      const cx = w * (0.55 + rand() * 0.2);
      const cy = h * 0.5;
      let out = "";
      for (let ring = 0; ring < 3; ring += 1) {
        const petals = 10 + ring * 4;
        const length = h * (0.42 - ring * 0.11);
        for (let i = 0; i < petals; i += 1) {
          const angle = (360 / petals) * i + ring * 9;
          out += `<ellipse cx="${cx}" cy="${cy - length / 2}" rx="${length * 0.16}" ry="${length / 2}" fill="${[c.mid, c.light, c.accent][ring]}" opacity="${0.5 + ring * 0.15}" transform="rotate(${angle} ${cx} ${cy})"/>`;
        }
      }
      return `${out}<circle cx="${cx}" cy="${cy}" r="${h * 0.05}" fill="${tint(c.accent, 0.5)}"/>`;
    }
  }
}

// --- Composition -------------------------------------------------------------------------------

const SIZES: Record<ArtKind, [number, number]> = {
  backdrop: [1920, 1080],
  card: [1280, 720],
  still: [1280, 720],
  poster: [800, 1200],
  logo: [1600, 400],
};

/** SVG markup for one artwork. `width` is the requested pixel width (sets the intrinsic size). */
export function renderArtwork(input: ArtInput, width?: number): string {
  const [w, h] = SIZES[input.kind];
  const rand = random(hashString(`${input.seed}:${input.variant ?? 0}`));
  const [a, b] = input.palette;
  const outW = width ?? w;
  const outH = Math.round((outW / w) * h);

  if (input.kind === "logo") {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${outW}" height="${outH}"><defs><filter id="shadow" x="-10%" y="-30%" width="120%" height="160%"><feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#000" flood-opacity="0.55"/></filter></defs>${titleTreatment(input, { x: 0, y: 10, width: w, height: h - 20 }, "start", "#fbf7f0")}</svg>`;
  }

  const c: Canvas = {
    width: w,
    height: h,
    rand,
    light: tint(a, 0.15),
    mid: shade(mix(a, b, 0.5), 0.25),
    dark: shade(b, 0.45),
    deep: shade(b, 0.7),
    accent: b,
  };
  // Portrait posters reuse landscape motifs, rendered into a taller frame.
  const motifCanvas: Canvas = input.kind === "poster" ? { ...c, width: h * 1.6, height: h } : c;
  const motifOffset = input.kind === "poster" ? -(h * 1.6 - w) / 2 : 0;
  const glowX = (0.2 + rand() * 0.6) * w;
  const glowY = (0.15 + rand() * 0.3) * h;
  const withTitle = input.kind === "card" || input.kind === "poster";
  // Backdrops sit behind text and UI: keep them a stop darker than card art.
  const skyTop = input.kind === "backdrop" ? shade(a, 0.2) : tint(a, 0.12);
  const glowOpacity = input.kind === "backdrop" ? 0.5 : 0.75;

  const defs = `<defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="${skyTop}"/><stop offset="1" stop-color="${shade(b, 0.55)}"/></linearGradient>
    <radialGradient id="glow" cx="${glowX / w}" cy="${glowY / h}" r="0.6"><stop offset="0" stop-color="${tint(a, 0.55)}" stop-opacity="${glowOpacity}"/><stop offset="1" stop-color="${a}" stop-opacity="0"/></radialGradient>
    <radialGradient id="sun" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${tint(b, 0.7)}"/><stop offset="0.7" stop-color="${tint(b, 0.25)}"/><stop offset="1" stop-color="${b}" stop-opacity="0.2"/></radialGradient>
    <radialGradient id="planet" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stop-color="${tint(a, 0.4)}"/><stop offset="0.6" stop-color="${c.mid}"/><stop offset="1" stop-color="${c.deep}"/></radialGradient>
    <radialGradient id="vignette" cx="0.5" cy="0.45" r="0.75"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.6"/></radialGradient>
    <linearGradient id="foot" x1="0" y1="0" x2="0" y2="1"><stop offset="0.45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.75"/></linearGradient>
    <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${h * 0.04}"/></filter>
    <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.09 0"/></filter>
    <filter id="shadow" x="-10%" y="-30%" width="120%" height="160%"><feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#000" flood-opacity="0.6"/></filter>
  </defs>`;

  const title =
    input.kind === "card"
      ? titleTreatment(
          input,
          { x: w * 0.06, y: h * 0.5, width: w * 0.6, height: h * 0.4 },
          "start",
          "#fbf7f0",
        )
      : input.kind === "poster"
        ? titleTreatment(
            input,
            { x: w * 0.08, y: h * 0.66, width: w * 0.84, height: h * 0.24 },
            "middle",
            "#fbf7f0",
          )
        : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${outW}" height="${outH}" preserveAspectRatio="xMidYMid slice">${defs}
  <rect width="${w}" height="${h}" fill="url(#sky)"/>
  <rect width="${w}" height="${h}" fill="url(#glow)"/>
  <g transform="translate(${motifOffset} 0)">${motifLayer(input.motif, motifCanvas)}</g>
  <rect width="${w}" height="${h}" fill="url(#vignette)"/>
  ${withTitle ? `<rect width="${w}" height="${h}" fill="url(#foot)"/>` : ""}
  <rect width="${w}" height="${h}" filter="url(#grain)" opacity="0.5"/>
  ${title}
</svg>`;
}

/** Profile avatar: a friendly geometric face on a bold colour. */
export function renderAvatar(seed: string): string {
  const rand = random(hashString(seed));
  const hues = [
    "#ffa31a",
    "#46d483",
    "#7ab8ff",
    "#ff6b9a",
    "#b58cff",
    "#ffd166",
    "#4cc9f0",
    "#ff7a5c",
  ];
  const bg = hues[Math.floor(rand() * hues.length)] ?? "#ffa31a";
  const face = shade(bg, 0.78);
  const eyeY = 42 + rand() * 6;
  const smile = 8 + rand() * 8;
  const shape = Math.floor(rand() * 3);
  const accessory =
    shape === 0
      ? `<circle cx="50" cy="50" r="40" fill="${tint(bg, 0.25)}" opacity="0.5"/>`
      : shape === 1
        ? `<path d="M10 100 L50 60 L90 100 Z" fill="${shade(bg, 0.2)}" opacity="0.6"/>`
        : `<rect x="14" y="14" width="72" height="72" rx="18" fill="${tint(bg, 0.2)}" opacity="0.45" transform="rotate(12 50 50)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="320" height="320"><rect width="100" height="100" fill="${bg}"/>${accessory}<circle cx="36" cy="${eyeY}" r="6" fill="${face}"/><circle cx="64" cy="${eyeY}" r="6" fill="${face}"/><path d="M32 ${eyeY + 16} Q50 ${eyeY + 16 + smile} 68 ${eyeY + 16}" fill="none" stroke="${face}" stroke-width="6" stroke-linecap="round"/></svg>`;
}
