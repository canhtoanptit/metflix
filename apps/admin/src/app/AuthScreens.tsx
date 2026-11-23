/** Full-page screens around the session: signing in, signed out, and nothing can work. */
import {
  AlertTriangleIcon,
  Badge,
  Button,
  LockIcon,
  LogOutIcon,
  RefreshIcon,
  ShieldIcon,
  Spinner,
  Wordmark,
} from "@webflix/ui";
import { type ReactNode, useEffect } from "react";
import type { SignedOutReason } from "../auth/session.ts";

export function ConsoleBrand({ development }: { development?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <Wordmark className="h-4 w-auto shrink-0" />
      <span className="type-caption text-fg-muted">Staff</span>
      {development ? (
        <Badge tone="warning" size="sm" title="Signed in through the development issuer">
          Development
        </Badge>
      ) : null}
    </div>
  );
}

function Frame({
  icon,
  title,
  children,
  development,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  development?: boolean;
}) {
  useEffect(() => {
    document.title = `${title} · Webflix Staff`;
  }, [title]);
  return (
    <main id="main" className="grid min-h-dvh place-items-center bg-canvas bg-glow px-4 py-10">
      <div className="flex w-full max-w-dialog-sm flex-col gap-6">
        <ConsoleBrand development={development ?? false} />
        <div className="flex flex-col gap-4 rounded-xl border border-line-subtle bg-surface-1 p-6 sm:p-8">
          <span className="grid size-11 place-items-center rounded-full bg-surface-3 text-fg-muted">
            {icon}
          </span>
          <h1 className="type-title-lg text-fg">{title}</h1>
          {children}
        </div>
      </div>
    </main>
  );
}

export function SigningIn({ label = "Signing you in…" }: { label?: string }) {
  useEffect(() => {
    document.title = "Signing in · Webflix Staff";
  }, []);
  return (
    <main id="main" className="grid min-h-dvh place-items-center bg-canvas">
      <div role="status" className="flex flex-col items-center gap-3 text-fg-muted">
        <Spinner size="lg" label={null} />
        <span className="type-body-sm">{label}</span>
      </div>
    </main>
  );
}

const SIGNED_OUT_COPY: Record<SignedOutReason, { title: string; body: string; action: string }> = {
  required: {
    title: "Sign in to the staff console",
    body: "Use your staff account. You sign in with the staff sign-in service: the console never sees your password.",
    action: "Sign in",
  },
  "signed-out": {
    title: "You're signed out",
    body: "The staff session in this browser has ended. Sign in again when you need the console.",
    action: "Sign in",
  },
  expired: {
    title: "Your session ended",
    body: "The staff sign-in service ended your session, so what was on screen has been cleared. Sign in again to go back to the same page. Anything you hadn't sent was not kept.",
    action: "Sign in again",
  },
  idle: {
    title: "Signed out after 15 minutes away",
    body: "The console signs itself out when nobody has used it for 15 minutes, and clears what was on screen. Sign in again to go back to the same page.",
    action: "Sign in again",
  },
  cancelled: {
    title: "Sign-in was canceled",
    body: "You canceled at the staff sign-in service. Nothing was changed.",
    action: "Sign in",
  },
  failed: {
    title: "Sign-in didn't complete",
    body: "The sign-in could not be finished.",
    action: "Try again",
  },
};

export function SignedOut({
  reason,
  detail,
  development,
  onSignIn,
}: {
  reason: SignedOutReason;
  detail?: string | undefined;
  development: boolean;
  onSignIn: () => void;
}) {
  const copy = SIGNED_OUT_COPY[reason];
  return (
    <Frame
      icon={
        reason === "failed" ? (
          <AlertTriangleIcon />
        ) : reason === "signed-out" ? (
          <LogOutIcon />
        ) : (
          <LockIcon />
        )
      }
      title={copy.title}
      development={development}
    >
      <p className="type-body-sm text-fg-muted">{detail ? `${copy.body} ${detail}` : copy.body}</p>
      <Button variant="accent" size="md" icon={ShieldIcon} onClick={onSignIn}>
        {copy.action}
      </Button>
      {development ? (
        <p className="type-caption text-fg-subtle">
          This console signs in through the development issuer: pick a staff persona on its page.
        </p>
      ) : null}
    </Frame>
  );
}

export function Unavailable({
  title,
  detail,
  onRetry,
  onSignOut,
  development,
}: {
  title: string;
  detail: string;
  onRetry?: () => void;
  onSignOut?: () => void;
  development?: boolean;
}) {
  return (
    <Frame icon={<AlertTriangleIcon />} title={title} development={development ?? false}>
      <p className="type-body-sm text-fg-muted">{detail}</p>
      <div className="flex flex-wrap gap-2">
        {onRetry ? (
          <Button variant="accent" size="sm" icon={RefreshIcon} onClick={onRetry}>
            Try again
          </Button>
        ) : null}
        {onSignOut ? (
          <Button variant="outline" size="sm" icon={LogOutIcon} onClick={onSignOut}>
            Sign out
          </Button>
        ) : null}
      </div>
    </Frame>
  );
}
