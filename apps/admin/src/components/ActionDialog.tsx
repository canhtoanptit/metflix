/**
 * Every change a staff member makes goes through this dialog: what it will do, the form, a
 * required reason (audited under their name), then one of four ends, each designed:
 *
 * - **Done**: what changed, in words, and a way straight to its audit entry (the audit log for an
 *   admin, your actions for anyone else).
 * - **Refused**: the server said no before acting; the form stays, with what to fix. A billing
 *   action gets a new idempotency key for the corrected form (the refused key is spent).
 * - **No answer**: the answer never arrived. Said plainly; a billing action may be checked
 *   again with the same key (it cannot act twice); anything else leads to the audit log.
 * - **Outcome unknown** / **already on record**: the server could not confirm, or an earlier
 *   attempt with this key exists. No second attempt is offered: the audit entry is the way on.
 *
 * While a request is in flight the dialog cannot be dismissed by accident and the button cannot
 * send twice; a slow payment provider is said to be slow. Leaving keeps the attempt
 * (attempts.ts), so reopening the same action shows where it stands.
 */

import { Link } from "@tanstack/react-router";
import { REQUEST_ID_HEADER } from "@webflix/contracts";
import {
  AlertTriangleIcon,
  Button,
  CheckCircleIcon,
  ClockIcon,
  Dialog,
  DialogContent,
  DialogFooter,
  HelpIcon,
  Spinner,
  XCircleIcon,
} from "@webflix/ui";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useStaff } from "../access/staff.tsx";
import { type ClassifiedFailure, classifyFailure, MUTATION_DEADLINE_MS } from "../api/errors.ts";
import { formatDateTime } from "../lib/format.ts";
import {
  closeAttempt,
  openAttempt,
  peekAttempt,
  renewAttempt,
  subscribeAttempts,
  updateAttempt,
} from "./attempts.ts";
import { Identifier } from "./primitives.tsx";
import { ReasonField, reasonError } from "./ReasonField.tsx";

/** `validate`'s answer when the caller shows the problem on the field itself. */
export const SHOWN_IN_FIELD = "\u0000field";

export interface RunContext {
  reason: string;
  /** Billing actions: the form's idempotency key (stable across sends of this form). */
  idempotencyKey: string;
  /** Our deadline, after which the answer counts as never arriving: pass to the call. */
  signal: AbortSignal;
  /** Pass as the call's headers: names this send in the server's logs and audit entry. */
  headers: Record<string, string>;
}

export interface ActionDialogProps<T> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Identifies the action and its target ("refund:<account>:<invoice>") across reopenings. */
  scope: string;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  /** The button that leaves without sending ("Cancel"); "Back" where the action is a cancel. */
  dismissLabel?: string;
  tone?: "danger" | "accent";
  /** Billing actions: the server deduplicates by key, so "check again" is safe. */
  idempotent?: boolean;
  /** More than one change (cancel now, then refund): any failure may be half-way. */
  multiStep?: boolean;
  /** The action's own fields (controlled by the caller). */
  children?: ReactNode;
  /**
   * The caller's validation, before anything is sent: a message for the form to show, or
   * `SHOWN_IN_FIELD` when the caller marks the field itself (the form then points to it).
   */
  validate?: () => string | null;
  run: (context: RunContext) => Promise<T>;
  success: (result: T) => ReactNode;
  onSuccess?: (result: T) => void;
  /** Where its audit entries are (the audit log filter). */
  audit?: { targetType: string; targetId: string };
  /** Shown while the server is slow ("Waiting for the payment provider…"). */
  slowNotice?: string;
  size?: "sm" | "md" | "lg";
}

export function ActionDialog<T>(props: ActionDialogProps<T>) {
  const { open, onOpenChange, scope } = props;
  const change = (next: boolean) => {
    if (!next) {
      const current = peekAttempt(scope);
      // Nothing sent, or settled and now seen: forget it. In flight or unclear: keep it.
      if (current && (current.phase === "editing" || current.phase === "succeeded")) {
        closeAttempt(scope);
      }
    }
    onOpenChange(next);
  };
  return (
    <Dialog open={open} onOpenChange={change}>
      {open ? <ActionDialogBody {...props} onOpenChange={change} /> : null}
    </Dialog>
  );
}

