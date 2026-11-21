import { Link } from "@tanstack/react-router";
import { useAuthenticatedSession } from "../../../app/session/session.ts";
import { FormAlert } from "../shared/FormAlert.tsx";
import { formatLongDate } from "../shared/format.ts";

/**
 * Membership status where members pass every day (profile gate): nothing while active, a quiet
 * reminder while a cancellation runs out, a clear way back once it has ended.
 */
export function MembershipNotice({ className }: { className?: string }) {
  const { subscription } = useAuthenticatedSession();
  if (subscription.status === "active") return null;
  const link = "focus-ring rounded-xs type-label text-fg underline underline-offset-2";
  return subscription.status === "ended" ? (
    <FormAlert
      tone="accent"
      title="Your membership has ended"
      className={className ?? "w-full max-w-form"}
      action={
        <Link to="/account/plan" className={link}>
          Restart membership
        </Link>
      }
    >
      Restart anytime to keep watching. Your profiles, My List and history are right where you left
      them.
    </FormAlert>
  ) : (
    <FormAlert
      tone="info"
      title={`Your membership ends on ${formatLongDate(subscription.currentPeriodEnd)}`}
      className={className ?? "w-full max-w-form"}
      action={
        <Link to="/account" className={link}>
          Keep my membership
        </Link>
      }
    >
      You can keep watching until then.
    </FormAlert>
  );
}
