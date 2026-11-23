/**
 * Account › Privacy, "Download your data": ask for a copy (a fresh "Confirm it's you" first),
 * wait as long as it takes, download it from here or from the email. The wait is a wait, not a
 * spinner the member must watch: the request lives on the server, the page says what is
 * happening and that they can leave, and looks again on its own, less often as time passes.
 *
 * Every sentence is the server's fact: the typical wait and how long a copy stays are the
 * deployment's terms; an email is promised only when one is on its way (`email`); an export that
 * is not ready a day after it was asked for is given up (`failed`), and the member can ask again.
 * The download sends its token in the request's body, after a fresh proof (privacy review L2, L3).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  type PrivacyRequest,
  type PrivacyRequestList,
  type PrivacyTerms,
} from "@webflix/contracts";
import {
  Button,
  CheckCircleIcon,
  EmailText,
  ErrorState,
  Skeleton,
  Spinner,
  toast,
} from "@webflix/ui";
import { useEffect, useRef, useState } from "react";
import { api } from "../../../../app/api.ts";
import { describeError } from "../../../../app/query/errors.ts";
import { useAuthenticatedSession } from "../../../../app/session/session.ts";
import { IdentityNotConfirmed, useConfirmIdentity } from "../../shared/ConfirmIdentity.tsx";
import { FormAlert } from "../../shared/FormAlert.tsx";
import { formatLongDate, formatRelativeTime } from "../../shared/format.ts";
import { describeMemberError, useIsDemoAccount } from "../../shared/privileges.ts";
import { AccountSection } from "../AccountLayout.tsx";
import { saveDataExport, tokenOf } from "./download.ts";
import { focusAfterDialogs } from "./focus.ts";
import {
  exportEmailLine,
  exportEmailNote,
  exportStage,
  formatPeriod,
  formatRetention,
  privacyRequestsKey,
  privacyRequestsQuery,
  slowAfterMs,
  typicalWait,
} from "./requests.ts";

/** One toast at a time about the copy of your data (docs/DESIGN_SYSTEM.md "Toasts"). */
const EXPORT_TOAST_ID = "data-export";

const WHAT_IS_INCLUDED =
  "Your account and profiles, My List, ratings and viewing history, signed-in devices, privacy choices, membership and invoices, the recommendation lists made for your profiles, when our staff looked at your account, and the activity Webflix recorded.";

export function ExportSection() {
  const session = useAuthenticatedSession();
  const demo = useIsDemoAccount();
  const queryClient = useQueryClient();
  const requests = useQuery(privacyRequestsQuery());
  const statusRef = useRef<HTMLDivElement>(null);
  const [focusStatus, setFocusStatus] = useState(false);
  const identity = useConfirmIdentity({
    id: "export-data",
    purpose: "download your data",
    // Back from confirming at a provider: asking for a copy changes nothing, so just ask.
    onResume: () => request.mutate(),
  });

  const request = useMutation({
    mutationFn: () => identity.run(() => api().requestDataExport()),
    meta: { silent: true },
    onSuccess: (created) => {
      queryClient.setQueryData<PrivacyRequestList>(privacyRequestsKey(), (current) =>
        current
          ? {
              ...current,
              items: [created, ...current.items.filter((item) => item.id !== created.id)],
            }
          : current,
      );
      toast.success("We're preparing your data", {
        id: EXPORT_TOAST_ID,
        description: exportEmailLine(created, session.account.email) ?? undefined,
      });
      // The button is gone: focus moves to what is happening now (UX review 2.7).
      setFocusStatus(true);
    },
    onError: (error) => {
      if (error instanceof IdentityNotConfirmed) return;
      // One at a time: another tab or device already asked. Show that one.
      if (ApiError.is(error, "privacy_request_pending")) {
        void queryClient.invalidateQueries({ queryKey: privacyRequestsKey() });
        return;
      }
      toast.error("We couldn't start your download", {
        id: EXPORT_TOAST_ID,
        description: describeMemberError(error).description,
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: privacyRequestsKey() }),
  });

  const stage = requests.data ? exportStage(requests.data.items) : null;
  const terms = requests.data?.terms;
  useAnnounceReady(stage?.stage ?? null);
  useEffect(() => {
    if (!focusStatus) return;
    setFocusStatus(false);
    focusAfterDialogs(() => statusRef.current);
  });

  const requestButton = (label: string, variant: "accent" | "outline" = "accent") => (
    <Button
      variant={variant}
      loading={request.isPending}
      disabled={demo}
      onClick={() => request.mutate()}
    >
      {label}
    </Button>
  );

  return (
    <AccountSection title="Download your data" description={WHAT_IS_INCLUDED}>
      {requests.isPending ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-4 w-full max-w-md" />
          <Skeleton className="h-10 w-40" radius="md" />
        </div>
      ) : requests.isError ? (
        <ErrorState
          layout="inline"
          title="We couldn't check your downloads"
          description={describeError(requests.error).description}
          action={
            <Button variant="accent" onClick={() => void requests.refetch()}>
              Try again
            </Button>
          }
        />
      ) : stage?.stage === "preparing" && terms ? (
        <Preparing
          ref={statusRef}
          request={stage.request}
          email={session.account.email}
          terms={terms}
        />
      ) : stage?.stage === "ready" ? (
        <div className="flex flex-col gap-4">
          <FormAlert
            ref={statusRef}
            tone="positive"
            icon={CheckCircleIcon}
            title="Your data is ready"
          >
            Prepared on {formatLongDate(stage.request.completedAt ?? stage.request.requestedAt)}.
            You can download it here
            {stage.request.email === "sent" ? " or from the email we sent you" : ""} until{" "}
            {formatLongDate(stage.request.expiresAt ?? stage.request.requestedAt)}.
            {stage.request.email === "suppressed" ? (
              <>
                {" "}
                We couldn't email <EmailText>{session.account.email}</EmailText>: earlier emails to
                it didn't arrive.
              </>
            ) : null}
          </FormAlert>
          <div className="flex flex-wrap items-center gap-3">
            <DownloadButton request={stage.request} />
            {requestButton("Ask for a new copy", "outline")}
          </div>
          <p className="type-body-sm text-fg-subtle">
            One file (JSON) that other services and tools can read. Keep it somewhere safe: it holds
            your personal details. You'll be asked to confirm it's you before it downloads.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {stage?.stage === "failed" ? (
            <FormAlert title="We couldn't prepare your last copy">
              Nothing was sent. You can ask again.
            </FormAlert>
          ) : stage?.stage === "expired" ? (
            <FormAlert tone="info" title="Your last copy has expired">
              {stage.request.expiresAt
                ? `You could download it until ${formatLongDate(stage.request.expiresAt)}. `
                : ""}
              Ask for a new one whenever you like.
            </FormAlert>
          ) : null}
          {demo ? (
            <FormAlert tone="info" title="Not available on the demo account">
              Everyone shares the demo account, so its data can't be downloaded.
            </FormAlert>
          ) : terms ? (
            <p className="type-body-sm text-fg-muted">
              It usually takes {typicalWait(terms)}
              {terms.exportMode === "batch"
                ? "; if it isn't ready a day after you ask, it stops and you can ask again"
                : ""}
              . When it's ready, the download will be here for{" "}
              {formatPeriod(terms.exportLinkTtlSec)}, and we'll also email{" "}
              <EmailText>{session.account.email}</EmailText> (unless earlier emails to it didn't
              arrive). It includes the activity Webflix still holds, at most{" "}
              {formatRetention(terms.eventsRetentionDays)}. You'll be asked to confirm it's you
              first.
            </p>
          ) : null}
          <div>{requestButton(stage?.stage === "none" ? "Ask for my data" : "Ask again")}</div>
        </div>
      )}
      {identity.prompt}
    </AccountSection>
  );
}

