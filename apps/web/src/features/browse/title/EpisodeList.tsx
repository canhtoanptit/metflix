import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Episode, ImageSet, TitleDetail } from "@webflix/contracts";
import {
  Button,
  cx,
  PlayIcon,
  ProgressBar,
  ResponsiveImage,
  Select,
  SelectItem,
  Skeleton,
  SkeletonText,
} from "@webflix/ui";
import { useState } from "react";
import { queries } from "../../../app/query/queries.ts";
import { formatRuntime, formatRuntimeLong, progressFraction } from "../common/format.ts";
import { watchLink } from "../common/watch.ts";

/**
 * Episodes of a series, one season at a time (season selector when there are several). Each
 * episode plays from its own resume point; progress shows on its still. Switching seasons keeps
 * the previous list on screen (dimmed) until the next arrives, so the panel never collapses.
 */
export function EpisodeList({ title }: { title: TitleDetail }) {
  const initialSeason = title.playTarget?.episode?.seasonNumber ?? title.seasons[0]?.number ?? 1;
  const [season, setSeason] = useState(initialSeason);
  const episodes = useQuery({
    ...queries.episodes(title.id, season),
    placeholderData: keepPreviousData,
  });
  const currentEpisodeId = title.playTarget?.episode?.id ?? null;
  const summary = title.seasons.find((candidate) => candidate.number === season);

  return (
    <section aria-labelledby="detail-episodes" className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4">
        <h3 id="detail-episodes" className="type-title-lg text-fg">
          Episodes
        </h3>
        {title.seasons.length > 1 ? (
          <Select
            variant="solid"
            aria-label="Season"
            value={String(season)}
            onValueChange={(value) => setSeason(Number(value))}
          >
            {title.seasons.map((option) => (
              <SelectItem key={option.number} value={String(option.number)}>
                {option.name} ({option.episodeCount} episode{option.episodeCount === 1 ? "" : "s"})
              </SelectItem>
            ))}
          </Select>
        ) : summary ? (
          <p className="type-label text-fg-muted">{summary.name}</p>
        ) : null}
      </div>

      {episodes.isPending ? (
        <ol aria-busy="true" className="flex flex-col">
          {Array.from({ length: Math.min(summary?.episodeCount ?? 3, 4) }, (_, index) => (
            <li
              key={index}
              className="grid grid-cols-[minmax(0,9rem)_1fr] items-center gap-4 py-5 sm:grid-cols-[2rem_minmax(0,10rem)_1fr]"
            >
              <Skeleton radius="sm" className="hidden h-6 w-5 sm:block" />
              <Skeleton radius="sm" className="aspect-video w-full" />
              <SkeletonText lines={3} />
            </li>
          ))}
        </ol>
      ) : episodes.isError ? (
        <div className="flex flex-col items-start gap-3 py-8">
          <p className="type-body text-fg-muted">The episodes couldn't be loaded.</p>
          <Button variant="outline" size="sm" onClick={() => episodes.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <ol
          className={cx(
            "flex flex-col transition-opacity duration-fast ease-standard",
            episodes.isPlaceholderData && "opacity-50",
          )}
          aria-busy={episodes.isPlaceholderData || undefined}
        >
          {episodes.data.items.map((episode) => (
            <EpisodeRow
              key={episode.id}
              episode={episode}
              fallback={title.images.backdrop}
              current={episode.id === currentEpisodeId}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function EpisodeRow({
  episode,
  fallback,
  current,
}: {
  episode: Episode;
  fallback: ImageSet;
  current: boolean;
}) {
  const fraction = progressFraction(episode.progress);
  const watched = episode.progress?.completed ?? false;
  const body = (
    <>
      <span
        aria-hidden
        className="hidden self-center text-center type-title-lg text-fg-muted sm:block"
      >
        {episode.number}
      </span>
      <span className="relative block aspect-video overflow-hidden rounded-sm bg-surface-3">
        <ResponsiveImage
          image={episode.still ?? fallback}
          alt=""
          fill
          sizes="(min-width: 500px) 10rem, 9rem"
        />
        {episode.isPlayable ? (
          <span
            aria-hidden
            className="absolute inset-0 grid place-items-center bg-black/40 opacity-0 transition-opacity duration-fast ease-standard group-hover/episode:opacity-100 group-focus-visible/episode:opacity-100"
          >
            <span className="grid size-10 place-items-center rounded-full border-2 border-fg bg-glass">
              <PlayIcon size="md" />
            </span>
          </span>
        ) : null}
        {fraction > 0 ? (
          <span className="absolute inset-x-0 bottom-0 px-2 pb-1.5">
            <ProgressBar value={watched ? 1 : fraction} size="xs" track="onImage" />
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-col gap-1.5">
        <span className="flex items-baseline justify-between gap-3">
          <span className="type-label text-fg">
            <span className="sm:hidden">{episode.number}. </span>
            {episode.name}
          </span>
          <span className="shrink-0 type-caption text-fg-muted tabular-nums">
            {formatRuntime(episode.runtimeSec)}
          </span>
        </span>
        <span className="line-clamp-3 type-body-sm text-fg-muted">{episode.synopsis}</span>
        {!episode.isPlayable ? (
          <span className="type-caption text-fg-subtle">Not available to play yet</span>
        ) : null}
      </span>
    </>
  );
  const rowClass = cx(
    "grid grid-cols-[minmax(0,9rem)_1fr] items-start gap-4 rounded-md px-2 py-5 sm:grid-cols-[2rem_minmax(0,10rem)_1fr] sm:px-4",
    current && "bg-surface-3",
  );

  return (
    <li className="border-b border-line-subtle last:border-b-0">
      {episode.isPlayable ? (
        <Link
          {...watchLink(episode.titleId, { episodeId: episode.id })}
          aria-label={`Episode ${episode.number}, ${episode.name}${
            fraction > 0 && !watched ? `, ${Math.round(fraction * 100)}% watched` : ""
          }, ${formatRuntimeLong(episode.runtimeSec)}`}
          aria-current={current ? "true" : undefined}
          className={cx(
            rowClass,
            "group/episode focus-ring-inset transition-colors duration-fast ease-standard hover:bg-surface-3",
          )}
        >
          {body}
        </Link>
      ) : (
        <div className={cx(rowClass, "opacity-60")}>{body}</div>
      )}
    </li>
  );
}
