/**
 * "Confirm it's you" (docs/BLUEPRINT-M2.md §4.2): the account-holder proof that sensitive actions
 * need. The server answers `reauthentication_required` (or `password_required` on routes that take
 * `currentPassword`) without a fresh proof; the proof is the password (`POST /session/elevation`)
 * or a fresh sign-in at a linked provider (`intent=reauth`), and it lasts five minutes. A
 * passwordless member whose provider cannot prove a fresh sign-in (Google may not report when
 * the member last authenticated) is offered no method at all: the prompt then leads them to set
 * a password by email instead of leaving them stuck.
 *
 * Use it from any screen:
 *
 *   const identity = useConfirmIdentity({
 *     id: "delete-account",                 // stable per action on this screen
 *     purpose: "delete your account",       // completes "To …, confirm you're the account holder."
 *     onResume: () => setDeleteOpen(true),  // back from a fresh sign-in at a provider: continue
 *   });
 *
 *   // Run the request; on a refusal for want of a proof, prompt, then run it once more.
 *   await identity.run(() => api().requestDeletion({ body }));   // IdentityNotConfirmed if dismissed
 *   // Or ask first (resolves at once when the session already holds a fresh proof):
 *   if (await identity.confirm()) navigateSomewhere();
 *
 *   return <>{…}{identity.prompt}</>;        // render the prompt once
 *
 * The fresh sign-in at a provider leaves the page: the provider sends the browser back to the
 * same URL with `?confirm=<id>&oidc=…`, where the hook calls `onResume` once the proof is held.
 * Reopen your own confirmation there rather than repeating a destructive request on your own;
 * whatever the member had typed is gone. A provider link opened in another tab works too: this
 * tab notices the proof when it is announced or shown again, and continues.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import {
  ApiError,
  type Elevation,
  OIDC_ERROR_PARAM,
  type OidcOutcome,
  type OidcProvider,
} from "@webflix/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  ErrorState,
  MailIcon,
  PasswordField,
  Spinner,
  toast,
} from "@webflix/ui";
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "../../../app/api.ts";
import { describeError } from "../../../app/query/errors.ts";
import { qk } from "../../../app/query/keys.ts";
import { queries } from "../../../app/query/queries.ts";
import { useAuthenticatedSession } from "../../../app/session/session.ts";
import { OrDivider, ProviderButton } from "../auth/FederatedButtons.tsx";
import {
  announceAuthChange,
  federatedStartUrl,
  parseOidcError,
  parseOutcome,
  parseProvider,
  pathWithout,
  providerName,
  useAuthChangeElsewhere,
  withParams,
} from "../auth/oidc.ts";
import { FormAlert } from "./FormAlert.tsx";
import { formatCountdown } from "./format.ts";
import { describeMemberError } from "./privileges.ts";
import { useRetryAfter } from "./useRetryAfter.ts";

/** The member closed the prompt without confirming: nothing was done, and nothing to report. */
export class IdentityNotConfirmed extends Error {
  override readonly name = "IdentityNotConfirmed";
  constructor() {
    super("The member did not confirm it's them");
  }
}

/** A refusal that a fresh account-holder proof answers. */
export function needsIdentityProof(error: unknown): boolean {
  return ApiError.is(error, "reauthentication_required") || ApiError.is(error, "password_required");
}

/** A proof that still has this long to run counts as held (it would not survive a slow form). */
const FRESH_MARGIN_MS = 20_000;

export function holdsFreshProof(elevation: Elevation | undefined, now = Date.now()): boolean {
  return (
    elevation?.elevatedUntil != null && Date.parse(elevation.elevatedUntil) - now > FRESH_MARGIN_MS
  );
}

export interface ConfirmIdentityOptions {
  /** Stable id of the action on this screen; it survives the round trip to a provider. */
  id: string;
  /** What the proof is for: completes "To …, confirm you're the account holder." */
  purpose: string;
  /**
   * The member came back from a fresh sign-in at a provider started from this prompt, and the
   * session holds the proof (or they gave it in the prompt reopened on their return): continue
   * the action. Called once.
   */
  onResume?: () => void;
}

export interface ConfirmIdentityHandle {
  /** True once the session holds a fresh proof (at once if it already does); false if dismissed. */
  confirm: () => Promise<boolean>;
  /**
   * Run `action`; when the server refuses it for want of a proof, prompt, then run it once more.
   * Rejects with `IdentityNotConfirmed` when the member dismisses the prompt.
   */
  run: <T>(action: () => Promise<T>) => Promise<T>;
  /** The prompt: render it once on the screen. */
  prompt: ReactNode;
  /** Whether the prompt is open. */
  open: boolean;
}

