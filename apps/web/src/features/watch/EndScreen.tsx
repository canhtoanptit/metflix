import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { RatingValue, TitleCard, TitleDetail } from "@webflix/contracts";
import type { EndScreenContext } from "@webflix/player";
import {
  Button,
  cx,
  MaturityBadge,
  PlayIcon,
  ResponsiveImage,
  Skeleton,
  ThumbsDownIcon,
  ThumbsUpDoubleIcon,
  ThumbsUpIcon,
  toast,
} from "@webflix/ui";
import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "../../app/api.ts";
import { TitleTileLink } from "../../app/links.ts";
import { describeError } from "../../app/query/errors.ts";
import { qk } from "../../app/query/keys.ts";
import { queries } from "../../app/query/queries.ts";
import { formatLength } from "../browse/common/format.ts";

/** Seconds before the lead recommendation starts by itself (when the profile autoplays). */
export const POST_PLAY_COUNTDOWN_SEC = 10;

const RATINGS: Array<{ value: RatingValue; label: string; icon: typeof ThumbsUpIcon }> = [
  { value: "dislike", label: "Not for me", icon: ThumbsDownIcon },
  { value: "like", label: "I like this", icon: ThumbsUpIcon },
  { value: "love", label: "Love this!", icon: ThumbsUpDoubleIcon },
];

/**
 * The post-play moment after a film or a series finale, beside the shrunken picture at the
 * credits and over the title's backdrop once it ends. It leads with one recommendation (its
 * backdrop, logo and a line of synopsis) which, when the profile autoplays, starts by itself
 * after a short countdown; the member can start it now, cancel the countdown, rate what they
 * watched, or pick from more like it. Recommendations replace this watch page in history, so
 * Back still returns to where the member started.
 *
 * The countdown stops for good as soon as the member does anything here (a click, a key) other
 * than starting the recommendation: someone choosing is never pulled away mid-choice.
 */
