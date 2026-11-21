import type { QueryClient } from "@tanstack/react-query";
import type { Profile, SessionState } from "@webflix/contracts";
import { qk } from "../../../app/query/keys.ts";

/**
 * Keep the cached session (the source every screen reads profiles from) in step with profile
 * mutations without waiting for a refetch, then refetch to stay authoritative.
 */
export function upsertSessionProfile(queryClient: QueryClient, profile: Profile): void {
  const session = queryClient.getQueryData<SessionState>(qk.session());
  if (session?.authenticated) {
    const exists = session.profiles.some((item) => item.id === profile.id);
    const next: SessionState = {
      ...session,
      profiles: exists
        ? session.profiles.map((item) => (item.id === profile.id ? profile : item))
        : [...session.profiles, profile],
      activeProfile: session.activeProfile?.id === profile.id ? profile : session.activeProfile,
    };
    queryClient.setQueryData(qk.session(), next);
    // A change to the active profile's maturity or settings changes what the catalog shows.
    if (session.activeProfile?.id === profile.id) {
      void queryClient.invalidateQueries({ queryKey: qk.profile.all() });
    }
  }
  void queryClient.invalidateQueries({ queryKey: qk.account.profiles() });
  void queryClient.invalidateQueries({ queryKey: qk.session() });
}

export function removeSessionProfile(queryClient: QueryClient, profileId: string): void {
  const session = queryClient.getQueryData<SessionState>(qk.session());
  if (session?.authenticated) {
    const next: SessionState = {
      ...session,
      profiles: session.profiles.filter((item) => item.id !== profileId),
      activeProfile: session.activeProfile?.id === profileId ? null : session.activeProfile,
    };
    queryClient.setQueryData(qk.session(), next);
  }
  void queryClient.invalidateQueries({ queryKey: qk.account.profiles() });
  void queryClient.invalidateQueries({ queryKey: qk.session() });
}
