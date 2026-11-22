import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Button, CheckCircleIcon, Spinner } from "@webflix/ui";
import { useEffect, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { sessionCache } from "../../../app/session/session.ts";
import { discardPendingEvents } from "../../../app/telemetry/index.ts";
import { AuthBackdrop } from "../shared/AuthBackdrop.tsx";
import { MemberHeader } from "../shared/Chrome.tsx";
import { useCountdown } from "../shared/useRetryAfter.ts";

const RETURN_AFTER_MS = 30_000;

/**
 * Sign out of this device: the server ends the session (and this device's streams), every
 * account cache is dropped and the guards re-run. Then a calm confirmation that returns to the
 * landing page on its own after 30 seconds.
 */
export function LogoutPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const navigate = useNavigate();
  const [returnAt, setReturnAt] = useState<number | null>(null);
  const remaining = useCountdown(returnAt);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let cancelled = false;
    // Events queued as this member must not be sent once the server no longer knows them (they
    // would be stamped anonymous) nor reach the next person to sign in on this device.
    discardPendingEvents();
    api()
      .logout()
      .catch(() => {
        // Signing out is idempotent: forget the session locally even if the request failed.
      })
      .finally(() => {
        if (cancelled) return;
        sessionCache.signOut(queryClient);
        void router.invalidate();
        setReturnAt(Date.now() + RETURN_AFTER_MS);
      });
    return () => {
      cancelled = true;
    };
  }, [queryClient, router]);

  const done = returnAt !== null;
  useEffect(() => {
    if (done) headingRef.current?.focus();
  }, [done]);
  useEffect(() => {
    if (done && remaining === 0) void navigate({ to: "/", replace: true });
  }, [done, remaining, navigate]);

  return (
    <div className="relative flex min-h-dvh flex-col bg-canvas">
      <AuthBackdrop />
      <MemberHeader />
      <main
        id="main"
        className="relative z-(--z-raised) flex flex-1 items-center justify-center px-gutter pb-nav"
      >
        {done ? (
          <div
            className="flex w-full max-w-form flex-col items-center gap-5 text-center md:rounded-2xl md:border md:border-line-subtle md:bg-canvas/85 md:p-12 md:shadow-xl md:backdrop-blur-md"
            data-testid="signed-out"
          >
            <span className="grid size-14 place-items-center rounded-full bg-positive-subtle text-positive">
              <CheckCircleIcon size="xl" />
            </span>
            <h1 ref={headingRef} tabIndex={-1} className="type-headline text-fg outline-none">
              You've signed out
            </h1>
            <p className="type-body text-fg-muted">
              You only need to sign out on shared or public devices. On your own, Webflix keeps you
              signed in so you can pick up where you left off.
            </p>
            <div className="mt-2 flex w-full flex-col gap-3">
              <Button variant="accent" size="lg" fullWidth asChild>
                <Link to="/login" search={{}}>
                  Sign in again
                </Link>
              </Button>
              <Button variant="outline" size="lg" fullWidth asChild>
                <Link to="/">Go to the home page</Link>
              </Button>
            </div>
            <p className="type-body-sm text-fg-subtle" aria-live="off">
              Taking you to the home page in {remaining} {remaining === 1 ? "second" : "seconds"}.
            </p>
          </div>
        ) : (
          <Spinner size="lg" label="Signing out" />
        )}
      </main>
    </div>
  );
}
