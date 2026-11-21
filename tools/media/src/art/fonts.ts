/**
 * Typography as geometry: text is shaped with fontkit (kerning, ligatures) and emitted as SVG
 * path data, so title treatments render identically everywhere (no system fonts, no
 * fontconfig) and can be filled, stroked, masked and filtered like any other shape.
 */
import { readFileSync } from "node:fs";
import * as fontkit from "fontkit";
import { FONTS_DIR } from "../paths.ts";
import { type FontEntry, fontFile } from "./fonts-fetch.ts";

const registry = JSON.parse(readFileSync(`${FONTS_DIR}/fonts.json`, "utf8")) as {
  fonts: FontEntry[];
};
export const FONT_IDS = registry.fonts.map((font) => font.id);

const cache = new Map<string, fontkit.Font>();

export function loadFont(id: string): fontkit.Font {
  let font = cache.get(id);
  if (!font) {
    const entry = registry.fonts.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`Unknown font ${id} (see tools/media/fonts/fonts.json)`);
    font = fontkit.create(readFileSync(fontFile(entry)));
    cache.set(id, font);
  }
  return font;
}

export interface ShapedText {
  /** SVG path data, baseline at y = 0, starting at x = 0. */
  d: string;
  /** Advance width including tracking (but not after the last glyph). */
  width: number;
  /** Tight ink bounds. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Cap height and descent of the font at this size (for consistent line spacing). */
  capHeight: number;
  ascent: number;
  descent: number;
}

const capHeights = new WeakMap<fontkit.Font, number>();

/**
 * Cap height measured from the ink of "H" (falling back to the OS/2 value). Several display
 * faces (Special Elite, Rye, UnifrakturMaguntia) declare a cap height a quarter to half of
 * their real one, which collapses line spacing.
 */
function capHeightUnits(font: fontkit.Font): number {
  const units = capHeights.get(font);
  if (units === undefined) {
    const measured = font.hasGlyphForCodePoint(72)
      ? font.layout("H").glyphs[0]?.path.bbox.maxY
      : undefined;
    const declared = font.capHeight && font.capHeight > 0 ? font.capHeight : font.ascent * 0.7;
    const value = measured && Number.isFinite(measured) && measured > 0 ? measured : declared;
    capHeights.set(font, value);
    return value;
  }
  return units;
}

/** Fonts without a glyph for a character (é in some display faces) get a plain substitute. */
function displayable(font: fontkit.Font, text: string): string {
  return [...text]
    .map((char) => {
      const code = char.codePointAt(0) ?? 32;
      if (char === " " || font.hasGlyphForCodePoint(code)) return char;
      const plain = char.normalize("NFD").replace(/[̀-ͯ]/g, "");
      return plain && font.hasGlyphForCodePoint(plain.codePointAt(0) ?? 32) ? plain : char;
    })
    .join("");
}

/**
 * Shape `text` at `size` px with `tracking` in em (letter-spacing). Returns path data in px
 * with y pointing down, ready to drop into an SVG.
 */
export function shapeText(fontId: string, text: string, size: number, tracking = 0): ShapedText {
  const font = loadFont(fontId);
  const scale = size / font.unitsPerEm;
  const run = font.layout(displayable(font, text));
  const spacing = tracking * size;
  const parts: string[] = [];
  let pen = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  run.glyphs.forEach((glyph, index) => {
    const position = run.positions[index];
    if (!position) return;
    const x = pen + position.xOffset * scale;
    const y = -position.yOffset * scale;
    const path = glyph.path.transform(scale, 0, 0, -scale, x, y);
    const svg = path.toSVG();
    if (svg) {
      parts.push(svg);
      const box = path.bbox;
      if (Number.isFinite(box.minX)) {
        minX = Math.min(minX, box.minX);
        maxX = Math.max(maxX, box.maxX);
        minY = Math.min(minY, box.minY);
        maxY = Math.max(maxY, box.maxY);
      }
    }
    pen += position.xAdvance * scale + (index < run.glyphs.length - 1 ? spacing : 0);
  });
  const capHeight = capHeightUnits(font) * scale;
  if (!Number.isFinite(minX)) {
    minX = 0;
    maxX = pen;
    minY = -capHeight;
    maxY = 0;
  }
  return {
    d: parts.join(""),
    width: pen,
    bounds: { minX, minY, maxX, maxY },
    capHeight,
    ascent: font.ascent * scale,
    descent: -font.descent * scale,
  };
}
