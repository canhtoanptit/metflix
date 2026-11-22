import {
  createHmacTokenSigner,
  createMediaTokens,
  createMockBillingProvider,
  createPbkdf2PasswordHasher,
  createServices,
  createUuidV7Generator,
  loadCoreConfig,
  type MembershipRecord,
  type ServiceDependencies,
  utf8Encode,
} from "@webflix/core";
import {
  createMemoryAreaPorts,
  createMemoryRepositories,
  MemoryJobQueue,
  MemoryKeyValueCache,
  MemorySearchIndex,
  MemoryStreamGate,
} from "@webflix/core/memory";
import { ManualClock, MemoryLogger } from "@webflix/core/testing";
import { describe, expect, it } from "vitest";
import { StripePaymentProvider } from "../../src/provider.ts";
import { signatureHeader } from "../../src/webhook.ts";
import { events, type StripeEvent } from "./fixtures.ts";

const SECRET = ["whsec", "convergence", "test", "0000"].join("_");

/**
 * The Stripe API as the recorded sandbox showed it, at a moment: each object as its latest
 * snapshot in the events created by then. The adapter's real mapping and the billing service's
 * real pipeline run against it, so recorded payloads (with their real disorder) are the input.
 */
class RecordedStripe {
  /** Provider time, epoch seconds: what a retrieval sees. */
  now = 0;
  private readonly snapshots = new Map<
    string,
    { created: number; rank: number[]; object: Record<string, unknown> }[]
  >();
  private readonly recorded: StripeEvent[];

  constructor(recorded: StripeEvent[]) {
    this.recorded = recorded;
    recorded.forEach((event, arrival) => {
      const object = event.data.object;
      if (typeof object.id !== "string" || event.type === "invoice.upcoming") return;
      const list = this.snapshots.get(object.id) ?? [];
      list.push({ created: event.created, rank: rankOf(object, event.created, arrival), object });
      this.snapshots.set(object.id, list);
    });
  }

  latest(id: string): Record<string, unknown> | null {
    const visible = (this.snapshots.get(id) ?? []).filter(
      (snapshot) => snapshot.created <= this.now,
    );
    visible.sort((a, b) => compareRanks(a.rank, b.rank));
    return visible[visible.length - 1]?.object ?? null;
  }

  readonly fetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    const missing = () =>
      json({ error: { type: "invalid_request_error", code: "resource_missing" } }, 404);
    const match = /^\/v1\/(subscriptions|invoices|setup_intents)\/([^/]+)$/.exec(url.pathname);
    if (match?.[2]) {
      const object = this.latest(decodeURIComponent(match[2]));
      return object ? json(object) : missing();
    }
    if (url.pathname === "/v1/invoice_payments")
      return json({ object: "list", data: [], has_more: false });
    if (url.pathname === "/v1/events") {
      const after = Number(url.searchParams.get("created[gt]") ?? 0);
      const startingAfter = url.searchParams.get("starting_after");
      const all = this.recorded
        .filter((event) => event.created > after && event.created <= this.now)
        .sort((a, b) => b.created - a.created);
      const start = startingAfter ? all.findIndex((event) => event.id === startingAfter) + 1 : 0;
      const page = all.slice(start, start + 100);
      return json({ object: "list", data: page, has_more: start + 100 < all.length });
    }
    return json({ error: { type: "invalid_request_error", code: "not_recorded" } }, 400);
  };
}

const INVOICE_RANK: Record<string, number> = {
  draft: 0,
  open: 1,
  paid: 2,
  void: 2,
  uncollectible: 2,
};

function rankOf(object: Record<string, unknown>, created: number, arrival: number): number[] {
  if (object.object === "invoice") {
    return [
      created,
      INVOICE_RANK[String(object.status)] ?? 0,
      Number(object.attempt_count ?? 0),
      Number(object.amount_paid ?? 0),
      arrival,
    ];
  }
  return [created, arrival];
}

