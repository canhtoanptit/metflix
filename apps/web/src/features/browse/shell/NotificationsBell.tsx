import { useQuery } from "@tanstack/react-query";
import { BellIcon, IconButton } from "@webflix/ui";
import { type ComponentProps, type Ref, useEffect } from "react";
import { queries } from "../../../app/query/queries.ts";
import { preloadable, useModule } from "../common/modules.ts";
import { useLoadOnIntent } from "./intent.ts";

export const notificationsModule = preloadable(() => import("./NotificationsMenu.tsx"));

export interface BellButtonProps extends Omit<ComponentProps<"button">, "children" | "ref"> {
  unread: number;
  ref?: Ref<HTMLButtonElement>;
}

/** The bell with its unread count (the count is decorative: the label carries it). */
export function BellButton({ unread, ref, ...rest }: BellButtonProps) {
  return (
    <span className="relative inline-flex">
      <IconButton
        ref={ref}
        label={unread > 0 ? `Notifications, ${unread} new` : "Notifications"}
        icon={BellIcon}
        {...rest}
      />
      {unread > 0 ? (
        <span
          aria-hidden
          className="pointer-events-none absolute end-0.5 top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-2xs font-bold leading-none text-fg-on-accent"
        >
          {unread > 9 ? "9+" : unread}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The notifications entry point in the navigation. The bell and its count are in the page's
 * first load; the menu itself (popover, list, read tracking) loads on intent — the pointer
 * reaching the bell, focus, or a click — so it costs nothing until someone wants it.
 */
export function NotificationsBell() {
  const notifications = useQuery({ ...queries.notifications(), meta: { silent: true } });
  const unread = notifications.data?.unreadCount ?? 0;
  const intent = useLoadOnIntent();
  const bell = <BellButton unread={unread} aria-haspopup="dialog" {...intent.triggerProps} />;
  const loaded = useModule(notificationsModule);
  useEffect(() => {
    if (intent.requested) void notificationsModule.load().catch(() => {});
  }, [intent.requested]);
  if (!intent.requested || !loaded) return bell;
  return <loaded.NotificationsMenu defaultOpen={intent.openOnLoad} autoFocus={intent.hadFocus} />;
}
