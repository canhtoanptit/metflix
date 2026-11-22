/**
 * Account › Privacy, "Download your data": ask for a copy (a fresh "Confirm it's you" first),
 * wait as long as it takes, download it from here or from the email. The wait is a wait, not a
 * spinner the member must watch: the request lives on the server, the page says what is
 * happening and that they can leave, and looks again on its own, less often as time passes.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  type PrivacyRequest,
  type PrivacyRequestList,
  type PrivacyTerms,
} from "@webflix/contracts";
import { Button, CheckCircleIcon, ErrorState, Skeleton, Spinner, toast } from "@webflix/ui";
import { useEffect, useRef } from "react";
import { api } from "../../../../app/api.ts";
import { describeError } from "../../../../app/query/errors.ts";
import { useAuthenticatedSession } from "../../../../app/session/session.ts";
import { IdentityNotConfirmed, useConfirmIdentity } from "../../shared/ConfirmIdentity.tsx";
import { FormAlert } from "../../shared/FormAlert.tsx";
import { formatDateTime, formatLongDate, formatRelativeTime } from "../../shared/format.ts";
import { describeMemberError, useIsDemoAccount } from "../../shared/privileges.ts";
import { AccountSection } from "../AccountLayout.tsx";
import { saveDataExport } from "./download.ts";
import {
  exportStage,
  formatPeriod,
  formatRetention,
  privacyRequestsKey,
  privacyRequestsQuery,
  slowAfterMs,
  typicalWait,
} from "./requests.ts";

const WHAT_IS_INCLUDED =
  "Your account and profiles, My List, ratings and viewing history, signed-in devices, privacy choices, membership and invoices, and the activity Webflix recorded.";

export function ExportSection() {
  const session = useAuthenticatedSession();
  const demo = useIsDemoAccount();
  const queryClient = useQueryClient();
  const requests = useQuery(privacyRequestsQuery());
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
        description: `We'll email ${session.account.email} when it's ready.`,
      });
    },
    onError: (error) => {
      if (error instanceof IdentityNotConfirmed) return;
      // One at a time: another tab or device already asked. Show that one.
      if (ApiError.is(error, "privacy_request_pending")) {
        void queryClient.invalidateQueries({ queryKey: privacyRequestsKey() });
        return;
      }
      toast.error("We couldn't start your download", {
        description: describeMemberError(error).description,
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: privacyRequestsKey() }),
  });

  const stage = requests.data ? exportStage(requests.data.items) : null;
  const terms = requests.data?.terms;
  useAnnounceReady(stage?.stage ?? null);

  const requestButton = (label: string, variant: "primary" | "outline" = "primary") => (
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
            <Button variant="primary" onClick={() => void requests.refetch()}>
              Try again
            </Button>
          }
        />
      ) : stage?.stage === "preparing" && terms ? (
        <Preparing request={stage.request} email={session.account.email} terms={terms} />
      ) : stage?.stage === "ready" ? (
        <div className="flex flex-col gap-4">
          <FormAlert tone="positive" icon={CheckCircleIcon} title="Your data is ready">
            Prepared {formatDateTime(stage.request.completedAt ?? stage.request.requestedAt)}. The
            download works until{" "}
            {formatLongDate(stage.request.expiresAt ?? stage.request.requestedAt)}, here or from the
            email we sent you.
          </FormAlert>
          <div className="flex flex-wrap items-center gap-3">
            <DownloadButton request={stage.request} />
            {requestButton("Ask for a new copy", "outline")}
          </div>
          <p className="type-body-sm text-fg-subtle">
            One file (JSON) that other services and tools can read. Keep it somewhere safe: it holds
            your personal details.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {stage?.stage === "failed" ? (
            <FormAlert title="We couldn't prepare your last copy">
              Nothing was sent. Ask again: it usually works the second time, and if it doesn't,
              contact us.
            </FormAlert>
          ) : stage?.stage === "expired" ? (
            <FormAlert tone="info" title="Your last copy has expired">
              {stage.request.expiresAt
                ? `Its link stopped working on ${formatLongDate(stage.request.expiresAt)}. `
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
              It usually takes {typicalWait(terms)}. We'll email{" "}
              <span className="text-fg">{session.account.email}</span> when it's ready, and the
              download will be here too, for {formatPeriod(terms.exportLinkTtlSec)}. It includes the
              activity recorded in the last {formatRetention(terms.eventsRetentionDays)}. You'll be
              asked to confirm it's you first.
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
  request,
  email,
  terms,
}: {
  request: PrivacyRequest;
  email: string;
  terms: PrivacyTerms;
}) {
  const slow = Date.now() - Date.parse(request.requestedAt) > slowAfterMs(terms);
  return (
    <div
      role="status"
      className="flex items-start gap-4 rounded-lg border border-line bg-surface-2 px-4 py-4"
    >
      <Spinner size="md" label={null} className="mt-0.5" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="type-label text-fg">Preparing your data</p>
        <p className="type-body-sm text-fg-muted">
          You asked {formatRelativeTime(request.requestedAt)}.{" "}
          {slow
            ? "It's taking longer than usual, but it will finish."
            : `It usually takes ${typicalWait(terms)}.`}{" "}
          We'll email <span className="text-fg">{email}</span> when it's ready. You don't need to
          stay on this page.
        </p>
      </div>
    </div>
  );
}

/**
 * The export's signed link: a plain download (the server answers it as an attachment, and the
 * browser streams it). Mock mode has no server behind the link, so it asks the mock API and
 * saves what it answers.
 */
function DownloadButton({ request }: { request: PrivacyRequest & { downloadUrl: string } }) {
  if (__WEBFLIX_MOCK__) {
    return (
      <Button
        variant="primary"
        onClick={() => {
          const token = new URL(request.downloadUrl, window.location.origin).searchParams.get(
            "token",
          );
          void saveDataExport(request.id, token ?? "").catch(() =>
            toast.error("We couldn't download your data", { description: "Please try again." }),
          );
        }}
      >
        Download your data
      </Button>
    );
  }
  return (
    <Button variant="primary" asChild>
      <a href={request.downloadUrl} download>
        Download your data
      </a>
    </Button>
  );
}

/** Says so, once, when a copy being prepared becomes ready while the member is on the page. */
function useAnnounceReady(stage: string | null): void {
  const previous = useRef(stage);
  useEffect(() => {
    if (stage === "ready" && previous.current === "preparing") {
      toast.success("Your data is ready to download");
    }
    previous.current = stage;
  }, [stage]);
}