function useAttempt(scope: string) {
  // Created when the form opens: that is when the idempotency key is minted.
  useState(() => openAttempt(scope));
  const subscribe = useCallback((listener: () => void) => subscribeAttempts(listener), []);
  return useSyncExternalStore(subscribe, () => peekAttempt(scope) ?? openAttempt(scope));
}

function ActionDialogBody<T>({
  onOpenChange,
  scope,
  title,
  description,
  confirmLabel,
  dismissLabel = "Cancel",
  tone = "accent",
  idempotent = false,
  multiStep = false,
  children,
  validate,
  run,
  success,
  onSuccess,
  audit,
  slowNotice,
  size = "md",
}: ActionDialogProps<T>) {
  const staff = useStaff();
  const attempt = useAttempt(scope);
  const [refusal, setRefusal] = useState<ClassifiedFailure | null>(null);
  const [reason, setReason] = useState("");
  const [reasonTouched, setReasonTouched] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [ownSend, setOwnSend] = useState(false);
  const mounted = useRef(true);
  const outcomeHeading = useRef<HTMLHeadingElement>(null);
  // Opened from state (no Radix trigger), the dialog would leave focus on the page body when it
  // closes: return it to whatever opened it.
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const phase = attempt.phase;
  // Move focus to an outcome so it is announced and the next key press acts on it.
  useEffect(() => {
    if (phase === "succeeded" || phase === "unresolved") outcomeHeading.current?.focus();
  }, [phase]);

  const sending = phase === "sending";
  const reasonMessage = reasonTouched ? reasonError(reason) : null;

  async function send(): Promise<void> {
    // One send at a time per action and target, across every open copy of this dialog.
    if (peekAttempt(scope)?.phase === "sending") return;
    setReasonTouched(true);
    const reasonProblem = reasonError(reason);
    const invalid = validate?.() ?? null;
    if (reasonProblem || invalid) {
      setFormError(
        invalid && invalid !== SHOWN_IN_FIELD
          ? invalid
          : reasonProblem && !invalid
            ? null
            : "Fix what's marked above, then send it again.",
      );
      return;
    }
    setFormError(null);
    setRefusal(null);
    const requestId = crypto.randomUUID();
    const before = peekAttempt(scope);
    const current = updateAttempt(scope, {
      phase: "sending",
      requestId,
      // A billing action's key is kept through its sends, and only its first send writes an
      // entry. Any other action writes an entry per send: its own send is the one to follow.
      firstRequestId: idempotent ? (before?.firstRequestId ?? requestId) : requestId,
      failure: null,
      startedAt: Date.now(),
    });
    setOwnSend(true);
    setSlow(false);
    const slowTimer = setTimeout(() => mounted.current && setSlow(true), 3_000);
    try {
      const result = await run({
        reason: reason.trim(),
        idempotencyKey: current.idempotencyKey,
        signal: AbortSignal.timeout(MUTATION_DEADLINE_MS),
        headers: { [REQUEST_ID_HEADER]: requestId },
      });
      onSuccess?.(result);
      updateAttempt(scope, { phase: "succeeded", result });
    } catch (error) {
      const classified = classifyFailure(error, { multiStep });
      const failure = { ...classified, reference: classified.reference ?? requestId };
      if (
        failure.kind === "refused" ||
        failure.kind === "session" ||
        failure.kind === "forbidden"
      ) {
        // Nothing changed. The refused key is spent on the server: the corrected form is a new
        // intention with a new key.
        if (idempotent) renewAttempt(scope);
        else updateAttempt(scope, { phase: "editing" });
        if (mounted.current) setRefusal(failure);
      } else {
        updateAttempt(scope, { phase: "unresolved", failure });
      }
    } finally {
      clearTimeout(slowTimer);
      if (mounted.current) setOwnSend(false);
    }
  }

  function startOver(): void {
    renewAttempt(scope);
    setRefusal(null);
    setReason("");
    setReasonTouched(false);
  }

  function close(): void {
    onOpenChange(false);
  }

  const failure = phase === "unresolved" ? attempt.failure : null;
  // The entry to follow: this key's first send wrote it (a later send of the same key writes
  // none). A conflict is with an attempt this tab may not have sent: find it by target instead.
  const entryRequest =
    failure && failure.kind !== "conflict" ? (attempt.firstRequestId ?? failure.reference) : null;
  const admin = staff.has("admin");
  const auditLink = !failure
    ? null
    : admin
      ? entryRequest
        ? {
            to: "/operations/audit" as const,
            search: { requestId: entryRequest },
            label: "Open its audit entry",
          }
        : audit
          ? {
              to: "/operations/audit" as const,
              search: { targetType: audit.targetType, targetId: audit.targetId },
              label: "Open the audit log",
            }
          : null
      : {
          to: "/activity" as const,
          search: entryRequest ? { requestId: entryRequest } : {},
          label: entryRequest ? "Open it in your actions" : "Open your actions",
        };

  // A success's entry carries the request id of the send that wrote it: the only send, when
  // there was one. After "check again" the first send may or may not have reached the server,
  // so the link lists the target's entries (newest first) instead of guessing.
  const singleSend = attempt.requestId !== null && attempt.requestId === attempt.firstRequestId;
  const doneLink =
    phase !== "succeeded"
      ? null
      : admin
        ? {
            to: "/operations/audit" as const,
            search:
              singleSend && attempt.firstRequestId
                ? { requestId: attempt.firstRequestId }
                : audit
                  ? { targetType: audit.targetType, targetId: audit.targetId }
                  : {},
            label: "See it in the audit log",
          }
        : {
            to: "/activity" as const,
            search:
              singleSend && attempt.firstRequestId ? { requestId: attempt.firstRequestId } : {},
            label: "See it in your actions",
          };

  return (
    <DialogContent
      title={title}
      description={phase === "editing" || (sending && ownSend) ? description : undefined}
      size={size}
      showClose={phase === "editing"}
      onOpenAutoFocus={(event) => {
        if (phase === "succeeded" || phase === "unresolved") event.preventDefault();
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        // The control that opened it may be gone (a PIN removed): the page's main area then.
        if (opener?.isConnected) opener.focus();
        else document.getElementById("main")?.focus({ preventScroll: true });
      }}
      onEscapeKeyDown={(event) => {
        if (sending && ownSend) event.preventDefault();
      }}
      onInteractOutside={(event) => {
        if (sending && ownSend) event.preventDefault();
      }}
    >
      {phase === "succeeded" ? (
        <Outcome
          headingRef={outcomeHeading}
          icon={<CheckCircleIcon size="lg" className="text-positive" />}
          title="Done"
        >
          <div className="type-body-sm text-fg">{success(attempt.result as T)}</div>
          <DialogFooter>
            {doneLink ? (
              <Button asChild variant="outline" size="sm">
                {/* Closing first forgets the settled attempt, as Close does. */}
                <Link to={doneLink.to} search={doneLink.search} onClick={close}>
                  {doneLink.label}
                </Link>
              </Button>
            ) : null}
            <Button variant="accent" size="sm" onClick={close}>
              Close
            </Button>
          </DialogFooter>
        </Outcome>
      ) : failure ? (
        <Outcome
          headingRef={outcomeHeading}
          icon={
            failure.kind === "conflict" ? (
              <ClockIcon size="lg" className="text-warning" />
            ) : (
              <HelpIcon size="lg" className="text-warning" />
            )
          }
          title={failure.title}
        >
          <p className="type-body-sm text-fg">{failure.description}</p>
          <p className="type-body-sm text-fg-muted">
            {idempotent && failure.kind === "no-answer"
              ? "Checking again sends the same request with the same key: if the first one got through, the server answers with its result instead of doing it twice."
              : "Don't do it again until you know. Look at the member first, then the audit entry: it records whether this happened."}
          </p>
          <References failure={failure} request={entryRequest ?? failure.reference} />
          <DialogFooter>
            {auditLink ? (
              <Button asChild variant="outline" size="sm">
                <Link to={auditLink.to} search={auditLink.search}>
                  {auditLink.label}
                </Link>
              </Button>
            ) : null}
            {idempotent && failure.kind === "no-answer" ? (
              <Button variant="accent" size="sm" onClick={() => void send()}>
                Check again
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={close}>
                Close
              </Button>
            )}
          </DialogFooter>
          {/* Deliberately quiet: starting again is the one risky way on from here. */}
          <p className="type-caption text-fg-subtle">
            Checked the member and the audit log, and it didn't happen?{" "}
            <button
              type="button"
              onClick={startOver}
              className="focus-ring rounded-xs text-fg-muted underline underline-offset-2 hover:text-fg"
            >
              Start a new attempt
            </button>
          </p>
        </Outcome>
      ) : sending && !ownSend ? (
        <Outcome
          headingRef={outcomeHeading}
          icon={<Spinner size="md" label={null} />}
          title="Still waiting for an answer"
        >
          <p className="type-body-sm text-fg">
            An attempt sent{" "}
            {attempt.startedAt
              ? `at ${formatDateTime(new Date(attempt.startedAt).toISOString(), { seconds: true })}`
              : "earlier"}{" "}
            hasn't been answered yet. This shows its result when it arrives.
          </p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={close}>
              Close
            </Button>
          </DialogFooter>
        </Outcome>
      ) : (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {refusal ? (
            <div
              role="alert"
              className="flex gap-2 rounded-md border border-danger/40 bg-danger-subtle p-3"
            >
              <XCircleIcon size="sm" className="mt-0.5 shrink-0 text-danger" />
              <div className="flex flex-col gap-0.5">
                <p className="type-label text-fg">{refusal.title}</p>
                <p className="type-body-sm text-fg-muted">
                  {refusal.description} Nothing was changed.
                </p>
              </div>
            </div>
          ) : null}
          <fieldset disabled={sending} className="flex min-w-0 flex-col gap-4">
            {children}
            <ReasonField
              value={reason}
              onChange={(next) => {
                setReason(next);
                if (formError) setFormError(null);
              }}
              error={reasonMessage}
            />
          </fieldset>
          {formError ? (
            <p role="alert" className="flex items-start gap-1.5 type-body-sm text-danger">
              <AlertTriangleIcon size="sm" className="mt-0.5 shrink-0" />
              {formError}
            </p>
          ) : null}
          <p aria-live="polite" className="type-body-sm text-fg-muted empty:hidden">
            {sending
              ? slow
                ? (slowNotice ?? "Still working. This can take up to a minute: keep this open.")
                : "Sending…"
              : ""}
          </p>
          <DialogFooter className="mt-2">
            <Button variant="outline" size="sm" disabled={sending} onClick={close}>
              {dismissLabel}
            </Button>
            <Button
              type="submit"
              variant={tone === "danger" ? "danger" : "accent"}
              size="sm"
              loading={sending}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      )}
    </DialogContent>
  );
}

function References({ failure, request }: { failure: ClassifiedFailure; request: string | null }) {
  if (!request && !failure.auditEntryId) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-surface-3 p-3">
      {request ? (
        <div className="flex flex-wrap items-center gap-x-2 type-caption text-fg-muted">
          Request <Identifier value={request} label="request ID" />
        </div>
      ) : null}
      {failure.auditEntryId ? (
        <div className="flex flex-wrap items-center gap-x-2 type-caption text-fg-muted">
          Audit entry <Identifier value={failure.auditEntryId} label="audit entry ID" />
        </div>
      ) : null}
    </div>
  );
}

function Outcome({
  icon,
  title,
  children,
  headingRef,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <div className="flex items-center gap-2">
        {icon}
        <h3 ref={headingRef} tabIndex={-1} className="type-title outline-none">
          {title}
        </h3>
      </div>
      {children}
    </div>
  );
}
