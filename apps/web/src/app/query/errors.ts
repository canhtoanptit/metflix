import { ApiError } from "@webflix/contracts";

export interface ErrorDescription {
  title: string;
  description: string;
  /** Worth offering "Try again". */
  retryable: boolean;
  /** Support reference (`requestId`) when the server sent one. */
  reference: string | null;
}

/**
 * Plain-language copy for any error thrown by a query or mutation. Screens may special-case
 * codes they understand (`invalid_credentials`, `stream_limit_reached`…) and fall back to this.
 */
export function describeError(error: unknown): ErrorDescription {
  if (!ApiError.is(error)) {
    return {
      title: "Something went wrong",
      description: "An unexpected error occurred. Please try again.",
      retryable: true,
      reference: null,
    };
  }
  const reference =
    "requestId" in error.problem && typeof error.problem.requestId === "string"
      ? error.problem.requestId
      : null;
  const base = { reference };
  if (isUnreachable(error)) {
    return {
      ...base,
      title: "Can't reach Webflix",
      description: "Check your internet connection and try again.",
      retryable: true,
    };
  }
  switch (error.code) {
    case "network_error":
      return {
        ...base,
        title: "Can't reach Webflix",
        description: "Check your internet connection and try again.",
        retryable: true,
      };
    case "rate_limited": {
      const seconds = ApiError.is(error, "rate_limited") ? error.problem.retryAfterSec : 30;
      return {
        ...base,
        title: "Too many attempts",
        description: `Please wait ${seconds} seconds and try again.`,
        retryable: true,
      };
    }
    case "not_found":
      return {
        ...base,
        title: "Not found",
        description: "This page or title isn't available.",
        retryable: false,
      };
    case "maturity_restricted":
      return {
        ...base,
        title: "Not available on this profile",
        description: "This title is outside the profile's maturity settings.",
        retryable: false,
      };
    case "service_unavailable":
    case "internal_error":
    case "unexpected_response":
      return {
        ...base,
        title: "Something went wrong on our side",
        description: "We're on it. Please try again in a moment.",
        retryable: true,
      };
    default:
      return { ...base, title: error.problem.title, description: error.message, retryable: false };
  }
}

/**
 * The API could not be reached: no network, or a gateway/proxy answered for it (502/504 without
 * a problem document, e.g. the dev proxy with no API running).
 */
export function isUnreachable(error: unknown): boolean {
  if (!ApiError.is(error)) return false;
  return (
    error.code === "network_error" ||
    (error.code === "unexpected_response" && (error.status === 502 || error.status === 504))
  );
}

/** Client-side failures and server faults may succeed on retry; 4xx answers will not. */
export function isRetryableError(error: unknown): boolean {
  if (!ApiError.is(error)) return false;
  return (
    error.code === "network_error" ||
    error.code === "service_unavailable" ||
    error.code === "internal_error" ||
    error.code === "unexpected_response"
  );
}
