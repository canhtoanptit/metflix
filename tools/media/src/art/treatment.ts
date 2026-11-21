/**
 * Title treatments: the typographic logo of a title, laid out to fit a box (logo, card, poster)
 * and dressed with effects that vary by genre and tone (metal, ember, neon, distressed,
 * prestige rules…). Output is a standalone SVG with a transparent background.
 */
import { type ShapedText, shapeText } from "./fonts.ts";

export type Paint =
  | { kind: "solid"; color: string }
  /** Vertical gradient across each line's cap height (metal, ember, sunset…). */
  | { kind: "linear"; stops: readonly (readonly [offset: number, color: string])[] };

export interface TreatmentStyle {
  font: string;
  /** For the small leading article ("THE") and subtitles; defaults to `font`. */
  kickerFont?: string;
  case: "upper" | "title" | "lower" | "asis";
  /** Letter-spacing in em. */
  tracking: number;
  /** Gap between lines as a fraction of the cap height. */
  lineGap: number;
  align: "left" | "center";
  /** `auto`: set a leading "The"/"A" small above the title. */
  kicker: "auto" | "none";
  /** Scale every line to the same width (stacked poster lockup). */
  justify: boolean;
  maxLines: number;
  fill: Paint;
  stroke?: { color: string; width: number; opacity?: number };
  /** Soft drop shadow for legibility over imagery (em units). */
  shadow?: { color: string; blur: number; dy: number; opacity: number };
  glow?: { color: string; blur: number; opacity: number };
  texture?: "none" | "grain" | "distress";
  /** Thin rules above and below the block (prestige drama, period pieces). */
  rules?: boolean;
  /** Vertical stretch of the glyphs (1 = none). */
  scaleY?: number;
  /** Optional small line under the title, e.g. "A WEBFLIX DOCUMENTARY". */
  subtitle?: string;
}

interface LineLayout {
  text: string;
  shaped: ShapedText;
  /** Scale relative to the reference size. */
  scale: number;
  kicker: boolean;
}

export interface Treatment {
  svg: string;
  width: number;
  height: number;
}

const REF = 100;
const KICKER_WORDS = new Set(["the", "a", "an"]);

function applyCase(text: string, mode: TreatmentStyle["case"]): string {
  if (mode === "upper") return text.toLocaleUpperCase("en");
  if (mode === "lower") return text.toLocaleLowerCase("en");
  return text;
}

/** All ways to break `words` into `lines` contiguous groups. */
function* breaks(words: readonly string[], lines: number): Generator<string[]> {
  if (lines === 1) {
    yield [words.join(" ")];
    return;
  }
  for (let cut = 1; cut <= words.length - lines + 1; cut += 1) {
    const head = words.slice(0, cut).join(" ");
    for (const rest of breaks(words.slice(cut), lines - 1)) yield [head, ...rest];
  }
}

function lineHeight(shaped: ShapedText, scale: number, scaleY: number): number {
  return shaped.capHeight * scale * scaleY;
}

/** Ink below the baseline (descenders) for the last line. */
function descender(shaped: ShapedText, scale: number, scaleY: number): number {
  return Math.max(0, shaped.bounds.maxY) * scale * scaleY;
}

/** Ink above the cap height (accents, tall ascenders, swashes). */
function overshoot(shaped: ShapedText, scale: number, scaleY: number): number {
  return Math.max(0, -shaped.bounds.minY - shaped.capHeight) * scale * scaleY;
}

/** Minimum clear space between the ink of two lines, as a fraction of the upper cap height. */
const MIN_CLEARANCE = 0.14;

/**
 * Baseline of `above` to cap line of `below`, in reference units: the style's gap, widened so
 * descenders (g, y, swashes) never touch ascenders or accents of the next line.
 */
function gapBetween(
  above: LineLayout,
  below: LineLayout,
  style: TreatmentStyle,
  scaleY: number,
): number {
  const cap = above.shaped.capHeight * Math.max(above.scale, 0.6) * scaleY;
  const styled = (above.kicker ? 0.55 : style.lineGap) * cap;
  const ink =
    descender(above.shaped, above.scale, scaleY) +
    overshoot(below.shaped, below.scale, scaleY) +
    MIN_CLEARANCE * cap;
  return Math.max(styled, ink);
}

