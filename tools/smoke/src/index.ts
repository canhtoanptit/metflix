/**
 * @webflix/smoke: the deployment conformance suite as a library.
 *
 * ```ts
 * import { allChecks, runChecks, parseCli } from "@webflix/smoke";
 * const { options } = parseCli(["--base-url", "http://localhost:4000", "--only", "identity"]);
 * const report = await runChecks(allChecks, options);
 * if (!report.ok) process.exitCode = 1;
 * ```
 */
export { allChecks } from "./checks/index.ts";
export { CookieJar, parseSetCookie } from "./cookies.ts";
export { Environment } from "./env.ts";
export { CheckFailure, SkipSignal } from "./expect.ts";
export { Agent, type Exchange, type HttpResult } from "./http.ts";
export { DOCUMENTED_LIMITS } from "./limits.ts";
export { needs } from "./needs.ts";
export { parseCli, parseRateLimits, USAGE } from "./options.ts";
export { formatCatalogue, formatResult, formatSummary } from "./report.ts";
export { matchesPattern, runChecks, selectChecks } from "./runner.ts";
export type * from "./types.ts";