export function WatchEndScreen({
  title,
  context,
  autoplay,
  onAutoplay,
}: {
  title: TitleDetail | undefined;
  context: EndScreenContext;
  /** Count down to the lead recommendation: the profile autoplays and nothing holds it. */
  autoplay: boolean;
  /** The countdown started the recommendation (counts towards "still watching?"). */
  onAutoplay?: () => void;
}) {
  const titleId = title?.id ?? "";
  const similar = useQuery({ ...queries.similar(titleId), enabled: Boolean(title) });
  const items = similar.data?.items ?? [];
  const lead = items[0] ?? null;
  const more = items.slice(1, 5);
  const navigate = useNavigate();

  const [held, setHeld] = useState(false);
  const counting = autoplay && !held && lead !== null;
  const start = (card: TitleCard) =>
    void navigate({
      to: "/watch/$titleId",
      params: { titleId: card.id },
      search: {},
      replace: true,
    });
  const remaining = useCountdown(counting, POST_PLAY_COUNTDOWN_SEC, () => {
    if (!lead) return;
    onAutoplay?.();
    start(lead);
  });

  const playRef = useRef<HTMLButtonElement>(null);
  const hold = (event: PointerEvent | KeyboardEvent) => {
    if (!counting) return;
    if (playRef.current?.contains(event.target as Node)) return;
    setHeld(true);
  };

  return (
    <div
      className="@container flex flex-col gap-6 pb-4"
      data-phase={context.phase}
      onPointerDownCapture={hold}
      onKeyDownCapture={hold}
    >
      {similar.isPending && title ? (
        <LeadSkeleton />
      ) : lead ? (
        <LeadRecommendation
          card={lead}
          remaining={counting ? remaining : null}
          playRef={playRef}
          onPlay={() => start(lead)}
          onCancel={() => setHeld(true)}
        />
      ) : null}
      {title ? <RateTitle title={title} /> : null}
      {more.length > 0 ? (
        <section aria-labelledby="watch-more-like-this" className="flex flex-col gap-3">
          <h3 id="watch-more-like-this" className="type-title text-fg">
            More like this
          </h3>
          <ul className="grid grid-cols-2 gap-2 @min-[40rem]:grid-cols-4 @min-[40rem]:gap-3">
            {more.map((item) => (
              <li key={item.id}>
                <TitleTileLink
                  title={item}
                  layout="standard"
                  sizes="(min-width: 1100px) 14vw, (min-width: 700px) 22vw, 45vw"
                  to="/watch/$titleId"
                  params={{ titleId: item.id }}
                  search={{}}
                  replace
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** Whole seconds left while `active`, from `seconds` down; calls `onDone` once at zero. */
function useCountdown(active: boolean, seconds: number, onDone: () => void): number {
  const [remaining, setRemaining] = useState(seconds);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!active) return;
    setRemaining(seconds);
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const left = Math.max(0, seconds - Math.floor((Date.now() - startedAt) / 1000));
      setRemaining(left);
      if (left === 0) {
        window.clearInterval(timer);
        done.current();
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [active, seconds]);
  return remaining;
}

function LeadRecommendation({
  card,
  remaining,
  playRef,
  onPlay,
  onCancel,
}: {
  card: TitleCard;
  /** Seconds before it starts by itself; null when it waits for the member. */
  remaining: number | null;
  playRef: RefObject<HTMLButtonElement | null>;
  onPlay: () => void;
  onCancel: () => void;
}) {
  // Backdrop and synopsis come with the detail; the card's own art stands in until then.
  const detail = useQuery(queries.title(card.id));
  const backdrop = detail.data?.images.backdrop ?? null;
  const logo = backdrop ? card.images.logo : null;
  const synopsis = detail.data?.synopsis ?? null;
  const length = formatLength(card);
  const counting = remaining !== null;
  // Said once when the countdown starts, not every second; cleared when it stops.
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    setAnnouncement(
      counting
        ? `${card.name} starts in ${POST_PLAY_COUNTDOWN_SEC} seconds. Choose Cancel to stay here.`
        : "",
    );
  }, [counting, card.name]);

  return (
    <section
      aria-labelledby="watch-next-title"
      className="grid overflow-hidden rounded-card bg-surface-1 shadow-lg @min-[40rem]:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]"
    >
      {/* 16:9 when stacked; beside the text it fills the row (at least 16:9-ish tall). */}
      <div className="relative aspect-video @min-[40rem]:aspect-auto @min-[40rem]:min-h-56">
        <ResponsiveImage
          image={backdrop ?? card.images.card}
          alt=""
          fill
          sizes="(min-width: 1100px) 32vw, (min-width: 700px) 60vw, 92vw"
          className="absolute inset-0"
        />
        {logo ? (
          <>
            <div aria-hidden className="absolute inset-0 scrim-bottom" />
            <ResponsiveImage
              image={logo}
              alt=""
              fit="contain"
              position="left bottom"
              placeholder="none"
              sizes="14rem"
              className="absolute start-4 bottom-3 h-2/5 w-3/5"
            />
          </>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-3 p-5 @min-[40rem]:p-6">
        <p className="type-overline text-accent">{counting ? "Up next" : "Watch next"}</p>
        <h3 id="watch-next-title" className={cx("type-title-lg text-fg", logo && "sr-only")}>
          {card.name}
        </h3>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 type-body-sm text-fg-muted">
          <span>{card.releaseYear}</span>
          <MaturityBadge rating={card.maturity} />
          {length ? <span>{length}</span> : null}
        </p>
        {synopsis ? (
          <p className="line-clamp-2 type-body text-fg-muted">{synopsis}</p>
        ) : detail.isPending ? (
          <Skeleton className="h-4 w-4/5" />
        ) : null}
        <div className="mt-auto flex flex-wrap items-center gap-3 pt-2">
          <Button
            ref={playRef}
            variant="primary"
            size="lg"
            icon={PlayIcon}
            onClick={onPlay}
            aria-label={`Play ${card.name}`}
            className="relative isolate overflow-hidden"
          >
            {counting ? (
              <>
                <span
                  aria-hidden
                  className="absolute inset-0 -z-10 origin-left bg-fg-inverse/15 transition-transform duration-1000 ease-linear motion-reduce:hidden"
                  style={{ transform: `scaleX(${1 - remaining / POST_PLAY_COUNTDOWN_SEC})` }}
                />
                <span aria-hidden className="tabular-nums">
                  Starts in {remaining}
                </span>
              </>
            ) : (
              "Play"
            )}
          </Button>
          {counting ? (
            <Button variant="secondary" size="lg" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </section>
  );
}

function LeadSkeleton() {
  return (
    <div className="grid overflow-hidden rounded-card bg-surface-1 @min-[40rem]:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <Skeleton aspectRatio={16 / 9} radius="none" />
      <div className="flex flex-col gap-3 p-5">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-6 w-3/5" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="mt-auto h-12 w-36" radius="md" />
      </div>
    </div>
  );
}

/** Rate what was just watched: full-size labelled controls, the choice shown as pressed. */
function RateTitle({ title }: { title: TitleDetail }) {
  const queryClient = useQueryClient();
  const rating = title.viewer.rating ?? null;
  const rate = useMutation({
    mutationFn: (value: RatingValue | null) =>
      value
        ? api().rateTitle({ params: { titleId: title.id }, body: { value } })
        : api().clearRating({ params: { titleId: title.id } }),
    meta: { silent: true },
    onError: (error) =>
      toast.error("Couldn't save your rating", {
        id: `rating-${title.id}`,
        description: describeError(error).description,
      }),
    onSuccess: (_data, value) => {
      queryClient.setQueryData<TitleDetail>(qk.profile.title(title.id), (current) =>
        current ? { ...current, viewer: { ...current.viewer, rating: value } } : current,
      );
      void queryClient.invalidateQueries({ queryKey: qk.profile.all() });
    },
  });
  const shown = rate.isPending ? (rate.variables ?? null) : rating;

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-3 type-title text-fg">Rate {title.name}</legend>
      <div className="flex flex-wrap gap-2">
        {RATINGS.map((option) => {
          const pressed = shown === option.value;
          return (
            <Button
              key={option.value}
              variant={pressed ? "primary" : "secondary"}
              size="lg"
              icon={option.icon}
              aria-pressed={pressed}
              onClick={() => rate.mutate(pressed ? null : option.value)}
            >
              {option.label}
            </Button>
          );
        })}
      </div>
    </fieldset>
  );
}
