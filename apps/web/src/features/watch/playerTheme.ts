import type { CSSProperties } from "react";

/**
 * The player's `--wfp-*` theme variables mapped onto Webflix design tokens, so the player reads
 * as part of the product (amber accent, Inter, our surfaces, radii and motion) and follows
 * token changes automatically. Variables not listed keep the player's defaults: pure-black
 * scrims, caption styling tuned for legibility, and durations (ours collapse to 0 under reduced
 * motion, while the player keeps its state-carrying fades and handles reduced motion itself).
 */
export const PLAYER_THEME = {
  "--wfp-font-family": "var(--font-sans)",
  "--wfp-caption-font-family": "var(--font-sans)",
  "--wfp-accent": "var(--color-accent)",
  "--wfp-advisory-accent": "var(--color-accent)",
  "--wfp-text": "var(--color-fg)",
  "--wfp-text-muted": "var(--color-fg-muted)",
  "--wfp-text-dim": "var(--color-fg-subtle)",
  // Opaque (captions sit beneath menus and panels).
  "--wfp-surface": "var(--color-surface-2)",
  "--wfp-surface-raised": "var(--color-line-subtle)",
  "--wfp-border": "var(--color-line)",
  "--wfp-backdrop": "var(--color-black)",
  "--wfp-focus-ring": "var(--color-focus)",
  "--wfp-track": "var(--color-track)",
  "--wfp-buffered": "var(--color-line-strong)",
  "--wfp-radius-sm": "var(--radius-sm)",
  "--wfp-radius-md": "var(--radius-md)",
  "--wfp-radius-lg": "var(--radius-xl)",
  "--wfp-ease": "var(--ease-standard)",
  "--wfp-ease-out": "var(--ease-enter)",
} as CSSProperties;
