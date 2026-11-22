/**
 * @webflix/telemetry: the web event SDK (docs/BLUEPRINT-M2.md §6.1, §6.2).
 *
 * Builds client behaviour events (`ClientEventInput`), batches them and sends them to
 * `POST /api/v1/events`. It never sends who the member is: the server stamps the subject from
 * the session and refuses a client-supplied identity. What it does:
 *
 * - envelopes: a UUIDv7 per event, the device's anonymous id (kept in `localStorage`), a
 *   sequence number per app session, the app's platform and version, the context (surface,
 *   row, positions, experiment assignments, ranking policy) exactly as the caller gives it;
 * - batches of at most 50 events and 64 KiB, one request in flight at a time, sent on a timer,
 *   when a batch fills, and with `keepalive` when the page is hidden or unloaded;
 * - delivery: a batch is dropped only when the server refuses it as invalid (4xx); network
 *   errors, 429 (honouring `Retry-After`) and 5xx keep it for a retry with backoff; the buffer is
 *   bounded and drops the oldest events first when the server is unreachable for long;
 * - sampling: impressions and row views are sampled per app session (a sampled session logs
 *   all of them, so pages stay whole) and carry the rate;
 * - impressions and row views: an element counts once it has been at least half visible for one
 *   second while the page is visible, once per appearance (it counts again only after leaving
 *   the screen entirely and coming back). One IntersectionObserver serves every observed
 *   element, so a home page of hundreds of cards costs one observer, not hundreds;
 * - forgetting: `discard()` drops everything queued and abandons a request in flight, for the
 *   moments that must take effect at once (consent withdrawn, another profile, signed out).
 *
 * Zod-free (types and constants only from `@webflix/contracts`), DOM APIs only where present.
 */
import {
  API_BASE_PATH,
  CLIENT_HEADER,
  CLIENT_HEADER_VALUE,
  type ClientEventInput,
  type ClientEventType,
  EVENT_BATCH_MAX_BYTES,
  EVENT_BATCH_MAX_EVENTS,
  EVENT_VERSION,
  type EventContext,
  type EventPayload,
} from "@webflix/contracts";

export type ClientPlatform = ClientEventInput["app"]["platform"];
export type ConsentAnswer = { analytics: boolean; personalisation: boolean };

/** What `localStorage` offers (and what tests inject). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type ObserverConstructor = new (
  callback: (
    entries: { target: Element; isIntersecting: boolean; intersectionRatio: number }[],
  ) => void,
  options?: { threshold?: number | number[] },
) => { observe(target: Element): void; unobserve(target: Element): void; disconnect(): void };

/** What a row knows about itself for a `row.view`. */
export interface RowViewInput {
  rowKind: EventPayload<"row.view">["rowKind"];
  itemCount: number;
  context?: ContextInput;
}

export interface TelemetryOptions {
  app: { platform: ClientPlatform; version: string };
  /** Default `/api/v1/events` (same origin: the session cookie travels with it). */
  endpoint?: string;
  fetch?: typeof fetch;
  /** Where the anonymous device id is kept. Default `localStorage` when available. */
  storage?: KeyValueStorage | null;
  /**
   * A signed-out device's own consent answer (the banner, opt-in mode), sent with each batch;
   * undefined when it has not answered. When both purposes are refused nothing is queued.
   */
  consent?: () => ConsentAnswer | undefined;
  /** Share of app sessions that log impressions and row views, (0, 1]. Default 1. */
  impressionSampleRate?: number;
  /** Default 5000. */
  flushIntervalMs?: number;
  /** Events kept while the server cannot be reached; the oldest go first. Default 500. */
  maxBufferedEvents?: number;
  /** The page whose lifecycle triggers a final flush. Default the global `document`/`window`. */
  document?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> | null;
  window?: Pick<Window, "addEventListener" | "removeEventListener"> | null;
  /** IntersectionObserver for impressions. Default the global one; absent: impressions off. */
  IntersectionObserver?: ObserverConstructor | null;
  now?: () => number;
  random?: () => number;
  /** Called with every batch the server refused for good, and every send failure. */
  onError?: (error: TelemetryError) => void;
}

export interface TelemetryError {
  kind: "refused" | "retrying" | "overflow";
  status: number | null;
  events: number;
  detail?: string;
}

/** What a card or row knows about where it is, for impressions and the title-open after. */
export type ContextInput = Partial<EventContext>;

