import { Link } from "@tanstack/react-router";
import type { AccountDetails } from "@webflix/contracts";
import { Button, ChevronRightIcon, ErrorState } from "@webflix/ui";
import { describeError } from "../../../app/query/errors.ts";
import { useScheduledDeletion } from "../billing/deletion.tsx";
import { FormAlert } from "../shared/FormAlert.tsx";
import { useIsDemoAccount } from "../shared/privileges.ts";
import { AccountHeading, AccountSection } from "./AccountLayout.tsx";
import { InvoiceList } from "./InvoicesPage.tsx";
import {
  alertActionOf,
  MembershipAlert,
  MembershipBadge,
  MembershipFacts,
  MembershipSkeleton,
} from "./MembershipSummary.tsx";
import { isLegacyMembership, membershipOfDetails, useAccountDetails } from "./membership.ts";

/**
 * The membership hub: what the member has (plan, dates, card), what needs their attention, and
 * every change they can make (plan, card, cancel or keep, restart), plus recent invoices.
 * Everything shown is the server's projection of the provider's state.
 */
export function AccountMembershipPage() {
  const details = useAccountDetails();
  return (
    <>
      <AccountHeading title="Membership" description="Your plan, billing and payment method." />
      {details.isPending ? (
        <MembershipSkeleton />
      ) : details.isError ? (
        <ErrorState
          layout="inline"
          title="We couldn't load your membership"
          description={describeError(details.error).description}
          reference={describeError(details.error).reference}
          action={
            <Button variant="primary" onClick={() => void details.refetch()}>
              Try again
            </Button>
          }
        />
      ) : (
        <MembershipDetails details={details.data} />
      )}
    </>
  );
}

function MembershipDetails({ details }: { details: AccountDetails }) {
  const demo = useIsDemoAccount();
  const view = membershipOfDetails(details);
  const { membership } = view;
  const legacy = isLegacyMembership(view);
  const running = ["trialing", "active", "past_due"].includes(membership.status);
  const cancellable =
    (membership.status === "trialing" || membership.status === "active") &&
    !membership.cancelAtPeriodEnd;
  // While a deletion is scheduled, billing refuses to start or change the membership: those
  // actions are not offered (the alert above says why). Replacing the card still works.
  const deletion = useScheduledDeletion(!demo);
  // The alert above leads with the one action that resolves it (update the card when a payment
  // failed, restart when it ended): the row below doesn't offer the same thing twice.
  const alertAction = deletion ? null : alertActionOf(details);
  const offeredAbove = (href: string) => alertAction?.kind === "link" && alertAction.href === href;
  const canChangeCard =
    !legacy &&
    ["trialing", "active", "past_due", "suspended"].includes(membership.status) &&
    !offeredAbove("/account/membership/payment");
  const canRestart = membership.status === "canceled" && !deletion && !alertAction;
  const actions = !demo && ((running && !deletion) || canChangeCard || canRestart || cancellable);

  return (
    <>
      {demo ? (
        <FormAlert tone="info" title="The demo account's membership can't be changed">
          Everyone who tries Webflix shares this account, so its plan and payment method stay as
          they are.
        </FormAlert>
      ) : null}
      <AccountSection title="Your membership" action={<MembershipBadge details={details} />}>
        <MembershipAlert details={details} readOnly={demo} />
        <MembershipFacts details={details} />
        {!actions ? null : (
          <div className="flex flex-wrap gap-3 border-t border-line-subtle pt-5">
            {running && !deletion ? (
              <Button variant="outline" size="sm" iconAfter={ChevronRightIcon} asChild>
                <Link to="/account/membership/plan">Change plan</Link>
              </Button>
            ) : null}
            {canRestart ? (
              <Button variant="accent" size="sm" asChild>
                <Link to="/account/membership/plan">Restart membership</Link>
              </Button>
            ) : null}
            {canChangeCard ? (
              <Button variant="outline" size="sm" iconAfter={ChevronRightIcon} asChild>
                <Link to="/account/membership/payment">Update payment method</Link>
              </Button>
            ) : null}
            {cancellable ? (
              <Button variant="ghost" size="sm" asChild>
                <Link to="/account/membership/cancel">Cancel membership</Link>
              </Button>
            ) : null}
          </div>
        )}
      </AccountSection>

      <AccountSection
        title="Billing history"
        description="Your latest invoices and receipts."
        action={
          <Button variant="outline" size="sm" iconAfter={ChevronRightIcon} asChild>
            <Link to="/account/membership/invoices">See all</Link>
          </Button>
        }
      >
        <InvoiceList limit={3} />
      </AccountSection>
    </>
  );
}
