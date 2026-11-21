import { Link, useRouterState } from "@tanstack/react-router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@webflix/ui";
import { useEffect, useRef } from "react";
import { PRIMARY_LINKS } from "./links.ts";
import {
  BROWSE_TRIGGER_CLASS,
  BrowseTriggerContent,
  type HandoverProps,
  useCurrentPrimaryLabel,
} from "./menus.tsx";

/** Tablet primary navigation: the current view's name opens the list of views. */
export function BrowseMenu({ defaultOpen = false, autoFocus = false }: HandoverProps) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const label = useCurrentPrimaryLabel();
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (autoFocus && !defaultOpen) trigger.current?.focus();
  }, []);
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger ref={trigger} className={BROWSE_TRIGGER_CLASS}>
        <BrowseTriggerContent label={label} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {PRIMARY_LINKS.map((item) => (
          <DropdownMenuItem key={item.to} asChild>
            <Link
              to={item.to}
              aria-current={item.to === pathname ? "page" : undefined}
              className="aria-[current=page]:font-semibold aria-[current=page]:text-accent"
            >
              {item.label}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
