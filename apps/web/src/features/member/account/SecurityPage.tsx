import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
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
  EmailText,
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
import { forgetLinkIntent } from "../auth/linkIntent.ts";
import {
  federatedStartUrl,
  hasProviderMark,
  onPageRestored,
  parseProvider,
  pathWithout,
  providerName,
  withParams,
} from "../auth/oidc.ts";
import { IdentityNotConfirmed, useConfirmIdentity } from "../shared/ConfirmIdentity.tsx";
import { FormAlert } from "../shared/FormAlert.tsx";
import { formatCountdown, formatShortDate } from "../shared/format.ts";
import { describeMemberError, useIsDemoAccount } from "../shared/privileges.ts";
import { useRetryAfter } from "../shared/useRetryAfter.ts";
import { normalizeEmail, validateEmail, validateNewPassword } from "../shared/validation.ts";
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
  const startPassword = useRef<(() => void) | null>(null);
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
        onPasswordAction={() => startPassword.current?.()}
      />
      {demo ? null : (
        <>
          <EmailSection hasPassword={hasPassword} />
          <PasswordSection hasPassword={hasPassword} startRef={startPassword} />
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
  const offer = useLinkOffer();
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
            <Button variant="accent" onClick={() => void identities.refetch()}>
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
                  Signs in as <EmailText>{session.account.email}</EmailText>
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
              offerAdd={offer === provider}
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
  offerAdd = false,
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
  /** Arrived to add this provider (after `link-required`): offer it at once. */
  offerAdd?: boolean;
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
  // Arrived from `link-required` (signed in, or reset the password): "Add Google?" at once.
  const [offering, setOffering] = useState(() => offerAdd && !identity && offered && !demo);
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
        id: "sign-in-methods",
        description: `You can't sign in with ${name} anymore. Link it again here whenever you like.`,
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
          <EmailText>{identity.emailAtLink}</EmailText>
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
            You won't be able to sign in with {name} anymore. It won't reconnect on its own, even if
            it uses the same email address as your account: to use it again, link it here. Devices
            that are signed in now stay signed in.
          </>
        }
        confirmLabel={`Unlink ${name}`}
        onConfirm={() => {
          setAskUnlink(false);
          unlink.mutate();
        }}
      />
      <ConfirmDialog
        open={offering}
        onOpenChange={setOffering}
        tone="accent"
        title={`Add ${name} to your account?`}
        description={`You tried to sign in with ${name}. Add it, and ${name} signs you in to this account from now on. You'll choose your ${name} account, then come back here.`}
        confirmLabel={`Add ${name}`}
        cancelLabel="Not now"
        onConfirm={() => {
          setOffering(false);
          void link();
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
      <FormAlert ref={ref} tone="info" title={`Linking ${name} was canceled`}>
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

/**
 * "Confirm it's you" first, then the field: changing the email or the password offers its field
 * only once the member is confirmed, so a round trip to a provider never throws away what they
 * typed (nothing is typed before it). The proof lasts five minutes; should it run out before the
 * form is sent, the request asks again.
 */
function useConfirmFirst(options: { id: string; purpose: string }) {
  const [offered, setOffered] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  // Where focus goes once the section has re-rendered: the field shown, or the button back.
  const [focus, setFocus] = useState<"field" | "open" | null>(null);
  useEffect(() => {
    if (!focus) return;
    (focus === "field" ? fieldRef : openRef).current?.focus();
    setFocus(null);
  }, [focus]);
  const reveal = () => {
    setOffered(true);
    setFocus("field");
  };
  // Back from confirming at a provider: nothing was typed yet, so nothing was lost.
  const proof = useConfirmIdentity({ ...options, onResume: reveal });
  return {
    offered,
    sectionRef,
    fieldRef,
    openRef,
    proof,
    start: async () => {
      sectionRef.current?.scrollIntoView({ block: "center" });
      if (await proof.confirm()) reveal();
    },
    close: () => {
      setOffered(false);
      setFocus("open");
    },
  };
}

function EmailSection({ hasPassword }: { hasPassword: boolean }) {
  const session = useAuthenticatedSession();
  const verified = session.account.emailVerified;
  const [email, setEmail] = useState("");
  const [checked, setChecked] = useState(false);
  // One way to prove it is the account holder everywhere (UX review 3.3), and it comes first.
  const flow = useConfirmFirst({ id: "change-email", purpose: "change your email" });
  const { mutation, rate } = useUpdateAccount((details) => {
    toast.success("Email updated", {
      id: "account-email",
      description: `We sent a link to ${details.account.email} to verify it.`,
    });
    close();
  });
  const close = () => {
    setEmail("");
    setChecked(false);
    mutation.reset();
    flow.close();
  };
  const same = normalizeEmail(email) === session.account.email;
  const emailError = ApiError.is(mutation.error, "email_already_registered")
    ? "Another account already uses this email."
    : checked
      ? (validateEmail(email) ?? (same ? "That's already your email." : null))
      : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (mutation.isPending || rate.limited) return;
    if (validateEmail(email) || same) return flow.fieldRef.current?.focus();
    mutation.mutate({ body: { email: normalizeEmail(email) }, run: flow.proof.run });
  };

  const other =
    mutation.error && !ApiError.is(mutation.error, "email_already_registered")
      ? mutation.error
      : null;

  return (
    <AccountSection
      title="Email"
      description={
        hasPassword ? (
          <>
            You sign in with <EmailText>{session.account.email}</EmailText>.
          </>
        ) : (
          <>
            Your account's email is <EmailText>{session.account.email}</EmailText>.
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
      <div ref={flow.sectionRef} className="flex flex-col gap-4">
        {flow.offered ? (
          <form
            onSubmit={submit}
            noValidate
            className="flex flex-col gap-4"
            aria-label="Change email"
          >
            <RateOrError error={other} limited={rate.limited} />
            <TextField
              ref={flow.fieldRef}
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
            <p className="type-body-sm text-fg-subtle">
              We'll email the new address a link to verify it, and let your current address know.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                variant="accent"
                loading={mutation.isPending}
                disabled={rate.limited}
              >
                {rate.limited ? `Try again in ${formatCountdown(rate.waiting)}` : "Update email"}
              </Button>
              <Button variant="outline" onClick={close} disabled={mutation.isPending}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            <p className="type-body-sm text-fg-subtle">
              You'll be asked to confirm it's you first, then to type the new address.
            </p>
            <div>
              <Button ref={flow.openRef} variant="outline" onClick={() => void flow.start()}>
                Change email
              </Button>
            </div>
          </>
        )}
      </div>
      {flow.proof.prompt}
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
  // The button is replaced by the answer: focus moves to it, not to the page (UX review 2.7).
  const sentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (send.isSuccess) sentRef.current?.focus();
  }, [send.isSuccess]);
  if (send.isSuccess) {
    return (
      <FormAlert ref={sentRef} tone="positive" icon={MailIcon} title="Check your email">
        We sent a link to <EmailText>{email}</EmailText>. It expires in {hours} hours.
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
      Follow the link we emailed to <EmailText>{email}</EmailText>. A verified address is how you
      get back into your account if you forget your password.
      {send.isError && !ApiError.is(send.error, "rate_limited") ? (
        <span className="mt-1 block text-danger">{describeError(send.error).description}</span>
      ) : null}
    </FormAlert>
  );
}

// --- Password -------------------------------------------------------------------------------------

/**
 * Set a first password (an account made with Google or Apple) or change it. Either way the proof
 * is "Confirm it's you" (the password itself, or a fresh sign-in at a provider), as for every
 * other change here, and it comes first (`useConfirmFirst`). One component for both, so focus
 * stays in the section when a first password turns it into "Change" (UX review 2.7).
 */
function PasswordSection({
  hasPassword,
  startRef,
}: {
  hasPassword: boolean;
  /** Filled with `start` for the "Ways to sign in" row's button. */
  startRef: RefObject<(() => void) | null>;
}) {
  const session = useAuthenticatedSession();
  const [next, setNext] = useState("");
  const [checked, setChecked] = useState(false);
  const flow = useConfirmFirst({
    id: hasPassword ? "change-password" : "set-password",
    purpose: hasPassword ? "change your password" : "set a password",
  });
  startRef.current = () => void flow.start();
  const { mutation, rate } = useUpdateAccount(() => {
    toast.success(hasPassword ? "Password changed" : "Password set", {
      id: "account-password",
      description: hasPassword
        ? "You're signed in here, and signed out everywhere else."
        : `You can also sign in with ${session.account.email} and your password now. You're signed out everywhere else.`,
    });
    close();
  });
  const close = () => {
    setNext("");
    setChecked(false);
    mutation.reset();
    flow.close();
  };
  const nextError = checked ? validateNewPassword(next) : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setChecked(true);
    if (mutation.isPending || rate.limited) return;
    if (validateNewPassword(next)) return flow.fieldRef.current?.focus();
    mutation.mutate({ body: { newPassword: next }, run: flow.proof.run });
  };
  return (
    <AccountSection
      title="Password"
      description={
        hasPassword ? (
          "Changing your password signs out every other device. Anything playing on them stops within about half a minute."
        ) : (
          <>
            Your account has no password yet: you sign in with a provider. Set one to also sign in
            with <EmailText>{session.account.email}</EmailText>. Setting it signs out your other
            devices.
          </>
        )
      }
    >
      <div ref={flow.sectionRef} className="flex flex-col gap-4">
        {flow.offered ? (
          <form
            onSubmit={submit}
            noValidate
            className="flex flex-col gap-4"
            aria-label={hasPassword ? "Change password" : "Set a password"}
          >
            <RateOrError error={mutation.error} limited={rate.limited} />
            {/* Lets password managers attach the new password to the right account. */}
            <input
              type="hidden"
              name="username"
              autoComplete="username"
              value={session.account.email}
              readOnly
            />
            <PasswordField
              ref={flow.fieldRef}
              label="New password"
              name="new-password"
              autoComplete="new-password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              error={nextError}
              hint="At least 8 characters."
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                variant="accent"
                loading={mutation.isPending}
                disabled={rate.limited}
              >
                {rate.limited
                  ? `Try again in ${formatCountdown(rate.waiting)}`
                  : hasPassword
                    ? "Change password"
                    : "Set password"}
              </Button>
              <Button variant="outline" onClick={close} disabled={mutation.isPending}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            <p className="type-body-sm text-fg-subtle">
              You'll be asked to confirm it's you first, then to type the new password.
            </p>
            <div>
              <Button ref={flow.openRef} variant="outline" onClick={() => void flow.start()}>
                {hasPassword ? "Change password" : "Set a password"}
              </Button>
            </div>
          </>
        )}
      </div>
      {flow.proof.prompt}
    </AccountSection>
  );
}

/**
 * `?link=<provider>`: the member signed in (or reset the password) to add a provider that could
 * not attach itself (`link-required`). Read once, then gone from the address bar; the wish kept
 * across those steps is forgotten too, since it is now offered.
 */
function useLinkOffer(): OidcProvider | null {
  const router = useRouter();
  const [provider] = useState(() =>
    parseProvider(new URLSearchParams(router.state.location.searchStr).get("link")),
  );
  const done = useRef(false);
  useEffect(() => {
    if (!provider || done.current) return;
    done.current = true;
    forgetLinkIntent();
    router.history.replace(
      pathWithout(router.history.location.href, ["link"]),
      router.history.location.state,
    );
  }, [provider, router]);
  return provider ?? null;
}
