import { AsyncLocalStorage } from "node:async_hooks";
import type Stripe from "stripe";
import type { Delivery, Receiver } from "./receiver.ts";
import type { TimeMode } from "./timeline.ts";

/** One HTTP request to Stripe, as the counting fetch saw it. */
export interface ApiCall {
  scenario: string;
  step: string;
  method: string;
  /** Path and query, ids included (scrubbed later). */
  path: string;
  status: number;
  ms: number;
  auth: "secret" | "publishable";
  requestId: string | null;
  idempotencyKey: string | null;
  replayed: boolean;
  rateLimitedReason: string | null;
  at: string;
}

export interface RecordedResponse {
  step: string;
  label: string;
  at: string;
  /** HTTP status for errors, null for SDK results (2xx). */
  status: number | null;
  body: unknown;
}

export interface Observation {
  step: string;
  key: string;
  value: unknown;
  expected?: unknown;
  /** Present when `expected` is: whether the value matched. */
  ok?: boolean;
  note?: string;
}

export interface ClockAdvance {
  clock: string;
  fromTime: number;
  toTime: number;
  /** Wall-clock milliseconds from the advance request until the clock reported `ready`. */
  ms: number;
  polls: number;
}

/** Which scenario and step an API call belongs to, carried through async calls. */
export const activeScope = new AsyncLocalStorage<{ scenario: Scenario }>();

export class Scenario {
  readonly name: string;
  readonly title: string;
  readonly stripe: Stripe;
  readonly receiver: Receiver;
  readonly runId: string;
  readonly publishableKey: string;
  readonly calls: ApiCall[] = [];
  readonly responses: RecordedResponse[] = [];
  readonly observations: Observation[] = [];
  readonly advances: ClockAdvance[] = [];
  readonly steps: Array<{ name: string; ms: number }> = [];
  /** Ids whose events belong to this scenario (customers, clocks, products, coupons…). */
  readonly owned = new Set<string>();
  readonly clocks: string[] = [];
  /** Checks this run could not make (e.g. they need a test clock), recorded as skipped. */
  readonly skipped: string[] = [];
  /** How time passes in this run: Stripe test clocks, or real time (unclaimed sandbox). */
  readonly timeMode: TimeMode;
  currentStep = "setup";
  startedAtMs = 0;
  finishedAtMs = 0;
  error: string | null = null;
  /** First delivery sequence number that can belong to this scenario. */
  firstSeq = 0;

  constructor(init: {
    name: string;
    title: string;
    stripe: Stripe;
    receiver: Receiver;
    runId: string;
    publishableKey: string;
    timeMode: TimeMode;
  }) {
    this.timeMode = init.timeMode;
    this.name = init.name;
    this.title = init.title;
    this.stripe = init.stripe;
    this.receiver = init.receiver;
    this.runId = init.runId;
    this.publishableKey = init.publishableKey;
  }

  own(...ids: Array<string | null | undefined>): void {
    for (const id of ids) if (id) this.owned.add(id);
  }

  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.currentStep;
    this.currentStep = name;
    const started = performance.now();
    try {
      return await fn();
    } finally {
      this.steps.push({ name, ms: Math.round(performance.now() - started) });
      this.currentStep = previous;
    }
  }

  record<T>(label: string, body: T): T {
    this.responses.push({
      step: this.currentStep,
      label,
      at: new Date().toISOString(),
      status: null,
      // Through JSON, not structuredClone: stripe-node 23 returns `unit_amount_decimal` as a
      // Decimal whose toJSON() gives the API's string, but structuredClone drops the prototype
      // and leaves a bare BigInt that JSON.stringify then rejects.
      body: JSON.parse(JSON.stringify(body)) as unknown,
    });
    return body;
  }

  recordError(
    label: string,
    error: unknown,
  ): { status: number | null; type: string | null; code: string | null; message: string } {
    const e = error as {
      statusCode?: number;
      type?: string;
      code?: string;
      message?: string;
      raw?: unknown;
    };
    const summary = {
      status: e.statusCode ?? null,
      type: e.type ?? null,
      code: e.code ?? null,
      message: e.message ?? String(error),
    };
    this.responses.push({
      step: this.currentStep,
      label,
      at: new Date().toISOString(),
      status: summary.status,
      body: e.raw ?? summary,
    });
    return summary;
  }

  observe(key: string, value: unknown, expected?: unknown, note?: string): boolean {
    const observation: Observation = { step: this.currentStep, key, value };
    if (expected !== undefined) {
      observation.expected = expected;
      observation.ok = JSON.stringify(value) === JSON.stringify(expected);
    }
    if (note) observation.note = note;
    this.observations.push(observation);
    return observation.ok ?? true;
  }

  /** Expect a condition; the scenario fails at the end if any expectation did not hold. */
  expect(key: string, value: unknown, expected: unknown, note?: string): void {
    this.observe(key, value, expected, note);
  }

  /**
   * Wait until a webhook delivery satisfying `match` arrives (counting deliveries since the
   * scenario began). Returns the first match.
   */
  async waitForEvent(
    type: string,
    match: (object: Record<string, unknown>, event: Stripe.Event) => boolean,
    timeoutMs = 90_000,
    since: number = this.firstSeq,
  ): Promise<Stripe.Event> {
    const delivery = await this.receiver.waitFor(
      (d: Delivery) =>
        d.seq >= since &&
        d.event !== null &&
        d.event.type === type &&
        match(d.event.data.object as unknown as Record<string, unknown>, d.event),
      timeoutMs,
      `${this.name}: ${type}`,
    );
    // biome-ignore lint/style/noNonNullAssertion: the predicate above only accepts parsed events.
    return delivery.event!;
  }

  /** The sequence number the next delivery will get: pass it as `since` to wait for later events only. */
  mark(): number {
    return this.receiver.deliveries.length;
  }

  /** Let in-flight deliveries land before the next step (Stripe sends events asynchronously). */
  async settle(ms = 4000): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  get failedExpectations(): Observation[] {
    return this.observations.filter((o) => o.ok === false);
  }
}

/** Predicate: the event's object is, or belongs to, this customer. */
export function forCustomer(customerId: string) {
  return (object: Record<string, unknown>) =>
    object.id === customerId || object.customer === customerId;
}

/** Predicate: the event's object is this id. */
export function isObject(id: string) {
  return (object: Record<string, unknown>) => object.id === id;
}
