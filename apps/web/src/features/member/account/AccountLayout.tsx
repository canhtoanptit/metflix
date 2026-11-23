import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { ApiError, type Profile } from "@webflix/contracts";
import {
  Avatar,
  Button,
  CreditCardIcon,
  cx,
  DevicesIcon,
  EyeIcon,
  HistoryIcon,
  HomeIcon,
  type IconComponent,
  prefersReducedMotion,
  ShieldIcon,
  UsersIcon,
} from "@webflix/ui";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { qk } from "../../../app/query/keys.ts";
import { useAuthenticatedSession } from "../../../app/session/session.ts";
import { FinishSetupNotice } from "../billing/FinishSetupNotice.tsx";
import { isUnfinishedSignup } from "../billing/membership.ts";
import { MATURITY_COPY } from "../profiles/maturity.ts";
import { MemberHeader } from "../shared/Chrome.tsx";
import { possessive } from "../shared/format.ts";
import { standingOf } from "../shared/privileges.ts";

interface NavItem {
  to:
    | "/account"
    | "/account/membership"
    | "/account/security"
    | "/account/devices"
    | "/account/privacy"
    | "/profiles/manage"
    | "/account/activity";
  label: string;
  icon: IconComponent;
  exact?: boolean;
  /** Needs a profile: not offered to an account that has not finished sign-up. */
  profiles?: boolean;
}

const NAV: NavItem[] = [
  { to: "/account", label: "Overview", icon: HomeIcon, exact: true },
  { to: "/account/membership", label: "Membership", icon: CreditCardIcon },
  { to: "/account/security", label: "Security", icon: ShieldIcon },
  { to: "/account/devices", label: "Devices", icon: DevicesIcon },
  { to: "/account/privacy", label: "Privacy", icon: EyeIcon },
  { to: "/profiles/manage", label: "Profiles", icon: UsersIcon, profiles: true },
  { to: "/account/activity", label: "Viewing activity", icon: HistoryIcon, profiles: true },
];

/**
 * `/account/*` routes render inside this frame. Account management needs a profile without
 * parental controls: a kids or restricted profile gets a way to switch instead of forms the
 * server would refuse (the gate never gets here: the route sends it to Who's watching? first).
 */
export function AccountLayout() {
  const session = useAuthenticatedSession();
  const refused = useAccountHolderRefused();
  const profile = session.activeProfile;
  const standing = standingOf(profile);
  if (profile && (refused || standing === "kids" || standing === "restricted")) {
    return (
      <AccountFrame navigation={false}>
        <AccountHolderRequired profile={profile} />
      </AccountFrame>
    );
  }
  return (
    <AccountFrame>
      <Outlet />
    </AccountFrame>
  );
}

/**
 * True once any account request is refused with `unrestricted_profile_required`: the profile got
 * parental controls on another device after this session loaded. Refreshes the session, so the
 * rest of the app sees the new controls too.
 */
function useAccountHolderRefused(): boolean {
  const queryClient = useQueryClient();
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    const check = (error: unknown) => {
      if (!ApiError.is(error, "unrestricted_profile_required")) return;
      setRefused(true);
      void queryClient.invalidateQueries({ queryKey: qk.session() });
    };
    const stopQueries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") check(event.action.error);
    });
    const stopMutations = queryClient.getMutationCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") check(event.action.error);
    });
    return () => {
      stopQueries();
      stopMutations();
    };
  }, [queryClient]);
  return refused;
}

function AccountHolderRequired({ profile }: { profile: Profile }) {
  const here = useLocation({ select: (location) => location.href });
  const reason = profile.isKids
    ? `${profile.name} is a kids profile.`
    : standingOf(profile) === "restricted"
      ? `${possessive(profile.name)} profile has a maturity limit (${MATURITY_COPY[profile.maturityCeiling].label}).`
      : `${profile.name} has parental controls now.`;
  return (
    <section
      aria-labelledby="account-holder-required"
      className="flex flex-col items-center gap-5 rounded-xl border border-line-subtle bg-surface-1 px-5 py-12 text-center sm:px-10"
    >
      <span className="grid size-16 place-items-center rounded-full bg-surface-2 text-fg-muted">
        <ShieldIcon size="xl" />
      </span>
      <h1 id="account-holder-required" className="type-headline text-fg">
        Account settings are available from a profile without parental controls
      </h1>
      <p className="max-w-prose type-body-lg text-fg-muted">
        {reason} Membership, payment, sign-in details and devices are managed from a profile without
        them.
      </p>
      <div className="mt-2 flex w-full flex-col gap-3 sm:w-auto sm:flex-row-reverse">
        <Button variant="primary" size="lg" asChild>
          <Link to="/profiles" search={{ redirect: here }}>
            Switch profile
          </Link>
        </Button>
        <Button variant="outline" size="lg" asChild>
          <Link to="/browse">Back to Webflix</Link>
        </Button>
      </div>
    </section>
  );
}

/**
 * Account chrome: header with a way back to watching, section navigation (a sidebar on wide
 * screens, a scrollable strip on phones) and the content column. Viewing activity lives under
 * the profile guard but uses the same frame.
 */
