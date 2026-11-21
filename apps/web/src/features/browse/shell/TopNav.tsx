import { Link } from "@tanstack/react-router";
import { cx, useMediaQuery, Wordmark } from "@webflix/ui";
import { useBrowseProfile } from "../common/session.ts";
import { PRIMARY_LINKS } from "./links.ts";
import { BrowseMenuEntry, ProfileMenuEntry } from "./menus.tsx";
import { NavSearch } from "./NavSearch.tsx";
import { NotificationsBell } from "./NotificationsBell.tsx";
import { useScrolled } from "./useScrolled.ts";

/** Breakpoints (match the `sm` / `md` tokens). */
export const PHONE_QUERY = "(max-width: 31.2rem)";
/** Inline primary links need room for the expanded search field beside them (the `lg` token). */
const INLINE_NAV_QUERY = "(min-width: 68.75rem)";

/**
 * Top navigation: transparent over the billboard (a soft scrim keeps it legible), solid once the
 * page scrolls. Desktop shows the primary links inline; tablets fold them into "Browse"; phones
 * keep the bar minimal and move primary navigation to the tab bar at the bottom.
 */
export function TopNav() {
  const profile = useBrowseProfile();
  const scrolled = useScrolled(8);
  const phone = useMediaQuery(PHONE_QUERY);
  const inlineNav = useMediaQuery(INLINE_NAV_QUERY);

  return (
    <header className="fixed inset-x-0 top-0 z-(--z-sticky)" data-scrolled={scrolled || undefined}>
      <div
        aria-hidden
        className={cx(
          "pointer-events-none absolute inset-0 bg-canvas shadow-md transition-opacity duration-slow ease-standard",
          scrolled ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        aria-hidden
        className={cx(
          "pointer-events-none absolute inset-x-0 top-0 h-[150%] scrim-top transition-opacity duration-slow ease-standard",
          scrolled ? "opacity-0" : "opacity-100",
        )}
      />
      <div className="relative flex h-nav items-center gap-3 px-gutter sm:gap-6 lg:gap-10">
        <Link
          to="/browse"
          className="focus-ring flex shrink-0 items-center gap-2 rounded-sm"
          aria-label={profile.isKids ? "Webflix Kids home" : "Webflix home"}
        >
          <Wordmark
            className="h-4 sm:h-5 xl:h-6"
            title={profile.isKids ? "Webflix Kids" : "Webflix"}
          />
          {profile.isKids ? (
            <span
              aria-hidden
              className="rounded-full bg-accent px-2 py-0.5 type-overline text-fg-on-accent"
            >
              Kids
            </span>
          ) : null}
        </Link>
        {inlineNav ? <PrimaryLinks /> : phone ? null : <BrowseMenuEntry />}
        <div className="ms-auto flex items-center gap-1 sm:gap-2 lg:gap-3">
          <NavSearch variant={phone ? "cover" : "inline"} />
          <NotificationsBell />
          <ProfileMenuEntry compact={phone} />
        </div>
      </div>
    </header>
  );
}

function PrimaryLinks() {
  return (
    <nav aria-label="Primary" className="min-w-0">
      <ul className="flex items-center gap-5 lg:gap-6">
        {PRIMARY_LINKS.map((item) => (
          <li key={item.to}>
            <Link
              to={item.to}
              activeOptions={{ exact: true, includeSearch: false }}
              className={cx(
                "focus-ring whitespace-nowrap rounded-sm type-body-sm text-fg-muted",
                "transition-colors duration-fast ease-standard hover:text-fg",
                "data-[status=active]:font-semibold data-[status=active]:text-fg",
              )}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
