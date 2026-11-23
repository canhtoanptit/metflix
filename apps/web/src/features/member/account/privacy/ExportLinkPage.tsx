/**
 * The export email's link: `/account/privacy/exports/{requestId}#token={token}`. The token is in
 * the fragment, so opening the link never sends it to a server; the page takes it, keeps it for
 * this tab only, and removes it from the address bar (as identity's emailed links do).
 *
 * Only the account holder may download a copy, so the page leads there: a member who opens the
 * email signed out (on their phone, usually) signs in and comes back to this same page, the token
 * still kept in the tab; one at Who's watching? chooses a profile; one on a kids or restricted
 * profile switches. Then one button downloads it through `POST /privacy/exports/{id}/download`
 * (the token in the body, never in a URL), after a fresh "Confirm it's you" when the server asks.
 * A link that cannot be used (expired, cut short, for another account) gets one honest screen
 * with the way to a new copy.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { ApiError, type PrivacyRequest } from "@webflix/contracts";
import {
  Button,
  CheckCircleIcon,
  EmailText,
  ErrorState,
  LockIcon,
  MailIcon,
  Spinner,
} from "@webflix/ui";
import { type ReactNode, useEffect, useRef } from "react";
import { describeError } from "../../../../app/query/errors.ts";
import { useSession } from "../../../../app/session/session.ts";
import { isRestrictedProfile } from "../../../../app/telemetry/index.ts";
import { forgetLinkToken, useLinkToken } from "../../auth/emailLink.ts";
import { Frame } from "../../auth/ResetPasswordPage.tsx";
import { isUnfinishedSignup } from "../../billing/membership.ts";
import { IdentityNotConfirmed, useConfirmIdentity } from "../../shared/ConfirmIdentity.tsx";
import { formatLongDate } from "../../shared/format.ts";
import { saveDataExport } from "./download.ts";
import { exportEmailNote, privacyRequestsQuery, typicalWait } from "./requests.ts";

const route = getRouteApi("/public/account/privacy/exports/$requestId");

const tokenKey = (requestId: string) => `webflix:export-token:${requestId}`;

/** The contract's bounds for the token (`DataExportQuery`); anything else was cut or altered. */
function usableToken(token: string | null): token is string {
  return token !== null && token.length > 0 && token.length <= 4096;
}

export function ExportLinkPage() {
  const { requestId } = route.useParams();
  const token = useLinkToken(tokenKey(requestId));
  const session = useSession();
  const here = `/account/privacy/exports/${encodeURIComponent(requestId)}`;

  let body: ReactNode;
  if (!usableToken(token)) {
    body = <CannotUse reason="incomplete" />;
  } else if (!session.authenticated) {
    body = (
      <Step
        icon={<LockIcon size="xl" />}
        title="Sign in to download your data"
        action={
          <Button variant="accent" size="lg" fullWidth asChild>
            <Link to="/login" search={{ redirect: here }}>
              Sign in
            </Link>
          </Button>
        }
      >
        For your security, only the account holder can download it, after confirming it's them. Sign
        in, and you'll come straight back here.
      </Step>
    );
  } else if (!session.activeProfile && !isUnfinishedSignup(session)) {
    body = (
      <Step
        icon={<LockIcon size="xl" />}
        title="Choose your profile to continue"
        action={
          <Button variant="accent" size="lg" fullWidth asChild>
            <Link to="/profiles" search={{ redirect: here }}>
              Choose a profile
            </Link>
          </Button>
        }
      >
        The account holder downloads it from a profile without parental controls.
      </Step>
    );
  } else if (session.activeProfile && isRestrictedProfile(session.activeProfile)) {
    body = (
      <Step
        icon={<LockIcon size="xl" />}
        title="Switch to a profile without parental controls"
        action={
          <Button variant="accent" size="lg" fullWidth asChild>
            <Link to="/profiles" search={{ redirect: here }}>
              Switch profile
            </Link>
          </Button>
        }
      >
        {session.activeProfile.name} can't download the account's data. Choose a profile without
        parental controls, and you'll come back here.
      </Step>
    );
  } else {
    body = <Download requestId={requestId} token={token} email={session.account.email} />;
  }
  return <Frame>{body}</Frame>;
}