function layoutLines(name: string, style: TreatmentStyle, aspect: number): LineLayout[] {
  const display = applyCase(name, style.case);
  const words = display.split(/\s+/).filter(Boolean);
  let kicker: LineLayout | null = null;
  let body = words;
  if (
    style.kicker === "auto" &&
    words.length >= 2 &&
    KICKER_WORDS.has((words[0] ?? "").toLowerCase())
  ) {
    const kickerFont = style.kickerFont ?? style.font;
    kicker = {
      text: words[0] ?? "",
      shaped: shapeText(kickerFont, words[0] ?? "", REF, Math.max(style.tracking, 0.18)),
      scale: 0.36,
      kicker: true,
    };
    body = words.slice(1);
  }
  let best: { lines: LineLayout[]; score: number } | null = null;
  const maxLines = Math.min(style.maxLines, body.length);
  for (let count = 1; count <= maxLines; count += 1) {
    for (const split of breaks(body, count)) {
      const shapedLines = split.map((text) => shapeText(style.font, text, REF, style.tracking));
      const widest = Math.max(...shapedLines.map((line) => line.width));
      const lines: LineLayout[] = shapedLines.map((shaped, index) => ({
        text: split[index] ?? "",
        shaped,
        scale: style.justify ? Math.min(widest / Math.max(shaped.width, 1), 1.7) : 1,
        kicker: false,
      }));
      // A long single word ("UNDERSTUDY") shrinks the whole block to fit the width; keep the
      // kicker legible by growing it with the body's proportions.
      const bodyCap = lines[0]?.shaped.capHeight ?? REF * 0.7;
      const all = kicker
        ? [
            { ...kicker, scale: Math.min(0.55, Math.max(0.36, (0.045 * widest) / bodyCap)) },
            ...lines,
          ]
        : lines;
      const width = Math.max(...all.map((line) => line.shaped.width * line.scale));
      const height = blockHeight(all, style);
      // How big the block can be drawn in a box of this aspect ratio (bigger is better).
      const fit = Math.min(aspect / width, 1 / height);
      const widths = lines.map((line) => line.shaped.width * line.scale);
      const balance = Math.min(...widths) / Math.max(...widths);
      const orphan = lines.some((line) => line.text.length <= 3 && lines.length > 1) ? 0.8 : 1;
      const score = fit * (0.75 + 0.25 * balance) * orphan * (count === 1 ? 1.06 : 1);
      if (!best || score > best.score) best = { lines: all, score };
    }
  }
  return best?.lines ?? [];
}

function blockHeight(lines: readonly LineLayout[], style: TreatmentStyle): number {
  const scaleY = style.scaleY ?? 1;
  let height = 0;
  lines.forEach((line, index) => {
    height += lineHeight(line.shaped, line.scale, scaleY);
    const next = lines[index + 1];
    if (next) height += gapBetween(line, next, style, scaleY);
  });
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (first) height += overshoot(first.shaped, first.scale, scaleY);
  if (last) height += descender(last.shaped, last.scale, scaleY);
  return height;
}

function paintDefs(id: string, paint: Paint): { defs: string; ref: string } {
  if (paint.kind === "solid") return { defs: "", ref: paint.color };
  const stops = paint.stops
    .map(([offset, color]) => `<stop offset="${offset}" stop-color="${color}"/>`)
    .join("");
  // objectBoundingBox: every line runs through the whole gradient, like a cast metal logo.
  return {
    defs: `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient>`,
    ref: `url(#${id})`,
  };
}

/**
 * Lay out `name` for a box of `boxWidth` × `boxHeight` px and render it with the style's
 * effects. The returned SVG is cropped to the ink plus room for glows and shadows.
 */