export interface Telemetry {
  readonly deviceId: string;
  /** Whether this app session logs impressions and row views. */
  readonly sampled: boolean;
  /**
   * Queue one event. Impressions and row views get `sampleRate` filled in. `occurredAt` (epoch
   * milliseconds) records an event that happened earlier than now, e.g. one held while the
   * app was still finding out whether it may collect.
   */
  track<T extends ClientEventType>(
    type: T,
    payload: Omit<EventPayload<T>, "sampleRate">,
    context?: ContextInput,
    options?: { occurredAt?: number },
  ): void;
  /** Context merged into every event (experiment assignments from `GET /session`...). */
  setDefaults(context: ContextInput): void;
  /**
   * Stop or resume collecting. Queued events stay and are still sent: when they must not be
   * (another profile, consent withdrawn), call `discard()` as well.
   */
  setEnabled(enabled: boolean): void;
  /**
   * Observe a card: one impression once it has been half visible for a second, and one more each
   * time it comes back after leaving the screen entirely. Returns a stop function.
   */
  observeImpression(
    element: Element,
    card: { titleId: string; context?: ContextInput },
  ): () => void;
  /** Observe a row: one `row.view` per appearance, as for a card's impression. */
  observeRowView(element: Element, row: RowViewInput): () => void;
  /** Send what is queued now (`keepalive` for page hide). */
  flush(options?: { keepalive?: boolean }): Promise<void>;
  /**
   * Forget everything queued, now: nothing queued so far is ever sent, a request in flight is
   * abandoned (aborted where it has not left yet; its answer, whenever it comes, changes
   * nothing), and pending retries stop. Observations and defaults stay.
   */
  discard(): void;
  /** Events waiting to be sent. */
  readonly pending: number;
  /**
   * Stop timers, observers and listeners. Queued events are flushed with keepalive, unless
   * `flush: false` (the app is dropping them: call `discard()` first or with it).
   */
  shutdown(options?: { flush?: boolean }): void;
}

/** Where the anonymous device id is kept (`localStorage`). */
export const DEVICE_ID_STORAGE_KEY = "webflix.deviceId";
const DEVICE_KEY = DEVICE_ID_STORAGE_KEY;
const IMPRESSION_DWELL_MS = 1000;
const IMPRESSION_RATIO = 0.5;
const MAX_BACKOFF_MS = 60_000;
/** Room for the batch envelope (`{"events":[...],"consent":{...}}`). */
const ENVELOPE_BYTES = 128;
const encoder = new TextEncoder();

const EMPTY_CONTEXT: EventContext = {
  surface: null,
  rowId: null,
  rowRank: null,
  rank: null,
  experiments: {},
  policy: null,
};

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** A UUIDv7 (RFC 9562): 48-bit milliseconds, version 7, variant 10, random bits. */
export function uuidV7(nowMs: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = Math.max(0, Math.floor(nowMs));
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function defaultStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage blocked (privacy settings): an id per page load instead
  }
}

function deviceIdFrom(storage: KeyValueStorage | null): string {
  try {
    const stored = storage?.getItem(DEVICE_KEY);
    if (stored && /^[A-Za-z0-9_-]{1,64}$/.test(stored)) return stored;
  } catch {
    // fall through: a fresh id
  }
  const fresh = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  try {
    storage?.setItem(DEVICE_KEY, fresh);
  } catch {
    // not persisted: still valid for this page
  }
  return fresh;
}

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get("Retry-After");
  if (value === null) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

