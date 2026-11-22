/**
 * What deleting the account does to the membership, said before the member commits and while the
 * deletion is scheduled (docs/CONTRACT_CHANGES.md, "a deletion stops renewals"): scheduling a
 * deletion stops the renewals, so the membership ends at the earlier of its period's close and
 * the erasure, and nothing is charged during the cooling-off period. Keeping the account leaves
 * the membership set to end; the member can resume it.
 */
import { ApiError, type DeletionMembership, type MembershipState } from "@webflix/contracts";
import { formatLongDate } from "../../shared/format.ts";

/** A membership that would renew (or is owed a payment) unless stopped. */
function renews(membership: MembershipState): boolean {
  return ["trialing", "active", "past_due", "suspended"].includes(membership.status);
}

/** When the current period (or the free trial) closes. */
export function periodEnd(membership: MembershipState): string | null {
  return membership.status === "trialing"
    ? (membership.trialEndsAt ?? membership.currentPeriodEnd)
    : membership.currentPeriodEnd;
}

function earlier(a: string | null, b: string): string {
  return a !== null && Date.parse(a) < Date.parse(b) ? a : b;
}

/** Before asking: the sentence about the membership, for a deletion that would happen at `deleteOn`. */
export function membershipBeforeDeletion(membership: MembershipState, deleteOn: string): string {
  if (!renews(membership)) {
    return "You have no membership that renews, so nothing will be charged.";
  }
  // Milestone 1's built-in membership (no payment provider): the deletion leaves it as it is
  // until the account goes (`membership.status: none` on the request).
  if (membership.provider === null) {
    return "It ends when your account is deleted, and you won't be charged after that.";
  }
  const ends = earlier(periodEnd(membership), deleteOn);
  return `Your membership will end on ${formatLongDate(ends)}, and you won't be charged again.`;
}

/** While the deletion is scheduled: what it did to the membership (null: nothing to say). */
export function membershipWhileScheduled(membership: DeletionMembership | null): string | null {
  if (!membership) return "Your membership ends when your account is deleted.";
  switch (membership.status) {
    case "stopping":
      return "We're stopping your membership's renewals: you won't be charged again.";
    case "ending":
      return membership.endsAt
        ? `Your membership ends on ${formatLongDate(membership.endsAt)}. You won't be charged again.`
        : "Your membership is set to end. You won't be charged again.";
    case "ended":
      return "Your membership has ended.";
    case "renewing":
      return "Your membership still renews: it ends when your account is deleted.";
    case "none":
      return null;
  }
}

/** The server refused to resume a membership because the account's deletion is scheduled. */
export function isDeletionScheduledRefusal(error: unknown): boolean {
  return ApiError.is(error, "account_deletion_scheduled");
}