/** What a round trip to a provider brought back, shown at the top of the reopened prompt. */
interface ReturnNotice {
  outcome: OidcOutcome | "expired";
  provider: OidcProvider | undefined;
  /** Why the server refused the attempt (`?oidcError=`), when it said. */
  error?: string | undefined;
}

export function useConfirmIdentity(options: ConfirmIdentityOptions): ConfirmIdentityHandle {
  const { id, purpose } = options;
  const queryClient = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<ReturnNotice | null>(null);
  const resolver = useRef<((confirmed: boolean) => void) | null>(null);
  const resumeOnProof = useRef(false);
  const onResume = useRef(options.onResume);
  onResume.current = options.onResume;

  const settle = useCallback((confirmed: boolean) => {
    setOpen(false);
    setNotice(null);
    const resolve = resolver.current;
    resolver.current = null;
    if (resolve) resolve(confirmed);
    else if (confirmed && resumeOnProof.current) onResume.current?.();
    resumeOnProof.current = false;
  }, []);

  // What had focus when the prompt was asked for; it gets focus back when the prompt closes.
  const opener = useRef<HTMLElement | null>(null);
  const prompt = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        // A prompt already waiting is superseded: its caller hears "not confirmed".
        resolver.current?.(false);
        resolver.current = resolve;
        opener.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setOpen(true);
      }),
    [],
  );

  const confirm = useCallback(async () => {
    try {
      const elevation = await queryClient.fetchQuery({ ...queries.elevation(), staleTime: 0 });
      if (holdsFreshProof(elevation)) return true;
    } catch {
      // The prompt loads the methods itself and shows why it cannot.
    }
    return prompt();
  }, [prompt, queryClient]);

  const run = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (error) {
        if (!needsIdentityProof(error)) throw error;
        // The server is the authority: whatever the cache says, the proof is missing or spent.
        queryClient.removeQueries({ queryKey: qk.account.elevation() });
        if (!(await prompt())) throw new IdentityNotConfirmed();
        return action();
      }
    },
    [prompt, queryClient],
  );

  // Back from a fresh sign-in started from this prompt: `?confirm=<id>&oidc=<outcome>`.
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    const params = new URLSearchParams(router.state.location.searchStr);
    if (params.get("confirm") !== id) return;
    const outcome = parseOutcome(params.get("oidc"));
    const provider = parseProvider(params.get("provider"));
    const error = parseOidcError(params.get(OIDC_ERROR_PARAM));
    router.history.replace(pathWithout(router.state.location.href), router.history.location.state);
    if (!outcome) return;
    resumeOnProof.current = true;
    if (outcome !== "reauthenticated") {
      setNotice({ outcome, provider, error });
      setOpen(true);
      return;
    }
    void queryClient
      .fetchQuery({ ...queries.elevation(), staleTime: 0 })
      .then((elevation) => {
        if (!holdsFreshProof(elevation)) throw new Error("no fresh proof");
        announceAuthChange("elevated");
        toast.success("Confirmed it's you", { description: "You can continue for 5 minutes." });
        resumeOnProof.current = false;
        onResume.current?.();
      })
      .catch(() => {
        setNotice({ outcome: "expired", provider });
        setOpen(true);
      });
  }, [id, queryClient, router]);

  return {
    confirm,
    run,
    open,
    prompt: (
      <ConfirmIdentityDialog
        id={id}
        purpose={purpose}
        open={open}
        notice={notice}
        returnFocusTo={opener}
        onConfirmed={() => settle(true)}
        onDismiss={() => settle(false)}
      />
    ),
  };
}

/**
 * The prompt itself, controlled. Prefer `useConfirmIdentity`, which also handles the return from
 * a provider; use this directly only to place the prompt yourself.
 */
