import { Link } from "@tanstack/react-router";
import { useMembership } from "../../../app/session/session.ts";
import { HrefLink } from "../billing/HrefLink.tsx";
import { describeStanding } from "../billing/membership.ts";
import { FormAlert } from "../shared/FormAlert.tsx";

/**
 * Membership status where members pass every day (profile gate): nothing while all is well; a
 * quiet reminder while a cancellation or trial runs out; a clear ask while a payment has failed
 * (still watching until grace ends); one clear action while on hold or after it has ended. The
 * same words as Account (`describeStanding`).
 */
export function MembershipNotice({ className }: { className?: string }) {
  const view = useMembership();
  const { notice } = describeStanding(view);
  if (!notice) return null;
  const link = "focus-ring rounded-xs type-label text-fg underline underline-offset-2";
  return (
    <FormAlert
      tone={notice.tone}
      title={notice.title}
      className={className ?? "w-full max-w-form"}
      action={
        notice.action?.kind === "link" ? (
          <HrefLink href={notice.action.href} className={link}>
            {notice.action.label}
          </HrefLink>
        ) : notice.action?.kind === "resume" ? (
          // Keeping a membership is done from Account (it needs a profile without controls).
          <Link to="/account/membership" className={link}>
            {notice.action.label}
          </Link>
        ) : undefined
      }
    >
      {notice.body}
    </FormAlert>
  );
}
