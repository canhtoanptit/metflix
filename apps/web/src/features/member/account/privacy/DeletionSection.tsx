/**
 * Account › Privacy, "Delete your account". Everything the member needs to decide is on the page
 * before the button: when it happens, what goes, what the law makes Webflix keep, what happens
 * to the membership (its renewals stop, so nothing is charged during the cooling-off period),
 * all in this deployment's terms. Asking schedules the deletion after the cooling-off period (a
 * confirmation, then "Confirm it's you"); until then the account works as usual and keeping it
 * is one button, with no proof asked: the way back is always easier than the way out. A kept
 * account's membership stays set to end, and the section offers to resume it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ApiError, type PrivacyRequest, type PrivacyRequestList } from "@webflix/contracts";
import { Button, ConfirmDialog, ErrorState, Skeleton, toast } from "@webflix/ui";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../../../app/api.ts";
import { describeError } from "../../../../app/query/errors.ts";
import { qk } from "../../../../app/query/keys.ts";
import { useAuthenticatedSession, useMembership } from "../../../../app/session/session.ts";
import { IdentityNotConfirmed, useConfirmIdentity } from "../../shared/ConfirmIdentity.tsx";
import { FormAlert } from "../../shared/FormAlert.tsx";
import { formatDateTime, formatLongDate, formatMoney } from "../../shared/format.ts";
import { describeMemberError, useIsDemoAccount } from "../../shared/privileges.ts";
import { AccountSection } from "../AccountLayout.tsx";
import { useResumeMembership } from "../membership.ts";
import {
  isDeletionScheduledRefusal,
  membershipBeforeDeletion,
  membershipWhileScheduled,
  periodEnd,
} from "./deletionMembership.ts";
import {
  formatPeriod,
  privacyRequestsKey,
  privacyRequestsQuery,
  resumableAfterDeletion,
  scheduledDeletion,
} from "./requests.ts";

/**
 * Set when a deletion was just scheduled: the page moves this section to the top (a new
 * instance), whose scheduled notice then takes focus so a screen reader hears what happened.
 */
let focusScheduledNotice = false;

