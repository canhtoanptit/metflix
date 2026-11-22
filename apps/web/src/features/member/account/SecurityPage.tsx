import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type AccountDetails,
  ApiError,
  EMAIL_VERIFICATION_TTL_SEC,
  type IdentityList,
  type LinkedIdentity,
  type OidcProvider,
  type SessionState,
  type UpdateAccountBody,
} from "@webflix/contracts";
import {
  Badge,
  Button,
  ConfirmDialog,
  ErrorState,
  KeyIcon,
  MailIcon,
  PasswordField,
  ProviderMark,
  Skeleton,
  TextField,
  toast,
} from "@webflix/ui";
import { type FormEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { describeError } from "../../../app/query/errors.ts";
import { qk } from "../../../app/query/keys.ts";
import { queries } from "../../../app/query/queries.ts";
import { useAuthenticatedSession } from "../../../app/session/session.ts";
import { useOutcomeFromUrl } from "../auth/FederatedButtons.tsx";
import {
  federatedStartUrl,
  hasProviderMark,
  onPageRestored,
  providerName,
  withParams,
} from "../auth/oidc.ts";
import { IdentityNotConfirmed, useConfirmIdentity } from "../shared/ConfirmIdentity.tsx";
import { FormAlert } from "../shared/FormAlert.tsx";
import { formatCountdown, formatShortDate } from "../shared/format.ts";
import { describeMemberError, useIsDemoAccount } from "../shared/privileges.ts";
import { useRetryAfter } from "../shared/useRetryAfter.ts";
import {
  normalizeEmail,
  validateCurrentPassword,
  validateEmail,
  validateNewPassword,
} from "../shared/validation.ts";
import { AccountHeading, AccountSection } from "./AccountLayout.tsx";

const HERE = "/account/security";
/** The member issuers Webflix knows how to show (others are listed only once linked). */
const MEMBER_PROVIDERS: readonly OidcProvider[] = ["google", "apple"];

/**
 * How the member signs in, and the address Webflix reaches them at: linked sign-in methods
 * (link; unlink while another way in remains), the password (set a first one, or change it), the
 * email address (verify it, change it). Changes that need proof go through "Confirm it's you";
 * a passwordless member gives it with a fresh sign-in at a provider.
 */
export function AccountSecurityPage() {
  const demo = useIsDemoAccount();
  const session = useAuthenticatedSession();
  const identities = useQuery(queries.identities());
  const passwordRef = useRef<HTMLInputElement>(null);
  const hasPassword = identities.data?.hasPassword ?? session.account.hasPassword ?? true;
  return (
    <>
      <AccountHeading
        title="Security"
        description="How you sign in to Webflix on every device, and the email address we use to reach you."
      />
      {demo ? (
        <FormAlert tone="info" title="The demo account's sign-in details can't be changed">
          Everyone who tries Webflix signs in with them, so they stay as they are.
        </FormAlert>
      ) : null}
      <SignInMethods
        demo={demo}
        hasPassword={hasPassword}
        identities={identities}
        onPasswordAction={() => {
          passwordRef.current?.scrollIntoView({ block: "center" });
          passwordRef.current?.focus({ preventScroll: true });
        }}
      />
      {demo ? null : (
        <>
          <EmailSection hasPassword={hasPassword} />
          {hasPassword ? (
            <PasswordForm fieldRef={passwordRef} />
          ) : (
            <SetPasswordForm fieldRef={passwordRef} />
          )}
        </>
      )}
    </>
  );
}

// --- Ways to sign in ----------------------------------------------------------------------------

function SignInMethods({
  demo,
  hasPassword,
  identities,
  onPasswordAction,
}: {
  demo: boolean;
  hasPassword: boolean;
  identities: UseQueryResult<IdentityList>;
  onPasswordAction: () => void;
}) {
  const session = useAuthenticatedSession();
  const queryClient = useQueryClient();
  const providers = useQuery(queries.signInProviders());
  const returned = useOutcomeFromUrl();
  const [problem, setProblem] = useState<ReactNode>(null);

  // Back from linking at a provider: the list has changed (or not); read it again.
  useEffect(() => {
    if (returned) void queryClient.invalidateQueries({ queryKey: qk.account.identities() });
  }, [returned, queryClient]);

  const offered = providers.data?.items ?? [];
  const linked = identities.data?.items ?? [];
  const shown = MEMBER_PROVIDERS.filter(
    (provider) =>
      offered.some((item) => item.id === provider) ||
      linked.some((item) => item.provider === provider),
  );
  const ways = (hasPassword ? 1 : 0) + linked.length;

  return (
    <AccountSection
      title="Ways to sign in"
      description="Any of these signs you in to Webflix, on any device."
    >
      {returned ? (
        <LinkOutcome
          outcome={returned.outcome}
          error={returned.error}
          name={providerName(returned.provider, offered)}
        />
      ) : null}
      {problem}
      {identities.isPending || providers.isPending ? (
        <div className="flex flex-col gap-5" aria-busy="true">
          <span className="sr-only">Loading sign-in methods</span>
          {[0, 1, 2].map((key) => (
            <div key={key} className="flex items-center gap-4">
              <Skeleton className="size-11" radius="full" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-3 w-52" />
              </div>
            </div>
          ))}
        </div>
      ) : identities.isError ? (
        <ErrorState
          title="We couldn't load your sign-in methods"
          description={describeError(identities.error).description}
          action={
            <Button variant="primary" onClick={() => void identities.refetch()}>
              Try again
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col divide-y divide-line-subtle">
          <MethodRow
            mark={
              <span className="grid size-11 shrink-0 place-items-center rounded-full bg-surface-3 text-fg-muted">
                <KeyIcon size="md" />
              </span>
            }
            name="Email and password"
            status={
              hasPassword ? (
                <>
                  Signs in as{" "}
                  <span className="wrap-anywhere text-fg-muted">{session.account.email}</span>
                </>
              ) : (
                "No password yet"
              )
            }
            action={
              demo ? null : (
                <Button variant="outline" size="sm" onClick={onPasswordAction}>
                  {hasPassword ? "Change password" : "Set a password"}
                </Button>
              )
            }
          />
          {shown.map((provider) => (
            <ProviderRow
              key={provider}
              provider={provider}
              name={providerName(provider, offered)}
              offered={offered.some((item) => item.id === provider)}
              identity={linked.find((item) => item.provider === provider) ?? null}
              lastWay={ways <= 1}
              // The start refused it: the proof had run out. Ask for it again, then go on.
              askAgain={
                returned?.outcome === "failed" &&
                returned.error === "reauthentication_required" &&
                returned.provider === provider
              }
              demo={demo}
              onProblem={setProblem}
            />
          ))}
        </ul>
      )}
      {demo || shown.length === 0 ? null : (
        <p className="type-body-sm text-fg-subtle">
          Linking takes you to the provider to choose an account, then brings you back here.
        </p>
      )}
    </AccountSection>
  );
}

function MethodRow({
  mark,
  name,
  status,
  action,
}: {
  mark: ReactNode;
  name: string;
  status: ReactNode;
  action: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-3 py-4 first:pt-0 last:pb-0">
      {mark}
      <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <span className="type-label text-fg">{name}</span>
        <span className="type-body-sm text-fg-subtle">{status}</span>
      </div>
      {action ? <div className="ms-15 shrink-0 sm:ms-0">{action}</div> : null}
    </li>
  );
}

function ProviderRow({
  provider,
  name,
  offered,
  identity,
  lastWay,
  demo,
  onProblem,
  askAgain = false,
}: {
  provider: OidcProvider;
  name: string;
  /** Whether this deployment still offers the provider (else it can be unlinked, not linked). */
  offered: boolean;
  identity: LinkedIdentity | null;
  /** The account's only way to sign in: it cannot be unlinked. */
  lastWay: boolean;
  demo: boolean;
  onProblem: (problem: ReactNode) => void;
  /** Came back refused for want of a fresh proof: reopen "Confirm it's you" for linking. */
  askAgain?: boolean;
}) {
  const queryClient = useQueryClient();
  const [leaving, setLeaving] = useState(false);
  const [resumeLink, setResumeLink] = useState(false);
  const [askUnlink, setAskUnlink] = useState(false);
  useEffect(() => onPageRestored(() => setLeaving(false)), []);
  // Unlinked from here: the Unlink button is gone, so focus moves to the Link that replaces it.
  const linkRef = useRef<HTMLButtonElement>(null);
  const justUnlinked = useRef(false);
  useEffect(() => {
    if (identity || !justUnlinked.current) return;
    justUnlinked.current = false;
    linkRef.current?.focus();
  }, [identity]);

  const linkProof = useConfirmIdentity({
    id: `link-${provider}`,
    purpose: `link ${name}`,
    onResume: () => setResumeLink(true),
  });
  const unlinkProof = useConfirmIdentity({
    id: `unlink-${provider}`,
    purpose: `unlink ${name}`,
    onResume: () => setAskUnlink(true),
  });

  const goLink = () => {
    setLeaving(true);
    window.location.assign(federatedStartUrl(provider, "link", withParams(HERE, { provider })));
  };
  const link = async () => {
    onProblem(null);
    // Linking needs a fresh proof before the navigation: the start route refuses without one.
    if (await linkProof.confirm()) goLink();
  };
  const askedAgain = useRef(false);
  useEffect(() => {
    if (!askAgain || askedAgain.current) return;
    askedAgain.current = true;
    void linkProof.confirm().then((confirmed) => {
      if (confirmed) setResumeLink(true);
    });
  }, [askAgain, linkProof]);

  const unlink = useMutation({
    mutationFn: () => unlinkProof.run(() => api().unlinkIdentity({ params: { provider } })),
    meta: { silent: true },
    onMutate: () => onProblem(null),
    onSuccess: () => {
      justUnlinked.current = true;
      toast.success(`${name} is unlinked`, {
        description: `You can't sign in with ${name} any more. Link it again here whenever you like.`,
      });
    },
    onError: (error) => {
      if (error instanceof IdentityNotConfirmed) return;
      onProblem(
        ApiError.is(error, "identity_last_sign_in_method") ? (
          <FormAlert title="Keep at least one way to sign in">
            Set a password or link another provider first, then unlink {name}.
          </FormAlert>
        ) : (
          <FormAlert title={`We couldn't unlink ${name}`}>
            {describeMemberError(error).description}
          </FormAlert>
        ),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.account.identities() });
    },
  });

  const status = identity ? (
    <>
      Linked
      {identity.emailAtLink ? (
        <>
          {" · "}
          <span className="wrap-anywhere text-fg-muted">{identity.emailAtLink}</span>
        </>
      ) : null}
      {` · since ${formatShortDate(identity.linkedAt)}`}
    </>
  ) : (
    "Not linked"
  );

  let action: ReactNode = null;
  if (demo) action = null;
  else if (identity && lastWay) {
    action = <span className="type-body-sm text-fg-subtle">Your only way to sign in</span>;
  } else if (identity) {
    action = (
      <Button
        variant="outline"
        size="sm"
        loading={unlink.isPending}
        onClick={() => setAskUnlink(true)}
        aria-label={`Unlink ${name}`}
      >
        Unlink
      </Button>
    );
  } else if (offered) {
    action = (
      <Button
        ref={linkRef}
        variant="outline"
        size="sm"
        loading={leaving}
        onClick={() => void link()}
        aria-label={`Link ${name}`}
      >
        Link
      </Button>
    );
  }

  return (
    <>
      <MethodRow
        mark={
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-surface-3 text-fg">
            {hasProviderMark(provider) ? <ProviderMark provider={provider} /> : null}
          </span>
        }
        name={name}
        status={
          identity && lastWay ? (
            <>
              {status}
              <span className="mt-1 block">Set a password below before you unlink it.</span>
            </>
          ) : (
            status
          )
        }
        action={action}
      />
      {linkProof.prompt}
      {unlinkProof.prompt}
      <ConfirmDialog
        open={askUnlink}
        onOpenChange={setAskUnlink}
        title={`Unlink ${name}?`}
        description={
          <>
            You won't be able to sign in with {name} any more. It won't reconnect on its own, even
            if it uses the same email address as your account: to use it again, link it here.
            Devices that are signed in now stay signed in.
          </>
        }
        confirmLabel={`Unlink ${name}`}
        onConfirm={() => {
          setAskUnlink(false);
          unlink.mutate();
        }}
      />
      <ConfirmDialog
        open={resumeLink}
        onOpenChange={setResumeLink}
        tone="accent"
        title={`Link ${name}`}
        description={`You're confirmed. Next, choose the ${name} account to link; you'll come back here.`}
        confirmLabel={`Continue to ${name}`}
        onConfirm={() => {
          setResumeLink(false);
          goLink();
        }}
      />
    </>
  );
}

function LinkOutcome({
  outcome,
  error,
  name,
}: {
  outcome: string;
  error?: string | undefined;
  name: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  if (outcome === "linked") {
    return (
      <FormAlert ref={ref} tone="positive" title={`${name} is linked`}>
        You can sign in to Webflix with {name} from now on.
      </FormAlert>
    );
  }
  if (outcome === "cancelled") {
    return (
      <FormAlert ref={ref} tone="info" title={`Linking ${name} was cancelled`}>
        Nothing changed.
      </FormAlert>
    );
  }
  if (outcome === "failed" && error === "reauthentication_required") {
    return (
      <FormAlert ref={ref} tone="info" title={`Confirm it's you again to link ${name}`}>
        Your confirmation lasts 5 minutes and had run out, so nothing was changed.
      </FormAlert>
    );
  }
  if (outcome === "failed" && error === "rate_limited") {
    return (
      <FormAlert ref={ref} title="Too many attempts">
        For your security, linking is paused for a moment. Try linking {name} again in a minute.
      </FormAlert>
    );
  }
  if (outcome === "identity-in-use") {
    return (
      <FormAlert ref={ref} title={`That ${name} account is linked to another Webflix account`}>
        Sign in to that account and unlink {name} there first, or link a different {name} account.
      </FormAlert>
    );
  }
  return (
    <FormAlert ref={ref} title={`We couldn't link ${name}`}>
      Nothing was changed. Try again, and check that your {name} account has a verified email
      address.
    </FormAlert>
  );
}

// --- Email ----------------------------------------------------------------------------------------

function useUpdateAccount(onDone: (details: AccountDetails) => void) {
  const queryClient = useQueryClient();
  const rate = useRetryAfter();
  const mutation = useMutation({
    mutationFn: ({
      body,
      run,
    }: {
      body: UpdateAccountBody;
      run?: <T>(action: () => Promise<T>) => Promise<T>;
    }) => (run ? run(() => api().updateAccount({ body })) : api().updateAccount({ body })),
    meta: { silent: true },
    onError: rate.track,
    onSuccess: (details) => {
      queryClient.setQueryData(qk.account.details(), details);
      const session = queryClient.getQueryData<SessionState>(qk.session());
      if (session?.authenticated) {
        const next: SessionState = { ...session, account: details.account };
        queryClient.setQueryData(qk.session(), next);
      }
      void queryClient.invalidateQueries({ queryKey: qk.account.devices() });
      void queryClient.invalidateQueries({ queryKey: qk.account.identities() });
      onDone(details);
    },
  });
  return { mutation, rate };
}

function RateOrError({ error, limited }: { error: unknown; limited: boolean }) {
  if (!error || error instanceof IdentityNotConfirmed) return null;
  if (ApiError.is(error, "rate_limited")) {
    return (
      <FormAlert title="Too many attempts">
        {limited
          ? "For your security, please wait a moment. The button shows when you can try again."
          : "You can try again now."}
      </FormAlert>
    );
  }
  const described = describeMemberError(error);
  return <FormAlert title={described.title}>{described.description}</FormAlert>;
}

function EmailSection({ hasPassword }: { hasPassword: boolean }) {
  const session = useAuthenticatedSession();
  const verified = session.account.emailVerified;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [checked, setChecked] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [resumed, setResumed] = useState(false);
  const proof = useConfirmIdentity({
    id: "change-email",
    purpose: "change your email",
    // Back from confirming at a provider: what was typed is gone; ask for it again, here.
    onResume: () => {
      setResumed(true);
      emailRef.current?.focus();
    },
  });
  const { mutation, rate } = useUpdateAccount((details) => {
    toast.success("Email updated", {
      description: `We sent a link to ${details.account.email} to verify it.`,
    });
    setEmail("");
    setPassword("");
    setChecked(false);
  });

  const same = normalizeEmail(email) === session.account.email;
  const emailError = ApiError.is(mutation.error, "email_already_registered")
    ? "Another account already uses this email."
    : checked
      ? (validateEmail(email) ?? (same ? "That's already your email." : null))
      : null;
  const passwordError = ApiError.is(mutation.error, "current_password_invalid")
    ? "That password isn't right."
    : checked && hasPassword
      ? validateCurrentPassword(password)
      : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (mutation.isPending || rate.limited) return;
    if (validateEmail(email) || same) return emailRef.current?.focus();
    if (hasPassword && validateCurrentPassword(password)) return passwordRef.current?.focus();
    mutation.mutate(
      hasPassword
        ? { body: { email: normalizeEmail(email), currentPassword: password } }
        : { body: { email: normalizeEmail(email) }, run: proof.run },
    );
  };

  const other =
    mutation.error &&
    !ApiError.is(mutation.error, "email_already_registered") &&
    !ApiError.is(mutation.error, "current_password_invalid")
      ? mutation.error
      : null;

  return (
    <AccountSection
      title="Email"
      description={
        hasPassword ? (
          <>
            You sign in with <span className="wrap-anywhere text-fg">{session.account.email}</span>.
          </>
        ) : (
          <>
            Your account's email is{" "}
            <span className="wrap-anywhere text-fg">{session.account.email}</span>.
          </>
        )
      }
      action={
        verified === undefined ? null : verified ? (
          <Badge tone="positive" size="sm">
            Verified
          </Badge>
        ) : (
          <Badge tone="neutral" size="sm">
            Not verified
          </Badge>
        )
      }
    >
      {verified === false ? <VerifyReminder email={session.account.email} /> : null}
      <form onSubmit={submit} noValidate className="flex flex-col gap-4" aria-label="Change email">
        {resumed && !mutation.isSuccess ? (
          <FormAlert tone="positive" title="You're confirmed">
            Enter the new email address again to change it.
          </FormAlert>
        ) : null}
        <RateOrError error={other} limited={rate.limited} />
        <TextField
          ref={emailRef}
          label="New email address"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            if (ApiError.is(mutation.error, "email_already_registered")) mutation.reset();
          }}
          error={emailError}
        />
        {hasPassword ? (
          <PasswordField
            ref={passwordRef}
            label="Current password"
            name="current-password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              if (ApiError.is(mutation.error, "current_password_invalid")) mutation.reset();
            }}
            error={passwordError}
          />
        ) : null}
        <p className="type-body-sm text-fg-subtle">
          We'll email the new address a link to verify it, and let your current address know.
        </p>
        <div>
          <Button
            type="submit"
            variant="accent"
            loading={mutation.isPending}
            disabled={rate.limited}
          >
            {rate.limited ? `Try again in ${formatCountdown(rate.waiting)}` : "Update email"}
          </Button>
        </div>
      </form>
      {proof.prompt}
    </AccountSection>
  );
}

