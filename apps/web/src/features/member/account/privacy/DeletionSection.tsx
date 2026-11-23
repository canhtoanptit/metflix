/**
 * Account › Privacy, "Delete your account". Everything the member needs to decide is on the page
 * before the button: when it happens, what goes, what Webflix keeps, and what deleting today
 * would mean for the membership, all in this deployment's terms. Asking schedules the deletion
 * after the cooling-off period (a confirmation, then "Confirm it's you"); until then the account
 * works as usual and keeping it is one button, with no proof asked: the way back is always easier
 * than the way out. A kept account's membership stays set to end; the section offers to resume it.
 * Once the erasure has started (`processing`) nothing can stop it, and the section says only that.
 *
 * Every sentence about the membership comes from `membershipOutcome` (billing/outcome.ts), the
 * one source Membership reads too (UX review 2.1): the explainer says what deleting *today* would
 * do, the scheduled notice what the scheduled deletion does, and neither can disagree with the
 * Membership page.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ApiError,
  type MembershipState,
  type PrivacyRequest,
  type PrivacyRequestList,
} from "@webflix/contracts";
import { Button, ConfirmDialog, ErrorState, Skeleton, toast } from "@webflix/ui";
import { useEffect, useState } from "react";
import { api } from "../../../../app/api.ts";
import { describeError } from "../../../../app/query/errors.ts";
import { qk } from "../../../../app/query/keys.ts";
import {
  type MembershipView,
  useAuthenticatedSession,
  useMembership,
} from "../../../../app/session/session.ts";
import { BusyButton } from "../../../../app/telemetry/BusyButton.tsx";
import { isDeletionScheduled } from "../../billing/deletion.tsx";
import { endingNotice } from "../../billing/membership.ts";
import { describeOutcome, membershipOutcome, type OutcomeContext } from "../../billing/outcome.ts";
import { membershipToast } from "../../billing/toasts.ts";
import { IdentityNotConfirmed, useConfirmIdentity } from "../../shared/ConfirmIdentity.tsx";
import { FormAlert } from "../../shared/FormAlert.tsx";
import { formatDateTime, formatLongDate } from "../../shared/format.ts";
import { describeMemberError, useIsDemoAccount } from "../../shared/privileges.ts";
import { AccountSection } from "../AccountLayout.tsx";
import { useResumeMembership } from "../membership.ts";
import { byId, focusAfterDialogs } from "./focus.ts";
import {
  deletionInProgress,
  formatPeriod,
  privacyRequestsKey,
  privacyRequestsQuery,
  resumableAfterDeletion,
  scheduledDeletion,
} from "./requests.ts";

/** The section's heading id (`AccountSection` derives it from the title). */
const HEADING_ID = "account-delete-your-account";

/** Ids of what takes focus after scheduling and keeping (UX review 2.7). */
const SCHEDULED_ID = "privacy-deletion-scheduled";
const RESUME_ID = "privacy-membership-resume";

/** The membership's facts, in the shared words, with what is said when it has none. */
function membershipSentences(
  view: MembershipView,
  context: OutcomeContext,
  options: { skipAccountDeleted?: boolean } = {},
): string {
  const outcome = membershipOutcome(view, context);
  const { watching, charge } = describeOutcome(outcome);
  const parts: string[] = [];
  if (
    watching &&
    !(options.skipAccountDeleted && outcome.watchingEnds?.because === "account_deleted")
  ) {
    parts.push(watching);
  }
  if (charge) parts.push(charge);
  if (parts.length === 0) {
    return view.membership.status === "canceled"
      ? "Your membership has already ended, so nothing is charged."
      : view.membership.status === "none"
        ? "You have no membership, so nothing is charged."
        : "";
  }
  return parts.join(" ");
}

