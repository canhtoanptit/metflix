/**
 * Trick-play thumbnail geometry: which sprite-sheet cell covers a position, scaled to the size
 * the scrubber preview is drawn at. The sheet layout itself lives in `trickPlayTile`
 * (`@webflix/contracts`, shared with the media pipeline).
 */
import { type TrickPlay, trickPlayTile } from "@webflix/contracts";

export interface TrickPlayFrame {
  sheetUrl: string;
  /** Display size in CSS px. */
  width: number;
  height: number;
  /** `background-size` for the whole sheet at that scale. */
  sheetWidth: number;
  sheetHeight: number;
  /** `background-position` (negative offsets) at that scale. */
  offsetX: number;
  offsetY: number;
}

/**
 * The thumbnail for `positionSec`, drawn `displayWidth` CSS px wide (height keeps the tile's
 * aspect ratio). Null when there is no thumbnail for that position.
 */
export function trickPlayFrame(
  trickPlay: TrickPlay,
  positionSec: number,
  displayWidth: number,
): TrickPlayFrame | null {
  const tile = trickPlayTile(trickPlay, Math.max(0, positionSec));
  if (!tile || displayWidth <= 0) return null;
  const scale = displayWidth / trickPlay.tileWidth;
  return {
    sheetUrl: tile.sheetUrl,
    width: round(trickPlay.tileWidth * scale),
    height: round(trickPlay.tileHeight * scale),
    sheetWidth: round(trickPlay.tileWidth * trickPlay.columns * scale),
    sheetHeight: round(trickPlay.tileHeight * trickPlay.rows * scale),
    offsetX: round(-tile.x * scale),
    offsetY: round(-tile.y * scale),
  };
}

/** Every sheet URL, in order, for preloading when the pointer first approaches the scrubber. */
export function trickPlaySheets(trickPlay: TrickPlay | null): readonly string[] {
  return trickPlay && trickPlay.count > 0 ? trickPlay.sheets : [];
}

/**
 * Keep a preview of `width` centred on `x` inside `[gutter, containerWidth - gutter]`.
 * Returns the left edge.
 */
export function clampPreviewLeft(
  x: number,
  width: number,
  containerWidth: number,
  gutter: number,
): number {
  const min = gutter;
  const max = Math.max(min, containerWidth - gutter - width);
  return Math.min(max, Math.max(min, x - width / 2));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