/** An unverified address: why it matters, and a new link. */
function VerifyReminder({ email }: { email: string }) {
  const rate = useRetryAfter();
  const send = useMutation({
    mutationFn: () => api().requestEmailVerification(),
    meta: { silent: true },
    onError: rate.track,
  });
  const hours = Math.round(EMAIL_VERIFICATION_TTL_SEC / 3600);
  if (send.isSuccess) {
    return (
      <FormAlert tone="positive" icon={MailIcon} title="Check your email">
        We sent a link to <span className="wrap-anywhere text-fg">{email}</span>. It expires in{" "}
        {hours} hours.
      </FormAlert>
    );
  }
  return (
    <FormAlert
      tone="accent"
      icon={MailIcon}
      title="Verify your email address"
      action={
        <Button
          variant="outline"
          size="sm"
          loading={send.isPending}
          disabled={rate.limited}
          onClick={() => send.mutate()}
        >
          {rate.limited ? `Send again in ${formatCountdown(rate.waiting)}` : "Send a new link"}
        </Button>
      }
    >
      Follow the link we emailed to <span className="wrap-anywhere text-fg">{email}</span>. A
      verified address lets you reset your password, and lets Google or Apple sign you in when they
      use the same address.
      {send.isError && !ApiError.is(send.error, "rate_limited") ? (
        <span className="mt-1 block text-danger">{describeError(send.error).description}</span>
      ) : null}
    </FormAlert>
  );
}

