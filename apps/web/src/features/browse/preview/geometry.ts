/**
 * Where a hover preview sits and how it grows out of its card. Pure (viewport coordinates in,
 * pixels out) so the placement rules are unit-tested.
 *
 * - The preview is `scale` × the card's width, its 16:9 picture centred on the card.
 * - The first/last visible card of a row expands inward (aligned to that card's outer edge), so
 *   the preview never crosses the page gutter, where the row's arrows live.
 * - It stays inside the gutters horizontally, below the navigation and above the bottom of the
 *   viewport vertically (the info panel's height is measured, then the box is shifted up).
 * - The transform origin is chosen so that scaling the box by `fromScale` lands its picture
 *   exactly on the card: the open animation starts *as* the card (a shared-element grow).
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GeometryInput {
  /** The card's rect (viewport coordinates). */
  rect: Box;
  edge: "start" | "end" | null;
  viewport: { width: number; height: number };
  /** Page gutter (px). */
  gutter: number;
  /** Height of the fixed navigation (px): the preview never slides under it. */
  navHeight: number;
  /** Measured total height (picture + info panel), once known. */
  height?: number;
  /** Width multiplier relative to the card (default 1.5). */
  scale?: number;
  /** Narrowest useful preview (px), within the gutters. */
  minWidth?: number;
}

export interface PreviewGeometry {
  left: number;
  top: number;
  width: number;
  /** Height of the 16:9 picture. */
  mediaHeight: number;
  /** Scale at which the preview's picture matches the card's width. */
  fromScale: number;
  /** Transform origin (px, relative to the preview box). */
  originX: number;
  originY: number;
}

const MARGIN = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function previewGeometry(input: GeometryInput): PreviewGeometry {
  const { rect, edge, viewport, gutter, navHeight } = input;
  const scale = input.scale ?? 1.5;
  const maxWidth = Math.max(0, viewport.width - gutter * 2);
  const width = clamp(rect.width * scale, Math.min(input.minWidth ?? 300, maxWidth), maxWidth);
  const mediaHeight = (width * 9) / 16;

  let left =
    edge === "start"
      ? rect.left
      : edge === "end"
        ? rect.left + rect.width - width
        : rect.left + rect.width / 2 - width / 2;
  left = clamp(left, gutter, viewport.width - gutter - width);

  const centreY = rect.top + rect.height / 2;
  let top = centreY - mediaHeight / 2;
  const minTop = navHeight + MARGIN;
  if (input.height !== undefined) {
    top = Math.min(top, viewport.height - MARGIN - input.height);
  }
  top = Math.max(top, minTop);

  // Map the picture's centre onto the card's centre at `fromScale`: p + s (x − p) = c.
  const fromScale = Math.min(1, rect.width / width);
  const cardCentreX = rect.left + rect.width / 2 - left;
  const cardCentreY = centreY - top;
  const free = 1 - fromScale;
  const originX = free < 0.01 ? width / 2 : (cardCentreX - (fromScale * width) / 2) / free;
  const originY =
    free < 0.01 ? mediaHeight / 2 : (cardCentreY - (fromScale * mediaHeight) / 2) / free;

  return { left, top, width, mediaHeight, fromScale, originX, originY };
}
