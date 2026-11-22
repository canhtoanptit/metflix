import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Notification, NotificationList } from "@webflix/contracts";
import {
  BellIcon,
  Button,
  CloseIcon,
  cx,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ResponsiveImage,
  Skeleton,
  useMediaQuery,
} from "@webflix/ui";
import { Dialog as RadixDialog } from "radix-ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { useTitleOverlay } from "../../../app/overlay/titleOverlay.ts";
import { qk } from "../../../app/query/keys.ts";
import { queries } from "../../../app/query/queries.ts";
import { relativeTime } from "../common/format.ts";
import { noteTitleOpen } from "../common/telemetry.ts";
import { BellButton } from "./NotificationsBell.tsx";
import { PHONE_QUERY } from "./TopNav.tsx";

/**
 * New arrivals and episodes for the active profile: a popover under the bell, a full-screen
 * sheet on phones (a popover there is a cramped box over a page that still scrolls beneath).
 * Opening it marks what it shows as read (optimistically: the count clears at once), but items
 * keep their "new" dot until it closes, so people can still see what was new. Choosing one opens
 * the title's details.
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
  const phone = useMediaQuery(PHONE_QUERY);
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
      // Opened from the notifications menu: no page surface, no place on a page.
      noteTitleOpen(item.title.id, { surface: null, rowId: null, rowRank: null, rank: null });
      openTitle(item.title.id, { origin: element.querySelector(".wf-image") ?? element });
    }
  };

  const list = (
    <NotificationItems
      notifications={notifications}
      fresh={fresh}
      onChoose={choose}
      roomy={phone}
    />
  );

  if (phone) {
    return (
      <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
        <RadixDialog.Trigger asChild>
          <BellButton ref={triggerRef} unread={unread} />
        </RadixDialog.Trigger>
        <RadixDialog.Portal>
          <RadixDialog.Content
            aria-describedby={undefined}
            data-testid="notifications-sheet"
            className={cx(
              "fixed inset-0 z-(--z-overlay) flex flex-col bg-surface-1 text-fg outline-none",
              "data-[state=open]:animate-sheet-in-end data-[state=closed]:animate-fade-out",
            )}
          >
            <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line-subtle ps-5 pe-2 pt-[env(safe-area-inset-top)]">
              <RadixDialog.Title className="type-title text-fg">Notifications</RadixDialog.Title>
              <RadixDialog.Close asChild>
                <IconButton label="Close" icon={CloseIcon} variant="ghost" size="md" />
              </RadixDialog.Close>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
              {list}
            </div>
          </RadixDialog.Content>
        </RadixDialog.Portal>
      </RadixDialog.Root>
    );
  }

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
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{list}</div>
      </PopoverContent>
    </Popover>
  );
}

function NotificationItems({
  notifications,
  fresh,
  onChoose,
  roomy,
}: {
  notifications: UseQueryResult<NotificationList>;
  fresh: ReadonlySet<string>;
  onChoose: (item: Notification, element: HTMLElement) => void;
  /** The phone sheet: more room around each item, larger pictures. */
  roomy: boolean;
}): ReactNode {
  const row = cx("flex w-full items-start gap-3 text-start", roomy ? "px-5 py-4" : "px-4 py-3");
  const picture = cx(
    "relative block aspect-video shrink-0 overflow-hidden rounded-sm bg-surface-3",
    roomy ? "w-32" : "w-28",
  );
  if (notifications.isPending) {
    return (
      <ul aria-busy="true" className="flex flex-col">
        {[0, 1, 2].map((index) => (
          <li key={index} className={row}>
            <Skeleton radius="sm" className={picture} />
            <span className="flex flex-1 flex-col gap-2 pt-1">
              <Skeleton radius="sm" className="h-3 w-24" />
              <Skeleton radius="sm" className="h-3 w-36" />
            </span>
          </li>
        ))}
      </ul>
    );
  }
  if (notifications.isError) {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
        <p className="type-body-sm text-fg-muted">Notifications couldn't be loaded.</p>
        <Button size="sm" variant="outline" onClick={() => notifications.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (notifications.data.items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
        <BellIcon size="xl" className="text-fg-subtle" />
        <p className="type-label text-fg">You're all caught up</p>
        <p className="type-body-sm text-fg-muted">New arrivals and episodes will show here.</p>
      </div>
    );
  }
  return (
    <ul className="flex flex-col py-1">
      {notifications.data.items.map((item) => {
        const isNew = !item.readAt || fresh.has(item.id);
        return (
          <li key={item.id}>
            <button
              type="button"
              disabled={!item.title}
              onClick={(event) => onChoose(item, event.currentTarget)}
              className={cx(
                row,
                "focus-ring-inset transition-colors duration-fast ease-standard hover:bg-surface-3",
              )}
            >
              <span
                aria-hidden
                className={cx(
                  "mt-2 size-1.5 shrink-0 rounded-full",
                  isNew ? "bg-accent" : "bg-transparent",
                )}
              />
              <span className={picture}>
                {item.image ? (
                  <ResponsiveImage
                    image={item.image}
                    alt=""
                    fill
                    sizes={roomy ? "128px" : "112px"}
                  />
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
  );
}
