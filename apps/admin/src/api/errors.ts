/**
 * What a failed staff call means, in plain words, and what may be done next.
 *
 * Reads (GET) are safe to repeat. Changes are not, and an error does not always say whether the
 * change happened: the staff API writes an audit entry before it acts and settles it after, so
 * the audit log is the authority. `classifyFailure` sorts a mutation's failure into:
 * - `refused`: the server said no before acting (a 4xx): nothing changed; fix and try again.
 * - `no-answer`: the answer never arrived (network, our own deadline): the request may or may
 *   not have reached the server. A billing action sent again with the same idempotency key
 *   cannot act twice, so that one may be checked again; anything else leads to the audit log.
 * - `unknown`: the server answered that it could not finish (5xx: a provider that timed out, a
 *   change refused half-way): the change may have happened. Never invite a second attempt; lead
 *   to the audit entry.
 * - `conflict`: an earlier attempt with this form's idempotency key is still running, failed or
 *   ended unknown (`staff_action_conflict`); `auditId` names its audit entry.
 * - `session` / `forbidden`: signed out meanwhile, or the role is gone.
 */
import { ApiError } from "@webflix/contracts";

export interface ErrorDescription {
  title: string;
  description: string;
  /** Worth offering "Try again" (reads). */
  retryable: boolean;
  /** The request id the server stamped on its answer (the audit entry carries it too). */
  reference: string | null;
}

export function requestIdOf(error: unknown): string | null {
  if (!ApiError.is(error)) return null;
  const problem = error.problem as { requestId?: unknown };
  return typeof problem.requestId === "string" ? problem.requestId : null;
}

/** The API could not be reached: no network, or the proxy answered for it (502/503/504). */
export function isUnreachable(error: unknown): boolean {
  if (!ApiError.is(error)) return false;
  return (
    error.code === "network_error" ||
    (error.code === "unexpected_response" && [502, 503, 504].includes(error.status))
  );
}

export function isRetryable(error: unknown): boolean {
  if (!ApiError.is(error)) return false;
  return (
    isUnreachable(error) ||
    error.code === "service_unavailable" ||
    error.code === "internal_error" ||
    (error.code === "unexpected_response" && error.status >= 500)
  );
}

export function describeError(error: unknown): ErrorDescription {
  const reference = requestIdOf(error);
  if (!ApiError.is(error)) {
    return {
      title: "Something went wrong",
      description:
        "The console hit an unexpected error. Reload the page; if it keeps happening, report it with the time it happened.",
      retryable: true,
      reference,
    };
  }
  if (isUnreachable(error)) {
    return {
      title: "Can't reach the staff API",
      description:
        "The console can't reach the service right now. Check your connection; if it's fine, the service may be down.",
      retryable: true,
      reference,
    };
  }
  switch (error.code) {
    case "unauthenticated":
      return {
        title: "Your session ended",
        description: "Sign in again to continue.",
        retryable: false,
        reference,
      };
    case "staff_role_required":
      return {
        title: "Your role doesn't allow this",
        description: `This needs the ${ApiError.is(error, "staff_role_required") ? error.problem.requiredRole : "right"} role. Ask an admin if you need it.`,
        retryable: false,
        reference,
      };
    case "not_found":
      return {
        title: "Not found",
        description: error.problem.detail ?? "It may have been removed, or the link is wrong.",
        retryable: false,
        reference,
      };
    case "validation_failed": {
      const issues = ApiError.is(error, "validation_failed") ? error.problem.issues : [];
      return {
        title: "Some details aren't valid",
        description:
          issues
            .map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
            .join("; ") || "Check the form and try again.",
        retryable: false,
        reference,
      };
    }
    case "rate_limited": {
      const seconds = ApiError.is(error, "rate_limited") ? error.problem.retryAfterSec : 30;
      return {
        title: "Too many requests",
        description: `Wait ${seconds} seconds, then try again.`,
        retryable: true,
        reference,
      };
    }
    case "service_unavailable":
      return {
        title: "The service is busy or a dependency didn't answer",
        description: error.problem.detail ?? "Try again in a moment.",
        retryable: true,
        reference,
      };
    case "checkout_state_conflict":
      return {
        title: "Not possible in the membership's current state",
        description: error.problem.detail ?? "The payment provider refused it as things stand.",
        retryable: false,
        reference,
      };
    case "subscription_required":
      return {
        title: "There's no running membership",
        description: "This needs a membership that is in a trial, active or past due.",
        retryable: false,
        reference,
      };
    case "demo_account_protected":
      return {
        title: "The demo account can't be changed",
        description: "It is shared by everyone who tries Webflix.",
        retryable: false,
        reference,
      };
    case "experiment_conflict":
      return {
        title: "That conflicts with the experiment",
        description: error.problem.detail ?? "Reload it: it may have changed meanwhile.",
        retryable: false,
        reference,
      };
    case "recommendation_import_too_large":
      return {
        title: "This run is too large to import here",
        description: error.problem.detail ?? "Use the importer that runs outside this runtime.",
        retryable: false,
        reference,
      };
    case "internal_error":
    case "unexpected_response":
      return {
        title: "Something went wrong on the server",
        description:
          "Try again in a moment. If it keeps happening, report it with the reference below.",
        retryable: true,
        reference,
      };
    default:
      return {
        title: error.problem.title,
        description: error.problem.detail ?? error.message,
        retryable: false,
        reference,
      };
  }
}

