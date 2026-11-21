/**
 * MEMBER — owned by the member + watch engineer: marketing, sign in/out, sign-up flow,
 * profiles and account. Every screen is declared here and lazily loaded from this folder;
 * `app/router/tree.ts` plugs each group into the matching guard layout. Edit routes here only.
 */
import { createRoute, lazyRouteComponent, redirect } from "@tanstack/react-router";
import { PLAN_IDS, type SessionState } from "@webflix/contracts";
import { queries } from "../../app/query/queries.ts";
import type { RouterContext } from "../../app/router/context.ts";
import { requireAccount } from "../../app/router/guards.ts";
import {
  accountLayout,
  guestLayout,
  profileLayout,
  publicLayout,
} from "../../app/router/layouts.tsx";
import { optionalSearch, searchParam } from "../../app/router/search.ts";
import { showcaseQuery } from "./shared/artwork.ts";
import { readDraft } from "./signup/draft.ts";

// --- Guests (signed out) ---------------------------------------------------------------------

/**
 * Start fetching the showcase with the navigation, in parallel with the page's code, so its
 * artwork is requested as early as it can be. Never awaited: the page renders without it.
 */
function prefetchShowcase({ context }: { context: RouterContext }): void {
  void context.queryClient.prefetchQuery(showcaseQuery());
}

const landingRoute = createRoute({
  getParentRoute: () => guestLayout,
  path: "/",
  loader: prefetchShowcase,
  component: lazyRouteComponent(() => import("./marketing/LandingPage.tsx"), "LandingPage"),
});

export const loginRoute = createRoute({
  getParentRoute: () => guestLayout,
  path: "/login",
  staticData: { title: "Sign in" },
  loader: prefetchShowcase,
  validateSearch: (search: Record<string, unknown>) =>
    optionalSearch({
      email: searchParam.string(search.email),
      redirect: searchParam.redirect(search.redirect),
    }),
  component: lazyRouteComponent(() => import("./auth/LoginPage.tsx"), "LoginPage"),
});

// --- Sign-up flow ------------------------------------------------------------------------------
//
// Steps 1–3 are for guests and build a draft (signup/draft.ts); the account is created at the
// payment step, and step 4 (profiles) runs signed in. Each step guards itself, so deep links,
// refreshes and the Back button always land on a step that can actually be completed.

async function loadSession(context: RouterContext): Promise<SessionState> {
  return context.queryClient.ensureQueryData(queries.session());
}

/** Signed-in visitors leave the guest steps: to the profile step if they have no profile yet. */
async function requireSignupGuest({ context }: { context: RouterContext }): Promise<void> {
  const session = await loadSession(context);
  if (!session.authenticated) return;
  if (session.profiles.length === 0) throw redirect({ to: "/signup/profile", replace: true });
  throw redirect({ href: session.activeProfile ? "/browse" : "/profiles", replace: true });
}

const signupRoute = createRoute({
  getParentRoute: () => publicLayout,
  path: "/signup",
  staticData: { title: "Sign up" },
  component: lazyRouteComponent(() => import("./signup/SignupLayout.tsx"), "SignupLayout"),
});

const signupRegistrationRoute = createRoute({
  getParentRoute: () => signupRoute,
  path: "/",
  beforeLoad: requireSignupGuest,
  validateSearch: (search: Record<string, unknown>) =>
    optionalSearch({
      email: searchParam.string(search.email),
      /** A plan picked on the landing page, carried into step 2. */
      plan: searchParam.oneOf(PLAN_IDS, search.plan),
    }),
  component: lazyRouteComponent(() => import("./signup/RegistrationStep.tsx"), "RegistrationStep"),
});

const signupPlanRoute = createRoute({
  getParentRoute: () => signupRoute,
  path: "/plan",
  staticData: { title: "Choose your plan" },
  beforeLoad: async (args) => {
    await requireSignupGuest(args);
    if (!readDraft().email) throw redirect({ to: "/signup", search: {}, replace: true });
  },
  validateSearch: (search: Record<string, unknown>) =>
    optionalSearch({ plan: searchParam.oneOf(PLAN_IDS, search.plan) }),
  component: lazyRouteComponent(() => import("./signup/PlanStep.tsx"), "PlanStep"),
});

const signupPaymentRoute = createRoute({
  getParentRoute: () => signupRoute,
  path: "/payment",
  staticData: { title: "Payment" },
  validateSearch: (search: Record<string, unknown>) =>
    optionalSearch({ plan: searchParam.oneOf(PLAN_IDS, search.plan) }),
  beforeLoad: async (args) => {
    await requireSignupGuest(args);
    const draft = readDraft();
    if (!draft.email) throw redirect({ to: "/signup", search: {}, replace: true });
    if (!args.search.plan && !draft.planId) {
      throw redirect({ to: "/signup/plan", search: {}, replace: true });
    }
  },
  component: lazyRouteComponent(() => import("./signup/PaymentStep.tsx"), "PaymentStep"),
});

