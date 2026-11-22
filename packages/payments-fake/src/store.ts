/**
 * Where the fake provider keeps its state (milestone 2 §5.5: "state in the database through its
 * own tables, so it works on every dialect and survives restarts"). Three things, matching the
 * three `payments_fake_*` tables: versioned JSON documents (customers, cards, setups,
 * subscriptions, invoices, refunds, prices, promotions, events, deliveries, settings),
 * idempotency records, and one test clock per customer (as Stripe's test clocks, so parallel
 * suites never move each other's time).
 *
 * `MemoryFakeStore` is in process; `createSqlFakeStore` (sql-store.ts) is the same over any
 * `@webflix/db` dialect (SQLite, PostgreSQL, D1).
 */
export interface FakeDocument<T = unknown> {
  kind: FakeDocumentKind;
  id: string;
  /** The customer it belongs to; null for global documents (prices, promotions, settings). */
  customerId: string | null;
  data: T;
  version: number;
  /** Real (wall-clock) time, epoch ms: events are listed by it (`listEvents`). */
  createdAt: number;
  updatedAt: number;
}

export const FAKE_DOCUMENT_KINDS = [
  "customer",
  "payment_method",
  "setup",
  "subscription",
  "invoice",
  "refund",
  "price",
  "promotion",
  "event",
  "delivery",
  "settings",
] as const;
export type FakeDocumentKind = (typeof FAKE_DOCUMENT_KINDS)[number];

/** Kinds that make up one customer's working set (events and deliveries are logs, not state). */
export const CUSTOMER_STATE_KINDS: readonly FakeDocumentKind[] = [
  "customer",
  "payment_method",
  "setup",
  "subscription",
  "invoice",
  "refund",
];

export type KeyReservation =
  | { reserved: true }
  | { reserved: false; fingerprint: string; outcome: string | null };

export interface FakeClockRecord {
  /** The clock's reading at `updatedAt` (real time); it runs in real time from there. */
  nowMs: number;
  updatedAt: number;
}

export interface FakeStore {
  get(kind: FakeDocumentKind, id: string): Promise<FakeDocument | null>;
  /** One customer's documents of the given kinds. */
  byCustomer(customerId: string, kinds: readonly FakeDocumentKind[]): Promise<FakeDocument[]>;
  /** Documents of one kind, oldest first by `createdAt`, optionally after a time. */
  byKind(
    kind: FakeDocumentKind,
    options?: { createdAfter?: number; limit?: number },
  ): Promise<FakeDocument[]>;
  /** Upserts every document atomically (one batch). */
  write(documents: readonly FakeDocument[]): Promise<void>;
  delete(keys: readonly { kind: FakeDocumentKind; id: string }[]): Promise<void>;
  /** Claims an idempotency key, or tells what it already holds (`outcome` null: in flight). */
  reserveKey(key: string, fingerprint: string, now: number): Promise<KeyReservation>;
  settleKey(key: string, outcome: string): Promise<void>;
  releaseKey(key: string): Promise<void>;
  clock(customerId: string): Promise<FakeClockRecord | null>;
  setClock(customerId: string, clock: FakeClockRecord): Promise<void>;
}

/** In-process `FakeStore` (tests, and the provider's own unit suite). */
export class MemoryFakeStore implements FakeStore {
  private readonly documents = new Map<string, FakeDocument>();
  private readonly keys = new Map<string, { fingerprint: string; outcome: string | null }>();
  private readonly clocks = new Map<string, FakeClockRecord>();

  async get(kind: FakeDocumentKind, id: string): Promise<FakeDocument | null> {
    const document = this.documents.get(`${kind}:${id}`);
    return document ? structuredClone(document) : null;
  }

  async byCustomer(
    customerId: string,
    kinds: readonly FakeDocumentKind[],
  ): Promise<FakeDocument[]> {
    return [...this.documents.values()]
      .filter((document) => document.customerId === customerId && kinds.includes(document.kind))
      .map((document) => structuredClone(document));
  }

  async byKind(
    kind: FakeDocumentKind,
    options: { createdAfter?: number; limit?: number } = {},
  ): Promise<FakeDocument[]> {
    const after = options.createdAfter ?? Number.NEGATIVE_INFINITY;
    return [...this.documents.values()]
      .filter((document) => document.kind === kind && document.createdAt > after)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      .slice(0, options.limit ?? Number.POSITIVE_INFINITY)
      .map((document) => structuredClone(document));
  }

  async write(documents: readonly FakeDocument[]): Promise<void> {
    for (const document of documents) {
      this.documents.set(`${document.kind}:${document.id}`, structuredClone(document));
    }
  }

  async delete(keys: readonly { kind: FakeDocumentKind; id: string }[]): Promise<void> {
    for (const { kind, id } of keys) this.documents.delete(`${kind}:${id}`);
  }

  async reserveKey(key: string, fingerprint: string): Promise<KeyReservation> {
    const existing = this.keys.get(key);
    if (existing) return { reserved: false, ...existing };
    this.keys.set(key, { fingerprint, outcome: null });
    return { reserved: true };
  }

  async settleKey(key: string, outcome: string): Promise<void> {
    const existing = this.keys.get(key);
    if (existing) existing.outcome = outcome;
  }

  async releaseKey(key: string): Promise<void> {
    this.keys.delete(key);
  }

  async clock(customerId: string): Promise<FakeClockRecord | null> {
    const clock = this.clocks.get(customerId);
    return clock ? { ...clock } : null;
  }

  async setClock(customerId: string, clock: FakeClockRecord): Promise<void> {
    this.clocks.set(customerId, { ...clock });
  }
}
