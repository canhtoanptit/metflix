import { Link, useRouterState } from "@tanstack/react-router";
import { cx, HomeIcon, type IconComponent, ListIcon, SearchIcon, SparkleIcon } from "@webflix/ui";

const TABS: ReadonlyArray<{
  to: "/browse" | "/search" | "/browse/new-popular" | "/my-list";
  label: string;
  icon: IconComponent;
}> = [
  { to: "/browse", label: "Home", icon: HomeIcon },
  { to: "/search", label: "Search", icon: SearchIcon },
  { to: "/browse/new-popular", label: "New & Popular", icon: SparkleIcon },
  { to: "/my-list", label: "My List", icon: ListIcon },
];

/** Which tab a path belongs to: Series, Movies and genre pages are views of Home. */
export function tabFor(pathname: string): string {
  if (pathname === "/browse/new-popular") return "/browse/new-popular";
  if (pathname.startsWith("/browse")) return "/browse";
  return pathname;
}

/** Phone navigation: a tab bar within thumb reach (the top bar stays minimal). */
export function MobileTabBar() {
  const current = useRouterState({ select: (state) => tabFor(state.location.pathname) });
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-(--z-sticky) border-t border-line-subtle bg-canvas/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md"
    >
      <ul className="grid h-14 grid-cols-4">
        {TABS.map(({ to, label, icon: Icon }) => (
          <li key={to} className="flex">
            <Link
              to={to}
              aria-current={current === to ? "page" : undefined}
              className={cx(
                "focus-ring-inset flex flex-1 flex-col items-center justify-center gap-1 text-fg-subtle",
                "transition-colors duration-fast ease-standard aria-[current=page]:text-fg",
              )}
            >
              <Icon size="md" />
              <span className="type-caption leading-none">{label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
