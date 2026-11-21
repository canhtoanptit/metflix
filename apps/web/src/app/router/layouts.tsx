import { createRoute } from "@tanstack/react-router";
import { validateTitleOverlaySearch } from "../overlay/titleOverlay.ts";
import { requireAccount, requireGuest, requireProfile } from "./guards.ts";
import { rootRoute } from "./root.tsx";

/**
 * Pathless layout routes: one per access level. Feature routes attach to these as parents
 * (`getParentRoute: () => profileLayout`), so a screen cannot forget its guard.
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
});
