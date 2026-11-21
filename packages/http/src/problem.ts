import {
  createProblem,
  type PlainErrorCode,
  PROBLEM_CONTENT_TYPE,
  type Problem,
  REQUEST_ID_HEADER,
} from "@webflix/contracts";
import { AppError, type Logger, noopLogger, serializeError } from "@webflix/core";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { redactPath } from "./redact.ts";

/** How long clients wait before retrying a `service_unavailable` (a dependency is down). */
export const SERVICE_UNAVAILABLE_RETRY_AFTER_SEC = 5;

function problemHeaders(problem: Problem, extra?: Record<string, string>): Headers {
  const headers = new Headers(extra);
  headers.set("Content-Type", PROBLEM_CONTENT_TYPE);
  headers.set("Cache-Control", "no-store");
  if (problem.code === "rate_limited") headers.set("Retry-After", String(problem.retryAfterSec));
  if (problem.code === "service_unavailable") {
    headers.set("Retry-After", String(SERVICE_UNAVAILABLE_RETRY_AFTER_SEC));
  }
  if (problem.requestId) headers.set(REQUEST_ID_HEADER, problem.requestId);
  return headers;
}

/** A standalone problem+json response. Adds `Retry-After` for `rate_limited` and 503s. */
export function problemResponse(problem: Problem, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers: problemHeaders(problem, headers),
  });
}

/**
 * A problem+json response through the Hono context, so headers set earlier in the request
 * (`setCookie` clearing an expired session, security headers) are kept.
 */
export function problemContextResponse(c: Context, problem: Problem): Response {
  problemHeaders(problem).forEach((value, key) => {
    c.header(key, value);
  });
  return c.body(JSON.stringify(problem), problem.status as ContentfulStatusCode);
}

const HTTP_EXCEPTION_CODES: Partial<Record<number, PlainErrorCode>> = {
  400: "bad_request",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  413: "payload_too_large",
  415: "unsupported_media_type",
  503: "service_unavailable",
};

export interface ProblemHandlerOptions {
  logger?: Logger;
  /** Where the request id lives (e.g. `c.get("requestId")` from `hono/request-id`). */
  requestId?: (c: Context) => string | undefined;
}

/**
 * `app.onError(...)`: `AppError` becomes its problem; Hono `HTTPException`s map onto the
 * nearest code; anything else is logged and answered as an opaque `internal_error`.
 */
export function problemErrorHandler(options: ProblemHandlerOptions = {}): ErrorHandler {
  const logger = options.logger ?? noopLogger;
  return (error, c) => {
    const requestId = options.requestId?.(c);
    const meta = requestId === undefined ? {} : { requestId };
    if (AppError.is(error)) {
      // A dependency is down: worth a log line (the client only learns to retry).
      if (error.code === "service_unavailable") {
        logger.warn("http.dependency_unavailable", {
          error: serializeError(error.cause ?? error),
          method: c.req.method,
          path: redactPath(c.req.path),
          ...meta,
        });
      }
      return problemContextResponse(c, error.toProblem(meta));
    }

    if (error instanceof HTTPException) {
      const code = HTTP_EXCEPTION_CODES[error.status];
      if (code) return problemContextResponse(c, createProblem(code, meta));
    }
    logger.error("http.unhandled_error", {
      error: serializeError(error),
      method: c.req.method,
      path: redactPath(c.req.path),
      ...meta,
    });
    return problemContextResponse(c, createProblem("internal_error", meta));
  };
}

/** `app.notFound(...)`: unknown routes answer a `not_found` problem. */
export function problemNotFoundHandler(options: ProblemHandlerOptions = {}): NotFoundHandler {
  return (c) => {
    const requestId = options.requestId?.(c);
    return problemContextResponse(
      c,
      createProblem("not_found", {
        detail: `No route for ${c.req.method} ${c.req.path}`,
        ...(requestId === undefined ? {} : { requestId }),
      }),
    );
  };
}
