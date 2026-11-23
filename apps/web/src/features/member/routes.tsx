/**
 * MEMBER — owned by the member + watch engineer: marketing, sign in/out, sign-up flow,
 * profiles and account. Every screen is declared here and lazily loaded from this folder;
 * `app/router/tree.ts` plugs each group into the matching guard layout. Edit routes here only.
 */
import {
  createRoute,
  lazyRouteComponent,
  type ParsedLocation,
  redirect,
} from "@tanstack/react-router";
import {
  type AuthenticatedSession,
  OIDC_INTENTS,
  OIDC_OUTCOMES,
  OIDC_PROVIDERS,
  PAYMENT_DECLINE_REASONS,
  PLAN_IDS,
  type SessionState,
} from "@webflix/contracts";
import { queries } from "../../app/query/queries.ts";
import type { RouterContext } from "../../app/router/context.ts";
import {
  accountLayout,
  guestLayout,
  profileLayout,
  publicLayout,
} from "../../app/router/layouts.tsx";
import { optionalSearch, searchParam } from "../../app/router/search.ts";
import {
  isUnfinishedSignup,
  resumeHref,
  type SignupStage,
  signupStage,
} from "./billing/membership.ts";
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
      /** A federated attempt that came back signed out (auth/oidc.ts). */
      oidc: searchParam.oneOf(OIDC_OUTCOMES, search.oidc),
      provider: searchParam.oneOf(OIDC_PROVIDERS, search.provider),
    }),
  component: lazyRouteComponent(() => import("./auth/LoginPage.tsx"), "LoginPage"),
});

// --- Sign-in landing and email links (identity; auth/) ------------------------------------------
//
// Public: a federated attempt comes back signed in or not, and an emailed link may be opened in
// any browser, signed in or out.

/** Every "Continue with Google / Apple" attempt comes back here; it dispatches on the outcome. */
const signInLandingRoute = createRoute({
  getParentRoute: () => publicLayout,
  path: "/login/continue",
  staticData: { title: "Signing in" },
  validateSearch: (search: Record<string, unknown>) =>
    optionalSearch({
      oidc: searchParam.oneOf(OIDC_OUTCOMES, search.oidc),
      /** `OIDC_ERROR_PARAM`: why the server refused the attempt, passed on to the page. */
      oidcError: searchParam.string(search.oidcError),
      provider: searchParam.oneOf(OIDC_PROVIDERS, search.provider),
      context: searchParam.oneOf(["signin", "signup"] as const, search.context),
      from: searchParam.redirect(search.from),
      redirect: searchParam.redirect(search.redirect),
      next: searchParam.redirect(search.next),
      // Mock mode only: the stand-in for the issuer's page.
      "mock-issuer": searchParam.string(search["mock-issuer"]),
      intent: searchParam.oneOf(OIDC_INTENTS, search.intent),
      returnTo: searchParam.redirect(search.returnTo),
    }),
  component: lazyRouteComponent(() => import("./auth/SignInLandingPage.tsx"), "SignInLandingPage"),
});

const forgotPasswordRoute = createRoute({
  getParentRoute: () => publicLayout,
  path: "/forgot-password",
  staticData: { title: "Reset your password" },
  validateSearch: (search: Record<string, unknown>) =>
    optionalSearch({ email: searchParam.string(search.email) }),
  component: lazyRouteComponent(
    () => import("./auth/ForgotPasswordPage.tsx"),
    "ForgotPasswordPage",
  ),
});

/** The emailed reset link: `/reset-password#token=…` (the token never reaches a server). */
const resetPasswordRoute = createRoute({
  getParentRoute: () => publicLayout,
  path: "/reset-password",
  staticData: { title: "Choose a new password" },
  component: lazyRouteComponent(() => import("./auth/ResetPasswordPage.tsx"), "ResetPasswordPage"),
});

/** The emailed verification link: `/verify-email#token=…`. */
const verifyEmailRoute = createRoute({
  getParentRoute: () => publicLayout,
  path: "/verify-email",
  staticData: { title: "Verify your email" },
  component: lazyRouteComponent(() => import("./auth/VerifyEmailPage.tsx"), "VerifyEmailPage"),
});

