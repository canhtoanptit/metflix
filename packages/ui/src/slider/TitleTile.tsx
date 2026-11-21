import type { EpisodeRef, Progress, RowLayout, TitleCard } from "@webflix/contracts";
import type { AnchorHTMLAttributes, Ref } from "react";
import { BrandMark } from "../brand/Brand.tsx";
import { TITLE_BADGE_LABELS, Top10Badge } from "../components/Badge.tsx";
import { ProgressBar } from "../components/ProgressBar.tsx";
import { ResponsiveImage } from "../components/ResponsiveImage.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { cx } from "../lib/cx.ts";
import { sliderImageSizes } from "./sizes.ts";

export interface TitleTileProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "title" | "children"> {
  title: TitleCard;
  /** The contract row layout this tile sits in. */
  layout: RowLayout;
  /** `ranked` rows: 1-based rank. */
  rank?: number;
  /** `continue` rows: progress and the episode to resume. */
  progress?: Progress | null;
  episode?: EpisodeRef | null;
  /** Override the image `sizes` (defaults to the slider's per-page widths). */
  sizes?: string;
  /** Eager-load the artwork (first visible row). */
  priority?: boolean;
  ref?: Ref<HTMLAnchorElement>;
}

function episodeLabel(episode: EpisodeRef): string {
  return `Season ${episode.seasonNumber}, episode ${episode.number}: ${episode.name}`;
}

/**
 * A title in a row: landscape card, portrait poster, ranked poster with its numeral, or a card
 * with progress. An anchor (wrap with `createLink` for router links); its accessible name is the
 * title plus rank or resume point. The artwork is decorative (`alt=""`): the name is in the
 * link text.
 */
export function TitleTile({
  title,
  layout,
  rank,
  progress,
  episode,
  sizes,
  priority = false,
  className,
  ref,
  ...anchor
}: TitleTileProps) {
  const isPoster = layout === "tall" || layout === "ranked";
  const image = isPoster ? title.images.poster : title.images.card;
  const imageSizes = sizes ?? sliderImageSizes(layout);
  const fraction =
    progress && progress.durationSec > 0 ? progress.positionSec / progress.durationSec : 0;
  const ribbon = title.badge && title.badge !== "top-10" ? TITLE_BADGE_LABELS[title.badge] : null;
  // Never in a ranked row (the numeral says it) or Continue Watching (that row is about
  // progress): the server does not send it there; this keeps any client from drawing it.
  const top10 = title.badge === "top-10" && layout !== "ranked" && layout !== "continue";

  const frame = (
    <span
      className={cx(
        "group/frame @container relative block overflow-hidden rounded-card bg-surface-1",
        "transition-[filter] duration-fast ease-standard group-hover/tile:brightness-110",
        layout === "tall" && "aspect-poster",
        layout === "ranked" && "aspect-poster h-full",
        (layout === "standard" || layout === "continue") && "aspect-video",
      )}
    >
      <ResponsiveImage image={image} alt="" sizes={imageSizes} fill priority={priority} />
      {/* Artwork that fails to load leaves the dominant colour; name the title on it. Drawn
          from an attribute so the name is neither repeated in the text nor announced twice. */}
      <span
        aria-hidden
        data-fallback-name={title.name}
        className={cx(
          "wf-tile-fallback absolute inset-0 hidden items-end bg-linear-to-t from-black/50 to-transparent p-[7%]",
          "font-display text-[max(0.75rem,8cqi)] font-bold leading-tight text-fg [text-wrap:balance]",
          "before:content-[attr(data-fallback-name)] group-has-[[data-failed]]/frame:flex",
        )}
      />
      {title.isOriginal ? (
        <BrandMark className="absolute start-[5%] top-[6%] h-[13%] w-auto drop-shadow-[0_1px_2px_rgb(0_0_0/0.6)]" />
      ) : null}
      {top10 ? (
        // Announced after the title in the link's name (", Top 10"), not before it.
        <span aria-hidden className="contents">
          <Top10Badge className="absolute end-0 top-0 rounded-none rounded-es-xs text-[clamp(0.625rem,0.9cqi,0.875rem)]" />
        </span>
      ) : null}
      {/* Status lives in the top-right corner with Top 10 (the server picks one badge): card
          artwork composites its title treatment along the bottom, where a label would cover it. */}
      {ribbon ? (
        <span
          aria-hidden
          className={cx(
            "absolute end-0 top-0 rounded-es-xs bg-accent px-[0.6em] pt-[0.45em] pb-[0.35em]",
            "text-[clamp(0.5625rem,4.2cqi,0.75rem)] font-bold uppercase leading-none tracking-wide text-fg-on-accent",
          )}
        >
          {ribbon}
        </span>
      ) : null}
      {layout === "continue" && progress ? (
        <span className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/70 to-transparent px-[6%] pb-[5%] pt-[12%]">
          <ProgressBar value={fraction} size="sm" track="onImage" />
        </span>
      ) : null}
    </span>
  );

  return (
    <a
      ref={ref}
      draggable={false}
      className={cx(
        "group/tile focus-ring relative block select-none rounded-card",
        layout === "ranked" && "@container flex aspect-ranked items-stretch justify-end",
        className,
      )}
      {...anchor}
    >
      {layout === "ranked" && rank !== undefined ? (
        <span
          aria-hidden
          className="wf-tile-numeral type-numeral pointer-events-none absolute bottom-[-0.06em] start-[-0.02em] text-[86cqi]"
        >
          {rank}
        </span>
      ) : null}
      {layout === "ranked" ? (
        <span className="relative z-(--z-raised) h-full">{frame}</span>
      ) : (
        frame
      )}
      <span className="sr-only">
        {rank !== undefined ? `${rank}. ` : ""}
        {title.name}
        {episode ? `, ${episodeLabel(episode)}` : ""}
        {layout === "continue" && progress ? `, ${Math.round(fraction * 100)}% watched` : ""}
        {top10 ? ", Top 10" : ""}
        {ribbon ? `, ${ribbon}` : ""}
      </span>
    </a>
  );
}

export interface TitleTileSkeletonProps {
  layout: RowLayout;
  className?: string;
}

/** Same frame as `TitleTile` for loading rows. */
export function TitleTileSkeleton({ layout, className }: TitleTileSkeletonProps) {
  if (layout === "ranked") {
    return (
      <span className={cx("flex aspect-ranked justify-end", className)}>
        <Skeleton radius="card" className="aspect-poster h-full" />
      </span>
    );
  }
  return (
    <Skeleton
      radius="card"
      className={cx(layout === "tall" ? "aspect-poster" : "aspect-video", className)}
    />
  );
}
