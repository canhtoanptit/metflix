// Minimal typings for the parts of fontkit 3 the renderer uses (the package ships none).
declare module "fontkit" {
  export interface BBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }
  export interface Path {
    commands: { command: string; args: number[] }[];
    bbox: BBox;
    toSVG(): string;
    transform(m0: number, m1: number, m2: number, m3: number, m4: number, m5: number): Path;
  }
  export interface Glyph {
    id: number;
    path: Path;
    advanceWidth: number;
    bbox: BBox;
  }
  export interface GlyphPosition {
    xAdvance: number;
    yAdvance: number;
    xOffset: number;
    yOffset: number;
  }
  export interface GlyphRun {
    glyphs: Glyph[];
    positions: GlyphPosition[];
    advanceWidth: number;
  }
  export interface Font {
    familyName: string;
    unitsPerEm: number;
    ascent: number;
    descent: number;
    capHeight?: number;
    xHeight?: number;
    layout(text: string, features?: string[] | Record<string, boolean>): GlyphRun;
    glyphForCodePoint(codePoint: number): Glyph;
    hasGlyphForCodePoint(codePoint: number): boolean;
  }
  export function create(buffer: Uint8Array): Font;
  export function openSync(path: string): Font;
}
