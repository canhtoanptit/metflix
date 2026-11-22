import type { AccountDetails } from "@webflix/contracts";
import { Badge, Button, Skeleton, toast } from "@webflix/ui";
import type { ReactNode } from "react";
import {
  DeletionScheduledNotice,
  isDeletionScheduled,
  useScheduledDeletion,
} from "../billing/deletion.tsx";
import { HrefLink } from "../billing/HrefLink.tsx";
import { describeStanding, type MembershipAction } from "../billing/membership.ts";
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
 * failed (still watching, until when), a membership on hold, one that is ending or has ended.
 * Nothing when all is well.
 */
export function MembershipAlert({
  details,
  readOnly = false,
}: {
  details: AccountDetails;
  /** The demo account: say what is so, offer no change. */
  readOnly?: boolean;
}) {
  const { notice } = describeStanding(membershipOfDetails(details));
  const deletion = useScheduledDeletion(!readOnly);
  const resume = useResumeMembership({
    onSuccess: () =>
      toast.success("Your membership will continue", {
        description: "Nothing changes: keep watching.",
      }),
  });
  // A scheduled deletion stops the renewals and refuses every change: say that instead.
  if (deletion || isDeletionScheduled(resume.error)) {
    return <DeletionScheduledNotice scheduledFor={deletion?.scheduledFor} />;
  }
  if (!notice) return null;
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
 * Plan, dates and card, as the server has them. Amounts are the plan's price from the server;
 * the next billing date is the provider's period end, never computed here.
 */
export function MembershipFacts({ details }: { details: AccountDetails }) {
  const { membership, entitlement } = membershipOfDetails(details);
  const { plan, paymentMethod } = details;
  // The next bill as the provider previews it: discounts and credit included, so exact.
  const next = membership.nextInvoice ?? null;
  const hasPlan = membership.status !== "none";
  const date = (iso: string | null) => (iso ? formatLongDate(iso) : "Not set");

  let when: { term: string; value: ReactNode } | null = null;
  switch (membership.status) {
    case "trialing":
      when = membership.cancelAtPeriodEnd
        ? { term: "Free trial ends", value: date(membership.trialEndsAt) }
        : {
            term: "First payment",
            value: (
              <>
                {next ? formatMoney(next.amount) : plan ? formatMoney(plan.monthlyPrice) : null} on{" "}
                {date(next?.at ?? membership.trialEndsAt)}
                <span className="block type-body-sm text-fg-muted">When your free trial ends</span>
              </>
            ),
          };
      break;
    case "active":
      when = membership.cancelAtPeriodEnd
        ? { term: "Membership ends", value: date(entitlement.until ?? membership.currentPeriodEnd) }
        : next
          ? { term: "Next payment", value: `${formatMoney(next.amount)} on ${date(next.at)}` }
          : { term: "Next billing date", value: date(membership.currentPeriodEnd) };
      break;
    case "past_due":
      when = {
        term: "Watching until",
        value: (
          <>
            {date(membership.graceEndsAt ?? entitlement.until)}
            <span className="block type-body-sm text-fg-muted">
              Then paused, unless the payment has gone through
            </span>
          </>
        ),
      };
      break;
    case "suspended":
      when = { term: "Watching", value: "Paused until the payment goes through" };
      break;
    case "canceled":
      when = membership.currentPeriodEnd
        ? { term: "Membership ended", value: date(membership.currentPeriodEnd) }
        : null;
      break;
    case "incomplete":
      when = { term: "First payment", value: "Waiting for confirmation" };
      break;
    case "none":
      when = null;
      break;
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