// --- Password -------------------------------------------------------------------------------------

function PasswordForm({ fieldRef }: { fieldRef: RefObject<HTMLInputElement | null> }) {
  const session = useAuthenticatedSession();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [checked, setChecked] = useState(false);
  const nextRef = useRef<HTMLInputElement>(null);
  const { mutation, rate } = useUpdateAccount(() => {
    toast.success("Password changed", {
      description: "Other devices have been signed out. This one stays signed in.",
    });
    setCurrent("");
    setNext("");
    setChecked(false);
  });

  const reused = next.length > 0 && next === current;
  const currentError = ApiError.is(mutation.error, "current_password_invalid")
    ? "That password isn't right."
    : checked
      ? validateCurrentPassword(current)
      : null;
  const nextError = checked
    ? (validateNewPassword(next) ?? (reused ? "Choose a password you haven't used here." : null))
    : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (mutation.isPending || rate.limited) return;
    if (validateCurrentPassword(current)) return fieldRef.current?.focus();
    if (validateNewPassword(next) || reused) return nextRef.current?.focus();
    mutation.mutate({ body: { currentPassword: current, newPassword: next } });
  };

  const other =
    mutation.error && !ApiError.is(mutation.error, "current_password_invalid")
      ? mutation.error
      : null;

  return (
    <AccountSection
      title="Password"
      description="Changing your password signs out every other device. Anything playing on them stops within about half a minute."
    >
      <form
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-4"
        aria-label="Change password"
      >
        <RateOrError error={other} limited={rate.limited} />
        {/* Lets password managers attach the new password to the right account. */}
        <input
          type="hidden"
          name="username"
          autoComplete="username"
          value={session.account.email}
          readOnly
        />
        <PasswordField
          ref={fieldRef}
          label="Current password"
          name="current-password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => {
            setCurrent(event.target.value);
            if (ApiError.is(mutation.error, "current_password_invalid")) mutation.reset();
          }}
          error={currentError}
        />
        <PasswordField
          ref={nextRef}
          label="New password"
          name="new-password"
          autoComplete="new-password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          error={nextError}
          hint="At least 8 characters."
        />
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <Button
            type="submit"
            variant="accent"
            loading={mutation.isPending}
            disabled={rate.limited}
          >
            {rate.limited ? `Try again in ${formatCountdown(rate.waiting)}` : "Change password"}
          </Button>
          <Link
            to="/forgot-password"
            search={{ email: session.account.email }}
            className="focus-ring rounded-xs type-label text-fg-muted underline-offset-2 hover:text-fg hover:underline"
          >
            Forgot your current password?
          </Link>
        </div>
      </form>
    </AccountSection>
  );
}

