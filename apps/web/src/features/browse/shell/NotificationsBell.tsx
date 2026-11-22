import { useQuery } from "@tanstack/react-query";
import { BellIcon, cx, IconButton } from "@webflix/ui";
import type { ComponentProps, Ref } from "react";
import { queries } from "../../../app/query/queries.ts";
import { preloadable } from "../common/modules.ts";
import { useLoadOnIntent } from "./intent.ts";
import { useRequestedModule } from "./menus.tsx";

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
        // Anchored just past the glyph's centre so a wider count grows outwards, away from the
        // bell, and cut out of it by a ring of the canvas colour: one digit is a neat circle on
        // the bell's shoulder, "9+" a short pill that never covers the glyph.
        <span
          aria-hidden
          data-count={unread > 9 ? "many" : "few"}
          className={cx(
            "pointer-events-none absolute start-[55%] top-1 grid h-4 min-w-4 place-items-center rounded-full",
            "bg-accent text-2xs font-bold leading-none tabular-nums text-fg-on-accent ring-2 ring-canvas",
            unread > 9 ? "px-1" : "px-0",
          )}
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
  const loaded = useRequestedModule(notificationsModule, intent.requested);
  if (!loaded) return bell;
  return <loaded.NotificationsMenu defaultOpen={intent.openOnLoad} autoFocus={intent.hadFocus} />;
}
