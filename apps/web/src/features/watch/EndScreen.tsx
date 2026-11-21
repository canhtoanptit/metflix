import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RatingValue, TitleDetail } from "@webflix/contracts";
import type { EndScreenContext } from "@webflix/player";
import {
  IconButton,
  Skeleton,
  ThumbsDownIcon,
  ThumbsUpDoubleIcon,
  ThumbsUpIcon,
  toast,
} from "@webflix/ui";
import { api } from "../../app/api.ts";
import { TitleTileLink } from "../../app/links.ts";
import { describeError } from "../../app/query/errors.ts";
import { qk } from "../../app/query/keys.ts";
import { queries } from "../../app/query/queries.ts";

const RATINGS: Array<{ value: RatingValue; label: string; icon: typeof ThumbsUpIcon }> = [
  { value: "dislike", label: "Not for me", icon: ThumbsDownIcon },
  { value: "like", label: "I like this", icon: ThumbsUpIcon },
  { value: "love", label: "Love this!", icon: ThumbsUpDoubleIcon },
];

/**
 * After a film or a series finale (the player shrinks the picture at the credits): rate what
 * you watched, then pick the next thing. Recommendations replace this watch page in history, so
 * Back still returns to where the member started.
 */
export function WatchEndScreen({
  title,
  context,
}: {
  title: TitleDetail | undefined;
  context: EndScreenContext;
}) {
  const titleId = title?.id ?? "";
  const similar = useQuery({ ...queries.similar(titleId), enabled: Boolean(title) });
  const queryClient = useQueryClient();
  const rating = title?.viewer.rating ?? null;

  const rate = useMutation({
    mutationFn: (value: RatingValue | null) =>
      value
        ? api().rateTitle({ params: { titleId }, body: { value } })
        : api().clearRating({ params: { titleId } }),
    meta: { silent: true },
    onError: (error) =>
      toast.error("Couldn't save your rating", { description: describeError(error).description }),
    onSuccess: (_data, value) => {
      queryClient.setQueryData<TitleDetail>(qk.profile.title(titleId), (current) =>
        current ? { ...current, viewer: { ...current.viewer, rating: value } } : current,
      );
      void queryClient.invalidateQueries({ queryKey: qk.profile.all() });
    },
  });
  const shown = rate.isPending ? (rate.variables ?? null) : rating;

  const items = similar.data?.items.slice(0, 4) ?? [];

  return (
    <div className="flex flex-col gap-5 pb-4" data-phase={context.phase}>
      {title ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="type-label text-fg-muted">Rate {title.name}</span>
          <div className="flex gap-2">
            {RATINGS.map((option) => (
              <IconButton
                key={option.value}
                label={option.label}
                icon={option.icon}
                variant="glass"
                size="md"
                pressed={shown === option.value}
                onClick={() => rate.mutate(shown === option.value ? null : option.value)}
              />
            ))}
          </div>
        </div>
      ) : null}
      <section aria-labelledby="watch-more-like-this" className="flex flex-col gap-3">
        <h3 id="watch-more-like-this" className="type-title text-fg">
          More like this
        </h3>
        <ul className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
          {similar.isPending
            ? Array.from({ length: 4 }, (_, index) => (
                <li key={index}>
                  <Skeleton aspectRatio={16 / 9} radius="card" />
                </li>
              ))
            : items.map((item) => (
                <li key={item.id}>
                  <TitleTileLink
                    title={item}
                    layout="standard"
                    sizes="(min-width: 1100px) 14vw, 30vw"
                    to="/watch/$titleId"
                    params={{ titleId: item.id }}
                    search={{}}
                    replace
                  />
                </li>
              ))}
        </ul>
      </section>
    </div>
  );
}