export type FailureKind =
  | "refused"
  | "no-answer"
  | "unknown"
  | "conflict"
  | "session"
  | "forbidden";

export interface ClassifiedFailure {
  kind: FailureKind;
  title: string;
  description: string;
  reference: string | null;
  /** The audit entry the server named (`staff_action_conflict`), when it named one. */
  auditEntryId: string | null;
}

/** Our own deadline for a change; past it the answer counts as never arriving. */
export const MUTATION_DEADLINE_MS = 60_000;

function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/**
 * Sort a failed change. `multiStep`: the action makes more than one change (cancel now, then
 * refund the unused time), so even a refusal may come after the first one happened.
 */
export function classifyFailure(
  error: unknown,
  options: { multiStep?: boolean } = {},
): ClassifiedFailure {
  const reference = requestIdOf(error);
  const base = { reference, auditEntryId: null };
  if (isAbort(error) || (ApiError.is(error) && error.code === "network_error")) {
    return {
      ...base,
      kind: "no-answer",
      title: "No answer from the server",
      description:
        "The request was sent but no answer came back, so it may or may not have been done.",
    };
  }
  if (!ApiError.is(error)) {
    return {
      ...base,
      kind: "unknown",
      title: "Outcome unknown",
      description: "The console hit an unexpected error while sending this. It may have been done.",
    };
  }
  if (error.code === "unauthenticated") {
    return {
      ...base,
      kind: "session",
      title: "Your session ended",
      description: "Nothing was sent. Sign in again, then try again.",
    };
  }
  if (error.code === "staff_role_required") {
    return { ...base, kind: "forbidden", ...pick(describeError(error)) };
  }
  if (ApiError.is(error, "staff_action_conflict")) {
    return {
      reference,
      auditEntryId: error.problem.auditId ?? null,
      kind: "conflict",
      title: "An earlier attempt is on record",
      description:
        error.problem.detail ??
        "An earlier attempt with this form is still running, failed, or ended without a clear result. Check its audit entry before doing anything else.",
    };
  }
  if (error.status >= 500 || error.code === "unexpected_response") {
    // One sentence of the console's own for every change that ended in a 5xx. The staff API's
    // billing actions now say the same in their detail (naming the entry by id, in prose); other
    // routes' 503s still say "try again", which for a change is exactly the risk. The dialog
    // shows the entry itself, found by the request id it sent.
    return {
      ...base,
      kind: "unknown",
      title: "Outcome unknown",
      description:
        error.code === "service_unavailable"
          ? "The service couldn't finish in time (a payment provider that didn't answer, for one), so it can't say whether the change was made."
          : "The server couldn't confirm whether the change was made.",
    };
  }
  if (options.multiStep) {
    return {
      ...base,
      kind: "unknown",
      title: "Outcome unknown",
      description: `${describeError(error).description} This action makes more than one change, so the first may have been made.`,
    };
  }
  return { ...base, kind: "refused", ...pick(describeError(error)) };
}

function pick(description: ErrorDescription): { title: string; description: string } {
  return { title: description.title, description: description.description };
}