function compareRanks(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function meaning(record: MembershipRecord | null) {
  if (!record) return null;
  return {
    status: record.status,
    suspendedReason: record.suspendedReason,
    planId: record.planId,
    cancelAtPeriodEnd: record.cancelAtPeriodEnd,
    currentPeriodEnd: record.currentPeriodEnd,
    trialEndsAt: record.trialEndsAt,
    graceStartedAt: record.graceStartedAt,
    endedAt: record.endedAt,
  };
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** A billing service over the Stripe adapter talking to the recorded API. */
async function harness(recorded: StripeEvent[]) {
  const api = new RecordedStripe(recorded);
  const last = Math.max(...recorded.map((event) => event.created));
  const clock = new ManualClock(last * 1000 + 60_000);
  const logger = new MemoryLogger({ clock });
  const config = loadCoreConfig({ WEBFLIX_MODE: "dev", WEBFLIX_ENV: "test" });
  const queue = new MemoryJobQueue({ clock, logger, maxAttempts: 3 });
  const ids = createUuidV7Generator({ clock });
  const payments = new StripePaymentProvider({
    secretKey: "rk_test_recorded",
    webhookSecret: SECRET,
    fetch: api.fetch,
    clock,
    sleep: async () => {},
    maxNetworkRetries: 0,
  });
  const repos = createMemoryRepositories();
  const deps: ServiceDependencies = {
    ...createMemoryAreaPorts({ clock, ids }),
    payments,
    config,
    repos,
    search: new MemorySearchIndex(),
    cache: new MemoryKeyValueCache({ clock }),
    streamGate: new MemoryStreamGate({ clock }),
    jobs: queue,
    passwords: createPbkdf2PasswordHasher({ iterations: 1_000 }),
    mediaTokens: createMediaTokens(
      createHmacTokenSigner({ keys: config.media.tokenKeys, clock }),
      clock,
    ),
    billing: createMockBillingProvider(),
    clock,
    ids,
    logger,
  };
  const services = createServices(deps);
  queue.setProcessor(services.processor);
  // Every recorded customer is a Webflix account (the link checkout records).
  const customers = [
    ...new Set(
      recorded.flatMap((event) =>
        event.data.object.object === "customer" && typeof event.data.object.id === "string"
          ? [event.data.object.id]
          : [],
      ),
    ),
  ];
  for (const customerId of customers) {
    await repos.billing.saveCustomer({
      accountId: `acct-${customerId}`,
      provider: "stripe",
      customerId,
      createdAt: 0,
    });
  }
  const deliver = async (event: StripeEvent) => {
    const body = utf8Encode(JSON.stringify(event));
    const header = await signatureHeader(SECRET, body, Math.floor(clock.now() / 1000));
    await services.billing.receiveWebhook("stripe", body, header);
  };
  const drain = async () => {
    for (let i = 0; i < 20 && queue.size > 0; i += 1) await queue.drain();
  };
  const projections = async (): Promise<Record<string, ReturnType<typeof meaning>>> =>
    Object.fromEntries(
      await Promise.all(
        customers.map(async (customerId) => [
          customerId,
          meaning(await repos.billing.getMembership(`acct-${customerId}`)),
        ]),
      ),
    );
  return { api, services, deliver, drain, projections, last, queue };
}

describe("recorded Stripe traffic converges, whatever the order, duplicates or outages", () => {
  for (const scenario of [
    "trial-converts",
    "renewal-recovers",
    "retries-exhausted",
    "three-d-secure",
    "plan-change",
    "cancel-refund",
    "trial-once",
    "promotion-codes",
  ]) {
    it(`${scenario}: arrival order (provider time moving), shuffled with duplicates, and an outage all agree`, async () => {
      const recorded = events(scenario);

      // Reference: as it happened. Each delivery is processed when it arrived, reading the
      // provider as it was at that moment.
      const reference = await harness(recorded);
      for (const event of recorded) {
        reference.api.now = Math.max(reference.api.now, event.created + 1);
        await reference.deliver(event);
        await reference.drain();
      }
      reference.api.now = reference.last + 1;
      await reference.services.billing.reconcile();
      await reference.drain();
      const expected = await reference.projections();
      expect(Object.values(expected).some((projection) => projection !== null)).toBe(true);

      for (const seed of [1, 2, 3]) {
        const run = await harness(recorded);
        run.api.now = run.last + 1;
        const random = seeded(seed);
        const shuffled = [...recorded, ...recorded.filter(() => random() < 0.5)]
          .map((event) => ({ event, key: random() }))
          .sort((a, b) => a.key - b.key)
          .map(({ event }) => event);
        for (const event of shuffled) await run.deliver(event);
        await run.drain();
        expect(await run.projections(), `${scenario} seed ${seed}`).toEqual(expected);
      }

      // Late deliveries with the provider moving on meanwhile (each delivered up to 30 s late).
      const late = await harness(recorded);
      const random = seeded(99);
      const schedule = recorded
        .map((event) => ({ event, at: event.created + Math.floor(random() * 30) }))
        .sort((a, b) => a.at - b.at);
      for (const { event, at } of schedule) {
        late.api.now = Math.max(late.api.now, at);
        await late.deliver(event);
        await late.drain();
      }
      late.api.now = late.last + 1;
      await late.services.billing.reconcile();
      await late.drain();
      expect(await late.projections(), `${scenario} late`).toEqual(expected);

      // An outage: nothing delivered; reconciliation lists the events and repairs everything.
      const outage = await harness(recorded);
      outage.api.now = outage.last + 1;
      await outage.services.billing.reconcile();
      await outage.drain();
      expect(await outage.projections(), `${scenario} outage`).toEqual(expected);
    });
  }

  it("ends where the sandbox ended (docs/STRIPE.md §8)", async () => {
    const final = async (scenario: string) => {
      const run = await harness(events(scenario));
      run.api.now = run.last + 1;
      await run.services.billing.reconcile();
      await run.drain();
      return Object.values(await run.projections()).filter((projection) => projection !== null);
    };
    expect((await final("renewal-recovers"))[0]).toMatchObject({
      status: "active",
      planId: "standard",
    });
    expect((await final("retries-exhausted"))[0]).toMatchObject({ status: "past_due" });
    expect((await final("trial-converts"))[0]).toMatchObject({ status: "active" });
    const cancels = await final("cancel-refund");
    expect(cancels.map((projection) => projection?.status)).toEqual([
      "canceled",
      "canceled",
      "canceled",
    ]);
    const plans = await final("plan-change");
    expect(plans[0]).toMatchObject({ status: "active", planId: "basic" });
  });
});
