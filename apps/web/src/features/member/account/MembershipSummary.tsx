import type { AccountDetails } from "@webflix/contracts";
import { Badge, Button, Skeleton } from "@webflix/ui";
import type { ReactNode } from "react";
import { useSession } from "../../../app/session/session.ts";
import {
  DeletionScheduledNotice,
  isDeletionScheduled,
  useScheduledDeletion,
} from "../billing/deletion.tsx";
import { focusWhenReady } from "../billing/focus.ts";
import { HrefLink } from "../billing/HrefLink.tsx";
import {
  describeStanding,
  isUnfinishedSignup,
  type MembershipAction,
} from "../billing/membership.ts";
import { describeOutcome, describeReduction, membershipOutcome } from "../billing/outcome.ts";
import { membershipToast } from "../billing/toasts.ts";
import { FormAlert } from "../shared/FormAlert.tsx";
import { describeQuality, formatLongDate, formatMoney, formatScreens } from "../shared/format.ts";
import { describeMemberError } from "../shared/privileges.ts";
import {
  describeCard,
  describeExpiry,
  membershipOfDetails,
  useResumeMembership,
} from "./membership.ts";

/** The membership's status as a badge. */
export function MembershipBadge({ details }: { details: AccountDetails }) {
  const { badge } = describeStanding(membershipOfDetails(details));
  return (
    <Badge tone={badge.tone} size="sm" data-testid="membership-status">
      {badge.label}
    </Badge>
  );
}

/**
 * What needs the member's attention, with the one action that resolves it: a payment that
 * failed (still watching, until when), a membership on hold, one that is ending or has ended, a
 * scheduled deletion (watching until it, nothing more charged). Nothing when all is well.
 */
export function MembershipAlert({
  details,
  readOnly = false,
}: {
  details: AccountDetails;
  /** The demo account: say what is so, offer no change. */
  readOnly?: boolean;
}) {
  const view = membershipOfDetails(details);
  const { notice } = describeStanding(view);
  const unfinished = isUnfinishedSignup(useSession());
  const deletion = useScheduledDeletion(!readOnly);
  const resume = useResumeMembership({
    onSuccess: (_membership, fresh) => {
      // The page's own words for what happens next ("Your next payment is ..."), and focus on
      // the membership's heading: the notice that held the button is gone.
      const charge = fresh
        ? describeOutcome(membershipOutcome(fresh.view, priceOf(fresh.details))).charge
        : null;
      membershipToast("Your membership will continue", charge ?? undefined);
      focusWhenReady(
        () =>
          document.getElementById("account-your-membership") ??
          document.getElementById("account-membership"),
      );
    },
  });
  // A scheduled deletion stops the renewals and refuses every change: say that instead.
  if (deletion || isDeletionScheduled(resume.error)) {
    return <DeletionScheduledNotice scheduledFor={deletion?.scheduledFor} view={view} />;
  }
  if (!notice) return null;
  // Not started yet, in an unfinished sign-up: the account pages' own notice offers the way on.
  if (unfinished && ["none", "incomplete"].includes(view.membership.status)) return null;
  return (
    <FormAlert
      tone={notice.tone}
      title={notice.title}
      action={
        readOnly || !notice.action ? undefined : (
          <NoticeAction
            action={notice.action}
            busy={resume.isPending}
            onResume={() => resume.mutate()}
          />
        )
      }
    >
      {notice.body}
      {resume.isError ? (
        <span className="mt-2 block text-danger">
          {describeMemberError(resume.error).description}
        </span>
      ) : null}
    </FormAlert>
  );
}

/** The plan's price, for `membershipOutcome` (what a payment is before credit and discounts). */
export function priceOf(details: AccountDetails) {
  return { monthlyPrice: details.plan?.monthlyPrice ?? null };
}

/** Whether the alert above the facts carries this membership's notice (and its action). */
export function alertActionOf(details: AccountDetails): MembershipAction | null {
  return describeStanding(membershipOfDetails(details)).notice?.action ?? null;
}

function NoticeAction({
  action,
  busy,
  onResume,
}: {
  action: MembershipAction;
  busy: boolean;
  onResume: () => void;
}) {
  if (action.kind === "resume") {
    return (
      <Button variant="accent" size="sm" loading={busy} onClick={onResume}>
        {action.label}
      </Button>
    );
  }
  return (
    <Button variant="accent" size="sm" asChild>
      <HrefLink href={action.href}>{action.label}</HrefLink>
    </Button>
  );
}

/**
 * Plan, the next payment and card, as the server has them (`membershipOutcome`: the amount the
 * provider will charge and why it is below the plan's price). When the alert above says when the
 * membership ends or what is owed, the facts don't repeat it (UX review 3.11).
 */
export function MembershipFacts({ details }: { details: AccountDetails }) {
  const view = membershipOfDetails(details);
  const { membership } = view;
  const { plan, paymentMethod } = details;
  const deletion = useScheduledDeletion();
  const outcome = membershipOutcome(view, { ...priceOf(details), deletion });
  const hasPlan = membership.status !== "none";

  let when: { term: string; value: ReactNode; detail?: string } | null = null;
  const charge = outcome.nextCharge;
  if (charge) {
    const first = charge.kind === "trial_converts";
    const why = describeReduction(charge.creditApplied, charge.discount);
    when = {
      term: first ? "First payment" : "Next payment",
      value: `${formatMoney(charge.amount)} on ${formatLongDate(charge.at)}`,
      detail: [
        first ? "When your free trial ends" : null,
        why && plan ? `${formatMoney(plan.monthlyPrice)} less ${why}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  } else if (membership.status === "canceled" && membership.currentPeriodEnd) {
    when = { term: "Membership ended", value: formatLongDate(membership.currentPeriodEnd) };
  }

  return (
    <dl className="grid gap-5 sm:grid-cols-2">
      <div>
        <dt className="type-caption text-fg-subtle">Plan</dt>
        {hasPlan && plan ? (
          <>
            <dd className="type-body text-fg">
              {plan.name} · {formatMoney(plan.monthlyPrice)}/month
            </dd>
            <dd className="type-body-sm text-fg-muted">
              {describeQuality(plan)} · {formatScreens(plan.maxStreams)}
            </dd>
          </>
        ) : (
          <dd className="type-body text-fg">No plan yet</dd>
        )}
      </div>
      {when ? (
        <div>
          <dt className="type-caption text-fg-subtle">{when.term}</dt>
          <dd className="type-body text-fg">{when.value}</dd>
          {when.detail ? <dd className="type-body-sm text-fg-muted">{when.detail}</dd> : null}
        </div>
      ) : null}
      <div>
        <dt className="type-caption text-fg-subtle">Payment method</dt>
        <dd className="type-body text-fg">
          {paymentMethod ? describeCard(paymentMethod) : "No card on file"}
        </dd>
        {paymentMethod ? (
          <dd className="type-body-sm text-fg-muted">{describeExpiry(paymentMethod)}</dd>
        ) : null}
      </div>
    </dl>
  );
}

/** Same geometry as the membership panel, while it loads. */
export function MembershipSkeleton() {
  return (
    <div
      className="flex flex-col gap-5 rounded-xl border border-line-subtle bg-surface-1 p-5 sm:p-6"
      aria-busy="true"
    >
      <Skeleton className="h-6 w-40" />
      <div className="grid gap-5 sm:grid-cols-2">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-10 w-44" />
      </div>
      <div className="flex gap-3">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-8 w-40" />
      </div>
    </div>
  );
}