export function createTelemetry(options: TelemetryOptions): Telemetry {
  const endpoint = options.endpoint ?? `${API_BASE_PATH}/events`;
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const flushIntervalMs = options.flushIntervalMs ?? 5000;
  const maxBuffered = options.maxBufferedEvents ?? 500;
  const sampleRate = options.impressionSampleRate ?? 1;
  if (!(sampleRate > 0 && sampleRate <= 1)) {
    throw new RangeError("impressionSampleRate must be in (0, 1]");
  }
  const doc = options.document === undefined ? (globalThis.document ?? null) : options.document;
  const win = options.window === undefined ? (globalThis.window ?? null) : options.window;
  const Observer =
    options.IntersectionObserver === undefined
      ? ((globalThis as { IntersectionObserver?: ObserverConstructor }).IntersectionObserver ??
        null)
      : options.IntersectionObserver;

  const deviceId = deviceIdFrom(options.storage === undefined ? defaultStorage() : options.storage);
  const sampled = random() < sampleRate;
  const queue: ClientEventInput[] = [];
  let sessionSeq = 0;
  let defaults: ContextInput = {};
  let enabled = true;
  let inFlight: Promise<void> | null = null;
  /** Aborts the request in flight (`discard`). */
  let inFlightAbort: AbortController | null = null;
  /**
   * Bumped by `discard()`. A request that started under an older generation must not touch the
   * queue when it settles: what it would splice off is no longer what it sent.
   */
  let generation = 0;
  let blockedUntil = 0;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function report(error: TelemetryError): void {
    try {
      options.onError?.(error);
    } catch {
      // a reporting callback must never break collection
    }
  }

  function schedule(delayMs = flushIntervalMs): void {
    if (timer !== null || queue.length === 0 || stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delayMs);
  }

  function enqueue(event: ClientEventInput): void {
    queue.push(event);
    if (queue.length > maxBuffered) {
      const dropped = queue.splice(0, queue.length - maxBuffered);
      report({ kind: "overflow", status: null, events: dropped.length });
    }
    if (queue.length >= EVENT_BATCH_MAX_EVENTS) void flush();
    else schedule();
  }

  /** The next batch: up to 50 events, within 64 KiB once serialised with its envelope. */
  function nextBatch(consent: ConsentAnswer | undefined): ClientEventInput[] {
    const batch: ClientEventInput[] = [];
    let bytes = ENVELOPE_BYTES + (consent ? encoder.encode(JSON.stringify(consent)).length : 0);
    for (const event of queue) {
      if (batch.length === EVENT_BATCH_MAX_EVENTS) break;
      const size = encoder.encode(JSON.stringify(event)).length + 1;
      if (bytes + size > EVENT_BATCH_MAX_BYTES && batch.length > 0) break;
      batch.push(event);
      bytes += size;
    }
    return batch;
  }

  async function sendOnce(keepalive: boolean): Promise<"sent" | "retry" | "empty"> {
    if (queue.length === 0) return "empty";
    const consent = options.consent?.();
    const batch = nextBatch(consent);
    const body = JSON.stringify(consent ? { events: batch, consent } : { events: batch });
    const sentUnder = generation;
    const abort = typeof AbortController === "undefined" ? null : new AbortController();
    inFlightAbort = abort;
    let response: Response;
    try {
      response = await send(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", [CLIENT_HEADER]: CLIENT_HEADER_VALUE },
        body,
        credentials: "same-origin",
        keepalive,
        ...(abort ? { signal: abort.signal } : {}),
      });
    } catch (error) {
      if (sentUnder !== generation) return "empty"; // discarded meanwhile: nothing to retry
      failures += 1;
      report({ kind: "retrying", status: null, events: batch.length, detail: String(error) });
      return "retry";
    } finally {
      if (inFlightAbort === abort) inFlightAbort = null;
    }
    if (sentUnder !== generation) return "empty";
    if (response.ok) {
      queue.splice(0, batch.length);
      failures = 0;
      return "sent";
    }
    if (response.status === 429 || response.status >= 500) {
      failures += 1;
      const wait = retryAfterMs(response);
      if (wait !== null) blockedUntil = now() + wait;
      report({ kind: "retrying", status: response.status, events: batch.length });
      return "retry";
    }
    // Refused as invalid (400, 413...): sending it again cannot succeed.
    queue.splice(0, batch.length);
    report({ kind: "refused", status: response.status, events: batch.length });
    return "sent";
  }

  async function drain(keepalive: boolean): Promise<void> {
    for (;;) {
      if (now() < blockedUntil && !keepalive) {
        schedule(blockedUntil - now());
        return;
      }
      const outcome = await sendOnce(keepalive);
      if (outcome === "empty") return;
      if (outcome === "retry") {
        const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures - 1, 6));
        schedule(Math.max(backoff, blockedUntil - now()));
        return;
      }
      if (keepalive) return; // one keepalive request: the page is going away
    }
  }

  function flush(flushOptions: { keepalive?: boolean } = {}): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (inFlight !== null) {
      return inFlight.then(() => (queue.length > 0 ? flush(flushOptions) : undefined));
    }
    if (queue.length === 0) return Promise.resolve();
    const current = drain(flushOptions.keepalive ?? false).finally(() => {
      if (inFlight === current) inFlight = null;
    });
    inFlight = current;
    return current;
  }

  function discard(): void {
    generation += 1;
    queue.length = 0;
    failures = 0;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    inFlightAbort?.abort();
    inFlightAbort = null;
    // The settled request finds the generation changed and leaves the (new) queue alone.
    inFlight = null;
  }

  function pageVisible(): boolean {
    return doc?.visibilityState !== "hidden";
  }

  // --- Visibility: one observer for every card and row ------------------------------------
  /**
   * One observed element. `counted` is this appearance's impression: set once the element has
   * been half visible for a second, cleared when it leaves the screen entirely (not a pixel in
   * view). So a card counts once however long it stays, and again when it comes back after
   * leaving (scrolled past, paged away): one impression per appearance, as the pipeline reads.
   */
  interface Watcher {
    element: Element;
    onSeen: () => void;
    visible: boolean;
    dwell: ReturnType<typeof setTimeout> | null;
    counted: boolean;
  }
  const watchers = new Map<Element, Set<Watcher>>();
  let observer: InstanceType<ObserverConstructor> | null = null;

  function arm(watcher: Watcher): void {
    if (watcher.dwell !== null || watcher.counted || !watcher.visible || !pageVisible()) return;
    watcher.dwell = setTimeout(() => {
      watcher.dwell = null;
      if (!pageVisible() || !watcher.visible || watcher.counted) return;
      watcher.counted = true;
      watcher.onSeen();
    }, IMPRESSION_DWELL_MS);
  }

  function disarm(watcher: Watcher): void {
    if (watcher.dwell === null) return;
    clearTimeout(watcher.dwell);
    watcher.dwell = null;
  }

  function visibilityObserver(): InstanceType<ObserverConstructor> | null {
    if (observer || !Observer) return observer;
    observer = new Observer(
      (entries) => {
        for (const entry of entries) {
          const visible = entry.isIntersecting && entry.intersectionRatio >= IMPRESSION_RATIO;
          for (const watcher of watchers.get(entry.target) ?? []) {
            watcher.visible = visible;
            // Gone from the screen entirely: the next time it is seen is a new appearance.
            if (!entry.isIntersecting) watcher.counted = false;
            if (visible) arm(watcher);
            else disarm(watcher);
          }
        }
      },
      { threshold: [0, IMPRESSION_RATIO, 1] },
    );
    return observer;
  }

  function unwatch(watcher: Watcher): void {
    disarm(watcher);
    const set = watchers.get(watcher.element);
    if (!set) return;
    set.delete(watcher);
    if (set.size === 0) {
      watchers.delete(watcher.element);
      observer?.unobserve(watcher.element);
    }
  }

  /**
   * Call `onSeen` once per appearance of `element`: after it has been half visible for a second,
   * and again only after it has left the screen entirely and come back. Until stopped.
   */
  function watch(element: Element, onSeen: () => void): () => void {
    const io = stopped ? null : visibilityObserver();
    if (!io) return () => {};
    const watcher: Watcher = { element, onSeen, visible: false, dwell: null, counted: false };
    const set = watchers.get(element);
    if (set) set.add(watcher);
    else {
      watchers.set(element, new Set([watcher]));
      io.observe(element);
    }
    return () => unwatch(watcher);
  }

  function onHidden(): void {
    if (doc?.visibilityState === "hidden") {
      // A second spent in a background tab is not a second looked at.
      for (const set of watchers.values()) for (const watcher of set) disarm(watcher);
      void flush({ keepalive: true });
    } else {
      for (const set of watchers.values()) for (const watcher of set) arm(watcher);
    }
  }
  function onPageHide(): void {
    void flush({ keepalive: true });
  }
  doc?.addEventListener("visibilitychange", onHidden);
  win?.addEventListener("pagehide", onPageHide);

  function track<T extends ClientEventType>(
    type: T,
    payload: Omit<EventPayload<T>, "sampleRate">,
    context: ContextInput = {},
    trackOptions: { occurredAt?: number } = {},
  ): void {
    if (!enabled || stopped) return;
    const consent = options.consent?.();
    if (consent && !consent.analytics && !consent.personalisation) return;
    const sampledType = type === "impression" || type === "row.view";
    if (sampledType && !sampled) return;
    const at = trackOptions.occurredAt ?? now();
    const event = {
      eventId: uuidV7(at),
      type,
      version: EVENT_VERSION,
      occurredAt: new Date(at).toISOString(),
      deviceId,
      sessionSeq,
      app: { platform: options.app.platform, version: options.app.version },
      context: {
        ...EMPTY_CONTEXT,
        ...defaults,
        ...context,
        experiments: { ...(defaults.experiments ?? {}), ...(context.experiments ?? {}) },
      },
      payload: sampledType ? { ...payload, sampleRate } : { ...payload },
    } as unknown as ClientEventInput;
    sessionSeq += 1;
    enqueue(event);
  }

  function observeImpression(
    element: Element,
    card: { titleId: string; context?: ContextInput },
  ): () => void {
    if (!sampled) return () => {};
    return watch(element, () => track("impression", { titleId: card.titleId }, card.context));
  }

  function observeRowView(element: Element, row: RowViewInput): () => void {
    if (!sampled) return () => {};
    return watch(element, () =>
      track("row.view", { rowKind: row.rowKind, itemCount: row.itemCount }, row.context),
    );
  }

  return {
    deviceId,
    sampled,
    track,
    setDefaults(context) {
      defaults = { ...defaults, ...context };
    },
    setEnabled(value) {
      enabled = value;
    },
    observeImpression,
    observeRowView,
    flush,
    discard,
    get pending() {
      return queue.length;
    },
    shutdown(shutdownOptions = {}) {
      doc?.removeEventListener("visibilitychange", onHidden);
      win?.removeEventListener("pagehide", onPageHide);
      for (const set of watchers.values()) for (const watcher of set) disarm(watcher);
      watchers.clear();
      observer?.disconnect();
      observer = null;
      if (shutdownOptions.flush ?? true) void flush({ keepalive: true });
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
