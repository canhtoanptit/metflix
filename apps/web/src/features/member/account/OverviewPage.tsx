import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type AccountDetails, ApiError } from "@webflix/contracts";
import {
  Avatar,
  Badge,
  Button,
  ChevronRightIcon,
  Dialog,
  DialogContent,
  DialogFooter,
  ErrorState,
  KidsIcon,
  LockIcon,
  Skeleton,
  toast,
} from "@webflix/ui";
import { type FormEvent, useRef, useState } from "react";
import { api } from "../../../app/api.ts";
import { describeError } from "../../../app/query/errors.ts";
import { qk } from "../../../app/query/keys.ts";
import { queries } from "../../../app/query/queries.ts";
import { useAuthenticatedSession } from "../../../app/session/session.ts";
import { cardErrorsFrom, describeDecline } from "../shared/billing.ts";
import { CardFields, type CardFieldsHandle, EMPTY_CARD } from "../shared/CardFields.tsx";
import { FormAlert } from "../shared/FormAlert.tsx";
import {
  describeQuality,
  formatLongDate,
  formatMoney,
  formatScreens,
  formatShortDate,
} from "../shared/format.ts";
import { describeMemberError, useIsDemoAccount } from "../shared/privileges.ts";
import { TestCardsNote } from "../shared/TestCardsNote.tsx";
import { type CardFormErrors, toCardPayment } from "../shared/validation.ts";
import { AccountHeading, AccountSection } from "./AccountLayout.tsx";
import { describeCard, describeExpiry, useResumeMembership } from "./membership.ts";

/**
 * Account overview: membership and billing, sign-in details, devices and profiles at a glance.
 * The shared demo account says once here what stays fixed, and offers no way to change it.
 */
