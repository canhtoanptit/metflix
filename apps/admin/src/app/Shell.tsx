/**
 * The console's frame: a navigation of what the staff member's roles open (nothing else), who is
 * signed in and with which roles, and sign-out. A sidebar from 1100px; a top bar with a menu
 * sheet below that.
 */

import { Link, type LinkProps, Outlet, useRouterState } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  Button,
  CalendarIcon,
  ClockIcon,
  CreditCardIcon,
  cx,
  Dialog,
  DialogTrigger,
  EmptyState,
  FilmIcon,
  FlagIcon,
  HelpIcon,
  HistoryIcon,
  HomeIcon,
  IconButton,
  type IconComponent,
  ListIcon,
  LogOutIcon,
  MenuIcon,
  MonitorIcon,
  SheetContent,
  ShieldIcon,
  SkipLink,
  SparkleIcon,
  UsersIcon,
} from "@webflix/ui";
import { useEffect, useRef, useState } from "react";
import { ROLE_LABELS } from "../access/roles.ts";
import { useStaff } from "../access/staff.tsx";
import { useRuntime } from "../auth/react.ts";
import { ConsoleBrand } from "./AuthScreens.tsx";

interface NavItem {
  to: LinkProps["to"];
  label: string;
  icon: IconComponent;
  exact?: boolean;
}

interface NavGroup {
  label: string | null;
  items: NavItem[];
}

function useNavigation(): NavGroup[] {
  const staff = useStaff();
  const groups: NavGroup[] = [
    { label: null, items: [{ to: "/", label: "Overview", icon: HomeIcon, exact: true }] },
  ];
  if (staff.has("support")) {
    groups[0]?.items.push({ to: "/members", label: "Members", icon: UsersIcon });
  }
  if (staff.has("billing")) {
    groups[0]?.items.push({ to: "/plans", label: "Plans & prices", icon: CreditCardIcon });
  }
  if (staff.has("experiments")) {
    groups[0]?.items.push({ to: "/experiments", label: "Experiments", icon: FlagIcon });
  }
  groups[0]?.items.push({ to: "/activity", label: "Your actions", icon: ClockIcon });
  if (staff.has("content")) {
    groups.push({
      label: "Content",
      items: [
        { to: "/content/billboards", label: "Billboards", icon: FilmIcon },
        { to: "/content/collections", label: "Collections", icon: ListIcon },
        { to: "/content/availability", label: "Availability", icon: CalendarIcon },
      ],
    });
  }
  if (staff.has("admin")) {
    groups.push({
      label: "Operations",
      items: [
        { to: "/operations/health", label: "System health", icon: MonitorIcon },
        { to: "/operations/dead-letters", label: "Failed jobs", icon: AlertTriangleIcon },
        { to: "/operations/recommendations", label: "Recommendations", icon: SparkleIcon },
        { to: "/operations/privacy", label: "Privacy jobs", icon: ShieldIcon },
        { to: "/operations/audit", label: "Audit log", icon: HistoryIcon },
      ],
    });
  }
  return groups;
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const groups = useNavigation();
  return (
    <nav aria-label="Console" className="flex flex-col gap-5">
      {groups.map((group) => (
        <div key={group.label ?? "main"} className="flex flex-col gap-0.5">
          {group.label ? (
            <h2 className="mb-1 px-3 type-overline text-fg-subtle">{group.label}</h2>
          ) : null}
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => (
              <li key={String(item.to)}>
                <Link
                  to={item.to}
                  activeOptions={{ exact: item.exact ?? false }}
                  onClick={onNavigate}
                  className="focus-ring flex h-9 items-center gap-2.5 rounded-md px-3 type-body-sm text-fg-muted transition-colors duration-fast hover:bg-surface-3 hover:text-fg aria-[current=page]:bg-surface-3 aria-[current=page]:text-fg"
                  activeProps={{ "aria-current": "page" }}
                >
                  <item.icon size="sm" />
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function WhoIsSignedIn() {
  const staff = useStaff();
  const { session } = useRuntime();
  const name = staff.identity.name ?? staff.identity.email ?? "Staff member";
  return (
    <div className="flex flex-col gap-2 border-t border-line-subtle pt-4">
      <div className="flex min-w-0 flex-col px-3">
        <span className="type-label truncate text-fg" title={name}>
          {name}
        </span>
        {staff.identity.email && staff.identity.name ? (
          <span className="type-caption truncate text-fg-subtle" title={staff.identity.email}>
            {staff.identity.email}
          </span>
        ) : null}
        <span className="mt-1 type-caption text-fg-muted">
          {staff.roles.map((role) => ROLE_LABELS[role]).join(" · ")}
        </span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        icon={LogOutIcon}
        className="justify-start"
        onClick={() => session.signOut()}
      >
        Sign out
      </Button>
    </div>
  );
}

export function Shell() {
  const { config } = useRuntime();
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const previous = useRef(pathname);
  // After a navigation, focus moves to the new screen's main landmark (so a screen reader
  // starts reading the new page and Tab continues from it), and the menu sheet closes. Compared
  // with the previous path, not "first render", so a remount (or React's development double
  // effects) never steals focus on load.
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    setMenuOpen(false);
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <div className="min-h-dvh bg-canvas lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      <SkipLink />
      <aside className="sticky top-0 hidden h-dvh flex-col gap-6 overflow-y-auto border-e border-line-subtle bg-surface-1 px-3 py-5 lg:flex">
        <Link to="/" className="focus-ring rounded-sm px-3">
          <ConsoleBrand development={config.development} />
          <span className="sr-only">Overview</span>
        </Link>
        <div className="flex-1">
          <NavList />
        </div>
        <WhoIsSignedIn />
      </aside>
      <header className="sticky top-0 z-(--z-sticky) flex h-14 items-center justify-between border-b border-line-subtle bg-surface-1 px-4 lg:hidden">
        <Link to="/" className="focus-ring rounded-sm">
          <ConsoleBrand development={config.development} />
          <span className="sr-only">Overview</span>
        </Link>
        <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
          <DialogTrigger asChild>
            <IconButton label="Menu" icon={MenuIcon} variant="ghost" />
          </DialogTrigger>
          <SheetContent title="Menu" side="end" className="gap-6">
            <div className="flex-1">
              <NavList onNavigate={() => setMenuOpen(false)} />
            </div>
            <WhoIsSignedIn />
          </SheetContent>
        </Dialog>
      </header>
      <main
        id="main"
        tabIndex={-1}
        className={cx("min-w-0 px-4 py-6 outline-none sm:px-6 lg:px-8 lg:py-8")}
      >
        <div className="mx-auto w-full max-w-page">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export function NotFound() {
  return (
    <EmptyState
      layout="page"
      icon={HelpIcon}
      title="There's no such page in the console"
      description="The link may be mistyped, or the page has moved."
      action={
        <Button asChild variant="outline" size="sm">
          <Link to="/">Go to the overview</Link>
        </Button>
      }
    />
  );
}