export function AccountFrame({
  children,
  navigation = true,
}: {
  children: ReactNode;
  /** Off when the account's sections aren't available to this profile. */
  navigation?: boolean;
}) {
  const session = useAuthenticatedSession();
  const profile = session.activeProfile;
  const unfinished = isUnfinishedSignup(session);
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <MemberHeader
        home={profile ? "/browse" : unfinished ? "/" : "/profiles"}
        className="border-b border-line-subtle"
        action={
          unfinished ? (
            <Link
              to="/logout"
              className="focus-ring rounded-sm type-label text-fg-muted hover:text-fg"
            >
              Sign out
            </Link>
          ) : profile ? (
            <Link
              to="/browse"
              className="focus-ring flex items-center gap-2.5 rounded-sm type-label text-fg-muted hover:text-fg"
            >
              <span className="hidden sm:inline">Back to Webflix</span>
              <Avatar src={profile.avatar.imageUrl} name={profile.name} size="sm" decorative />
              <span className="sr-only sm:hidden">Back to Webflix</span>
            </Link>
          ) : (
            <Link
              to="/profiles"
              className="focus-ring rounded-sm type-label text-fg-muted hover:text-fg"
            >
              Who's watching?
            </Link>
          )
        }
      />
      <div className="mx-auto flex w-full max-w-page flex-1 flex-col gap-6 px-gutter pt-6 pb-20 lg:flex-row lg:gap-12 lg:pt-12">
        {navigation ? <AccountNav withProfiles={!unfinished} /> : null}
        <main
          id="main"
          className={cx(
            "flex min-w-0 max-w-dialog-lg flex-1 flex-col gap-8",
            !navigation && "mx-auto",
          )}
        >
          <FinishSetupNotice session={session} />
          {children}
        </main>
      </div>
    </div>
  );
}

/**
 * The account's sections: a sidebar on wide screens, a strip on phones that scrolls sideways.
 * On a phone the current section is brought into view (centred when it can be), and the strip
 * fades at an edge with more sections beyond it, so it is evident that it scrolls.
 */
function AccountNav({ withProfiles }: { withProfiles: boolean }) {
  const list = useRef<HTMLUListElement>(null);
  const pathname = useLocation({ select: (location) => location.pathname });
  const [edges, setEdges] = useState({ start: false, end: false });
  const placed = useRef(false);

  const measure = useCallback(() => {
    const element = list.current;
    if (!element) return;
    const max = element.scrollWidth - element.clientWidth;
    const next = {
      start: max > 1 && element.scrollLeft > 1,
      end: max > 1 && element.scrollLeft < max - 1,
    };
    setEdges((current) =>
      current.start === next.start && current.end === next.end ? current : next,
    );
  }, []);

  // The current section into view, whenever it changes (instantly the first time).
  useEffect(() => {
    const element = list.current;
    const active = element?.querySelector<HTMLElement>('[data-status="active"]');
    if (!element || !active || element.scrollWidth <= element.clientWidth) {
      measure();
      return;
    }
    const left = active.offsetLeft - (element.clientWidth - active.offsetWidth) / 2;
    element.scrollTo({
      left: Math.max(0, left),
      behavior: placed.current && !prefersReducedMotion() ? "smooth" : "auto",
    });
    placed.current = true;
    measure();
  }, [pathname, measure]);

  useEffect(() => {
    const element = list.current;
    if (!element) return;
    element.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      element.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  // Alpha only: a mask, so the fade follows whatever is behind the strip.
  const fade = "2.5rem";
  const mask =
    edges.start && edges.end
      ? `linear-gradient(to right, transparent, black ${fade}, black calc(100% - ${fade}), transparent)`
      : edges.start
        ? `linear-gradient(to right, transparent, black ${fade})`
        : edges.end
          ? `linear-gradient(to left, transparent, black ${fade})`
          : undefined;

  return (
    <nav aria-label="Account" className="-mx-gutter lg:mx-0 lg:w-56 lg:shrink-0">
      <ul
        ref={list}
        style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
        className="scrollbar-none relative flex gap-1 overflow-x-auto px-gutter lg:sticky lg:top-6 lg:flex-col lg:overflow-visible lg:px-0"
      >
        {NAV.filter((item) => withProfiles || !item.profiles).map((item) => (
          <li key={item.to} className="shrink-0">
            <Link
              to={item.to}
              activeOptions={{ exact: item.exact ?? false, includeSearch: false }}
              className={cx(
                "focus-ring flex items-center gap-3 rounded-control px-3 py-2 type-label whitespace-nowrap text-fg-muted transition-colors duration-fast",
                "hover:bg-surface-2 hover:text-fg",
                "data-[status=active]:bg-surface-2 data-[status=active]:text-fg",
                "lg:py-2.5",
              )}
            >
              <item.icon size="md" className="hidden lg:block" />
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Page title block inside the account frame. */
export function AccountHeading({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="type-headline text-fg">{title}</h1>
      {description ? <div className="type-body-lg text-fg-muted">{description}</div> : null}
    </div>
  );
}

/** A titled panel of the account pages. */
export function AccountSection({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const id = `account-${title.toLowerCase().replaceAll(/\W+/g, "-")}`;
  return (
    <section
      aria-labelledby={id}
      className={cx(
        "flex flex-col gap-5 rounded-xl border border-line-subtle bg-surface-1 p-5 sm:p-6",
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={id} className="type-title text-fg">
            {title}
          </h2>
          {description ? <div className="type-body-sm text-fg-muted">{description}</div> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
