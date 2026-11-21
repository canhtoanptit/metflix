import {
  createProblem,
  ERROR_CATALOG,
  type ErrorCode,
  type Problem,
  type ProblemExtensions,
} from "@webflix/contracts";

type AppErrorArgs<C extends ErrorCode> = keyof ProblemExtensions<C> extends never
  ? [options?: AppErrorOptions]
  : [options: AppErrorOptions & ProblemExtensions<C>];

export interface AppErrorOptions {
  /** Human-readable explanation of this occurrence (safe to show to the user). */
  detail?: string;
  cause?: unknown;
}

/**
 * The error type application services throw. It carries a stable contract `code`; the HTTP
 * layer turns it into a problem+json response. Codes with extension members require them:
 *
 * ```ts
 * throw new AppError("rate_limited", { retryAfterSec: 30 });
 * ```
 */
export class AppError<C extends ErrorCode = ErrorCode> extends Error {
  override readonly name = "AppError";
  readonly code: C;
  readonly status: number;
  readonly detail: string | undefined;
  readonly extensions: Record<string, unknown>;

  constructor(code: C, ...args: AppErrorArgs<C>) {
    const { detail, cause, ...extensions } = (args[0] ?? {}) as AppErrorOptions &
      Record<string, unknown>;
    super(detail ?? ERROR_CATALOG[code].title, cause === undefined ? undefined : { cause });
    this.code = code;
    this.status = ERROR_CATALOG[code].status;
    this.detail = detail;
    this.extensions = extensions;
  }

  toProblem(options: { requestId?: string; instance?: string } = {}): Problem<C> {
    const args = {
      ...this.extensions,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
      ...options,
    };
    // The constructor already enforced the code's extension members.
    return (createProblem as (code: C, options: object) => Problem<C>)(this.code, args);
  }

  static is<K extends ErrorCode = ErrorCode>(value: unknown, code?: K): value is AppError<K> {
    return value instanceof AppError && (code === undefined || value.code === code);
  }
}