function Download({
  requestId,
  token,
  email,
}: {
  requestId: string;
  token: string;
  email: string;
}) {
  const requests = useQuery(privacyRequestsQuery());
  const identity = useConfirmIdentity({
    id: "export-link-download",
    purpose: "download your data",
    // Back from confirming at a provider (the token is still kept in this tab): download it.
    onResume: () => save.mutate(),
  });
  const save = useMutation({
    mutationFn: () => identity.run(() => saveDataExport(requestId, token)),
    meta: { silent: true },
    onSuccess: () => forgetLinkToken(tokenKey(requestId)),
  });

  if (requests.isPending) {
    return (
      <div className="grid min-h-60 place-items-center" aria-live="polite">
        <Spinner size="lg" label="Checking your link" />
      </div>
    );
  }
  if (requests.isError) {
    return (
      <ErrorState
        title="We couldn't check your link just now"
        description={describeError(requests.error).description}
        action={
          <Button variant="accent" onClick={() => void requests.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  const request: PrivacyRequest | undefined = requests.data.items.find(
    (item) => item.kind === "export" && item.id === requestId,
  );
  const typical = typicalWait(requests.data.terms);
  if (!request) return <CannotUse reason="other-account" email={email} />;
  if (request.status === "pending" || request.status === "processing") {
    return (
      <Step
        icon={<MailIcon size="xl" />}
        title="Your data isn't ready yet"
        action={<BackToPrivacy />}
      >
        It usually takes {typical}.{" "}
        {exportEmailNote(request, email) ?? "Check back in Account › Privacy."}
      </Step>
    );
  }
  const expired =
    request.status === "completed" &&
    (request.downloadUrl === null ||
      (request.expiresAt !== null && Date.parse(request.expiresAt) <= Date.now()));
  if (request.status !== "completed" || expired || ApiError.is(save.error, "not_found")) {
    return (
      <CannotUse
        reason="expired"
        expiresAt={request.expiresAt}
        typical={typical}
        failed={request.status === "failed"}
      />
    );
  }
  if (save.isSuccess) {
    return (
      <Step
        icon={<CheckCircleIcon size="xl" />}
        tone="positive"
        title="Your download has started"
        action={<BackToPrivacy />}
      >
        One file (JSON) with your account, profiles, viewing activity, membership and the rest of
        your personal data; its notes say what isn't in it and why. Keep it somewhere safe: it holds
        your personal details.
      </Step>
    );
  }
  return (
    <Step
      icon={<CheckCircleIcon size="xl" />}
      tone="positive"
      title="Your data is ready"
      action={
        <>
          <Button
            variant="accent"
            size="lg"
            fullWidth
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Download your data
          </Button>
          {identity.prompt}
        </>
      }
    >
      {request.expiresAt
        ? `You can download this copy until ${formatLongDate(request.expiresAt)}. You'll be asked to confirm it's you first.`
        : "You'll be asked to confirm it's you first."}
      {save.isError && !(save.error instanceof IdentityNotConfirmed) ? (
        <span role="alert" className="mt-2 block text-danger">
          {describeError(save.error).description}
        </span>
      ) : null}
    </Step>
  );
}

function CannotUse({
  reason,
  email,
  expiresAt = null,
  typical,
  failed = false,
}: {
  reason: "incomplete" | "other-account" | "expired";
  email?: string;
  expiresAt?: string | null;
  typical?: string;
  failed?: boolean;
}) {
  const title =
    reason === "other-account"
      ? "This link is for another Webflix account"
      : reason === "incomplete"
        ? "This link can't be used"
        : failed
          ? "This copy couldn't be prepared"
          : "This link has expired";
  const body =
    reason === "other-account" ? (
      <>
        You're signed in as <EmailText>{email}</EmailText>, and this copy isn't one this account
        asked for. If you have more than one account, sign out and sign in to the one that asked.
      </>
    ) : reason === "incomplete" ? (
      "It looks cut short or changed. Open it again from the email, or ask for a new copy in Account › Privacy."
    ) : (
      `${failed ? "Nothing was sent." : expiresAt ? `It stopped working on ${formatLongDate(expiresAt)}.` : "It no longer works."} Ask for a new copy in Account › Privacy: it usually takes ${typical ?? "a little while"}.`
    );
  return (
    <Step
      icon={<MailIcon size="xl" />}
      title={title}
      action={
        reason === "other-account" ? (
          <>
            <Button variant="accent" size="lg" fullWidth asChild>
              <Link to="/logout">Sign out</Link>
            </Button>
            <BackToPrivacy variant="outline" />
          </>
        ) : (
          <BackToPrivacy />
        )
      }
    >
      {body}
    </Step>
  );
}

function BackToPrivacy({ variant = "accent" }: { variant?: "accent" | "outline" }) {
  return (
    <Button variant={variant} size="lg" fullWidth asChild>
      <Link to="/account/privacy">Go to Account › Privacy</Link>
    </Button>
  );
}

/** One step of the page: an icon, a heading that takes focus (screen readers hear it), a way on. */
function Step({
  icon,
  title,
  tone = "neutral",
  action,
  children,
}: {
  icon: ReactNode;
  title: string;
  tone?: "neutral" | "positive";
  action: ReactNode;
  children: ReactNode;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, [title]);
  return (
    <section aria-labelledby="export-link" className="flex flex-col gap-4">
      <span
        className={
          tone === "positive"
            ? "grid size-14 place-items-center rounded-full bg-positive-subtle text-positive"
            : "grid size-14 place-items-center rounded-full bg-surface-3 text-fg-muted"
        }
      >
        {icon}
      </span>
      <h1
        id="export-link"
        ref={headingRef}
        tabIndex={-1}
        className="type-card-headline text-fg outline-none"
      >
        {title}
      </h1>
      <p className="type-body-lg text-fg-muted">{children}</p>
      <div className="mt-2 flex w-full flex-col gap-3">{action}</div>
    </section>
  );
}
