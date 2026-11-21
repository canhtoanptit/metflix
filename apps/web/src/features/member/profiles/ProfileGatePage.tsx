import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import {
  ApiError,
  MAX_PROFILES_PER_ACCOUNT,
  type Profile,
  type SelectProfileBody,
} from "@webflix/contracts";
import { Avatar, Button, Dialog, DialogContent, PinInput, toast } from "@webflix/ui";
import { useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { describeError } from "../../../app/query/errors.ts";
import { qk } from "../../../app/query/keys.ts";
import { isSafeRedirect } from "../../../app/router/search.ts";
import { useApplySession, useAuthenticatedSession } from "../../../app/session/session.ts";
import { MemberHeader } from "../shared/Chrome.tsx";
import { FormAlert } from "../shared/FormAlert.tsx";
import { possessive } from "../shared/format.ts";
import { PasswordPrompt } from "../shared/PasswordPrompt.tsx";
import { standingOf, useIsDemoAccount } from "../shared/privileges.ts";
import { RetryTimer } from "../shared/RetryTimer.tsx";
import { useRetryAfter } from "../shared/useRetryAfter.ts";
import { MembershipNotice } from "./MembershipNotice.tsx";
import { AddProfileTile, ProfileChoice, ProfileGrid } from "./ProfileTile.tsx";

const route = getRouteApi("/account/profiles");

/**
 * "Who's watching?": choose a profile (PIN when locked), then continue to `?redirect=` or home.
 * Locked profiles open a PIN dialog with a visible retry timer when attempts are rate limited,
 * and a "Forgot PIN?" path that removes the lock with the account password. A kids profile is
 * offered no profile management: only another profile.
 */
export function ProfileGatePage() {
  const session = useAuthenticatedSession();
  const demo = useIsDemoAccount();
  const manages = standingOf(session.activeProfile) !== "kids";
  const { redirect } = route.useSearch();
  const navigate = useNavigate();
  const applySession = useApplySession();
  const queryClient = useQueryClient();
  const [locked, setLocked] = useState<Profile | null>(null);
  const [forgot, setForgot] = useState(false);
  const [pin, setPin] = useState("");
  const [attempt, setAttempt] = useState(0);
  const rate = useRetryAfter();
  const returnFocus = useRef<HTMLElement | null>(null);

  const enter = async (next: Awaited<ReturnType<ReturnType<typeof api>["selectProfile"]>>) => {
    setLocked(null);
    await applySession(next);
    await navigate({
      href: redirect && isSafeRedirect(redirect) ? redirect : "/browse",
      replace: true,
    });
  };

  const select = useMutation({
    mutationFn: (body: SelectProfileBody) => api().selectProfile({ body }),
    meta: { silent: true },
    onError: (error, body) => {
      setPin("");
      setAttempt((count) => count + 1);
      rate.track(error);
      if (ApiError.is(error, "profile_pin_required")) {
        // Locked on another device since this list loaded: ask for the PIN after all.
        const profile = session.profiles.find((candidate) => candidate.id === body.profileId);
        if (profile) {
          setForgot(false);
          unlock.reset();
          setLocked({ ...profile, isLocked: true });
        }
        void queryClient.invalidateQueries({ queryKey: qk.session() });
        return;
      }
      if (!locked && !ApiError.is(error, "rate_limited")) {
        const { title, description } = describeError(error);
        toast.error(title, { description });
      }
    },
    onSuccess: enter,
  });

  // Forgot PIN: remove the lock with the account password, then go straight in. A kids profile
  // may not change locks, so leave it first (anyone may leave a profile).
  const unlock = useMutation({
    mutationFn: async ({ profile, password }: { profile: Profile; password: string }) => {
      if (!manages) await applySession(await api().clearProfile());
      await api().updateProfile({
        params: { id: profile.id },
        body: { pin: null, currentPassword: password },
      });
      return api().selectProfile({ body: { profileId: profile.id } });
    },
    meta: { silent: true },
    onSuccess: async (next) => {
      void queryClient.invalidateQueries({ queryKey: qk.account.profiles() });
      toast.success("Profile lock removed", {
        description: "You can set a new PIN in Manage profiles.",
      });
      await enter(next);
    },
  });

  const choose = (profile: Profile) => {
    if (select.isPending) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    if (profile.isLocked) {
      setPin("");
      setForgot(false);
      select.reset();
      unlock.reset();
      setLocked(profile);
      return;
    }
    select.mutate({ profileId: profile.id });
  };

  const pinError =
    locked && select.error
      ? ApiError.is(select.error, "profile_pin_invalid")
        ? "Incorrect PIN. Please try again."
        : ApiError.is(select.error, "rate_limited") ||
            ApiError.is(select.error, "profile_pin_required")
          ? null
          : describeError(select.error).description
      : null;

  const pending = select.isPending ? select.variables?.profileId : null;

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <MemberHeader home="/profiles" />
      <main
        id="main"
        className="flex flex-1 flex-col items-center justify-center gap-10 px-gutter pt-6 pb-16 md:gap-12"
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <h1 className="type-display-md text-fg">Who's watching?</h1>
          {redirect?.startsWith("/account") ? (
            <p className="type-body-lg text-fg-muted">
              Choose your profile to continue to your account.
            </p>
          ) : null}
        </div>
        <MembershipNotice />
        <ProfileGrid label="Profiles">
          {session.profiles.map((profile) => (
            <ProfileChoice
              key={profile.id}
              profile={profile}
              busy={pending === profile.id}
              disabled={select.isPending}
              onChoose={choose}
            />
          ))}
          {manages && !demo && session.profiles.length < MAX_PROFILES_PER_ACCOUNT ? (
            <AddProfileTile />
          ) : null}
        </ProfileGrid>
        {manages ? (
          <Button variant="outline" size="lg" asChild>
            <Link to="/profiles/manage">Manage profiles</Link>
          </Button>
        ) : null}
      </main>

      <Dialog
        open={locked !== null}
        onOpenChange={(open) => {
          if (!open) setLocked(null);
        }}
      >
        {locked ? (
          <DialogContent
            size="sm"
            title={forgot ? "Remove profile lock" : "Profile lock is on"}
            description={forgot ? undefined : `Enter your PIN to watch as ${locked.name}.`}
            onCloseAutoFocus={(event) => {
              // Back to the tile that opened the dialog (Radix would pick the first tile).
              event.preventDefault();
              returnFocus.current?.focus();
            }}
          >
            {forgot ? (
              <PasswordPrompt
                intro={
                  <>
                    Forgot {possessive(locked.name)} PIN? Enter your account password to remove the
                    lock and continue. You can set a new PIN later.
                  </>
                }
                submitLabel="Remove lock"
                pending={unlock.isPending}
                error={unlock.error}
                onCancel={() => setForgot(false)}
                onSubmit={(password) => unlock.mutate({ profile: locked, password })}
              />
            ) : (
              <div className="flex flex-col items-center gap-5 pt-2">
                <Avatar src={locked.avatar.imageUrl} name={locked.name} size="lg" decorative />
                <PinInput
                  aria-label={`PIN for ${locked.name}`}
                  aria-describedby={pinError || rate.limited ? "pin-message" : undefined}
                  value={pin}
                  onChange={setPin}
                  autoFocus
                  error={Boolean(pinError)}
                  shakeKey={attempt}
                  disabled={rate.limited}
                  onComplete={(value) => {
                    if (!select.isPending) select.mutate({ profileId: locked.id, pin: value });
                  }}
                />
                {rate.limited ? (
                  <FormAlert id="pin-message" title="Too many attempts">
                    For your security, try again in <RetryTimer seconds={rate.waiting} />.
                  </FormAlert>
                ) : pinError ? (
                  <p id="pin-message" role="alert" className="type-body-sm text-danger">
                    {pinError}
                  </p>
                ) : (
                  <p className="min-h-5 type-body-sm text-fg-subtle" aria-live="polite">
                    {select.isPending ? "Checking your PIN…" : ""}
                  </p>
                )}
                {/* The demo account's locks stay put. */}
                {demo ? null : (
                  <Button variant="link" size="sm" onClick={() => setForgot(true)}>
                    Forgot PIN?
                  </Button>
                )}
              </div>
            )}
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
