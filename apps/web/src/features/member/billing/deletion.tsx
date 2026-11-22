import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ApiError } from "@webflix/contracts";
import { useSession } from "../../../app/session/session.ts";
import { privacyRequestsQuery, scheduledDeletion } from "../account/privacy/requests.ts";
import { FormAlert } from "../shared/FormAlert.tsx";
import { formatLongDate } from "../shared/format.ts";
import { standingOf } from "../shared/privileges.ts";

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
 * from a profile that may manage the account: elsewhere the list is refused, and the refusal of
 * a billing action says the same thing.
 */
export function useScheduledDeletion(enabled = true): { scheduledFor: string } | null {
  const session = useSession();
  const holder =
    session.authenticated &&
    session.activeProfile !== null &&
    standingOf(session.activeProfile) === "unrestricted" &&
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

export const DELETION_BODY =
  "Until then your membership can't be started, restarted or changed, and nothing more is charged. To carry on watching, keep your account first: it's one step in Privacy.";

/** The scheduled deletion, said plainly, with the way to keep the account. */
export function DeletionScheduledNotice({
  scheduledFor,
  className,
}: {
  scheduledFor?: string | null;
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
      {DELETION_BODY}
    </FormAlert>
  );
}
