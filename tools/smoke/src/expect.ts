/**
 * Assertions that fail a check with the three things a platform engineer needs: what was
 * expected, what was observed, and the request that observed it.
 */
import {
  ApiError,
  type ApiErrorCode,
  ERROR_CATALOG,
  type ErrorCode,
  PROBLEM_CONTENT_TYPE,
  Problem,
  REQUEST_ID_HEADER,
} from "@webflix/contracts";
import { capture, type Exchange, exchangeOf, type HttpResult } from "./http.ts";

export interface FailureDetails {
  expected?: string;
  observed?: string;
  exchange?: Exchange | undefined;
  /** Extra lines (validation issues, per-request tallies). */
  details?: string[];
}

export class CheckFailure extends Error {
  override readonly name = "CheckFailure";
  readonly expected: string | undefined;
  readonly observed: string | undefined;
  readonly exchange: Exchange | undefined;
  readonly details: string[];

  constructor(message: string, details: FailureDetails = {}) {
    super(message);
    this.expected = details.expected;
    this.observed = details.observed;
    this.exchange = details.exchange;
    this.details = details.details ?? [];
  }
}

/** Thrown by `ctx.skip`: the target cannot support the check. Never counted as a pass. */
export class SkipSignal extends Error {
  override readonly name = "SkipSignal";
}

export function fail(message: string, details: FailureDetails = {}): never {
  throw new CheckFailure(message, details);
}

export function check(
  condition: unknown,
  message: string,
  details: FailureDetails = {},
): asserts condition {
  if (!condition) fail(message, details);
}

export function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json.length > 400 ? `${json.slice(0, 400)}…` : json;
  } catch {
    return String(value);
  }
}

export function equal<T>(actual: T, expected: T, what: string, exchange?: Exchange): void {
  if (!Object.is(actual, expected) && show(actual) !== show(expected)) {
    fail(`${what} differs`, { expected: show(expected), observed: show(actual), exchange });
  }
}

/** Assert an HTTP status on a raw result. */
export function status(
  result: HttpResult,
  expected: number | readonly number[],
  what: string,
): void {
  const allowed = typeof expected === "number" ? [expected] : expected;
  if (!allowed.includes(result.status)) {
    fail(`${what}: unexpected status`, {
      expected: allowed.join(" or "),
      observed:
        `${result.status} ${result.headers.get("Content-Type") ?? ""} ${result.exchange.responseBody ?? ""}`.trim(),
      exchange: result.exchange,
    });
  }
}

/** Assert a header (exact value, or a predicate) on a raw result. */
export function header(
  result: HttpResult,
  name: string,
  expected: string | RegExp | ((value: string | null) => boolean),
  what: string,
): string | null {
  const value = result.headers.get(name);
  const ok =
    typeof expected === "string"
      ? value === expected
      : expected instanceof RegExp
        ? value !== null && expected.test(value)
        : expected(value);
  if (!ok) {
    fail(`${what}: header ${name}`, {
      expected:
        typeof expected === "string"
          ? expected
          : expected instanceof RegExp
            ? String(expected)
            : "(see check)",
      observed: value === null ? "(absent)" : value,
      exchange: result.exchange,
    });
  }
  return value;
}

/**
 * Assert an RFC 9457 problem document with `code`: status from the error catalogue,
 * `application/problem+json`, the contract's shape, and the request id echoed in the body.
 */
export function problem<C extends ErrorCode>(
  result: HttpResult,
  code: C,
  what: string,
): Problem<C> {
  const expectedStatus = ERROR_CATALOG[code].status;
  const contentType = result.headers.get("Content-Type") ?? "";
  const summary = `${result.status} ${contentType} ${result.exchange.responseBody ?? ""}`.trim();
  if (result.status !== expectedStatus || !contentType.includes(PROBLEM_CONTENT_TYPE)) {
    fail(`${what}: expected a ${code} problem`, {
      expected: `${expectedStatus} ${PROBLEM_CONTENT_TYPE} with code ${code}`,
      observed: summary,
      exchange: result.exchange,
    });
  }
  let body: unknown;
  try {
    body = result.json();
  } catch {
    fail(`${what}: problem body is not JSON`, { observed: summary, exchange: result.exchange });
  }
  const parsed = Problem.safeParse(body);
  if (!parsed.success || parsed.data.code !== code) {
    fail(`${what}: problem document does not match the contract`, {
      expected: `Problem with code ${code}`,
      observed: summary,
      exchange: result.exchange,
      details: parsed.success
        ? []
        : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    });
  }
  const requestId = result.headers.get(REQUEST_ID_HEADER);
  if (
    parsed.data.requestId !== undefined &&
    requestId !== null &&
    parsed.data.requestId !== requestId
  ) {
    fail(`${what}: problem requestId differs from the ${REQUEST_ID_HEADER} header`, {
      expected: requestId,
      observed: parsed.data.requestId,
      exchange: result.exchange,
    });
  }
  return parsed.data as Problem<C>;
}

/** Describe an unexpected error from a typed call (contract drift shows the zod issues). */
export function describeError(error: unknown): FailureDetails & { message: string } {
  const exchange = exchangeOf(error);
  if (error instanceof ApiError) {
    const details: string[] = [];
    const cause = (error as { cause?: unknown }).cause;
    if (
      error.code === "unexpected_response" &&
      cause &&
      typeof cause === "object" &&
      "issues" in cause
    ) {
      const issues = (cause as { issues: { path: PropertyKey[]; message: string }[] }).issues;
      for (const issue of issues.slice(0, 12)) {
        details.push(`contract: ${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`);
      }
    }
    return {
      message:
        error.code === "unexpected_response"
          ? `Response does not match the contract: ${error.message}`
          : `Unexpected API error ${error.code} (${error.status}): ${error.message}`,
      observed: `${error.status} ${error.code}`,
      exchange,
      details,
    };
  }
  if (error instanceof Error) return { message: `${error.name}: ${error.message}`, exchange };
  return { message: String(error), exchange };
}

/**
 * Run a typed call that must fail with `code`. Returns the error (narrowed) for further
 * assertions on its extension members.
 */
export async function rejects<C extends ApiErrorCode>(
  call: () => Promise<unknown>,
  code: C,
  what: string,
): Promise<ApiError<C>> {
  const result = await capture(call);
  const exchange = result.exchanges[result.exchanges.length - 1];
  if (result.ok) {
    fail(`${what}: expected ${code}, but the call succeeded`, {
      expected: `${code} (${code in ERROR_CATALOG ? ERROR_CATALOG[code as ErrorCode].status : "client"})`,
      observed: `${exchange?.status ?? "?"} ${show(result.value)}`,
      exchange,
    });
  }
  if (!ApiError.is(result.error, code)) {
    const described = describeError(result.error);
    fail(`${what}: expected ${code}`, {
      expected: code,
      observed: described.observed ?? described.message,
      exchange,
      details: described.details ?? [],
    });
  }
  return result.error as ApiError<C>;
}

/** Run a typed call that must succeed; on failure, report it with its exchange. */
export async function succeeds<T>(call: () => Promise<T>, what: string): Promise<T> {
  const result = await capture(call);
  if (result.ok) return result.value;
  const described = describeError(result.error);
  fail(`${what}: ${described.message}`, {
    expected: "success",
    observed: described.observed ?? described.message,
    exchange: described.exchange ?? result.exchanges[result.exchanges.length - 1],
    details: described.details ?? [],
  });
}