const signupProfileRoute = createRoute({
  getParentRoute: () => signupRoute,
  path: "/profile",
  staticData: { title: "Create your profiles" },
  beforeLoad: async (args) => {
    const { session } = await requireAccount(args);
    // Setup is finished once a profile exists (Back from the app, or a stale tab).
    if (session.profiles.length > 0) {
      throw redirect({ href: session.activeProfile ? "/browse" : "/profiles", replace: true });
    }
  },
  component: lazyRouteComponent(() => import("./signup/ProfileStep.tsx"), "ProfileStep"),
});

const logoutRoute = createRoute({
  getParentRoute: () => publicLayout,
  path: "/logout",
  staticData: { title: "Signed out" },
  component: lazyRouteComponent(() => import("./auth/LogoutPage.tsx"), "LogoutPage"),
});

// --- Signed in (profile optional) ----------------------------------------------------------

export const profileGateRoute = createRoute({
  getParentRoute: () => accountLayout,
  path: "/profiles",
  staticData: { title: "Who's watching?" },
  validateSearch: (search: Record<string, unknown>) =>
    optionalSearch({ redirect: searchParam.redirect(search.redirect) }),
  beforeLoad: async ({ context }) => {
    // An account that never finished setup has nobody to choose: finish it first.
    const session = await loadSession(context);
    if (session.authenticated && session.profiles.length === 0) {
      throw redirect({ to: "/signup/profile", replace: true });
    }
  },
  component: lazyRouteComponent(() => import("./profiles/ProfileGatePage.tsx"), "ProfileGatePage"),
});

/** Profile management is closed to kids profiles (they may only switch): Who's watching? instead. */
async function requireProfileManager({ context }: { context: RouterContext }): Promise<void> {
  const session = await loadSession(context);
  if (session.authenticated && session.activeProfile?.isKids) {
    throw redirect({ to: "/profiles", search: {}, replace: true });
  }
}

const manageProfilesRoute = createRoute({
  getParentRoute: () => accountLayout,
  path: "/profiles/manage",
  staticData: { title: "Manage profiles" },
  beforeLoad: requireProfileManager,
  component: lazyRouteComponent(
    () => import("./profiles/ManageProfilesPage.tsx"),
    "ManageProfilesPage",
  ),
});

const newProfileRoute = createRoute({
  getParentRoute: () => accountLayout,
  path: "/profiles/new",
  staticData: { title: "Add profile" },
  beforeLoad: requireProfileManager,
  component: lazyRouteComponent(() => import("./profiles/EditProfilePage.tsx"), "NewProfilePage"),
});

const editProfileRoute = createRoute({
  getParentRoute: () => accountLayout,
  path: "/profiles/$profileId/edit",
  staticData: { title: "Edit profile" },
  beforeLoad: requireProfileManager,
  component: lazyRouteComponent(() => import("./profiles/EditProfilePage.tsx"), "EditProfilePage"),
});

const accountRoute = createRoute({
  getParentRoute: () => accountLayout,
  path: "/account",
  staticData: { title: "Account" },
  // Account management happens from a profile: at the gate, choose one first, then come back.
  beforeLoad: async ({ context, location }) => {
    const session = await loadSession(context);
    if (session.authenticated && !session.activeProfile) {
      throw redirect({ to: "/profiles", search: { redirect: location.href }, replace: true });
    }
  },
  component: lazyRouteComponent(() => import("./account/AccountLayout.tsx"), "AccountLayout"),
});

const accountOverviewRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/",
  component: lazyRouteComponent(() => import("./account/OverviewPage.tsx"), "AccountOverviewPage"),
});

const accountPlanRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/plan",
  staticData: { title: "Change plan" },
  component: lazyRouteComponent(() => import("./account/PlanPage.tsx"), "AccountPlanPage"),
});

const accountCancelRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/cancel",
  staticData: { title: "Cancel membership" },
  component: lazyRouteComponent(() => import("./account/CancelPage.tsx"), "AccountCancelPage"),
});

const accountDevicesRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/devices",
  staticData: { title: "Devices" },
  component: lazyRouteComponent(() => import("./account/DevicesPage.tsx"), "AccountDevicesPage"),
});

const accountSecurityRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/security",
  staticData: { title: "Security" },
  component: lazyRouteComponent(() => import("./account/SecurityPage.tsx"), "AccountSecurityPage"),
});

// --- Signed in with a profile (viewing activity is per profile) ------------------------------

const accountActivityRoute = createRoute({
  getParentRoute: () => profileLayout,
  path: "/account/activity",
  staticData: { title: "Viewing activity" },
  component: lazyRouteComponent(() => import("./account/ActivityPage.tsx"), "AccountActivityPage"),
});

export const memberRoutes = {
  public: [
    signupRoute.addChildren([
      signupRegistrationRoute,
      signupPlanRoute,
      signupPaymentRoute,
      signupProfileRoute,
    ]),
    logoutRoute,
  ],
  guest: [landingRoute, loginRoute],
  account: [
    profileGateRoute,
    manageProfilesRoute,
    newProfileRoute,
    editProfileRoute,
    accountRoute.addChildren([
      accountOverviewRoute,
      accountPlanRoute,
      accountCancelRoute,
      accountDevicesRoute,
      accountSecurityRoute,
    ]),
  ],
  profile: [accountActivityRoute],
} as const;