/** A first password for an account created with Google or Apple. Needs a fresh proof. */
function SetPasswordForm({ fieldRef }: { fieldRef: RefObject<HTMLInputElement | null> }) {
  const session = useAuthenticatedSession();
  const [next, setNext] = useState("");
  const [checked, setChecked] = useState(false);
  const [resumed, setResumed] = useState(false);
  const proof = useConfirmIdentity({
    id: "set-password",
    purpose: "set a password",
    onResume: () => {
      setResumed(true);
      fieldRef.current?.focus();
    },
  });
  const { mutation, rate } = useUpdateAccount(() => {
    toast.success("Password set", {
      description: `You can also sign in with ${session.account.email} and your password now. Other devices were signed out.`,
    });
    setNext("");
    setChecked(false);
  });
  const nextError = checked ? validateNewPassword(next) : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (mutation.isPending || rate.limited) return;
    if (validateNewPassword(next)) return fieldRef.current?.focus();
    mutation.mutate({ body: { newPassword: next }, run: proof.run });
  };
  return (
    <AccountSection
      title="Password"
      description={
        <>
          Your account has no password yet: you sign in with a provider. Set one to also sign in
          with <span className="wrap-anywhere text-fg">{session.account.email}</span>. Setting it
          signs out your other devices.
        </>
      }
    >
      <form
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-4"
        aria-label="Set a password"
      >
        {resumed && !mutation.isSuccess ? (
          <FormAlert tone="positive" title="You're confirmed">
            Enter your new password again to set it.
          </FormAlert>
        ) : null}
        <RateOrError error={mutation.error} limited={rate.limited} />
        <input
          type="hidden"
          name="username"
          autoComplete="username"
          value={session.account.email}
          readOnly
        />
        <PasswordField
          ref={fieldRef}
          label="New password"
          name="new-password"
          autoComplete="new-password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          error={nextError}
          hint="At least 8 characters."
        />
        <div>
          <Button
            type="submit"
            variant="accent"
            loading={mutation.isPending}
            disabled={rate.limited}
          >
            {rate.limited ? `Try again in ${formatCountdown(rate.waiting)}` : "Set password"}
          </Button>
        </div>
      </form>
      {proof.prompt}
    </AccountSection>
  );
}
