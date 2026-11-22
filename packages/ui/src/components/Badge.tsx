import type { MATURITY_LEVELS, TitleBadge as TitleBadgeValue } from "@webflix/contracts";
import type { HTMLAttributes } from "react";
import { cx } from "../lib/cx.ts";

const TONES = {
  accent: "bg-accent text-fg-on-accent",
  neutral: "bg-surface-4 text-fg",
  outline: "border border-line-strong text-fg-muted",
  positive: "bg-positive-subtle text-positive",
  danger: "bg-danger-subtle text-danger",
  glass: "bg-glass text-fg backdrop-blur-md",
} as const;
export type BadgeTone = keyof typeof TONES;

const SIZES = {
  sm: "h-4.5 px-1.5 type-overline tracking-wide",
  md: "h-6 px-2 text-xs font-bold tracking-wide uppercase",
} as const;

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: keyof typeof SIZES;
}

/** Compact status label ("New", "Recently added", "Leaving soon"). */
export function Badge({ tone = "neutral", size = "md", className, ...rest }: BadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-xs leading-none",
        SIZES[size],
        TONES[tone],
        className,
      )}
      {...rest}
    />
  );
}

type Maturity = (typeof MATURITY_LEVELS)[number];

export interface MaturityBadgeProps {
  rating: Maturity;
  /** Content advisories shown after the badge ("violence, language"). */
  descriptors?: readonly string[];
  className?: string;
}

/** Maturity rating box. Screen readers hear "Maturity rating 13+". */
export function MaturityBadge({ rating, descriptors, className }: MaturityBadgeProps) {
  return (
    <span className={cx("inline-flex items-center gap-2", className)}>
      <span className="inline-flex h-[1.5em] items-center border border-fg-subtle px-[0.4em] text-[0.875em] font-medium leading-none text-fg-muted">
        <span className="sr-only">Maturity rating </span>
        {rating === "ALL" ? "All" : rating}
      </span>
      {descriptors && descriptors.length > 0 ? (
        <span className="text-[0.875em] text-fg-muted">{descriptors.join(", ")}</span>
      ) : null}
    </span>
  );
}

export interface QualityBadgeProps {
  /** "HD", "4K", "Ultra HD", "5.1", "AD"… */
  children: string;
  className?: string;
}

/** Technical capability tag (outlined, compact). */
export function QualityBadge({ children, className }: QualityBadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex h-[1.35em] items-center rounded-xs border border-line-strong px-[0.35em]",
        "text-[0.75em] font-semibold uppercase leading-none tracking-wide text-fg-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}

export interface Top10BadgeProps {
  className?: string;
  /** Accessible label; defaults to "Top 10". */
  label?: string;
}

/** The amber "TOP 10" square. Sized in `em`: set a font size on the parent to scale it. */
export function Top10Badge({ className, label = "Top 10" }: Top10BadgeProps) {
  return (
    <span
      role="img"
      aria-label={label}
      className={cx(
        "inline-flex size-[2.15em] shrink-0 flex-col items-center justify-center rounded-xs bg-accent text-fg-on-accent",
        "font-display font-black leading-none",
        className,
      )}
    >
      <span aria-hidden className="text-[0.5em] tracking-[0.12em]">
        TOP
      </span>
      <span aria-hidden className="-mt-[0.02em] text-[1em] tracking-tight [font-stretch:85%]">
        10
      </span>
    </span>
  );
}

export const TITLE_BADGE_LABELS: Record<Exclude<TitleBadgeValue, "top-10">, string> = {
  new: "Recently added",
  "new-episodes": "New episodes",
  "leaving-soon": "Leaving soon",
};

/**
 * One short word for the same badges, for narrow cards (posters, phones), where the full label
 * would run across the card into the Originals mark. The full label stays in the accessible name.
 */
export const TITLE_BADGE_SHORT_LABELS: Record<Exclude<TitleBadgeValue, "top-10">, string> = {
  new: "New",
  "new-episodes": "New",
  "leaving-soon": "Leaving",
};

export interface TitleBadgeProps {
  badge: TitleBadgeValue;
  className?: string;
}

/** Renders the contract's `TitleCard.badge` (the one badge the server chose for a card). */
export function TitleBadge({ badge, className }: TitleBadgeProps) {
  if (badge === "top-10") return <Top10Badge className={className} />;
  return (
    <Badge tone={badge === "leaving-soon" ? "neutral" : "accent"} size="sm" className={className}>
      {TITLE_BADGE_LABELS[badge]}
    </Badge>
  );
}