export function buildTreatment(
  name: string,
  style: TreatmentStyle,
  boxWidth: number,
  boxHeight: number,
): Treatment {
  const lines = layoutLines(name, style, boxWidth / boxHeight);
  const scaleY = style.scaleY ?? 1;
  const refWidth = Math.max(...lines.map((line) => line.shaped.width * line.scale));
  const refHeight = blockHeight(lines, style);
  const subtitleRatio = style.subtitle ? 0.16 : 0;
  const k = Math.min(boxWidth / refWidth, boxHeight / (refHeight * (1 + subtitleRatio * 1.6)));
  const mainCap = (lines.find((line) => !line.kicker)?.shaped.capHeight ?? REF * 0.7) * k;
  const em = mainCap / 0.7;

  // Effect padding so blurs are not clipped.
  const pad = Math.ceil(
    Math.max(
      style.glow ? style.glow.blur * em * 2.4 : 0,
      style.shadow ? (style.shadow.blur * 2.4 + Math.abs(style.shadow.dy)) * em : 0,
      style.stroke ? style.stroke.width * em : 0,
      em * 0.06,
    ),
  );
  const width = Math.ceil(refWidth * k) + pad * 2;

  const paths: string[] = [];
  const ruleThickness = Math.max(1.5, em * 0.018);
  const ruleGap = em * 0.24;
  let y = pad + (style.rules ? ruleThickness + ruleGap : 0);
  const first = lines[0];
  if (first) y += overshoot(first.shaped, first.scale, scaleY) * k;
  lines.forEach((line, index) => {
    const s = line.scale * k;
    const capPx = line.shaped.capHeight * s * scaleY;
    const baseline = y + capPx;
    const lineWidth = line.shaped.width * s;
    const x = style.align === "center" ? (width - lineWidth) / 2 : pad;
    paths.push(
      `<path transform="translate(${x.toFixed(2)} ${baseline.toFixed(2)}) scale(${s.toFixed(5)} ${(s * scaleY).toFixed(5)})" d="${line.shaped.d}"/>`,
    );
    y = baseline;
    const next = lines[index + 1];
    if (next) y += gapBetween(line, next, style, scaleY) * k;
  });
  const last = lines[lines.length - 1];
  if (last) y += descender(last.shaped, last.scale, scaleY) * k;

  let subtitlePath = "";
  if (style.subtitle) {
    const subFont = style.kickerFont ?? style.font;
    const subSize = em * 0.2;
    const shaped = shapeText(subFont, style.subtitle.toLocaleUpperCase("en"), REF, 0.32);
    const s = Math.min(subSize / REF, (refWidth * k * 0.9) / shaped.width);
    const subWidth = shaped.width * s;
    const x = style.align === "center" ? (width - subWidth) / 2 : pad;
    y += em * 0.28;
    const baseline = y + shaped.capHeight * s;
    subtitlePath = `<path transform="translate(${x.toFixed(2)} ${baseline.toFixed(2)}) scale(${s.toFixed(5)})" d="${shaped.d}"/>`;
    y = baseline;
  }

  let rules = "";
  if (style.rules) {
    const ruleWidth = Math.min(refWidth * k * 0.9, em * 6);
    const x = style.align === "center" ? (width - ruleWidth) / 2 : pad;
    const bottomRule = y + ruleGap;
    rules = `<rect x="${x.toFixed(1)}" y="${pad}" width="${ruleWidth.toFixed(1)}" height="${ruleThickness.toFixed(1)}"/><rect x="${x.toFixed(1)}" y="${bottomRule.toFixed(1)}" width="${ruleWidth.toFixed(1)}" height="${ruleThickness.toFixed(1)}"/>`;
    y = bottomRule + ruleThickness;
  }
  const height = Math.ceil(y) + pad;

  const glyphs = `${paths.join("")}${subtitlePath}`;
  const paint = paintDefs("fill", style.fill);
  const defs: string[] = [paint.defs, `<clipPath id="ink">${glyphs}</clipPath>`];
  const layers: string[] = [];

  if (style.glow) {
    defs.push(
      `<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${(style.glow.blur * em).toFixed(2)}"/></filter>`,
    );
    layers.push(
      `<g filter="url(#glow)" fill="${style.glow.color}" opacity="${style.glow.opacity}">${glyphs}${rules}</g>`,
    );
  }
  if (style.shadow) {
    defs.push(
      `<filter id="shadow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${(style.shadow.blur * em).toFixed(2)}"/></filter>`,
    );
    layers.push(
      `<g filter="url(#shadow)" fill="${style.shadow.color}" opacity="${style.shadow.opacity}" transform="translate(0 ${(style.shadow.dy * em).toFixed(2)})">${glyphs}${rules}</g>`,
    );
  }
  if (style.stroke) {
    layers.push(
      `<g fill="none" stroke="${style.stroke.color}" stroke-width="${(style.stroke.width * em * 2).toFixed(2)}" stroke-linejoin="round" opacity="${style.stroke.opacity ?? 1}">${glyphs}</g>`,
    );
  }
  let mask = "";
  if (style.texture === "distress") {
    defs.push(
      `<filter id="wear" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="${(5.5 / em).toFixed(4)} ${(4 / em).toFixed(4)}" numOctaves="3" seed="7"/><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 14 0 0 0 -9.1"/></filter>`,
      `<mask id="worn" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="white"/><rect width="${width}" height="${height}" fill="black" filter="url(#wear)"/></mask>`,
    );
    mask = ` mask="url(#worn)"`;
  }
  layers.push(`<g fill="${paint.ref}">${glyphs}${rules}</g>`);
  if (style.texture === "grain" || style.texture === "distress") {
    defs.push(
      `<filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="3"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="0" intercept="0.22"/></feComponentTransfer></filter>`,
    );
    layers.push(
      `<g clip-path="url(#ink)"><rect width="${width}" height="${height}" filter="url(#grain)" style="mix-blend-mode:multiply"/></g>`,
    );
  }

  // Wear goes through every layer, so holes show what is behind the logo, not its shadow.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${defs.join("")}</defs><g${mask}>${layers.join("")}</g></svg>`;
  return { svg, width, height };
}
