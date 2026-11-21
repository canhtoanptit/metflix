import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { HistoryEntry, HistoryPage } from "@webflix/contracts";
import {
  Avatar,
  Button,
  EmptyState,
  ErrorState,
  HistoryIcon,
  IconButton,
  Skeleton,
  TrashIcon,
  toast,
} from "@webflix/ui";
import { api } from "../../../app/api.ts";
import { describeError } from "../../../app/query/errors.ts";
import { qk } from "../../../app/query/keys.ts";
import { optimisticUpdate } from "../../../app/query/optimistic.ts";
import { queries } from "../../../app/query/queries.ts";
import { useActiveProfile } from "../../../app/session/session.ts";
import { formatShortDate } from "../shared/format.ts";
import { AccountFrame, AccountHeading } from "./AccountLayout.tsx";

function episodeLabel(entry: HistoryEntry): string | null {
  if (!entry.episode) return null;
  return `S${entry.episode.seasonNumber}:E${entry.episode.number} · ${entry.episode.name}`;
}

/**
 * Viewing activity of the active profile, newest first, loaded page by page. Removing an entry
 * is optimistic and also removes its progress (Continue Watching updates).
 */
export function AccountActivityPage() {
  const profile = useActiveProfile();
  const queryClient = useQueryClient();
  const history = useInfiniteQuery(queries.history());

  const remove = useMutation({
    mutationFn: (entry: HistoryEntry) => api().removeHistoryEntry({ params: { id: entry.id } }),
    meta: { silent: true },
    onMutate: (entry) =>
      optimisticUpdate(queryClient, qk.profile.history(), (data) => {
        const pages = data as InfiniteData<HistoryPage>;
        return {
          ...pages,
          pages: pages.pages.map((page) => ({
            ...page,
            items: page.items.filter((item) => item.id !== entry.id),
          })),
        };
      }),
    onError: (error, entry, rollback) => {
      rollback?.();
      toast.error(`Couldn't remove ${entry.title.name}`, {
        description: describeError(error).description,
      });
    },
    onSuccess: (_data, entry) => {
      toast.success(`Removed ${entry.title.name}`, {
        description: "It won't shape recommendations or appear in Continue Watching.",
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.profile.history() });
      void queryClient.invalidateQueries({ queryKey: qk.profile.continueWatching() });
      void queryClient.invalidateQueries({ queryKey: qk.profile.browse("home") });
    },
  });

  const entries = history.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <AccountFrame>
      <div className="flex items-center gap-4">
        <Avatar src={profile.avatar.imageUrl} name={profile.name} size="md" decorative />
        <AccountHeading
          title="Viewing activity"
          description={
            <>
              What <span className="text-fg">{profile.name}</span> has watched. Removing a title
              also clears its progress.
            </>
          }
        />
      </div>
      {history.isPending ? (
        <ul className="flex flex-col divide-y divide-line-subtle" aria-busy="true">
          {Array.from({ length: 6 }, (_, index) => (
            <li key={index} className="flex items-center gap-4 py-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 flex-1" />
            </li>
          ))}
        </ul>
      ) : history.isError ? (
        <ErrorState
          title="We couldn't load viewing activity"
          description={describeError(history.error).description}
          action={
            <Button variant="primary" onClick={() => void history.refetch()}>
              Try again
            </Button>
          }
        />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={HistoryIcon}
          title="Nothing watched yet"
          description={`Titles ${profile.name} watches will show up here.`}
          action={
            <Button variant="primary" asChild>
              <Link to="/browse">Find something to watch</Link>
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-6">
          <ul className="flex flex-col divide-y divide-line-subtle rounded-xl border border-line-subtle bg-surface-1 px-4 sm:px-6">
            {entries.map((entry) => {
              const episode = episodeLabel(entry);
              return (
                <li key={entry.id} className="flex items-center gap-4 py-3.5">
                  <time
                    dateTime={entry.watchedAt}
                    className="w-24 shrink-0 type-body-sm text-fg-subtle tabular-nums"
                  >
                    {formatShortDate(entry.watchedAt)}
                  </time>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <Link
                      to="/browse"
                      search={{ title: entry.title.id }}
                      className="focus-ring truncate rounded-xs type-label text-fg hover:underline"
                    >
                      {entry.title.name}
                    </Link>
                    {episode ? (
                      <span className="truncate type-body-sm text-fg-muted">{episode}</span>
                    ) : null}
                  </div>
                  <IconButton
                    label={`Remove ${entry.title.name}${episode ? `, ${episode}` : ""} from viewing activity`}
                    icon={TrashIcon}
                    variant="ghost"
                    size="sm"
                    onClick={() => remove.mutate(entry)}
                  />
                </li>
              );
            })}
          </ul>
          {history.hasNextPage ? (
            <Button
              variant="outline"
              className="self-center"
              loading={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              Show more
            </Button>
          ) : null}
        </div>
      )}
    </AccountFrame>
  );
}
