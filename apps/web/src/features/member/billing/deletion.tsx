import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ApiError, type Entitlement, type MembershipState } from "@webflix/contracts";
import { useSession } from "../../../app/session/session.ts";
import { privacyRequestsQuery, scheduledDeletion } from "../account/privacy/requests.ts";
import { FormAlert } from "../shared/FormAlert.tsx";
import { formatLongDate } from "../shared/format.ts";
import { standingOf } from "../shared/privileges.ts";
import { isUnfinishedSignup } from "./membership.ts";
import { membershipOutcome } from "./outcome.ts";

/**
 * An account whose deletion is scheduled (docs/BLUEPRINT-M2.md §6.3) stops renewing at once, and
 * billing refuses to start, restart, resume or change the membership until the account is kept
 * (`account_deletion_scheduled`). That is not an error and not a payment problem: these say what
 * is so, and lead to Account › Privacy, where the account can be kept.
 */

export function isDeletionScheduled(error: unknown): boolean {
  return ApiError.is(error, "account_deletion_scheduled");
}

/**
 * The scheduled deletion, from the privacy engineer's requests list (one read). Only asked for
 * by the account holder (a profile without parental controls, or an account that has not
 * finished sign-up): elsewhere the list is refused, and the refusal of a billing action says the
 * same thing.
 */
export function useScheduledDeletion(enabled = true): { scheduledFor: string } | null {
  const session = useSession();
  const holder =
    session.authenticated &&
    (isUnfinishedSignup(session) ||
      (session.activeProfile !== null && standingOf(session.activeProfile) === "unrestricted")) &&
    session.account.isDemo !== true;
  const requests = useQuery({
    ...privacyRequestsQuery(),
    enabled: enabled && holder,
    meta: { silent: true },
  });
  const scheduled = requests.data ? scheduledDeletion(requests.data.items) : undefined;
  return scheduled ? { scheduledFor: scheduled.scheduledFor } : null;
}

export function deletionTitle(scheduledFor: string | null | undefined): string {
  return scheduledFor
    ? `Your account is scheduled to be deleted on ${formatLongDate(scheduledFor)}`
    : "Your account is scheduled to be deleted";
}

/**
 * What the scheduled deletion means for watching and paying (UX review 2.1): a running
 * membership carries on until it ends or the account goes, whichever is first, and nothing more
 * is charged; nothing can be started or changed meanwhile. From `membershipOutcome`, so Membership,
 * Privacy and every refusal say the same.
 */
export function deletionBody(
  view: { membership: MembershipState; entitlement: Entitlement } | null,
  scheduledFor: string | null | undefined,
): string {
  const outcome =
    view && scheduledFor ? membershipOutcome(view, { deletion: { scheduledFor } }) : null;
  const ends = outcome?.watching ? outcome.watchingEnds : null;
  const watching = !ends
    ? "Nothing more is charged."
    : ends.because === "account_deleted"
      ? "You can keep watching until then, and nothing more is charged."
      : `You can keep watching until ${formatLongDate(ends.at)}, when your ${
          ends.because === "trial_ends" ? "free trial" : "membership"
        } ends, and nothing more is charged.`;
  const running = outcome?.watching === true;
  return `${watching} ${
    running
      ? "Your membership can't be changed meanwhile."
      : "A membership can't be started or restarted meanwhile."
  } Changed your mind? Choose Keep my account in Privacy.`;
}

/** The scheduled deletion, said plainly, with the way to keep the account. */
export function DeletionScheduledNotice({
  scheduledFor,
  view = null,
  className,
}: {
  scheduledFor?: string | null;
  /** The membership, when the page has it: what happens to watching until the deletion. */
  view?: { membership: MembershipState; entitlement: Entitlement } | null;
  className?: string;
}) {
  return (
    <FormAlert
      tone="accent"
      title={deletionTitle(scheduledFor)}
      className={className}
      action={
        <Link
          to="/account/privacy"
          className="focus-ring rounded-xs type-label text-fg underline underline-offset-2"
        >
          Go to Privacy
        </Link>
      }
    >
      {deletionBody(view, scheduledFor)}
    </FormAlert>
  );
}