export function ConfirmIdentityDialog({
  id,
  purpose,
  open,
  notice = null,
  onConfirmed,
  onDismiss,
  returnFocusTo,
}: {
  id: string;
  purpose: string;
  open: boolean;
  notice?: ReturnNotice | null;
  onConfirmed: () => void;
  onDismiss: () => void;
  /** What gets focus back on close (default: whatever had focus when the prompt opened). */
  returnFocusTo?: RefObject<HTMLElement | null>;
}) {
  const captured = useRef<HTMLElement | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <DialogContent
        size="sm"
        title="Confirm it's you"
        description={`To ${purpose}, confirm you're the account holder.`}
        // Opened by a request, not a trigger: give focus back to what the member was on.
        onOpenAutoFocus={() => {
          captured.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          const target = returnFocusTo?.current ?? captured.current;
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        {open ? (
          <ConfirmIdentityBody
            id={id}
            notice={notice}
            onConfirmed={onConfirmed}
            onCancel={onDismiss}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ConfirmIdentityBody({
  id,
  notice,
  onConfirmed,
  onCancel,
}: {
  id: string;
  notice: ReturnNotice | null;
  onConfirmed: () => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const elevation = useQuery({ ...queries.elevation(), staleTime: 0 });
  const providers = useQuery(queries.signInProviders());
  const offered = providers.data?.items;

  // Proved in another tab (a provider link opened there) or before this tab was shown again.
  useAuthChangeElsewhere(() => {
    void queryClient
      .fetchQuery({ ...queries.elevation(), staleTime: 0 })
      .then((next) => {
        if (holdsFreshProof(next)) onConfirmed();
      })
      .catch(() => {});
  });
  useEffect(() => {
    if (holdsFreshProof(elevation.data)) onConfirmed();
  }, [elevation.data, onConfirmed]);

  if (elevation.isPending) {
    return (
      <div className="grid min-h-40 place-items-center">
        <Spinner size="lg" label="Checking how you can confirm" />
      </div>
    );
  }
  if (elevation.isError) {
    const described = describeError(elevation.error);
    return (
      <ErrorState
        title="We couldn't check how to confirm it's you"
        description={described.description}
        action={
          <Button variant="primary" onClick={() => void elevation.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }

  const methods = elevation.data.methods;
  const password = methods.includes("password");
  const issuers = methods.filter((method): method is OidcProvider => method !== "password");
  const returnTo = (provider: OidcProvider) =>
    withParams(pathWithout(router.state.location.href), { confirm: id, provider });

  return (
    <div className="flex flex-col gap-4">
      {notice ? (
        <ReturnNoticeAlert notice={notice} offered={offered} alternatives={methods.length > 1} />
      ) : null}
      {methods.length === 0 ? (
        <SetPasswordByEmail onCancel={onCancel} />
      ) : (
        <>
          {password ? (
            <PasswordProof
              onProved={(next) => {
                queryClient.setQueryData(qk.account.elevation(), next);
                announceAuthChange("elevated");
                onConfirmed();
              }}
              onMethodsChanged={() => void elevation.refetch()}
            />
          ) : null}
          {password && issuers.length > 0 ? <OrDivider /> : null}
          {issuers.length > 0 ? (
            <div className="flex flex-col gap-3">
              {issuers.map((provider) => {
                const name = providerName(provider, offered);
                return (
                  <ProviderButton
                    key={provider}
                    provider={{ id: provider, displayName: name }}
                    href={federatedStartUrl(provider, "reauth", returnTo(provider))}
                    label={password ? `Use ${name} instead` : `Continue with ${name}`}
                  />
                );
              })}
              <p className="type-body-sm text-fg-subtle">
                {issuers.length === 1
                  ? `You'll sign in to ${providerName(issuers[0] as OidcProvider, offered)} again, then come back here.`
                  : "You'll sign in to the provider again, then come back here."}
              </p>
            </div>
          ) : null}
          <Button variant="ghost" size="lg" fullWidth onClick={onCancel}>
            Cancel
          </Button>
        </>
      )}
    </div>
  );
}

function ReturnNoticeAlert({
  notice,
  offered,
  alternatives,
}: {
  notice: ReturnNotice;
  offered: readonly { id: string; displayName: string }[] | undefined;
  /** Whether the prompt offers another way than the provider that said no. */
  alternatives: boolean;
}) {
  const name = notice.provider ? providerName(notice.provider, offered) : "The provider";
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  if (notice.outcome === "cancelled") {
    return (
      <FormAlert ref={ref} tone="info" title={`You cancelled at ${name}`}>
        Nothing changed. Choose a way to confirm it's you.
      </FormAlert>
    );
  }
  if (notice.error === "rate_limited") {
    return (
      <FormAlert ref={ref} title="Too many attempts">
        {alternatives
          ? `For your security, ${name} sign-in is paused for a moment. Try again in a minute, or use another way below.`
          : `For your security, ${name} sign-in is paused for a moment. Try again in a minute.`}
      </FormAlert>
    );
  }
  if (notice.outcome === "expired" || notice.error === "reauthentication_required") {
    return (
      <FormAlert ref={ref} tone="info" title="Your confirmation has run out">
        It lasts 5 minutes. Confirm it's you again to continue.
      </FormAlert>
    );
  }
  return (
    <FormAlert ref={ref} title={`${name} couldn't confirm it's you`}>
      {alternatives
        ? `Sign in with the ${name} account linked to Webflix, or use another way below.`
        : `Sign in with the ${name} account linked to Webflix, and try again.`}
    </FormAlert>
  );
}

function PasswordProof({
  onProved,
  onMethodsChanged,
}: {
  onProved: (elevation: Elevation) => void;
  onMethodsChanged: () => void;
}) {
  const session = useAuthenticatedSession();
  const [password, setPassword] = useState("");
  const [checked, setChecked] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const rate = useRetryAfter();
  const elevate = useMutation({
    mutationFn: (value: string) => api().elevate({ body: { password: value } }),
    meta: { silent: true },
    onError: (error) => {
      rate.track(error);
      if (ApiError.is(error, "current_password_invalid")) {
        setPassword("");
        inputRef.current?.focus();
      }
      // The account has no password after all (set elsewhere moments ago): offer what it has.
      if (ApiError.is(error, "password_required")) onMethodsChanged();
    },
    onSuccess: onProved,
  });

  const wrong = ApiError.is(elevate.error, "current_password_invalid") && password === "";
  const fieldError = wrong
    ? "That password isn't right. Try again."
    : checked && password === ""
      ? "Enter your password."
      : null;
  const other =
    elevate.error &&
    !ApiError.is(elevate.error, "current_password_invalid") &&
    !ApiError.is(elevate.error, "rate_limited") &&
    !ApiError.is(elevate.error, "password_required")
      ? describeMemberError(elevate.error)
      : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setChecked(true);
    if (elevate.isPending || rate.limited) return;
    if (!password) return inputRef.current?.focus();
    elevate.mutate(password);
  };

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-4"
      aria-label="Confirm with your password"
    >
      {other ? <FormAlert title={other.title}>{other.description}</FormAlert> : null}
      {rate.limited ? (
        <FormAlert title="Too many attempts">
          For your security, please wait a moment. The button shows when you can try again.
        </FormAlert>
      ) : null}
      {/* Lets password managers offer the right saved password. */}
      <input
        type="hidden"
        name="username"
        autoComplete="username"
        value={session.account.email}
        readOnly
      />
      <PasswordField
        ref={inputRef}
        label="Webflix password"
        name="current-password"
        autoComplete="current-password"
        autoFocus
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
          setChecked(false);
        }}
        error={fieldError}
      />
      <Link
        to="/forgot-password"
        search={{ email: session.account.email }}
        className="focus-ring -mt-1 self-end rounded-xs type-label text-fg-muted underline-offset-2 hover:text-fg hover:underline"
      >
        Forgot your password?
      </Link>
      <Button
        type="submit"
        variant="accent"
        size="lg"
        fullWidth
        loading={elevate.isPending}
        disabled={rate.limited}
      >
        {rate.limited ? `Try again in ${formatCountdown(rate.waiting)}` : "Confirm"}
      </Button>
    </form>
  );
}

/**
 * No way to prove it is the account holder right now: a passwordless account whose provider
 * does not report a fresh sign-in. Setting a password by email is the way out.
 */
function SetPasswordByEmail({ onCancel }: { onCancel: () => void }) {
  const session = useAuthenticatedSession();
  const email = session.account.email;
  const rate = useRetryAfter();
  const send = useMutation({
    mutationFn: () => api().requestPasswordReset({ body: { email } }),
    meta: { silent: true },
    onError: rate.track,
  });

  if (send.isSuccess) {
    return (
      <div className="flex flex-col gap-4">
        <FormAlert tone="positive" icon={MailIcon} title="Check your email">
          We sent a link to <span className="text-fg">{email}</span>. It works once and expires in
          30 minutes.
        </FormAlert>
        <DialogFooter className="mt-2">
          <Button variant="primary" onClick={onCancel}>
            Done
          </Button>
        </DialogFooter>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <FormAlert tone="info" title="Set a password to continue">
        Your sign-in provider can't confirm it's you right now, so set a Webflix password instead.
        We'll email a link to <span className="text-fg">{email}</span>.
      </FormAlert>
      <p className="type-body-sm text-fg-muted">
        Setting your password through the link signs you out on every device, this one too. Then
        sign in with your new password and try again.
      </p>
      {send.isError && !ApiError.is(send.error, "rate_limited") ? (
        <FormAlert title={describeError(send.error).title}>
          {describeError(send.error).description}
        </FormAlert>
      ) : null}
      <DialogFooter className="mt-2">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="accent"
          loading={send.isPending}
          disabled={rate.limited}
          onClick={() => send.mutate()}
        >
          {rate.limited ? `Try again in ${formatCountdown(rate.waiting)}` : "Email me a link"}
        </Button>
      </DialogFooter>
    </div>
  );
}
