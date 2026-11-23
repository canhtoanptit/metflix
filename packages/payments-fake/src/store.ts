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

/**
 * One operation's writes, applied only if nothing it read has been committed over since
 * (finding K2: replicas and isolates share one store, so an in-process lock is not enough).
 * Each guard names a unit of state (`customer:<id>`, `promotions`, `catalogue`) with the version
 * it had when the operation read that state; every commit to the unit moves its guard on.
 */
export interface FakeCommit {
  /** Guard key → the version read before the documents were (0: never committed). */
  guards: ReadonlyMap<string, number>;
  documents: readonly FakeDocument[];
  clocks?: readonly { customerId: string; clock: FakeClockRecord }[];
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
  /**
   * Upserts every document atomically (one batch), unconditionally: only for writes that no
   * concurrent operation can undo (settings, delivery bookkeeping). State goes through `commit`.
   */
  write(documents: readonly FakeDocument[]): Promise<void>;
  /** The current versions of guard keys (0 for a key never committed). */
  guardVersions(keys: readonly string[]): Promise<Map<string, number>>;
  /**
   * Compare-and-set, all or nothing: writes the documents and clocks and moves every guard one
   * version on, only if every guard is still at the version given. False, with nothing written,
   * when another commit moved one first: the caller reads again and recomputes.
   */
  commit(input: FakeCommit): Promise<boolean>;
  delete(keys: readonly { kind: FakeDocumentKind; id: string }[]): Promise<void>;
  /** Claims an idempotency key, or tells what it already holds (`outcome` null: in flight). */
  reserveKey(key: string, fingerprint: string, now: number): Promise<KeyReservation>;
  settleKey(key: string, outcome: string): Promise<void>;
  releaseKey(key: string): Promise<void>;
  clock(customerId: string): Promise<FakeClockRecord | null>;
  setClock(customerId: string, clock: FakeClockRecord): Promise<void>;
  /**
   * A deleted customer's traces outside its documents (privacy review M5): its test clock, and
   * every idempotency record whose key, request or outcome contains one of `fragments` (the
   * customer's id, the account id its keys were derived from). Fragments shorter than 8
   * characters are ignored (they could match anyone's).
   */
  forget(customerId: string, fragments: readonly string[]): Promise<void>;
}

/** In-process `FakeStore` (tests, and the provider's own unit suite). */
export class MemoryFakeStore implements FakeStore {
  private readonly documents = new Map<string, FakeDocument>();
  private readonly keys = new Map<string, { fingerprint: string; outcome: string | null }>();
  private readonly clocks = new Map<string, FakeClockRecord>();
  private readonly guards = new Map<string, number>();

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

  async guardVersions(keys: readonly string[]): Promise<Map<string, number>> {
    return new Map(keys.map((key) => [key, this.guards.get(key) ?? 0]));
  }

  async commit({ guards, documents, clocks = [] }: FakeCommit): Promise<boolean> {
    // Synchronous from the check to the last write: atomic for every caller of this store.
    for (const [key, version] of guards) {
      if ((this.guards.get(key) ?? 0) !== version) return false;
    }
    for (const [key, version] of guards) this.guards.set(key, version + 1);
    for (const document of documents) {
      this.documents.set(`${document.kind}:${document.id}`, structuredClone(document));
    }
    for (const { customerId, clock } of clocks) this.clocks.set(customerId, { ...clock });
    return true;
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

  async forget(customerId: string, fragments: readonly string[]): Promise<void> {
    this.clocks.delete(customerId);
    const usable = fragments.filter((fragment) => fragment.length >= 8);
    for (const [key, record] of this.keys) {
      const text = `${key}\n${record.fingerprint}\n${record.outcome ?? ""}`;
      if (usable.some((fragment) => text.includes(fragment))) this.keys.delete(key);
    }
  }

  async setClock(customerId: string, clock: FakeClockRecord): Promise<void> {
    this.clocks.set(customerId, { ...clock });
  }
}
