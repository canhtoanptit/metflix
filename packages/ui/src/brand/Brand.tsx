import { type SVGProps, useId } from "react";
import { cx } from "../lib/cx.ts";
import {
  MARK_GLYPH_HEIGHT,
  MARK_GLYPH_WIDTH,
  MARK_PATH,
  WORDMARK_PATH,
  WORDMARK_VIEWBOX,
} from "./paths.ts";

type SvgProps = Omit<SVGProps<SVGSVGElement>, "children" | "ref">;

export type BrandTone = "brand" | "light" | "dark";

function useFill(tone: BrandTone) {
  const gradientId = `wf-brand-${useId().replaceAll(":", "")}`;
  const fill =
    tone === "brand"
      ? `url(#${gradientId})`
      : tone === "light"
        ? "var(--color-fg)"
        : "var(--color-fg-inverse)";
  const defs =
    tone === "brand" ? (
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: "var(--color-brand-light)" }} />
          <stop offset="1" style={{ stopColor: "var(--color-brand-deep)" }} />
        </linearGradient>
      </defs>
    ) : null;
  return { fill, defs };
}

export interface WordmarkProps extends SvgProps {
  /** `brand` (amber light gradient, default), `light` (paper white) or `dark` (on light fills). */
  tone?: BrandTone;
  /** Accessible name; the wordmark is an image of the product name. */
  title?: string;
}

/**
 * The WEBFLIX wordmark. Size it with a height (`className="h-6"`); the width follows the aspect
 * ratio. Clear space: at least half the cap height on every side.
 */
export function Wordmark({ tone = "brand", title = "Webflix", className, ...rest }: WordmarkProps) {
  const { fill, defs } = useFill(tone);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={WORDMARK_VIEWBOX}
      role="img"
      aria-label={title}
      className={cx("wf-wordmark", className)}
      {...rest}
    >
      {defs}
      <path d={WORDMARK_PATH} fill={fill} />
    </svg>
  );
}

const MARK_PAD = 0.14;
const markSize = MARK_GLYPH_WIDTH * (1 + MARK_PAD * 2);
const markX = -MARK_GLYPH_WIDTH * MARK_PAD;
const markY = (MARK_GLYPH_HEIGHT - markSize) / 2;

export interface BrandMarkProps extends SvgProps {
  tone?: BrandTone;
  /** Accessible name; omit when decorative (e.g. next to the wordmark). */
  title?: string;
}

/** The compact "W" mark: badges on Originals, loading splash, small spaces. */
export function BrandMark({ tone = "brand", title, className, ...rest }: BrandMarkProps) {
  const { fill, defs } = useFill(tone);
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative by default (aria-hidden); labelled with aria-label when `title` is given.
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`${markX} ${markY} ${markSize} ${markSize}`}
      className={cx("wf-mark", className)}
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true })}
      {...rest}
    >
      {defs}
      <path d={MARK_PATH} fill={fill} />
    </svg>
  );
}

const TILE_PAD = 0.26;
const tileSize = MARK_GLYPH_WIDTH * (1 + TILE_PAD * 2);
const tileX = -MARK_GLYPH_WIDTH * TILE_PAD;
const tileY = (MARK_GLYPH_HEIGHT - tileSize) / 2 + MARK_GLYPH_HEIGHT * 0.02;

export interface AppIconProps extends SvgProps {
  title?: string;
}

/** App icon: dark "W" on the amber tile (favicons, install icons, the profile gate splash). */
export function AppIcon({ title, className, ...rest }: AppIconProps) {
  const { fill, defs } = useFill("brand");
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative by default (aria-hidden); labelled with aria-label when `title` is given.
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`${tileX} ${tileY} ${tileSize} ${tileSize}`}
      className={cx("wf-app-icon", className)}
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true })}
      {...rest}
    >
      {defs}
      <rect
        x={tileX}
        y={tileY}
        width={tileSize}
        height={tileSize}
        rx={tileSize * 0.22}
        fill={fill}
      />
      <path d={MARK_PATH} fill="var(--color-fg-on-accent)" />
    </svg>
  );
}

export interface OriginalLabelProps {
  /** "series" or "film" (movies). */
  kind: "series" | "film";
  className?: string;
}

/** "W SERIES" / "W FILM" eyebrow shown above Original titles on the billboard and detail. */
export function OriginalLabel({ kind, className }: OriginalLabelProps) {
  return (
    <span className={cx("inline-flex items-center gap-1.5", className)}>
      <BrandMark className="size-[1.6em]" />
      <span className="type-overline text-fg-muted tracking-widest">
        {kind === "series" ? "Series" : "Film"}
      </span>
    </span>
  );
}
