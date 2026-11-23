import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ApiError, EMAIL_VERIFICATION_TTL_SEC, PASSWORD_RESET_TTL_SEC } from "@webflix/contracts";
import { Button, MailIcon } from "@webflix/ui";
import { useEffect, useRef } from "react";
import { api } from "../../../app/api.ts";
import { describeError } from "../../../app/query/errors.ts";
import { useSession } from "../../../app/session/session.ts";
import { FormAlert } from "../shared/FormAlert.tsx";
import { formatCountdown } from "../shared/format.ts";
import { useRetryAfter } from "../shared/useRetryAfter.ts";
import { CARD_HEADING, EmailText } from "./parts.tsx";

/**
 * One honest screen for an emailed link that cannot be used: used already, expired, cut short
 * or altered. The server deliberately answers all of them the same way, so the page does too,
 * and offers the way to a new link.
 */
export function DeadLink({ kind }: { kind: "reset" | "verify" }) {
  const session = useSession();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  const lifetime =
    kind === "reset"
      ? `${Math.round(PASSWORD_RESET_TTL_SEC / 60)} minutes`
      : `${Math.round(EMAIL_VERIFICATION_TTL_SEC / 3600)} hours`;
  return (
    <section aria-labelledby="dead-link" className="flex flex-col gap-4" data-testid="dead-link">
      <span className="grid size-14 place-items-center rounded-full bg-surface-3 text-fg-muted">
        <MailIcon size="xl" />
      </span>
      <h1 id="dead-link" ref={headingRef} tabIndex={-1} className={`${CARD_HEADING} outline-none`}>
        This link can't be used
      </h1>
      <p className="type-body-lg text-fg-muted">
        It may have been used already, it may have expired (
        {kind === "reset" ? "reset" : "verification"} links last {lifetime}), or part of it is
        missing. Ask for a new one, and use the newest email.
      </p>
      {kind === "reset" ? (
        <div className="mt-2 flex flex-col gap-3">
          <Button variant="accent" size="lg" fullWidth asChild>
            <Link to="/forgot-password" search={{}}>
              Send a new link
            </Link>
          </Button>
          <Button variant="outline" size="lg" fullWidth asChild>
            <Link to={session.authenticated ? "/account/security" : "/login"}>
              {session.authenticated ? "Back to Account" : "Sign in"}
            </Link>
          </Button>
        </div>
      ) : session.authenticated ? (
        <ResendVerification email={session.account.email} />
      ) : (
        <div className="mt-2 flex flex-col gap-3">
          <Button variant="accent" size="lg" fullWidth asChild>
            <Link to="/login" search={{ redirect: "/account/security" }}>
              Sign in to get a new link
            </Link>
          </Button>
        </div>
      )}
    </section>
  );
}

/** Send the signed-in account a new verification link. */
export function ResendVerification({ email }: { email: string }) {
  const rate = useRetryAfter();
  // The button is replaced by the answer: focus moves to it, not to the page.
  const sentRef = useRef<HTMLDivElement>(null);
  const send = useMutation({
    mutationFn: () => api().requestEmailVerification(),
    meta: { silent: true },
    onError: rate.track,
  });
  useEffect(() => {
    if (send.isSuccess) sentRef.current?.focus();
  }, [send.isSuccess]);
  if (send.isSuccess) {
    return (
      <FormAlert ref={sentRef} tone="positive" icon={MailIcon} title="A new link is on its way">
        We sent it to <EmailText>{email}</EmailText>. It expires in{" "}
        {Math.round(EMAIL_VERIFICATION_TTL_SEC / 3600)} hours.
      </FormAlert>
    );
  }
  return (
    <div className="mt-2 flex flex-col gap-3">
      <p className="type-body text-fg-muted">
        We'll send it to <EmailText>{email}</EmailText>.
      </p>
      {send.isError && !ApiError.is(send.error, "rate_limited") ? (
        <FormAlert title={describeError(send.error).title}>
          {describeError(send.error).description}
        </FormAlert>
      ) : null}
      <Button
        variant="accent"
        size="lg"
        fullWidth
        loading={send.isPending}
        disabled={rate.limited}
        onClick={() => send.mutate()}
      >
        {rate.limited ? `Try again in ${formatCountdown(rate.waiting)}` : "Send a new link"}
      </Button>
    </div>
  );
}
