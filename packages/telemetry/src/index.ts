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
 * - impressions: a card counts once it has been at least half visible for one second.
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
  /** Queue one event. Impressions and row views get `sampleRate` filled in. */
  track<T extends ClientEventType>(
    type: T,
    payload: Omit<EventPayload<T>, "sampleRate">,
    context?: ContextInput,
  ): void;
  /** Context merged into every event (experiment assignments from `GET /session`...). */
  setDefaults(context: ContextInput): void;
  /** Stop or resume collecting (e.g. while a kids profile is active). Queued events stay. */
  setEnabled(enabled: boolean): void;
  /** Observe a card: one impression once it has been half visible for a second. */
  observeImpression(
    element: Element,
    card: { titleId: string; context?: ContextInput },
  ): () => void;
  /** Send what is queued now (`keepalive` for page hide). */
  flush(options?: { keepalive?: boolean }): Promise<void>;
  /** Events waiting to be sent. */
  readonly pending: number;
  /** Stop timers and listeners (queued events are flushed with keepalive). */
  shutdown(): void;
}

const DEVICE_KEY = "webflix.deviceId";
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
  let blockedUntil = 0;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function report(error: TelemetryError): void {
    try {
      options.onError?.(error);
    } catch {
      // a reporting callback must never break collection
    }
  }

  function schedule(delayMs = flushIntervalMs): void {
    if (timer !== null || queue.length === 0) return;
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
    let response: Response;
    try {
      response = await send(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", [CLIENT_HEADER]: CLIENT_HEADER_VALUE },
        body,
        credentials: "same-origin",
        keepalive,
      });
    } catch (error) {
      failures += 1;
      report({ kind: "retrying", status: null, events: batch.length, detail: String(error) });
      return "retry";
    }
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
    inFlight = drain(flushOptions.keepalive ?? false).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function onHidden(): void {
    if (doc?.visibilityState === "hidden") void flush({ keepalive: true });
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
  ): void {
    if (!enabled) return;
    const consent = options.consent?.();
    if (consent && !consent.analytics && !consent.personalisation) return;
    const sampledType = type === "impression" || type === "row.view";
    if (sampledType && !sampled) return;
    const at = now();
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
    if (!Observer || !sampled) return () => {};
    let dwell: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const observer = new Observer(
      (entries) => {
        for (const entry of entries) {
          if (entry.target !== element || done) continue;
          const visible = entry.isIntersecting && entry.intersectionRatio >= IMPRESSION_RATIO;
          if (visible && dwell === null) {
            dwell = setTimeout(() => {
              done = true;
              observer.disconnect();
              track("impression", { titleId: card.titleId }, card.context);
            }, IMPRESSION_DWELL_MS);
          } else if (!visible && dwell !== null) {
            clearTimeout(dwell);
            dwell = null;
          }
        }
      },
      { threshold: [0, IMPRESSION_RATIO, 1] },
    );
    observer.observe(element);
    return () => {
      if (dwell !== null) clearTimeout(dwell);
      observer.disconnect();
    };
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
    flush,
    get pending() {
      return queue.length;
    },
    shutdown() {
      doc?.removeEventListener("visibilitychange", onHidden);
      win?.removeEventListener("pagehide", onPageHide);
      void flush({ keepalive: true });
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
