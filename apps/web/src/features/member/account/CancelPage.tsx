import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Button,
  CalendarIcon,
  CheckCircleIcon,
  ErrorState,
  HeartIcon,
  RefreshIcon,
  Skeleton,
  toast,
} from "@webflix/ui";
import type { ReactNode } from "react";
import { api } from "../../../app/api.ts";
import { describeError } from "../../../app/query/errors.ts";
import { queries } from "../../../app/query/queries.ts";
import { FormAlert } from "../shared/FormAlert.tsx";
import { formatLongDate } from "../shared/format.ts";
import { describeMemberError, useIsDemoAccount } from "../shared/privileges.ts";
import { useSingleFlight } from "../shared/useSingleFlight.ts";
import { AccountHeading } from "./AccountLayout.tsx";
import { applyMembership, useResumeMembership } from "./membership.ts";

/**
 * Cancellation, done honestly: one page that says exactly what happens and when, a clear
 * "Finish cancellation", an equally clear way to keep the membership, and no guilt trip.
 */
export function AccountCancelPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const demo = useIsDemoAccount();
  const details = useQuery(queries.account());
  const flight = useSingleFlight();
  const resume = useResumeMembership({
    onSuccess: () => {
      toast.success("Your membership will continue");
      void navigate({ to: "/account" });
    },
  });
  const cancel = useMutation({
    mutationFn: () => api().cancelMembership(),
    meta: { silent: true },
    onSuccess: (membership) => {
      applyMembership(queryClient, membership);
      toast.success("Your membership is canceled", {
        description: `You can keep watching until ${formatLongDate(membership.subscription.currentPeriodEnd)}.`,
      });
      void navigate({ to: "/account" });
    },
  });

  if (demo) {
    return (
      <>
        <AccountHeading title="Cancel membership" />
        <FormAlert
          tone="info"
          title="The demo account's membership can't be canceled"
          action={
            <Button variant="outline" size="sm" asChild>
              <Link to="/account">Back to account</Link>
            </Button>
          }
        >
          It stays active for everyone who tries Webflix.
        </FormAlert>
      </>
    );
  }
  if (details.isPending) {
    return (
      <>
        <AccountHeading title="Cancel membership" />
        <Skeleton className="h-48 w-full" radius="card" />
      </>
    );
  }
  if (details.isError) {
    return (
      <>
        <AccountHeading title="Cancel membership" />
        <ErrorState
          title="We couldn't load your membership"
          description={describeError(details.error).description}
          action={
            <Button variant="primary" onClick={() => void details.refetch()}>
              Try again
            </Button>
          }
        />
      </>
    );
  }

  const { subscription, plan } = details.data;
  const ends = formatLongDate(subscription.currentPeriodEnd);

  if (subscription.status !== "active") {
    return (
      <>
        <AccountHeading title="Cancel membership" />
        <FormAlert
          tone={subscription.status === "ended" ? "accent" : "info"}
          title={
            subscription.status === "ended"
              ? "Your membership has already ended"
              : `Your membership is already set to end on ${ends}`
          }
          action={
            subscription.status === "ended" ? (
              <Button variant="accent" size="sm" asChild>
                <Link to="/account/plan">Restart membership</Link>
              </Button>
            ) : (
              <Button
                variant="accent"
                size="sm"
                loading={resume.isPending}
                onClick={() => resume.mutate()}
              >
                Keep my membership
              </Button>
            )
          }
        >
          {subscription.status === "ended"
            ? "Restart anytime to keep watching."
            : "You won't be charged again. Changed your mind? Keep it in one click."}
        </FormAlert>
      </>
    );
  }

  return (
    <>
      <AccountHeading
        title="Cancel your membership?"
        description={`You're on ${plan.name}. Here's what happens if you cancel today.`}
      />
      <ul className="flex flex-col gap-4 rounded-xl border border-line-subtle bg-surface-1 p-5 sm:p-6">
        <Point icon={CalendarIcon} title={`You can keep watching until ${ends}`}>
          Your membership stays active for the rest of the period you've paid for.
        </Point>
        <Point icon={CheckCircleIcon} title="You won't be charged again">
          No cancellation fee, and nothing more after today.
        </Point>
        <Point icon={HeartIcon} title="Your profiles stay put">
          Profiles, My List, ratings and viewing activity are kept, so everything is where you left
          it if you come back.
        </Point>
        <Point icon={RefreshIcon} title="Restart anytime">
          Changed your mind before {ends}? Keep your membership from the Account page.
        </Point>
      </ul>
      {cancel.isError ? (
        <FormAlert title="We couldn't cancel your membership">
          {describeMemberError(cancel.error).description} Your membership is unchanged.
        </FormAlert>
      ) : null}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button variant="outline" size="lg" asChild>
          <Link to="/account">Keep my membership</Link>
        </Button>
        <Button
          variant="danger"
          size="lg"
          loading={cancel.isPending}
          onClick={() => flight.run(() => cancel.mutateAsync())}
        >
          Finish cancellation
        </Button>
      </div>
    </>
  );
}

function Point({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof CalendarIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-4">
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-3 text-fg-muted">
        <Icon size="md" />
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="type-label text-fg">{title}</span>
        <span className="type-body-sm text-fg-muted">{children}</span>
      </span>
    </li>
  );
}
