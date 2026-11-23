import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ApiError, PASSWORD_RESET_TTL_SEC } from "@webflix/contracts";
import {
  Button,
  CheckCircleIcon,
  DevicesIcon,
  type IconComponent,
  KeyIcon,
  MailIcon,
  PasswordField,
  Spinner,
  toast,
} from "@webflix/ui";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { useApplySession } from "../../../app/session/session.ts";
import { discardPendingEvents } from "../../../app/telemetry/index.ts";
import { AuthBackdrop } from "../shared/AuthBackdrop.tsx";
import { MemberHeader } from "../shared/Chrome.tsx";
import { forgetDeletionOnSignIn } from "../shared/deletionMemory.ts";
import { FormAlert } from "../shared/FormAlert.tsx";
import { describeMemberError } from "../shared/privileges.ts";
import { useFocusOnError } from "../shared/useFocusOnError.ts";
import { validateNewPassword } from "../shared/validation.ts";
import { DeadLink } from "./DeadLink.tsx";
import { forgetLinkToken, looksLikeLinkToken, useLinkToken } from "./emailLink.ts";
import { linkOfferPath, pendingLinkIntent } from "./linkIntent.ts";
import { afterSignInPath, announceAuthChange, providerName } from "./oidc.ts";

const TOKEN_KEY = "webflix:reset-token";

/**
 * The emailed reset link: choose a new password. Before the member saves, the page says what a
 * reset does besides changing the password, so nothing comes as a surprise: every other device is
 * signed out, and Google or Apple sign-in linked under a different email address is unlinked.
 * Saving signs this device in (the server answers the session, as sign-in does): the member is
 * told so and continues where sign-in goes, or to adding the provider they came here for
 * (`link-required`). A used, expired or altered link gets one honest screen (the server
 * deliberately does not tell them apart) with the way to a new one.
 */
export function ResetPasswordPage() {
  const token = useLinkToken(TOKEN_KEY);
  const applySession = useApplySession();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [wanted] = useState(() => pendingLinkIntent());
  const [checked, setChecked] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  const reset = useMutation({
    mutationFn: (newPassword: string) => {
      // The reset signs every device out, this one too: nothing queued as the member is sent after.
      discardPendingEvents();
      return api().confirmPasswordReset({ body: { token: token ?? "", newPassword } });
    },
    meta: { silent: true },
    onSuccess: async (session, newPassword) => {
      forgetLinkToken(TOKEN_KEY);
      // This device is signed in, every other one signed out; this browser's other tabs share
      // the new session and move on by themselves.
      await applySession(session);
      announceAuthChange("signed-in");
      forgetDeletionOnSignIn();
      toast.success("Password changed", {
        id: "account-password",
        description: "You're signed in here, and signed out everywhere else.",
      });
      const linking = pendingLinkIntent();
      if (linking) {
        // Reset to add a provider (`link-required`): the new password is the proof the offer needs.
        await api()
          .elevate({ body: { password: newPassword } })
          .catch(() => {
            // The offer asks for the proof itself if this did not take.
          });
        await navigate({ href: linkOfferPath(linking), replace: true });
        return;
      }
      await navigate({ href: afterSignInPath(session, undefined), replace: true });
    },
    onError: (error) => {
      if (ApiError.is(error, "verification_token_invalid")) forgetLinkToken(TOKEN_KEY);
    },
  });
  useFocusOnError(reset.error, (error) =>
    ApiError.is(error, "validation_failed") ? passwordRef : alertRef,
  );

  if (!looksLikeLinkToken(token) || ApiError.is(reset.error, "verification_token_invalid")) {
    return (
      <Frame>
        <DeadLink kind="reset" />
      </Frame>
    );
  }

  // Signed in and on the way out: nothing to show for the moment it takes.
  if (reset.isSuccess) {
    return (
      <Frame>
        <div className="grid min-h-60 place-items-center">
          <Spinner size="lg" label="Signing you in" />
        </div>
      </Frame>
    );
  }

  const fieldError = checked ? validateNewPassword(password) : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (reset.isPending) return;
    if (validateNewPassword(password)) return passwordRef.current?.focus();
    reset.mutate(password);
  };
  const failure =
    reset.error && !ApiError.is(reset.error, "verification_token_invalid") ? reset.error : null;

  return (
    <Frame>
      <form
        onSubmit={submit}
        noValidate
        aria-labelledby="reset-heading"
        className="flex flex-col gap-4"
      >
        <h1 id="reset-heading" className="type-card-headline mb-1 text-fg">
          Choose a new password
        </h1>
        {failure ? (
          <FormAlert ref={alertRef} title={describeMemberError(failure).title}>
            {describeMemberError(failure).description}
          </FormAlert>
        ) : null}
        <div className="flex flex-col gap-3 rounded-lg border border-line-subtle bg-surface-1 p-4">
          <p className="type-label text-fg">When you save it</p>
          <ul className="flex flex-col gap-3">
            <Effect icon={DevicesIcon}>
              Every other device signed in to your account is signed out. You stay signed in here.
            </Effect>
            <Effect icon={KeyIcon}>
              Google or Apple sign-in linked under a different email address is unlinked. You can
              link it again in Account › Security.
            </Effect>
            <Effect icon={MailIcon}>We'll email you to confirm the change.</Effect>
            {wanted ? (
              <Effect icon={CheckCircleIcon}>
                Then you'll be offered to add {providerName(wanted)} to the account.
              </Effect>
            ) : null}
          </ul>
        </div>
        <PasswordField
          ref={passwordRef}
          label="New password"
          name="new-password"
          autoComplete="new-password"
          autoFocus
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={fieldError}
          hint="At least 8 characters."
        />
        <Button
          type="submit"
          variant="accent"
          size="lg"
          fullWidth
          loading={reset.isPending}
          className="mt-2"
        >
          Save new password
        </Button>
        <p className="type-body-sm text-fg-subtle">
          This link works once and expires {Math.round(PASSWORD_RESET_TTL_SEC / 60)} minutes after
          it was sent.
        </p>
      </form>
    </Frame>
  );
}

function Effect({ icon: Icon, children }: { icon: IconComponent; children: ReactNode }) {
  return (
    <li className="flex gap-3 type-body-sm text-fg-muted">
      <Icon size="md" className="mt-0.5 shrink-0 text-fg-subtle" />
      <span>{children}</span>
    </li>
  );
}

export function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col bg-canvas">
      <AuthBackdrop />
      <MemberHeader />
      <main
        id="main"
        className="relative z-(--z-raised) flex flex-1 justify-center px-gutter pb-16 pt-4 sm:pt-10"
      >
        <div className="flex w-full max-w-form flex-col gap-4 md:self-start md:rounded-2xl md:border md:border-line-subtle md:bg-canvas/85 md:p-12 md:shadow-xl md:backdrop-blur-md">
          {children}
        </div>
      </main>
    </div>
  );
}
