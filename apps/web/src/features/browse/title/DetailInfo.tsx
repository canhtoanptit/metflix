import { Link } from "@tanstack/react-router";
import type { TitleDetail } from "@webflix/contracts";
import {
  cx,
  MaturityBadge,
  ProgressBar,
  QualityBadge,
  TITLE_BADGE_LABELS,
  Top10Badge,
} from "@webflix/ui";
import type { ReactNode } from "react";
import {
  episodeCode,
  formatLength,
  formatProgress,
  progressFraction,
  qualityLabel,
  top10RankLabel,
} from "../common/format.ts";
import { useBrowseSession } from "../common/session.ts";

/** Match, year, length, quality, rating; resume point; synopsis; the people and genres. */
export function DetailInfo({ title, phone }: { title: TitleDetail; phone: boolean }) {
  const session = useBrowseSession();
  const target = title.playTarget;
  const progress = target?.action === "resume" ? (target.progress ?? null) : null;
  const status = title.badge && title.badge !== "top-10" ? TITLE_BADGE_LABELS[title.badge] : null;
  // The rank is stated whenever the title is ranked, badge or not: detail has room for it.
  const rank = top10RankLabel(title, null);
  const quality = qualityLabel(title, session.plan);

  return (
    <div
      className={cx(
        "grid gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] md:gap-10",
        phone ? "pt-5" : "pt-1",
      )}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 type-body text-fg-muted">
          {title.matchScore !== null ? (
            <span className="font-semibold text-positive">{title.matchScore}% Match</span>
          ) : null}
          <span>{title.releaseYear}</span>
          <span>{formatLength(title)}</span>
          {quality ? <QualityBadge>{quality}</QualityBadge> : null}
          {title.subtitleLanguages.length > 0 ? (
            <span title="Subtitles available">
              <QualityBadge>CC</QualityBadge>
              <span className="sr-only">Subtitles available</span>
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3 type-body-sm">
          <MaturityBadge rating={title.maturity} descriptors={title.maturityDescriptors} />
        </div>
        {rank || status ? (
          <p className="flex items-center gap-2 type-label text-fg">
            {rank ? (
              <>
                <Top10Badge className="text-xs" /> {rank}
              </>
            ) : (
              <span className="type-label text-accent">{status}</span>
            )}
          </p>
        ) : null}
        {progress ? (
          <div className="flex max-w-md flex-col gap-2">
            {target?.episode && title.type === "series" ? (
              <p className="type-label text-fg">
                {episodeCode(target.episode)}{" "}
                <span className="font-normal text-fg-muted">“{target.episode.name}”</span>
              </p>
            ) : null}
            <div className="flex items-center gap-3">
              <ProgressBar
                value={progressFraction(progress)}
                size="sm"
                className="flex-1"
                label="Watched"
                valueText={`${formatProgress(progress).replace("m", " minutes")} watched`}
              />
              <span className="shrink-0 type-caption text-fg-muted tabular-nums">
                {formatProgress(progress)}
              </span>
            </div>
          </div>
        ) : null}
        {title.tagline ? <p className="type-title text-fg">{title.tagline}</p> : null}
        <p className="type-body-lg text-fg">{title.synopsis}</p>
      </div>

      <dl className="flex flex-col gap-3 type-body-sm">
        {title.cast.length > 0 ? (
          <Row term="Cast">
            {title.cast
              .slice(0, 3)
              .map((person) => person.name)
              .join(", ")}
            {title.cast.length > 3 ? (
              <>
                {", "}
                <button
                  type="button"
                  className="focus-ring rounded-xs italic text-fg hover:underline"
                  onClick={() =>
                    document
                      .getElementById("detail-about")
                      ?.scrollIntoView({ behavior: "smooth", block: "start" })
                  }
                >
                  more
                </button>
              </>
            ) : null}
          </Row>
        ) : null}
        <Row term="Genres">
          {title.genres.slice(0, 3).map((genre, index) => (
            <span key={genre.slug}>
              {index > 0 ? ", " : null}
              <Link
                to="/browse/genre/$slug"
                params={{ slug: genre.slug }}
                search={{}}
                className="focus-ring rounded-xs underline-offset-4 hover:underline"
              >
                {genre.name}
              </Link>
            </span>
          ))}
        </Row>
        {title.moods.length > 0 ? <Row term="This title is">{title.moods.join(", ")}</Row> : null}
      </dl>
    </div>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt className="inline text-fg-subtle">{term}: </dt>
      <dd className="inline text-fg">{children}</dd>
    </div>
  );
}
