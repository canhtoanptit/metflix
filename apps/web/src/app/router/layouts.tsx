import { createRoute, Outlet } from "@tanstack/react-router";
import { validateTitleOverlaySearch } from "../overlay/titleOverlay.ts";
import { useSession } from "../session/session.ts";
import { requireAccount, requireGuest, requireProfile } from "./guards.ts";
import { rootRoute } from "./root.tsx";

/**
 * Pathless layout routes: one per access level. Feature routes attach to these as parents
 * (`getParentRoute: () => profileLayout`), so a screen cannot forget its guard.
 *
 * The guarded groups also render their screens only while the live session still passes the
 * guard. A session that ends with a screen open (signed out everywhere, revoked, "Sign in again",
 * `profile_required`) changes the session cache first, and the router re-runs the guard straight
 * after (`router.invalidate()`). In between, a screen would render without the session the guard
 * promised it: `useAuthenticatedSession` throws and the error page flashes on the way to sign-in.
 * For that moment the group renders nothing, and the guard's redirect follows.
 */

/** No guard (sign-up flow shell, sign-out page, legal, dev tools). */
export const publicLayout = createRoute({ getParentRoute: () => rootRoute, id: "public" });

/** Signed-out visitors only: landing and sign in. */
export const guestLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: "guest",
  beforeLoad: requireGuest,
});

/** Signed in, profile optional: Who's watching?, profile management, account. */
export const accountLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: "account",
  beforeLoad: requireAccount,
  component: AccountScreens,
});

/**
 * Signed in with an active profile: browse, search, My List, watch. Also owns the `?title=`
 * overlay param (see `overlay/titleOverlay.ts`), inherited by every child route.
 */
export const profileLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: "profile",
  beforeLoad: requireProfile,
  validateSearch: validateTitleOverlaySearch,
  component: ProfileScreens,
});

function AccountScreens() {
  const session = useSession();
  return session.authenticated ? <Outlet /> : null;
}

function ProfileScreens() {
  const session = useSession();
  return session.authenticated && session.activeProfile ? <Outlet /> : null;
}
