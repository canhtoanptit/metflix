import { type QueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type {
  AuthenticatedSession,
  Entitlement,
  MembershipState,
  Profile,
  SessionState,
} from "@webflix/contracts";
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

// --- Membership (milestone 2, docs/BLUEPRINT-M2.md §5.2) ----------------------------------------

/** The membership projection and the entitlement derived from it, as the server last said. */
export interface MembershipView {
  membership: MembershipState;
  entitlement: Entitlement;
}

/**
 * The session's membership. The server's projection when it sends one; an older server (no
 * `membership`) is read from milestone 1's subscription, which only knows active, canceling and
 * ended. Never guessed from anything the browser did: only the server moves a membership.
 */
export function membershipOf(
  session: Pick<AuthenticatedSession, "membership" | "entitlement" | "subscription" | "plan">,
): MembershipView {
  if (session.membership && session.entitlement) {
    return { membership: session.membership, entitlement: session.entitlement };
  }
  const { subscription, plan } = session;
  if (!subscription || !plan) {
    return {
      membership: {
        status: "none",
        planId: null,
        cancelAtPeriodEnd: false,
        trialEndsAt: null,
        currentPeriodEnd: null,
        graceEndsAt: null,
        suspendedReason: null,
        provider: null,
      },
      entitlement: {
        entitled: false,
        reason: "no_membership",
        maxStreams: 0,
        maxVideoHeight: null,
        until: null,
      },
    };
  }
  const entitled = subscription.status !== "ended";
  return {
    membership: {
      status: entitled ? "active" : "canceled",
      planId: subscription.planId,
      cancelAtPeriodEnd: subscription.status === "canceling",
      trialEndsAt: null,
      currentPeriodEnd: subscription.currentPeriodEnd,
      graceEndsAt: null,
      suspendedReason: null,
      provider: null,
    },
    entitlement: {
      entitled,
      reason: entitled ? "entitled" : "ended",
      maxStreams: entitled ? plan.maxStreams : 0,
      maxVideoHeight: entitled ? plan.maxVideoHeight : null,
      until: subscription.status === "canceling" ? subscription.currentPeriodEnd : null,
    },
  };
}

/** The signed-in account's membership. Use under the account or profile guards only. */
export function useMembership(): MembershipView {
  return membershipOf(useAuthenticatedSession());
}

/**
 * Cache transitions when the session changes. Each drops the caches that belonged to the
 * previous identity, so nothing personalised leaks across accounts or profiles.
 */
export const sessionCache = {
  /**
   * The server answered with a newer membership (`GET /account`, a checkout that completed, a
   * refused playback): write it into the cached session so every gate and notice agrees, then
   * refetch the session for anything else that moved with it.
   */
  applyMembership(
    queryClient: QueryClient,
    next: Partial<
      Pick<AuthenticatedSession, "membership" | "entitlement" | "subscription" | "plan">
    >,
  ): void {
    const current = queryClient.getQueryData<SessionState>(qk.session());
    if (current?.authenticated) {
      const defined = Object.fromEntries(
        Object.entries(next).filter(([, value]) => value !== undefined),
      );
      queryClient.setQueryData(qk.session(), { ...current, ...defined });
    }
    void queryClient.invalidateQueries({ queryKey: qk.session() });
  },
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