export function AccountOverviewPage() {
  const session = useAuthenticatedSession();
  const demo = useIsDemoAccount();
  const details = useQuery(queries.account());

  return (
    <>
      <AccountHeading
        title="Account"
        description={
          <>
            Member since {formatLongDate(session.account.createdAt)} ·{" "}
            <span className="text-fg">{session.account.email}</span>
          </>
        }
      />
      {demo ? (
        <FormAlert tone="info" title="This is the shared demo account">
          Everyone who tries Webflix uses it, so its sign-in details, membership and profiles can't
          be changed. Playback settings and viewing activity are yours to change.
        </FormAlert>
      ) : null}
      {details.isPending ? (
        <MembershipSkeleton />
      ) : details.isError ? (
        <ErrorState
          layout="inline"
          title="We couldn't load your membership"
          description={describeError(details.error).description}
          action={
            <Button variant="primary" onClick={() => void details.refetch()}>
              Try again
            </Button>
          }
        />
      ) : (
        <MembershipPanel details={details.data} />
      )}

      <AccountSection
        title="Security"
        description="How you sign in to Webflix."
        action={demo ? null : <SectionLink to="/account/security">Update</SectionLink>}
      >
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="type-caption text-fg-subtle">Email</dt>
            <dd className="truncate type-body text-fg">{session.account.email}</dd>
          </div>
          <div>
            <dt className="type-caption text-fg-subtle">Password</dt>
            <dd className="type-body text-fg">
              <span aria-hidden>••••••••••</span>
              <span className="sr-only">Hidden</span>
            </dd>
          </div>
        </dl>
      </AccountSection>

      <AccountSection
        title="Devices"
        description="Where you're signed in. Sign out any device remotely."
        action={<SectionLink to="/account/devices">Manage devices</SectionLink>}
      />

      <AccountSection
        title="Profiles"
        description={`${session.profiles.length} of 5 profiles in use.`}
        action={<SectionLink to="/profiles/manage">Manage profiles</SectionLink>}
      >
        <ul className="flex flex-col divide-y divide-line-subtle">
          {session.profiles.map((profile) => (
            <li key={profile.id}>
              <Link
                to="/profiles/$profileId/edit"
                params={{ profileId: profile.id }}
                className="focus-ring-inset group flex items-center gap-4 rounded-sm py-3"
              >
                <Avatar src={profile.avatar.imageUrl} name={profile.name} size="md" decorative />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2 type-label text-fg">
                    {profile.name}
                    {profile.id === session.activeProfile?.id ? (
                      <Badge tone="outline" size="sm">
                        Watching now
                      </Badge>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-2 type-body-sm text-fg-muted">
                    {profile.isKids ? (
                      <>
                        <KidsIcon size="xs" /> Kids ·{" "}
                      </>
                    ) : null}
                    Maturity{" "}
                    {profile.maturityCeiling === "ALL" ? "All ages" : profile.maturityCeiling}
                    {profile.isLocked ? (
                      <>
                        {" "}
                        · <LockIcon size="xs" /> Locked
                      </>
                    ) : null}
                  </span>
                </span>
                <ChevronRightIcon
                  size="md"
                  className="text-fg-subtle transition-transform duration-fast group-hover:translate-x-0.5"
                />
              </Link>
            </li>
          ))}
        </ul>
      </AccountSection>

      <AccountSection
        title="Viewing activity"
        description="Titles a profile has watched. Remove anything you'd rather it forgot."
        action={<SectionLink to="/account/activity">View activity</SectionLink>}
      />
    </>
  );
}

function SectionLink({
  to,
  children,
}: {
  to:
    | "/account/security"
    | "/account/devices"
    | "/profiles/manage"
    | "/account/activity"
    | "/account/plan";
  children: string;
}) {
  return (
    <Button variant="outline" size="sm" iconAfter={ChevronRightIcon} asChild>
      <Link to={to}>{children}</Link>
    </Button>
  );
}

function MembershipSkeleton() {
  return (
    <div
      className="flex flex-col gap-5 rounded-xl border border-line-subtle bg-surface-1 p-5 sm:p-6"
      aria-busy="true"
    >
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-64" />
      <Skeleton className="h-4 w-52" />
      <div className="flex gap-3">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-8 w-28" />
      </div>
    </div>
  );
}

function MembershipPanel({ details }: { details: AccountDetails }) {
  const { subscription, plan, paymentMethod } = details;
  const demo = useIsDemoAccount();
  const [updatingCard, setUpdatingCard] = useState(false);
  const resume = useResumeMembership({
    onSuccess: () =>
      toast.success("Your membership will continue", {
        description: "Nothing changes: keep watching.",
      }),
  });

  const status =
    subscription.status === "active" ? (
      <Badge tone="positive" size="sm">
        Active
      </Badge>
    ) : subscription.status === "canceling" ? (
      <Badge tone="neutral" size="sm">
        Ends {formatShortDate(subscription.currentPeriodEnd)}
      </Badge>
    ) : (
      <Badge tone="danger" size="sm">
        Ended
      </Badge>
    );

  return (
    <AccountSection title="Membership" action={status}>
      {subscription.status === "canceling" ? (
        <FormAlert
          tone="info"
          title={`Your membership ends on ${formatLongDate(subscription.currentPeriodEnd)}`}
          action={
            <Button
              variant="accent"
              size="sm"
              loading={resume.isPending}
              onClick={() => resume.mutate()}
            >
              Keep my membership
            </Button>
          }
        >
          You won't be charged again, and you can watch until then. Changed your mind? Keep it in
          one click.
          {resume.isError ? (
            <span className="mt-2 block text-danger">
              {describeMemberError(resume.error).description}
            </span>
          ) : null}
        </FormAlert>
      ) : subscription.status === "ended" ? (
        <FormAlert
          tone="accent"
          title="Your membership has ended"
          action={
            <Button variant="accent" size="sm" asChild>
              <Link to="/account/plan">Restart membership</Link>
            </Button>
          }
        >
          Restart anytime. Your profiles, My List and viewing activity are still here.
        </FormAlert>
      ) : null}

      <dl className="grid gap-5 sm:grid-cols-2">
        <div>
          <dt className="type-caption text-fg-subtle">Plan</dt>
          <dd className="type-body text-fg">
            {plan.name} · {formatMoney(plan.monthlyPrice)}/month
          </dd>
          <dd className="type-body-sm text-fg-muted">
            {describeQuality(plan)} · {formatScreens(plan.maxStreams)}
          </dd>
        </div>
        <div>
          <dt className="type-caption text-fg-subtle">
            {subscription.status === "active"
              ? "Next payment"
              : subscription.status === "canceling"
                ? "Membership ends"
                : "Membership ended"}
          </dt>
          <dd className="type-body text-fg">
            {subscription.status === "active"
              ? `${formatMoney(plan.monthlyPrice)} on ${formatLongDate(subscription.currentPeriodEnd)}`
              : formatLongDate(subscription.currentPeriodEnd)}
          </dd>
        </div>
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

      {subscription.status === "ended" || demo ? null : (
        <div className="flex flex-wrap gap-3 border-t border-line-subtle pt-5">
          <Button variant="outline" size="sm" asChild>
            <Link to="/account/plan">Change plan</Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => setUpdatingCard(true)}>
            Update payment method
          </Button>
          {subscription.status === "active" ? (
            <Button variant="ghost" size="sm" asChild>
              <Link to="/account/cancel">Cancel membership</Link>
            </Button>
          ) : null}
        </div>
      )}

      <UpdateCardDialog open={updatingCard} onOpenChange={setUpdatingCard} details={details} />
    </AccountSection>
  );
}

/**
 * Replace the card on file (`PUT /account/payment-method`): the card is verified with a
 * zero-amount authorisation; a declined one leaves the card on file as it was.
 */
function UpdateCardDialog({
  open,
  onOpenChange,
  details,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  details: AccountDetails;
}) {
  const queryClient = useQueryClient();
  const [card, setCard] = useState(EMPTY_CARD);
  const [serverErrors, setServerErrors] = useState<CardFormErrors>({});
  const cardRef = useRef<CardFieldsHandle>(null);

  const close = () => {
    onOpenChange(false);
    setCard(EMPTY_CARD);
    setServerErrors({});
    update.reset();
  };

  const update = useMutation({
    mutationFn: () => api().updatePaymentMethod({ body: { payment: toCardPayment(card) } }),
    meta: { silent: true },
    onError: (error) => setServerErrors(cardErrorsFrom(error)),
    onSuccess: (updated) => {
      queryClient.setQueryData(qk.account.details(), updated);
      toast.success("Payment method updated");
      close();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (update.isPending) return;
    if (!cardRef.current?.validate()) return;
    update.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        title="Update payment method"
        description={`Your next payment of ${formatMoney(details.plan.monthlyPrice)} will be charged to this card.`}
        size="md"
      >
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          {ApiError.is(update.error, "payment_declined") ? (
            <FormAlert title={describeDecline(update.error.problem.declineReason).title}>
              {describeDecline(update.error.problem.declineReason).body} Your card on file hasn't
              changed.
            </FormAlert>
          ) : update.error ? (
            <FormAlert title={describeMemberError(update.error).title}>
              {describeMemberError(update.error).description}
            </FormAlert>
          ) : null}
          <CardFields
            ref={cardRef}
            value={card}
            onChange={(next) => {
              setCard(next);
              setServerErrors({});
            }}
            serverErrors={serverErrors}
            disabled={update.isPending}
          />
          <TestCardsNote />
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" loading={update.isPending}>
              Save card
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