export function DeletionSection() {
  const demo = useIsDemoAccount();
  const session = useAuthenticatedSession();
  const queryClient = useQueryClient();
  const view = useMembership();
  const price: OutcomeContext = { monthlyPrice: session.plan?.monthlyPrice ?? null };
  const requests = useQuery(privacyRequestsQuery());
  const [confirming, setConfirming] = useState(false);
  const identity = useConfirmIdentity({
    id: "delete-account",
    purpose: "delete your account",
    // Back from confirming at a provider: ask once more rather than deleting on our own.
    onResume: () => setConfirming(true),
  });

  const store = (update: (items: PrivacyRequest[]) => PrivacyRequest[]) =>
    queryClient.setQueryData<PrivacyRequestList>(privacyRequestsKey(), (current) =>
      current ? { ...current, items: update(current.items) } : current,
    );

  const schedule = useMutation({
    mutationFn: () => identity.run(() => api().requestAccountDeletion()),
    meta: { silent: true },
    onSuccess: (created) => {
      store((items) => [created, ...items.filter((item) => item.id !== created.id)]);
      const membership = created.scheduledFor
        ? membershipSentences(
            view,
            {
              ...price,
              deletion: { scheduledFor: created.scheduledFor, membership: created.membership },
            },
            { skipAccountDeleted: true },
          )
        : "";
      toast.success("Your account deletion is scheduled", {
        description: created.scheduledFor
          ? `It happens on ${formatLongDate(created.scheduledFor)}. ${membership}`.trim()
          : undefined,
      });
      // Its renewals stopped: the session's membership changed too.
      void queryClient.invalidateQueries({ queryKey: qk.session() });
      focusAfterDialogs(byId(SCHEDULED_ID));
    },
    onError: (error) => {
      if (error instanceof IdentityNotConfirmed) return;
      if (ApiError.is(error, "privacy_request_pending")) return; // already scheduled elsewhere
      toast.error("We couldn't schedule the deletion", {
        description: describeMemberError(error).description,
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: privacyRequestsKey() }),
  });

  const keep = useMutation({
    mutationFn: () => api().cancelAccountDeletion(),
    meta: { silent: true },
    onSuccess: async () => {
      store((items) =>
        items.map((item) =>
          item.kind === "deletion" && item.status === "scheduled"
            ? { ...item, status: "canceled" as const }
            : item,
        ),
      );
      // The membership as it now stands (still set to end, when the deletion stopped it).
      toast.success("Your account is staying", {
        description: `Nothing will be deleted. ${membershipSentences(view, price)}`.trim(),
      });
      void queryClient.invalidateQueries({ queryKey: qk.session() });
      // Only the list says whether the membership can be resumed (the answer is empty): read it
      // first, so focus lands on the resume notice when there is one, else the section's heading.
      await queryClient.invalidateQueries({ queryKey: privacyRequestsKey() });
      const list = queryClient.getQueryData<PrivacyRequestList>(privacyRequestsKey());
      focusAfterDialogs(byId(list && resumableAfterDeletion(list.items) ? RESUME_ID : HEADING_ID));
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: privacyRequestsKey() });
      // Already cancelled (another tab): the list shows the truth once refetched.
      if (ApiError.is(error, "not_found")) return;
      toast.error("We couldn't cancel the deletion", {
        description: describeMemberError(error).description,
      });
    },
  });

  const terms = requests.data?.terms;
  const inProgress = requests.data ? deletionInProgress(requests.data.items) : undefined;
  const scheduled = requests.data ? scheduledDeletion(requests.data.items) : undefined;
  const resumable = requests.data ? resumableAfterDeletion(requests.data.items) : undefined;
  const deleteOn = terms
    ? new Date(Date.now() + terms.deletionCoolingOffSec * 1000).toISOString()
    : null;
  // "If you delete today": what a deletion scheduled now would mean (conditional, never a fact).
  const ifToday = deleteOn
    ? membershipSentences(view, { ...price, deletion: { scheduledFor: deleteOn } })
    : "";
  // Only a membership that is still going to charge can be stopped without deleting anything.
  const offerCancelInstead = membershipOutcome(view, price).nextCharge !== null;

  return (
    <AccountSection
      title="Delete your account"
      description="Permanently delete your Webflix account and your personal data, apart from the few records listed under What we keep."
    >
      {requests.isPending ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-4 w-full max-w-lg" />
          <Skeleton className="h-4 w-full max-w-md" />
          <Skeleton className="h-10 w-44" radius="md" />
        </div>
      ) : requests.isError ? (
        <ErrorState
          layout="inline"
          title="We couldn't check your account's status"
          description={describeError(requests.error).description}
          action={
            <Button variant="primary" onClick={() => void requests.refetch()}>
              Try again
            </Button>
          }
        />
      ) : inProgress ? (
        <DeletionUnderway request={inProgress} />
      ) : scheduled ? (
        <FormAlert
          id={SCHEDULED_ID}
          title={`Your account will be deleted on ${formatLongDate(scheduled.scheduledFor)}`}
          action={
            <BusyButton variant="primary" busy={keep.isPending} onClick={() => keep.mutate()}>
              Keep my account
            </BusyButton>
          }
        >
          You asked on {formatDateTime(scheduled.requestedAt)}. Until{" "}
          {formatDateTime(scheduled.scheduledFor)} everything works as usual and you can change your
          mind here. After that, it can't be undone.
          <span className="mt-2 block">
            {membershipSentences(
              view,
              {
                ...price,
                deletion: {
                  scheduledFor: scheduled.scheduledFor,
                  membership: scheduled.membership,
                },
              },
              { skipAccountDeleted: true },
            )}
          </span>
          {scheduled.email === "sent" || scheduled.email === "pending" ? (
            <span className="mt-2 block">
              {scheduled.email === "sent" ? "We emailed" : "We'll email"} {session.account.email}{" "}
              the date and how to keep your account.
            </span>
          ) : null}
        </FormAlert>
      ) : !terms ? null : (
        <div className="flex flex-col gap-5">
          {resumable ? <ResumeMembership view={view} price={price} /> : null}
          <dl className="flex flex-col gap-4 type-body-sm text-fg-muted">
            <div className="flex flex-col gap-1 sm:grid sm:grid-cols-[10rem_1fr] sm:gap-x-6">
              <dt className="type-label text-fg">When you ask</dt>
              <dd>
                Nothing is deleted yet. Your account keeps working for{" "}
                {formatPeriod(terms.deletionCoolingOffSec)}, and you can keep it from this page at
                any time.
              </dd>
            </div>
            <div className="flex flex-col gap-1 sm:grid sm:grid-cols-[10rem_1fr] sm:gap-x-6">
              <dt className="type-label text-fg">
                After {formatPeriod(terms.deletionCoolingOffSec)}
              </dt>
              <dd>
                You're signed out everywhere, and we delete your account and sign-in details, every
                profile with its My List, ratings, viewing history, Continue Watching and the
                recommendations made for it, your devices, your privacy choices and the activity
                Webflix recorded. This can't be undone: signing in with your email address won't
                work any more, and the address can be used for a new account.
              </dd>
            </div>
            <div className="flex flex-col gap-1 sm:grid sm:grid-cols-[10rem_1fr] sm:gap-x-6">
              <dt className="type-label text-fg">What we keep</dt>
              <dd>
                <ul className="flex list-disc flex-col gap-1 ps-4">
                  <li>Your invoices, payments and refunds, which the law requires us to keep.</li>
                  <li>A record that you asked us to delete your account.</li>
                  <li>
                    If a card was used for a free trial, a fingerprint of that card with nothing
                    linking it to you, so it can't start another free trial.
                  </li>
                  <li>
                    The record of what our staff did on your account, showing you as "Erased
                    member", with no email address.
                  </li>
                </ul>
              </dd>
            </div>
            <div className="flex flex-col gap-1 sm:grid sm:grid-cols-[10rem_1fr] sm:gap-x-6">
              <dt className="type-label text-fg">Your membership</dt>
              <dd>
                {ifToday ? `If you delete your account today: ${ifToday}` : null}
                {offerCancelInstead ? (
                  <>
                    {" "}
                    To stop paying without deleting anything,{" "}
                    <Link
                      to="/account/membership/cancel"
                      className="focus-ring rounded-xs text-fg underline"
                    >
                      cancel your membership
                    </Link>{" "}
                    instead.
                  </>
                ) : null}
              </dd>
            </div>
          </dl>
          {demo ? (
            <FormAlert tone="info" title="Not available on the demo account">
              Everyone shares the demo account, so it can't be deleted.
            </FormAlert>
          ) : (
            <p className="type-body-sm text-fg-muted">
              Want a copy of your data first? Ask for it above before you go.
            </p>
          )}
          <div>
            <BusyButton
              variant="outline"
              disabled={demo}
              busy={schedule.isPending}
              onClick={() => setConfirming(true)}
            >
              Delete my account
            </BusyButton>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete your account?"
        description={
          deleteOn
            ? `It will be deleted on ${formatLongDate(deleteOn)}. ${membershipSentences(
                view,
                { ...price, deletion: { scheduledFor: deleteOn } },
                { skipAccountDeleted: true },
              )} Until then it works as usual and you can keep it from Account › Privacy. You'll be asked to confirm it's you.`
            : undefined
        }
        confirmLabel="Delete my account"
        cancelLabel="Keep my account"
        onConfirm={() => {
          // One dialog at a time: close this one before "Confirm it's you" may open.
          setConfirming(false);
          schedule.mutate();
        }}
      />
      {identity.prompt}
    </AccountSection>
  );
}