// --- Sign-up flow ------------------------------------------------------------------------------
//
// Milestone 2 order (docs/BLUEPRINT-M2.md §5.1): the account is created at step 1, then plan,
// payment in the provider's form, the confirming state, profiles. `/signup` is the one entry for
// everyone: a guest starts at step 1, and a signed-in account is sent to the step its state calls
// for (`signupStage`, billing/membership.ts). Every later step runs the same check, so deep links,
// refreshes, the Back button and members who stopped half-way always land on a step that can
// actually be completed.

async function loadSession(context: RouterContext): Promise<SessionState> {
  return context.queryClient.ensureQueryData(queries.session());
}

/**
 * Where this signed-in account's sign-up resumes (asks the server for an open checkout, unless
 * this deployment takes no payments: then there can be none).
 */
function resumeFor(context: RouterContext, session: SessionState): Promise<string> {
  return resumeHref(session, async () => {
    const config = await context.queryClient.ensureQueryData(queries.billingConfig());
    if (config.provider === "none") return null;
    const answer = await context.queryClient.fetchQuery(queries.openCheckout());
    return answer.checkout;
  });
}

/** Step 1 is for guests: a signed-in account resumes where its sign-up stands. */
async function requireSignupGuest({ context }: { context: RouterContext }): Promise<void> {
  const session = await loadSession(context);
  if (session.authenticated)
    throw redirect({ href: await resumeFor(context, session), replace: true });
}

/**
 * A step after the account exists. Guests go back to the start (`/signup` offers sign-in to
 * someone who already has an account); an account whose stage is not one of `allowed` resumes
 * where it stands.
 */
async function requireSignupStage(
  { context, location }: { context: RouterContext; location: ParsedLocation },
  allowed: readonly SignupStage[],
  signedOut: "start" | "sign-in" = "start",
): Promise<AuthenticatedSession> {
  const session = await loadSession(context);
  if (!session.authenticated) {
    throw signedOut === "start"
      ? redirect({ to: "/signup", search: {}, replace: true })
      : redirect({ to: "/login", search: { redirect: location.href }, replace: true });
  }
  if (!allowed.includes(signupStage(session))) {
    throw redirect({ href: await resumeFor(context, session), replace: true });
  }
  return session;
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
      /** A federated attempt that came back to this page (FederatedButtons shows it). */
      oidc: searchParam.oneOf(OIDC_OUTCOMES, search.oidc),
      provider: searchParam.oneOf(OIDC_PROVIDERS, search.provider),
    }),
  component: lazyRouteComponent(() => import("./signup/RegistrationStep.tsx"), "RegistrationStep"),
});

const signupPlanRoute = createRoute({
  getParentRoute: () => signupRoute,
  path: "/plan",
  staticData: { title: "Choose your plan" },
  // A first payment that awaits confirmation may still pick another plan (the server ends the
  // unpaid one when a checkout starts for another plan).
  beforeLoad: (args) => requireSignupStage(args, ["plan", "payment"]),
  validateSearch: (search: Record<string, unknown>) =>
    optionalSearch({ plan: searchParam.oneOf(PLAN_IDS, search.plan) }),
  component: lazyRouteComponent(() => import("./signup/PlanStep.tsx"), "PlanStep"),
});

/**
 * `declined`: a card was just declined at the confirming state ("Use another card"): the payment
 * step says so, instead of looking as if nothing happened (UX review 2.13).
 */
const DECLINED_AGAIN = [...PAYMENT_DECLINE_REASONS, "unknown"] as const;

const signupPaymentRoute = createRoute({
  getParentRoute: () => signupRoute,
  path: "/payment",
  staticData: { title: "Payment" },
  validateSearch: (search: Record<string, unknown>) =>
    optionalSearch({
      plan: searchParam.oneOf(PLAN_IDS, search.plan),
      declined: searchParam.oneOf(DECLINED_AGAIN, search.declined),
    }),
  beforeLoad: async (args) => {
    await requireSignupStage(args, ["plan", "payment"]);
    if (!args.search.plan && !readDraft().planId) {
      throw redirect({ to: "/signup/plan", search: {}, replace: true });
    }
  },
  component: lazyRouteComponent(() => import("./signup/PaymentStep.tsx"), "PaymentStep"),
});

