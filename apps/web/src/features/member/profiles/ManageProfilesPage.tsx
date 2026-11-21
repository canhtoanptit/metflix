import { Link } from "@tanstack/react-router";
import { MAX_PROFILES_PER_ACCOUNT } from "@webflix/contracts";
import { Button } from "@webflix/ui";
import { useAuthenticatedSession } from "../../../app/session/session.ts";
import { MemberHeader } from "../shared/Chrome.tsx";
import { useIsDemoAccount } from "../shared/privileges.ts";
import { AddProfileTile, ProfileEditLink, ProfileGrid } from "./ProfileTile.tsx";

/**
 * "Manage profiles": every profile opens its editor; add one while under the limit. The demo
 * account's profiles keep their shape: only their playback settings change.
 */
export function ManageProfilesPage() {
  const session = useAuthenticatedSession();
  const demo = useIsDemoAccount();
  const full = session.profiles.length >= MAX_PROFILES_PER_ACCOUNT;
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <MemberHeader home="/profiles" />
      <main
        id="main"
        className="flex flex-1 flex-col items-center justify-center gap-10 px-gutter pt-6 pb-16 md:gap-12"
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <h1 className="type-display-md text-fg">Manage profiles</h1>
          <p className="type-body-lg text-fg-muted">
            {demo
              ? "This is the shared demo account: choose a profile to change its playback settings."
              : full
                ? `You have ${MAX_PROFILES_PER_ACCOUNT} profiles, the most an account can have. Edit or delete one to make room.`
                : "Choose a profile to change its name, picture, maturity rating, lock or playback settings."}
          </p>
        </div>
        <ProfileGrid label="Profiles">
          {session.profiles.map((profile) => (
            <ProfileEditLink key={profile.id} profile={profile} />
          ))}
          {full || demo ? null : <AddProfileTile />}
        </ProfileGrid>
        <Button variant="primary" size="lg" asChild>
          <Link to="/profiles">Done</Link>
        </Button>
      </main>
    </div>
  );
}
