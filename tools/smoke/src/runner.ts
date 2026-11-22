/**
 * Runs checks: filtering, requirement evaluation (skip with a reason), a concurrency pool for
 * ordinary checks, then exclusive checks one at a time, each under its own timeout.
 */
import { REQUEST_ID_HEADER } from "@webflix/contracts";
import { Environment } from "./env.ts";
import { CheckFailure, describeError, fail, SkipSignal } from "./expect.ts";
import { type Exchange, exchangeOf, NetworkError, runInScope } from "./http.ts";
import type {
  CheckContext,
  CheckDefinition,
  CheckResult,
  Outcome,
  RequestSummary,
  RunReport,
  SmokeOptions,
} from "./types.ts";

/** `identity.*`, `identity`, `media.range-requests`, `*range*`. */
export function matchesPattern(id: string, pattern: string): boolean {
  if (pattern === id) return true;
  if (!pattern.includes("*")) return id.startsWith(`${pattern}.`) || id === pattern;
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`);
  return regex.test(id);
}

function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

export function selectChecks(
  checks: readonly CheckDefinition[],
  options: SmokeOptions,
): CheckDefinition[] {
  return checks.filter((definition) => {
    if (
      options.only.length > 0 &&
      !options.only.some((pattern) => matchesPattern(definition.id, pattern))
    ) {
      return false;
    }
    if (options.skip.some((pattern) => matchesPattern(definition.id, pattern))) return false;
    if (
      options.tags.length > 0 &&
      !options.tags.some((tag) => (definition.tags ?? []).includes(tag as never))
    ) {
      return false;
    }
    return true;
  });
}

function summarize(exchange: Exchange | undefined): RequestSummary | undefined {
  if (!exchange) return undefined;
  return {
    agent: exchange.agent,
    method: exchange.method,
    url: exchange.url,
    status: exchange.status,
    requestId: exchange.requestId,
    serverRequestId: exchange.responseHeaders[REQUEST_ID_HEADER.toLowerCase()] ?? null,
    requestHeaders: exchange.requestHeaders,
    ...(exchange.requestBody === undefined ? {} : { requestBody: exchange.requestBody }),
    responseHeaders: exchange.responseHeaders,
    ...(exchange.responseBody === undefined ? {} : { responseBody: exchange.responseBody }),
    ...(exchange.error === undefined ? {} : { error: exchange.error }),
    durationMs: exchange.durationMs,
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

class TimeoutError extends Error {
  override readonly name = "TimeoutError";
}

async function runOne(definition: CheckDefinition, env: Environment): Promise<CheckResult> {
  const options = env.options;
  const started = performance.now();
  const exchanges: Exchange[] = [];
  const notes: string[] = [];
  const controller = new AbortController();
  const timeoutMs = definition.timeoutMs ?? options.checkTimeoutMs;
  // Waiting out the deployment's rate limits (a strict profile, a shared address) is not the
  // check's time: the deadline moves by every Retry-After the check's requests waited.
  let throttledMs = 0;
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    const remaining = started + timeoutMs + throttledMs - performance.now();
    if (remaining > 0) {
      timer = setTimeout(arm, remaining);
      return;
    }
    controller.abort(
      new TimeoutError(
        `check timed out after ${Math.round(timeoutMs / 1000)} s${throttledMs > 0 ? ` (plus ${Math.round(throttledMs / 1000)} s waiting on rate limits)` : ""}`,
      ),
    );
  };
  timer = setTimeout(arm, timeoutMs);
  const ctx: CheckContext = {
    options,
    env,
    signal: controller.signal,
    agent: (label, agentOptions) => env.agent(label, agentOptions),
    note: (message) => {
      notes.push(message);
    },
    skip: (reason) => {
      throw new SkipSignal(reason);
    },
    sleep: (ms) => sleep(ms, controller.signal),
    async eventually(what, probe, pollOptions = {}) {
      const limit = pollOptions.timeoutMs ?? options.eventualTimeoutMs;
      const interval = pollOptions.intervalMs ?? options.pollIntervalMs;
      const begun = performance.now();
      let attempts = 0;
      let last = "(not probed)";
      for (;;) {
        attempts += 1;
        const outcome = await probe();
        const elapsedMs = Math.round(performance.now() - begun);
        if (outcome.done) return { value: outcome.value, elapsedMs, attempts };
        last = outcome.observed;
        if (elapsedMs + interval > limit) {
          fail(`never observed: ${what}`, {
            expected: `${what} within ${Math.round(limit / 1000)} s`,
            observed: `after ${attempts} polls over ${Math.round(elapsedMs / 1000)} s: ${last}`,
            exchange: exchanges[exchanges.length - 1],
          });
        }
        await sleep(interval, controller.signal);
      }
    },
  };

  let outcome: Outcome = "pass";
  let reason: string | undefined;
  let failure: CheckResult["failure"];
  try {
    await runInScope(
      {
        collectors: [exchanges],
        signal: controller.signal,
        note: (message) => {
          if (!notes.includes(message)) notes.push(message);
        },
        onThrottle: (ms) => {
          throttledMs += ms;
        },
      },
      async () => {
        const run = async () => {
          for (const requirement of definition.needs ?? []) {
            const unmet = await requirement.evaluate(env);
            if (unmet !== null) throw new SkipSignal(unmet);
          }
          await definition.run(ctx);
        };
        // The abort reason wins over whatever the in-flight request rejects with.
        const aborted = new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
            once: true,
          });
        });
        await Promise.race([run(), aborted]);
      },
    );
  } catch (error) {
    if (error instanceof SkipSignal) {
      outcome = "skip";
      reason = error.message;
    } else {
      outcome = "fail";
      failure = failureOf(error, exchanges);
    }
  } finally {
    clearTimeout(timer);
  }

  if (
    definition.knownFinding !== undefined ||
    options.expectFail.some((pattern) => matchesPattern(definition.id, pattern))
  ) {
    if (outcome === "fail") outcome = "xfail";
    else if (outcome === "pass") outcome = "xpass";
  }
  return {
    id: definition.id,
    area: definition.area,
    title: definition.title,
    tags: definition.tags ?? [],
    outcome,
    durationMs: Math.round(performance.now() - started),
    ...(reason === undefined ? {} : { reason }),
    ...(failure === undefined ? {} : { failure }),
    notes,
    requests: exchanges.length,
    ...(definition.knownFinding === undefined ? {} : { finding: definition.knownFinding }),
  };
}

function failureOf(error: unknown, exchanges: Exchange[]): NonNullable<CheckResult["failure"]> {
  const last = exchanges[exchanges.length - 1];
  if (error instanceof CheckFailure) {
    return {
      message: error.message,
      ...(error.expected === undefined ? {} : { expected: error.expected }),
      ...(error.observed === undefined ? {} : { observed: error.observed }),
      details: error.details,
      ...(summarize(error.exchange) ? { request: summarize(error.exchange) } : {}),
    };
  }
  if (error instanceof TimeoutError) {
    return {
      message: error.message,
      details: last
        ? [`last request: ${last.method} ${last.url} → ${last.status || last.error}`]
        : [],
      ...(summarize(last) ? { request: summarize(last) } : {}),
    };
  }
  if (error instanceof NetworkError) {
    return {
      message: error.message,
      details: [],
      ...(summarize(error.exchange) ? { request: summarize(error.exchange) } : {}),
    };
  }
  const described = describeError(error);
  const exchange = exchangeOf(error) ?? described.exchange ?? last;
  return {
    message: described.message,
    ...(described.observed === undefined ? {} : { observed: described.observed }),
    details: described.details ?? [],
    ...(summarize(exchange) ? { request: summarize(exchange) } : {}),
  };
}

export interface RunHooks {
  onResult?: (result: CheckResult) => void;
}

/** Run the selected checks against the target and build the report. */
export async function runChecks(
  checks: readonly CheckDefinition[],
  options: SmokeOptions,
  hooks: RunHooks = {},
): Promise<RunReport> {
  const env = new Environment(options);
  const startedAt = new Date();
  const started = performance.now();
  const selected = selectChecks(checks, options);
  const isExclusive = (definition: CheckDefinition) =>
    (definition.tags ?? []).includes("exclusive");
  // Slow checks start first so their waiting overlaps everything else.
  const ordinary = selected
    .filter((definition) => !isExclusive(definition))
    .sort(
      (a, b) => Number((b.tags ?? []).includes("slow")) - Number((a.tags ?? []).includes("slow")),
    );
  const exclusive = selected.filter(isExclusive);
  const results = new Map<string, CheckResult>();

  const queue = [...ordinary];
  const workers = Array.from({ length: Math.max(1, options.concurrency) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const result = await runOne(next, env);
      results.set(next.id, result);
      hooks.onResult?.(result);
    }
  });
  await Promise.all(workers);
  for (const definition of exclusive) {
    const result = await runOne(definition, env);
    results.set(definition.id, result);
    hooks.onResult?.(result);
  }
  await env.dispose();

  const ordered = selected.flatMap((definition) => results.get(definition.id) ?? []);
  const counts = { pass: 0, fail: 0, skip: 0, xfail: 0, xpass: 0, total: ordered.length };
  for (const result of ordered) counts[result.outcome] += 1;
  const finishedAt = new Date();
  return {
    tool: "webflix-smoke",
    runId: options.runId,
    baseUrl: options.baseUrl,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.round(performance.now() - started),
    target: Object.fromEntries(env.target),
    options: {
      concurrency: options.concurrency,
      checkTimeoutMs: options.checkTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
      eventualTimeoutMs: options.eventualTimeoutMs,
      parallelism: options.parallelism,
      repeat: options.repeat,
      burst: options.burst,
      rateLimits: options.rateLimits,
      allowIpExhaustion: options.allowIpExhaustion,
      only: options.only,
      skip: options.skip,
      tags: options.tags,
      expectFail: options.expectFail,
      failOnSkip: options.failOnSkip,
    },
    counts,
    ok: counts.fail === 0 && (!options.failOnSkip || counts.skip === 0),
    results: ordered,
  };
}