/**
 * Step 3, continued: the payment is being confirmed. The provider's form returns here
 * (`payment=succeeded` from the fake provider's form, `redirect_status` from Stripe after a
 * redirect). Any stage may land here: a reload after the membership started shows its welcome.
 */
const signupConfirmRoute = createRoute({
  getParentRoute: () => signupRoute,
  path: "/confirm",
  staticData: { title: "Confirming your payment" },
  validateSearch: (search: Record<string, unknown>) =>
    optionalSearch({
      checkout: searchParam.string(search.checkout),
      payment: searchParam.oneOf(["succeeded", "failed"] as const, search.payment),
      redirect_status: searchParam.oneOf(
        ["succeeded", "processing", "failed"] as const,
        search.redirect_status,
      ),
    }),
  beforeLoad: async (args) => {
    const session = await requireSignupStage(
      args,
      ["plan", "payment", "profiles", "complete"],
      "sign-in",
    );
    if (!args.search.checkout) {
      throw redirect({ href: await resumeFor(args.context, session), replace: true });
    }
  },
  component: lazyRouteComponent(() => import("./signup/ConfirmStep.tsx"), "ConfirmStep"),
});

const signupProfileRoute = createRoute({
  getParentRoute: () => signupRoute,
  path: "/profile",
  staticData: { title: "Create your profiles" },
  // Setup is finished once a profile exists (Back from the app, or a stale tab); an account
  // without a membership pays first.
  beforeLoad: (args) => requireSignupStage(args, ["profiles"], "sign-in"),
  component: lazyRouteComponent(() => import("./signup/ProfileStep.tsx"), "ProfileStep"),
});

/**
 * Mock mode only: the stand-in for the payment provider's hosted form (`GET /billing/config`
 * names it in mock mode; the real fake provider's form is served by the API under `/_pay`).
 */
const mockProviderRoute = __WEBFLIX_MOCK__
  ? createRoute({
      getParentRoute: () => publicLayout,
      path: "/mock-pay",
      staticData: { title: "Test payments" },
      validateSearch: (search: Record<string, unknown>) =>
        optionalSearch({
          secret: searchParam.string(search.secret),
          return: searchParam.redirect(search.return),
        }),
      component: lazyRouteComponent(
        () => import("./billing/MockProviderPage.tsx"),
        "MockProviderPage",
      ),
    })
  : null;

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
  // An account that never finished sign-up has no profile to choose: the server treats it as the
  // account holder, so its account pages open (with finishing sign-up offered, not forced).
  beforeLoad: async ({ context, location }) => {
    const session = await loadSession(context);
    if (session.authenticated && !session.activeProfile && !isUnfinishedSignup(session)) {
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

// Membership (billing): the hub and its flows. `/account/plan` and `/account/cancel` (milestone 1
// links) lead to their new homes.

const accountMembershipRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/membership",
  staticData: { title: "Membership" },
  component: lazyRouteComponent(
    () => import("./account/MembershipPage.tsx"),
    "AccountMembershipPage",
  ),
});

const accountPlanRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/membership/plan",
  staticData: { title: "Change plan" },
  component: lazyRouteComponent(() => import("./account/PlanPage.tsx"), "AccountPlanPage"),
});

const accountCancelRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/membership/cancel",
  staticData: { title: "Cancel membership" },
  component: lazyRouteComponent(() => import("./account/CancelPage.tsx"), "AccountCancelPage"),
});

const accountPaymentMethodRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/membership/payment",
  staticData: { title: "Payment method" },
  validateSearch: (search: Record<string, unknown>) =>
    optionalSearch({
      /** The card change the provider's form returns to. */
      setup: searchParam.string(search.setup),
      payment: searchParam.oneOf(["succeeded", "failed"] as const, search.payment),
      redirect_status: searchParam.oneOf(
        ["succeeded", "processing", "failed"] as const,
        search.redirect_status,
      ),
    }),
  component: lazyRouteComponent(
    () => import("./account/PaymentMethodPage.tsx"),
    "AccountPaymentMethodPage",
  ),
});

const accountInvoicesRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/membership/invoices",
  staticData: { title: "Billing history" },
  component: lazyRouteComponent(() => import("./account/InvoicesPage.tsx"), "AccountInvoicesPage"),
});

/** Restarting an ended membership: the payment step of a new checkout. */
const accountCheckoutRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/membership/checkout",
  staticData: { title: "Restart your membership" },
  validateSearch: (search: Record<string, unknown>) =>
    optionalSearch({
      plan: searchParam.oneOf(PLAN_IDS, search.plan),
      declined: searchParam.oneOf(DECLINED_AGAIN, search.declined),
    }),
  beforeLoad: ({ search }) => {
    if (!search.plan) throw redirect({ to: "/account/membership/plan", replace: true });
  },
  component: lazyRouteComponent(
    () => import("./account/RestartPage.tsx"),
    "AccountRestartPaymentPage",
  ),
});

/** The confirming state of a restart (the provider's form returns here). */
const accountConfirmRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/membership/confirm",
  staticData: { title: "Confirming your payment" },
  validateSearch: (search: Record<string, unknown>) =>
    optionalSearch({
      checkout: searchParam.string(search.checkout),
      payment: searchParam.oneOf(["succeeded", "failed"] as const, search.payment),
      redirect_status: searchParam.oneOf(
        ["succeeded", "processing", "failed"] as const,
        search.redirect_status,
      ),
    }),
  beforeLoad: ({ search }) => {
    if (!search.checkout) throw redirect({ to: "/account/membership", replace: true });
  },
  component: lazyRouteComponent(
    () => import("./account/RestartPage.tsx"),
    "AccountRestartConfirmPage",
  ),
});

const legacyPlanRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/plan",
  beforeLoad: () => {
    throw redirect({ to: "/account/membership/plan", replace: true });
  },
});

const legacyCancelRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/cancel",
  beforeLoad: () => {
    throw redirect({ to: "/account/membership/cancel", replace: true });
  },
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

/**
 * The export email's link (`/account/privacy/exports/{id}#token=…`). Outside the account guard:
 * the page itself leads a signed-out member to sign in and back, keeping the token in the tab.
 */
const exportLinkRoute = createRoute({
  getParentRoute: () => publicLayout,
  path: "/account/privacy/exports/$requestId",
  staticData: { title: "Your Webflix data" },
  component: lazyRouteComponent(
    () => import("./account/privacy/ExportLinkPage.tsx"),
    "ExportLinkPage",
  ),
});

const accountPrivacyRoute = createRoute({
  getParentRoute: () => accountRoute,
  path: "/privacy",
  staticData: { title: "Privacy" },
  component: lazyRouteComponent(
    () => import("./account/privacy/PrivacyPage.tsx"),
    "AccountPrivacyPage",
  ),
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
      signupConfirmRoute,
      signupProfileRoute,
    ]),
    ...(mockProviderRoute ? [mockProviderRoute] : []),
    logoutRoute,
    exportLinkRoute,
    signInLandingRoute,
    forgotPasswordRoute,
    resetPasswordRoute,
    verifyEmailRoute,
  ],
  guest: [landingRoute, loginRoute],
  account: [
    profileGateRoute,
    manageProfilesRoute,
    newProfileRoute,
    editProfileRoute,
    accountRoute.addChildren([
      accountOverviewRoute,
      accountMembershipRoute,
      accountPlanRoute,
      accountCancelRoute,
      accountPaymentMethodRoute,
      accountInvoicesRoute,
      accountCheckoutRoute,
      accountConfirmRoute,
      legacyPlanRoute,
      legacyCancelRoute,
      accountDevicesRoute,
      accountSecurityRoute,
      accountPrivacyRoute,
    ]),
  ],
  profile: [accountActivityRoute],
} as const;