export function DeletionSection() {
  const demo = useIsDemoAccount();
  const queryClient = useQueryClient();
  const { membership } = useMembership();
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
      focusScheduledNotice = true;
      store((items) => [created, ...items.filter((item) => item.id !== created.id)]);
      toast.success("Your account deletion is scheduled", {
        description: created.scheduledFor
          ? `It happens on ${formatLongDate(created.scheduledFor)}. You can keep your account until then.`
          : undefined,
      });
      // Its renewals stopped: the session's membership changed too.
      void queryClient.invalidateQueries({ queryKey: qk.session() });
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
    onSuccess: () => {
      const ending = scheduled?.membership?.status === "ending";
      store((items) =>
        items.map((item) =>
          item.kind === "deletion" && item.status === "scheduled"
            ? { ...item, status: "canceled" as const }
            : item,
        ),
      );
      toast.success("Your account is staying", {
        description: ending
          ? "Nothing will be deleted. Your membership is still set to end: you can resume it here."
          : "Nothing will be deleted.",
      });
    },
    onError: (error) => {
      // Already cancelled (another tab): the list shows the truth once refetched.
      if (ApiError.is(error, "not_found")) return;
      toast.error("We couldn't cancel the deletion", {
        description: describeMemberError(error).description,
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: privacyRequestsKey() }),
  });

  const terms = requests.data?.terms;
  const scheduled = requests.data ? scheduledDeletion(requests.data.items) : undefined;
  const resumable = requests.data ? resumableAfterDeletion(requests.data.items) : undefined;
  const scheduledRef = useCallback((element: HTMLDivElement | null) => {
    if (element && focusScheduledNotice) {
      focusScheduledNotice = false;
      element.focus();
    }
  }, []);
  const deleteOn = terms
    ? new Date(Date.now() + terms.deletionCoolingOffSec * 1000).toISOString()
    : null;
  const membershipLine = deleteOn ? membershipBeforeDeletion(membership, deleteOn) : null;
  // Only a membership that still renews can be stopped without deleting anything.
  const offerCancelInstead =
    ["trialing", "active", "past_due"].includes(membership.status) && !membership.cancelAtPeriodEnd;

  return (
    <AccountSection
      title="Delete your account"
      description="Permanently delete your Webflix account and everything in it."
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
      ) : scheduled ? (
        <FormAlert
          ref={scheduledRef}
          title={`Your account will be deleted on ${formatLongDate(scheduled.scheduledFor)}`}
          action={
            <Button variant="primary" loading={keep.isPending} onClick={() => keep.mutate()}>
              Keep my account
            </Button>
          }
        >
          You asked on {formatDateTime(scheduled.requestedAt)}. Until{" "}
          {formatDateTime(scheduled.scheduledFor)} everything works as usual and you can change your
          mind here. After that, it can't be undone.
          {membershipWhileScheduled(scheduled.membership) ? (
            <span className="mt-2 block">{membershipWhileScheduled(scheduled.membership)}</span>
          ) : null}
        </FormAlert>
      ) : !terms ? null : (
        <div className="flex flex-col gap-5">
          {resumable ? <ResumeMembership endsAt={resumable.membership.endsAt} /> : null}
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
                We delete your account and sign-in details, every profile with its My List, ratings,
                viewing history and Continue Watching, your devices, your privacy choices and the
                activity Webflix recorded. This can't be undone.
              </dd>
            </div>
            <div className="flex flex-col gap-1 sm:grid sm:grid-cols-[10rem_1fr] sm:gap-x-6">
              <dt className="type-label text-fg">What we keep</dt>
              <dd>
                Only what the law requires: your invoices, payments and refunds, and a record that
                you asked us to delete your account.
              </dd>
            </div>
            <div className="flex flex-col gap-1 sm:grid sm:grid-cols-[10rem_1fr] sm:gap-x-6">
              <dt className="type-label text-fg">Your membership</dt>
              <dd>
                {membershipLine}
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
            <Button
              variant="outline"
              disabled={demo}
              loading={schedule.isPending}
              onClick={() => setConfirming(true)}
            >
              Delete my account
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete your account?"
        description={
          deleteOn
            ? `It will be deleted on ${formatLongDate(deleteOn)}. ${membershipLine ?? ""} Until then it works as usual and you can keep it from Account › Privacy. You'll be asked to confirm it's you.`
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
 * The account was kept after its deletion stopped the membership's renewals: the membership is
 * still set to end. One clear action resumes it, saying what that means for the next bill.
 */
function ResumeMembership({ endsAt }: { endsAt: string | null }) {
  const session = useAuthenticatedSession();
  const { membership } = useMembership();
  const queryClient = useQueryClient();
  const resume = useResumeMembership({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: privacyRequestsKey() });
      toast.success("Your membership will continue", {
        description: "It renews as before. Nothing else changes.",
      });
    },
  });
  const refused = isDeletionScheduledRefusal(resume.error);
  useEffect(() => {
    // The deletion was scheduled again elsewhere: the page shows that state once it refetches.
    if (refused) void queryClient.invalidateQueries({ queryKey: privacyRequestsKey() });
  }, [refused, queryClient]);
  const renewsOn = periodEnd(membership) ?? endsAt;
  const ends = endsAt ?? renewsOn;
  return (
    <FormAlert
      tone="info"
      title={
        ends ? `Your membership ends on ${formatLongDate(ends)}` : "Your membership is set to end"
      }
      action={
        <Button
          variant="primary"
          size="sm"
          loading={resume.isPending}
          onClick={() => resume.mutate()}
        >
          Resume membership
        </Button>
      }
    >
      Deleting your account stopped its renewals, and keeping your account doesn't restart them.
      {renewsOn && session.plan
        ? ` Resume it to keep watching: it renews on ${formatLongDate(renewsOn)} at ${formatMoney(session.plan.monthlyPrice)} a month, as before.`
        : " Resume it to keep watching: it renews as before."}
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