function Preparing({
  ref,
  request,
  email,
  terms,
}: {
  ref: React.Ref<HTMLDivElement>;
  request: PrivacyRequest;
  email: string;
  terms: PrivacyTerms;
}) {
  const slow = Date.now() - Date.parse(request.requestedAt) > slowAfterMs(terms);
  const emailLine = exportEmailNote(request, email);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="status"
      className="flex items-start gap-4 rounded-lg border border-line bg-surface-2 px-4 py-4 outline-none focus-visible:ring-2 focus-visible:ring-fg"
    >
      <Spinner size="md" label={null} className="mt-0.5" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="type-label text-fg">Preparing your data</p>
        <p className="type-body-sm text-fg-muted">
          You asked {formatRelativeTime(request.requestedAt)}.{" "}
          {slow
            ? "It's taking longer than usual. If it isn't ready a day after you asked, it stops and you can ask again."
            : `It usually takes ${typicalWait(terms)}.`}{" "}
          {emailLine ? <>{emailLine} </> : null}You don't need to stay on this page.
        </p>
      </div>
    </div>
  );
}

/**
 * The finished export, downloaded through `POST /privacy/exports/:id/download` (the token in the
 * body) once the member has confirmed it's them; saved from what the server answers.
 */
function DownloadButton({ request }: { request: PrivacyRequest & { downloadUrl: string } }) {
  const identity = useConfirmIdentity({
    id: "export-download",
    purpose: "download your data",
    // Back from confirming at a provider: the member asked for the file, so fetch it.
    onResume: () => download.mutate(),
  });
  const download = useMutation({
    mutationFn: () =>
      identity.run(() => saveDataExport(request.id, tokenOf(request.downloadUrl) ?? "")),
    meta: { silent: true },
    onSuccess: () => toast.success("Your download has started", { id: EXPORT_TOAST_ID }),
    onError: (error) => {
      if (error instanceof IdentityNotConfirmed) return;
      toast.error("We couldn't download your data", {
        id: EXPORT_TOAST_ID,
        description: describeMemberError(error).description,
      });
    },
  });
  return (
    <>
      <Button variant="accent" loading={download.isPending} onClick={() => download.mutate()}>
        Download your data
      </Button>
      {identity.prompt}
    </>
  );
}

/** Says so, once, when a copy being prepared becomes ready while the member is on the page. */
function useAnnounceReady(stage: string | null): void {
  const previous = useRef(stage);
  useEffect(() => {
    if (stage === "ready" && previous.current === "preparing") {
      toast.success("Your data is ready to download", { id: EXPORT_TOAST_ID });
    }
    previous.current = stage;
  }, [stage]);
}
