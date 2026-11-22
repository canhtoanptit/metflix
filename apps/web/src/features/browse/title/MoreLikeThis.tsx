import { useQuery } from "@tanstack/react-query";
import type { TitleCard } from "@webflix/contracts";
import { Button, ChevronDownIcon, cx, MaturityBadge, Skeleton, SkeletonText } from "@webflix/ui";
import { useState } from "react";
import { TitleTileLink } from "../../../app/links.ts";
import { queries } from "../../../app/query/queries.ts";
import { formatLength, genreLine } from "../common/format.ts";
import { cardLinkProps } from "../common/telemetry.ts";
import { MyListButton } from "../library/MyListButton.tsx";

const COLLAPSED_COUNT = 9;
const SIMILAR_SIZES = "(min-width: 848px) 16rem, (min-width: 500px) 30vw, 45vw";

/**
 * Titles like this one. Opening one stacks it on the overlay (Back returns here). Shows nine,
 * then expands in place.
 */
export function MoreLikeThis({ titleId }: { titleId: string }) {
  const similar = useQuery(queries.similar(titleId));
  const [expanded, setExpanded] = useState(false);

  if (similar.isError || (similar.data && similar.data.items.length === 0)) return null;
  const items = similar.data?.items ?? [];
  const visible = expanded ? items : items.slice(0, COLLAPSED_COUNT);

  return (
    <section aria-labelledby="detail-similar" className="mt-10">
      <h3 id="detail-similar" className="type-title-lg text-fg">
        More Like This
      </h3>
      <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
        {similar.isPending
          ? Array.from({ length: 6 }, (_, index) => (
              <li key={index} className="overflow-hidden rounded-md bg-surface-3">
                <Skeleton radius="none" className="aspect-video w-full" />
                <span className="block p-3">
                  <SkeletonText lines={2} />
                </span>
              </li>
            ))
          : visible.map((card, index) => (
              <SimilarCard key={card.id} card={card} rank={index + 1} />
            ))}
      </ul>
      {items.length > COLLAPSED_COUNT ? (
        <div className="relative mt-2 flex justify-center border-b border-line">
          <Button
            variant="outline"
            size="sm"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="translate-y-1/2 rounded-full bg-surface-2"
            icon={ChevronDownIcon}
          >
            {expanded ? "Show fewer" : `Show all ${items.length}`}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function SimilarCard({ card, rank }: { card: TitleCard; rank: number }) {
  return (
    <li className="flex flex-col overflow-hidden rounded-md bg-surface-3">
      <span className="relative block">
        <TitleTileLink
          title={card}
          layout="standard"
          sizes={SIMILAR_SIZES}
          className="rounded-b-none"
          {...cardLinkProps(card.id, {
            surface: "title-detail",
            rowId: null,
            rowRank: null,
            rank,
            policy: null,
          })}
        />
      </span>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            {card.matchScore !== null ? (
              <span className="type-label text-positive">{card.matchScore}% Match</span>
            ) : null}
            {/* The length sits with the year, not on the picture: the picture's corners hold
                the Originals mark and the card's badge, and its foot the title treatment. */}
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 type-body-sm text-fg-muted">
              <MaturityBadge rating={card.maturity} />
              <span>{card.releaseYear}</span>
              <span data-duration="">{formatLength(card)}</span>
            </span>
          </div>
          <MyListButton title={card} card={card} size="sm" />
        </div>
        <p className={cx("type-caption text-fg-muted")}>{genreLine(card).join(" · ")}</p>
      </div>
    </li>
  );
}
