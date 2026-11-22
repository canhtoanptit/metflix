import { useRouterState } from "@tanstack/react-router";
import type { TitleType } from "@webflix/contracts";
import { Avatar, ChevronDownIcon, cx } from "@webflix/ui";
import { type ReactNode, useEffect } from "react";
import { type Preloadable, preloadable, useModule } from "../common/modules.ts";
import { useBrowseProfile } from "../common/session.ts";
import { useLoadOnIntent } from "./intent.ts";
import { PRIMARY_LINKS } from "./links.ts";

/**
 * Navigation menus, loaded on intent (see `intent.ts`): each entry renders a trigger that looks
 * exactly like the real one and swaps in the menu when someone reaches for it.
 */

export const profileMenuModule = preloadable(() => import("./ProfileMenu.tsx"));
export const browseMenuModule = preloadable(() => import("./BrowseMenu.tsx"));
export const genreMenuModule = preloadable(() => import("./GenreMenu.tsx"));

/**
 * The menu module as soon as its code is here (preloaded on idle, or requested by the stand-in):
 * the real trigger replaces the stand-in then, before anyone presses it, so a press never lands
 * half on one and half on the other.
 */
export function useRequestedModule<T>(module: Preloadable<T>, requested: boolean): T | undefined {
  const loaded = useModule(module);
  useEffect(() => {
    if (requested) void module.load().catch(() => {});
  }, [module, requested]);
  return loaded;
}

/** Props every lazily loaded menu accepts from its stand-in trigger. */
export interface HandoverProps {
  /** Open on mount: the stand-in was pressed before the menu's code arrived. */
  defaultOpen?: boolean;
  /** Focus the real trigger on mount: the stand-in had focus. */
  autoFocus?: boolean;
}

const CHEVRON =
  "transition-transform duration-base ease-standard group-data-[state=open]:rotate-180";

// --- Profile ------------------------------------------------------------------------------------

export const PROFILE_TRIGGER_CLASS = "focus-ring group flex items-center gap-1.5 rounded-sm";

export function ProfileTriggerContent({ compact }: { compact: boolean }) {
  const profile = useBrowseProfile();
  return (
    <>
      <Avatar src={profile.avatar.imageUrl} name={profile.name} size="sm" decorative />
      {compact ? null : <ChevronDownIcon size="sm" className={cx("text-fg-muted", CHEVRON)} />}
    </>
  );
}

export function ProfileMenuEntry({ compact = false }: { compact?: boolean }) {
  const profile = useBrowseProfile();
  const intent = useLoadOnIntent();
  const standIn = (
    <button
      type="button"
      className={PROFILE_TRIGGER_CLASS}
      aria-label={`Profile menu for ${profile.name}`}
      aria-haspopup="menu"
      {...intent.triggerProps}
    >
      <ProfileTriggerContent compact={compact} />
    </button>
  );
  const module = useRequestedModule(profileMenuModule, intent.requested);
  if (!module) return standIn;
  return (
    <module.ProfileMenu
      compact={compact}
      defaultOpen={intent.openOnLoad}
      autoFocus={intent.hadFocus}
    />
  );
}

// --- Browse (tablet primary navigation) --------------------------------------------------------

export const BROWSE_TRIGGER_CLASS =
  "focus-ring group flex items-center gap-1.5 rounded-sm type-label text-fg";

export function useCurrentPrimaryLabel(): string {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return PRIMARY_LINKS.find((item) => item.to === pathname)?.label ?? "Browse";
}

export function BrowseTriggerContent({ label }: { label: string }) {
  return (
    <>
      {label}
      <ChevronDownIcon size="sm" className={CHEVRON} />
    </>
  );
}

export function BrowseMenuEntry() {
  const label = useCurrentPrimaryLabel();
  const intent = useLoadOnIntent();
  const standIn = (
    <button
      type="button"
      className={BROWSE_TRIGGER_CLASS}
      aria-haspopup="menu"
      {...intent.triggerProps}
    >
      <BrowseTriggerContent label={label} />
    </button>
  );
  const module = useRequestedModule(browseMenuModule, intent.requested);
  return (
    <nav aria-label="Primary">
      {module ? (
        <module.BrowseMenu defaultOpen={intent.openOnLoad} autoFocus={intent.hadFocus} />
      ) : (
        standIn
      )}
    </nav>
  );
}

// --- Genres ---------------------------------------------------------------------------------------

export interface GenreMenuEntryProps {
  /** Restrict the genre pages to one type (opened from Series or Movies). */
  type?: TitleType;
  /** Trigger text. */
  children?: ReactNode;
  /** `pill`: rounded outline (phone category bar); `plain`: bordered box (page headers). */
  appearance?: "pill" | "plain";
}

export function genreTriggerClass(appearance: "pill" | "plain"): string {
  return cx(
    "focus-ring group inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-fg",
    "transition-colors duration-fast ease-standard",
    appearance === "pill"
      ? "h-8 rounded-full border border-line-strong px-3.5 type-label hover:border-fg"
      : "h-9 rounded-sm border border-line-strong bg-canvas/60 px-3 type-label hover:border-fg",
  );
}

export function GenreTriggerContent({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <ChevronDownIcon size="sm" className={CHEVRON} />
    </>
  );
}

export function GenreMenuEntry({
  type,
  children = "Genres",
  appearance = "plain",
}: GenreMenuEntryProps) {
  const intent = useLoadOnIntent();
  const standIn = (
    <button
      type="button"
      className={genreTriggerClass(appearance)}
      aria-haspopup="menu"
      {...intent.triggerProps}
    >
      <GenreTriggerContent>{children}</GenreTriggerContent>
    </button>
  );
  const module = useRequestedModule(genreMenuModule, intent.requested);
  if (!module) return standIn;
  return (
    <module.GenreMenu
      type={type}
      appearance={appearance}
      defaultOpen={intent.openOnLoad}
      autoFocus={intent.hadFocus}
    >
      {children}
    </module.GenreMenu>
  );
}
