import type { RowLayout } from "@webflix/contracts";

/** Cards per page by breakpoint (must match the container queries in components.css). */
export const SLIDER_PER_PAGE = [
  { minWidth: 1400, perPage: 6 },
  { minWidth: 1100, perPage: 5 },
  { minWidth: 800, perPage: 4 },
  { minWidth: 500, perPage: 3 },
  { minWidth: 0, perPage: 2 },
] as const;

/**
 * `sizes` attribute for artwork in a full-bleed row: each card is (100vw − 2 × 4vw gutter) ÷
 * cards-per-page; ranked rows show the poster at half the cell width.
 */
export function sliderImageSizes(layout: RowLayout): string {
  const factor = layout === "ranked" ? 0.5 : 1;
  return SLIDER_PER_PAGE.map(({ minWidth, perPage }) => {
    const vw = Math.ceil((92 / perPage) * factor);
    return minWidth > 0 ? `(min-width: ${minWidth}px) ${vw}vw` : `${vw}vw`;
  }).join(", ");
}
