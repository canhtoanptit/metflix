import { type ParsedLocation, redirect } from "@tanstack/react-router";
import type { AuthenticatedSession, Profile, SessionState } from "@webflix/contracts";
import { queries } from "../query/queries.ts";
import type { RouterContext } from "./context.ts";
import { isSafeRedirect } from "./search.ts";

/**
 * Route guards (blueprint: signed out → marketing/auth; signed in without an active profile →
 * profile gate; with a profile → the app). Layout routes in `layouts.tsx` apply them to whole
 * groups; a route outside those groups can call one from its own `beforeLoad`.
 */

interface GuardArgs {
  context: RouterContext;
  location: ParsedLocation;
}

export const SIGN_IN_PATH = "/login";
export const PROFILE_GATE_PATH = "/profiles";
export const HOME_PATH = "/browse";

async function loadSession(context: RouterContext): Promise<SessionState> {
  return context.queryClient.ensureQueryData(queries.session());
}

function returnTo(location: ParsedLocation): string | undefined {
  const href = location.href;
  return isSafeRedirect(href) && href !== "/" ? href : undefined;
}

/** Only for signed-out visitors (landing, sign in, sign-up steps). Members go to the app. */
export async function requireGuest({ context }: GuardArgs): Promise<void> {
  const session = await loadSession(context);
  if (session.authenticated) {
    throw redirect({ href: session.activeProfile ? HOME_PATH : PROFILE_GATE_PATH, replace: true });
  }
}

/** Signed in, with or without an active profile (profile gate, account pages). */
export async function requireAccount({
  context,
  location,
}: GuardArgs): Promise<{ session: AuthenticatedSession }> {
  const session = await loadSession(context);
  if (!session.authenticated) {
    throw redirect({ to: SIGN_IN_PATH, search: { redirect: returnTo(location) }, replace: true });
  }
  return { session };
}

/** Signed in with an active profile (browse, title detail, search, watch). */
export async function requireProfile({
  context,
  location,
}: GuardArgs): Promise<{ session: AuthenticatedSession; profile: Profile }> {
  const { session } = await requireAccount({ context, location });
  if (!session.activeProfile) {
    throw redirect({
      to: PROFILE_GATE_PATH,
      search: { redirect: returnTo(location) },
      replace: true,
    });
  }
  return { session, profile: session.activeProfile };
}
