import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import {
  ApiError,
  MAX_PROFILES_PER_ACCOUNT,
  type Profile,
  type SelectProfileBody,
} from "@webflix/contracts";
import { Avatar, Button, Dialog, DialogContent, DialogFooter, PinInput, toast } from "@webflix/ui";
import { useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { describeError } from "../../../app/query/errors.ts";
import { qk } from "../../../app/query/keys.ts";
import { isSafeRedirect } from "../../../app/router/search.ts";
import { useApplySession, useAuthenticatedSession } from "../../../app/session/session.ts";
import { discardPendingEvents } from "../../../app/telemetry/index.ts";
import { parseProvider, providerName } from "../auth/oidc.ts";
import { MemberHeader } from "../shared/Chrome.tsx";
import { IdentityNotConfirmed, useConfirmIdentity } from "../shared/ConfirmIdentity.tsx";
import { FormAlert } from "../shared/FormAlert.tsx";
import { possessive } from "../shared/format.ts";
import { standingOf, useIsDemoAccount } from "../shared/privileges.ts";
import { RetryTimer } from "../shared/RetryTimer.tsx";
import { useFocusAfterBusy } from "../shared/useFocusAfterBusy.ts";
import { useRetryAfter } from "../shared/useRetryAfter.ts";
import { MembershipNotice } from "./MembershipNotice.tsx";
import { AddProfileTile, ProfileChoice, ProfileGrid } from "./ProfileTile.tsx";

const route = getRouteApi("/account/profiles");

/**
 * "Who's watching?": choose a profile (PIN when locked), then continue to `?redirect=` or home.
 * Locked profiles open a PIN dialog with a visible retry timer when attempts are rate limited,
 * and a "Forgot PIN?" path that removes the lock once the account holder confirms it's them (the
 * password, or a fresh sign-in at a provider for an account without one). A kids profile is
 * offered no profile management: only another profile.
 */
export function ProfileGatePage() {
  const session = useAuthenticatedSession();
  const demo = useIsDemoAccount();
  const manages = standingOf(session.activeProfile) !== "kids";
  const { redirect } = route.useSearch();
  // On the way to adding a provider (after `link-required`): say where choosing leads.
  const linking = redirect?.startsWith("/account/security?")
    ? parseProvider(new URLSearchParams(redirect.split("?")[1]).get("link"))
    : undefined;
  const navigate = useNavigate();
  const applySession = useApplySession();
  const queryClient = useQueryClient();
  const [locked, setLocked] = useState<Profile | null>(null);
  const [forgot, setForgot] = useState(false);
  const [pin, setPin] = useState("");
  const [attempt, setAttempt] = useState(0);
  const rate = useRetryAfter();
  const returnFocus = useRef<HTMLElement | null>(null);
  const identity = useConfirmIdentity({
    id: "forgot-pin",
    purpose: `remove the lock from ${locked?.name ?? "this profile"}`,
    // Back from confirming at a provider (the page reloaded): offer the removal again.
    onResume: () => {
      const profile = session.profiles.find((candidate) => candidate.id === takeForgotProfile());
      if (!profile) return;
      setPin("");
      setForgot(true);
      setLocked(profile);
    },
  });

  const enter = async (next: Awaited<ReturnType<ReturnType<typeof api>["selectProfile"]>>) => {
    setLocked(null);
    await applySession(next);
    await navigate({
      href: redirect && isSafeRedirect(redirect) ? redirect : "/browse",
      replace: true,
    });
  };

  const select = useMutation({
    mutationFn: (body: SelectProfileBody) => {
      // Events queued for the profile being left must never be stamped as the next one.
      discardPendingEvents();
      return api().selectProfile({ body });
    },
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

  // Forgot PIN: remove the lock as the proven account holder, then go straight in. A kids
  // profile may not change locks, so leave it first (anyone may leave a profile).
  const unlock = useMutation({
    mutationFn: async (profile: Profile) => {
      if (!manages) {
        discardPendingEvents();
        await applySession(await api().clearProfile());
      }
      keepForgotProfile(profile.id);
      await identity.run(() =>
        api().updateProfile({ params: { id: profile.id }, body: { pin: null } }),
      );
      takeForgotProfile();
      discardPendingEvents();
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

  const removeRef = useRef<HTMLButtonElement>(null);
  useFocusAfterBusy(unlock.isPending, removeRef);

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
          {linking ? (
            <p className="type-body-lg text-fg-muted">
              Choose your profile, then add {providerName(linking)} to your account.
            </p>
          ) : redirect?.startsWith("/account") ? (
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
              <div className="flex flex-col gap-4">
                <p className="type-body text-fg-muted">
                  Forgot {possessive(locked.name)} PIN? Remove the lock and continue as{" "}
                  {locked.name}. You'll be asked to confirm it's you, and you can set a new PIN
                  later.
                </p>
                {unlock.error && !(unlock.error instanceof IdentityNotConfirmed) ? (
                  <FormAlert title={describeError(unlock.error).title}>
                    {describeError(unlock.error).description}
                  </FormAlert>
                ) : null}
                <DialogFooter className="mt-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      unlock.reset();
                      setForgot(false);
                    }}
                  >
                    Back
                  </Button>
                  <Button
                    ref={removeRef}
                    variant="accent"
                    loading={unlock.isPending}
                    onClick={() => unlock.mutate(locked)}
                  >
                    Remove lock
                  </Button>
                </DialogFooter>
              </div>
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
      {identity.prompt}
    </div>
  );
}

const FORGOT_KEY = "webflix:forgot-pin-profile";

/** Which profile's lock is being removed, kept for this tab across a provider round trip. */
function keepForgotProfile(profileId: string): void {
  try {
    sessionStorage.setItem(FORGOT_KEY, profileId);
  } catch {
    // Without storage the member chooses the profile again on return: still correct.
  }
}

function takeForgotProfile(): string | null {
  try {
    const id = sessionStorage.getItem(FORGOT_KEY);
    sessionStorage.removeItem(FORGOT_KEY);
    return id;
  } catch {
    return null;
  }
}
