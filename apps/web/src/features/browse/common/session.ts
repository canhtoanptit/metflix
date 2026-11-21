import type { AuthenticatedSession, Profile } from "@webflix/contracts";
import { useSession } from "../../../app/session/session.ts";

type ProfileSession = AuthenticatedSession & { activeProfile: Profile };

let lastSignedIn: ProfileSession | null = null;

/**
 * The signed-in session with its active profile, for browse components.
 *
 * The platform hooks (`useActiveProfile`, `useAuthenticatedSession`) throw when the session is
 * not signed in with a profile. When a session ends underneath the page (signed out elsewhere,
 * expired, profile deleted), components subscribed to the session re-render with the new state a
 * moment before the route guards redirect, and a throw there flashes the route's error page.
 * This hook keeps answering with the last signed-in session for that transitional frame instead.
 */
export function useBrowseSession(): ProfileSession {
  const session = useSession();
  if (session.authenticated && session.activeProfile) {
    lastSignedIn = session as ProfileSession;
    return lastSignedIn;
  }
  if (lastSignedIn) return lastSignedIn;
  throw new Error("useBrowseSession used outside the profile guard");
}

export function useBrowseProfile(): Profile {
  return useBrowseSession().activeProfile;
}
