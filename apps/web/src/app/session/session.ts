import { type QueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { AuthenticatedSession, Profile, SessionState } from "@webflix/contracts";
import { useCallback } from "react";
import { qk } from "../query/keys.ts";
import { queries } from "../query/queries.ts";

const ANONYMOUS: SessionState = { authenticated: false };

/** The current session (always loaded before any route renders). */
export function useSession(): SessionState {
  return useSuspenseQuery(queries.session()).data;
}

/** The signed-in session. Use under the account or profile guards only. */
export function useAuthenticatedSession(): AuthenticatedSession {
  const session = useSession();
  if (!session.authenticated) throw new Error("useAuthenticatedSession used while signed out");
  return session;
}

/** The active profile. Use under the profile guard only. */
export function useActiveProfile(): Profile {
  const session = useAuthenticatedSession();
  if (!session.activeProfile) throw new Error("useActiveProfile used without an active profile");
  return session.activeProfile;
}

/**
 * Cache transitions when the session changes. Each drops the caches that belonged to the
 * previous identity, so nothing personalised leaks across accounts or profiles.
 */
export const sessionCache = {
  /** After sign-in, sign-up, profile selection or clearing: store the server's session. */
  apply(queryClient: QueryClient, next: SessionState): void {
    const previous = queryClient.getQueryData<SessionState>(qk.session());
    const accountChanged =
      !previous?.authenticated || !next.authenticated || previous.account.id !== next.account.id;
    const profileChanged =
      accountChanged ||
      (previous?.authenticated && next.authenticated
        ? previous.activeProfile?.id !== next.activeProfile?.id
        : true);
    if (accountChanged) queryClient.removeQueries({ queryKey: qk.account.all() });
    if (profileChanged) queryClient.removeQueries({ queryKey: qk.profile.all() });
    queryClient.setQueryData(qk.session(), next);
  },
  /** After sign-out (or a 401): forget the account entirely. */
  signOut(queryClient: QueryClient): void {
    queryClient.removeQueries({ queryKey: qk.account.all() });
    queryClient.removeQueries({ queryKey: qk.profile.all() });
    queryClient.setQueryData(qk.session(), ANONYMOUS);
  },
  /** After `profile_required`: keep the account, drop the profile. */
  clearProfile(queryClient: QueryClient): void {
    const current = queryClient.getQueryData<SessionState>(qk.session());
    queryClient.removeQueries({ queryKey: qk.profile.all() });
    if (current?.authenticated) {
      queryClient.setQueryData(qk.session(), { ...current, activeProfile: null });
    }
  },
};

/**
 * Apply a new session and re-run the route guards (which redirect as needed). Returns a promise
 * that settles once the router has re-evaluated the current location.
 *
 *   const applySession = useApplySession();
 *   const session = await api().login({ body });
 *   await applySession(session);            // guards move a signed-in user off /login
 *   navigate({ to: redirectTo ?? "/browse" });
 */
export function useApplySession() {
  const router = useRouter();
  return useCallback(
    async (next: SessionState) => {
      sessionCache.apply(router.options.context.queryClient, next);
      await router.invalidate();
    },
    [router],
  );
}