/**
 * The erasure has started: the account is locked (every session ended, no sign-in), it cannot be
 * kept any more, and the server retries it until it is done. Nothing here can change that, so
 * nothing is offered.
 */
function DeletionUnderway({ request }: { request: PrivacyRequest }) {
  return (
    <FormAlert tone="info" title="We're deleting your account">
      {request.scheduledFor
        ? `It started on ${formatDateTime(request.scheduledFor)} and can't be stopped now. `
        : "It can't be stopped now. "}
      You're signed out everywhere, and you won't be able to sign in again. Once it's done, your
      email address can be used for a new account.
    </FormAlert>
  );
}

/**
 * The account was kept after its deletion stopped the membership's renewals: the membership is
 * still set to end. One clear action resumes it, saying what that means for the next bill, in the
 * Membership page's own words (`endingNotice`, `describeOutcome`).
 */
function ResumeMembership({ view, price }: { view: MembershipView; price: OutcomeContext }) {
  const queryClient = useQueryClient();
  const resume = useResumeMembership({
    onSuccess: (_membership, fresh) => {
      void queryClient.invalidateQueries({ queryKey: privacyRequestsKey() });
      const charge = fresh
        ? describeOutcome(
            membershipOutcome(fresh.view, {
              monthlyPrice: fresh.details.plan?.monthlyPrice ?? null,
            }),
          ).charge
        : null;
      membershipToast("Your membership will continue", charge ?? undefined);
      // The notice that held the button is gone: focus the section's heading.
      focusAfterDialogs(byId(HEADING_ID));
    },
  });
  const refused = isDeletionScheduled(resume.error);
  useEffect(() => {
    // The deletion was scheduled again elsewhere: the page shows that state once it refetches.
    if (refused) void queryClient.invalidateQueries({ queryKey: privacyRequestsKey() });
  }, [refused, queryClient]);
  const notice = endingNotice(view);
  // What resuming would mean: the same membership, renewing again.
  const resumed: MembershipView = {
    ...view,
    membership: { ...view.membership, cancelAtPeriodEnd: false } satisfies MembershipState,
  };
  const next = describeOutcome(membershipOutcome(resumed, price)).charge;
  return (
    <FormAlert
      id={RESUME_ID}
      tone="info"
      title={notice?.title ?? "Your membership is set to end"}
      action={
        <BusyButton
          variant="primary"
          size="sm"
          busy={resume.isPending}
          onClick={() => resume.mutate()}
        >
          Resume membership
        </BusyButton>
      }
    >
      {notice?.body ?? ""} Deleting your account stopped its renewals, and keeping your account
      doesn't restart them.{next ? ` If you resume it: ${next}` : ""}
      {resume.isError ? (
        <span role="alert" className="mt-2 block text-danger">
          {refused
            ? "Your account is scheduled for deletion, so the membership can't be resumed. Keep your account first."
            : describeMemberError(resume.error).description}
        </span>
      ) : null}
    </FormAlert>
  );
}
