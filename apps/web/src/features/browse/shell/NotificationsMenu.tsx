import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Notification, NotificationList } from "@webflix/contracts";
import {
  BellIcon,
  Button,
  cx,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ResponsiveImage,
  Skeleton,
} from "@webflix/ui";
import { useEffect, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { useTitleOverlay } from "../../../app/overlay/titleOverlay.ts";
import { qk } from "../../../app/query/keys.ts";
import { queries } from "../../../app/query/queries.ts";
import { relativeTime } from "../common/format.ts";
import { BellButton } from "./NotificationsBell.tsx";

/**
 * New arrivals and episodes for the active profile. Opening the menu marks what it shows as
 * read (optimistically: the count clears at once), but items keep their "new" dot until the
 * menu closes, so people can still see what was new. Choosing one opens the title's details.
 */
export function NotificationsMenu({
  defaultOpen = false,
  autoFocus = false,
}: {
  /** Open as soon as it mounts (the bell was clicked before this code had loaded). */
  defaultOpen?: boolean;
  /** Take focus on mount (the lightweight bell it replaces had focus). */
  autoFocus?: boolean;
}) {
  const queryClient = useQueryClient();
  const notifications = useQuery({ ...queries.notifications(), meta: { silent: true } });
  const { open: openTitle } = useTitleOverlay();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** Ids that were unread when the menu opened (their dots stay while it is open). */
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const unread = notifications.data?.unreadCount ?? 0;

  const markRead = useMutation({
    mutationFn: (ids: string[]) => api().markNotificationsRead({ body: { ids } }),
    meta: { silent: true },
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: qk.profile.notifications() });
      const previous = queryClient.getQueryData<NotificationList>(qk.profile.notifications());
      if (previous) {
        const now = new Date().toISOString();
        queryClient.setQueryData<NotificationList>(qk.profile.notifications(), {
          items: previous.items.map((item) =>
            ids.includes(item.id) && !item.readAt ? { ...item, readAt: now } : item,
          ),
          unreadCount: Math.max(0, previous.unreadCount - ids.length),
        });
      }
      return previous;
    },
    // Not worth an error message: the dot simply comes back on the next refresh.
    onError: (_error, _ids, previous) => {
      if (previous) queryClient.setQueryData(qk.profile.notifications(), previous);
    },
  });

  useEffect(() => {
    if (autoFocus && !defaultOpen) triggerRef.current?.focus();
    if (defaultOpen) onOpenChange(true);
  }, []);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    const ids = (notifications.data?.items ?? []).filter((item) => !item.readAt).map((i) => i.id);
    setFresh(new Set(ids));
    if (ids.length > 0) markRead.mutate(ids);
  };

  const choose = (item: Notification, element: HTMLElement) => {
    setOpen(false);
    if (item.title) {
      openTitle(item.title.id, { origin: element.querySelector(".wf-image") ?? element });
    }
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <BellButton ref={triggerRef} unread={unread} />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        arrow
        className="flex max-h-[min(34rem,70dvh)] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden"
        aria-label="Notifications"
      >
        <div className="flex items-center justify-between border-b border-line-subtle px-4 py-3">
          <h2 className="type-label text-fg">Notifications</h2>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {notifications.isPending ? (
            <ul aria-busy="true" className="flex flex-col">
              {[0, 1, 2].map((index) => (
                <li key={index} className="flex gap-3 px-4 py-3">
                  <Skeleton radius="sm" className="aspect-video w-28 shrink-0" />
                  <span className="flex flex-1 flex-col gap-2 pt-1">
                    <Skeleton radius="sm" className="h-3 w-24" />
                    <Skeleton radius="sm" className="h-3 w-36" />
                  </span>
                </li>
              ))}
            </ul>
          ) : notifications.isError ? (
            <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
              <p className="type-body-sm text-fg-muted">Notifications couldn't be loaded.</p>
              <Button size="sm" variant="outline" onClick={() => notifications.refetch()}>
                Try again
              </Button>
            </div>
          ) : notifications.data.items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <BellIcon size="xl" className="text-fg-subtle" />
              <p className="type-label text-fg">You're all caught up</p>
              <p className="type-body-sm text-fg-muted">
                New arrivals and episodes will show here.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col py-1">
              {notifications.data.items.map((item) => {
                const isNew = !item.readAt || fresh.has(item.id);
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      disabled={!item.title}
                      onClick={(event) => choose(item, event.currentTarget)}
                      className={cx(
                        "focus-ring-inset flex w-full items-start gap-3 px-4 py-3 text-start",
                        "transition-colors duration-fast ease-standard hover:bg-surface-3",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cx(
                          "mt-2 size-1.5 shrink-0 rounded-full",
                          isNew ? "bg-accent" : "bg-transparent",
                        )}
                      />
                      <span className="relative block aspect-video w-28 shrink-0 overflow-hidden rounded-sm bg-surface-3">
                        {item.image ? (
                          <ResponsiveImage image={item.image} alt="" fill sizes="112px" />
                        ) : null}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="type-label text-fg">{item.headline}</span>
                        <span className="type-body-sm text-fg-muted">{item.body}</span>
                        <span className="type-caption text-fg-subtle">
                          {relativeTime(item.createdAt)}
                          {isNew ? <span className="sr-only">, new</span> : null}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
