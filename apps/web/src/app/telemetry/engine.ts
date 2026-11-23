/**
 * The telemetry engine: the one place the web event SDK (`@webflix/telemetry`) lives,
 * wired to the session (who is signed in, which profile, which experiment assignments) and to
 * the consent in force (`./consent.ts`, `./policy.ts`).
 *
 * The invariant: while the policy says "collect", an SDK exists and events flow into it. While
 * it says "none", no SDK exists: nothing is queued, nothing is sent, and no device identifier is
 * kept in the browser. While it is "pending" (the consent is still being read), events are held
 * in memory only, then handed over with their own time if collection is allowed, or dropped.
 *
 * Moments that take effect at once, including for events already waiting to be sent:
 * - another identity (profile switch, the gate, sign-in, sign-out): everything queued or held
 *   is dropped, never sent as someone else's;
 * - a restricted profile becomes active: no SDK, no device id;
 * - consent withdrawn for any purpose: the queue is emptied (and if nothing is left granted,
 *   the SDK and the device id go too).
 *
 * Screens never see any of this: they call the light surface in `./runtime.ts` (`track()`, the
 * observers), which hands over to this engine once it has loaded. The engine and the SDK are
 * their own chunk, loaded when the page is idle: a signed-out landing page never downloads them.
 */
import type { QueryCacheNotifyEvent, QueryClient } from "@tanstack/react-query";
import {
  ApiError,
  type ClientEventType,
  type ConsentState,
  type EventBatch,
  type SessionState,
} from "@webflix/contracts";
import {
  createTelemetry,
  DEVICE_ID_STORAGE_KEY,
  type Telemetry,
  type TelemetryOptions,
} from "@webflix/telemetry";
import { api } from "../api.ts";
import { qk } from "../query/keys.ts";
import { consentKey, consentOwner, consentQuery, isConsentKey } from "./consent.ts";
import {
  browserGpc,
  type CollectionPolicy,
  collectionPolicy,
  identityOf,
  isRestrictedSession,
  type Purposes,
  withdrew,
} from "./policy.ts";
import {
  attachEngine,
  detachEngine,
  type Observation,
  registry,
  type TelemetryContext,
  type TelemetryEngine,
  type TrackPayload,
} from "./runtime.ts";

/** The release the events say they come from (`app.version`, 1 to 40 characters). */
const APP_VERSION = (import.meta.env.VITE_WEBFLIX_RELEASE as string | undefined) || "dev";
/**
 * Share of app sessions that log impressions and row views. Every session in this spike; a
 * deployment with real traffic lowers it (the events carry the rate, so counts scale back up).
 */
const IMPRESSION_SAMPLE_RATE = 1;
/**
 * How often a batch goes out while the page is open. Events are not urgent and every request
 * competes with the member's own (artwork, playback, navigation): one batch every 15 s is a few
 * requests a minute at most, and a page that is hidden or closed sends what it holds at once.
 */
const FLUSH_INTERVAL_MS = 15_000;
/**
 * The API calls that change who events are about: signing in or up, signing out, choosing or
 * leaving a profile. While one is in flight nothing is tracked or sent (see `guardIdentityChanges`).
 */
const IDENTITY_CHANGES = [
  "login",
  "signup",
  "logout",
  "logoutAll",
  "selectProfile",
  "clearProfile",
] as const;
/**
 * After such a call settles, the app writes the new session into the cache a moment later (the
 * caller's `applySession`); until then, or this long, nothing is tracked either.
 */
const IDENTITY_SETTLE_MS = 1500;
const GUARDED = Symbol("telemetry.identity-guard");
/** Which account the stored device id was made under (`anonymous` for the signed-out device). */
const DEVICE_OWNER_STORAGE_KEY = "webflix.deviceId.owner";

function deviceOwnerOf(session: SessionState): string {
  return session.authenticated ? `account:${session.account.id}` : "anonymous";
}
/** Events held while the consent is read; beyond this the oldest go. */
const MAX_HELD = 100;
/** A consent read that failed is tried again after this long (nothing is collected meanwhile). */
const CONSENT_RETRY_MS = 60_000;

interface Held {
  type: ClientEventType;
  payload: object;
  context: TelemetryContext | undefined;
  at: number;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface TelemetryRuntimeOptions {
  queryClient: QueryClient;
  /** The SDK factory (tests pass one with a fake transport and clock). */
  createSdk?: (options: TelemetryOptions) => Telemetry;
  /** Global Privacy Control (default `navigator.globalPrivacyControl`). */
  gpc?: () => boolean;
  /** Where the SDK keeps the device id (default `localStorage`). */
  storage?: StorageLike | null;
  /** Defers the consent read off the critical path (default `requestIdleCallback`). */
  whenIdle?: (run: () => void) => () => void;
  now?: () => number;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function defaultWhenIdle(run: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(run, { timeout: 1500 });
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(run, 0);
  return () => clearTimeout(handle);
}

/**
 * The SDK's transport, through the app's API client: same origin, the session cookie, the
 * client header, `keepalive` on page hide, and the in-browser mock in mock mode. Problems come
 * back as their HTTP status (with `Retry-After`), so the SDK's retry rules apply unchanged.
 */
const sendThroughApi: typeof fetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body)) as EventBatch;
  try {
    const ack = await api().ingestEvents(
      { body },
      {
        ...(init?.keepalive ? { keepalive: true } : {}),
        ...(init?.signal ? { signal: init.signal } : {}),
      },
    );
    return new Response(JSON.stringify(ack), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    if (!ApiError.is(error) || error.status === 0) throw error; // offline, aborted: retry
    const headers = new Headers();
    const retryAfter = (error.problem as { retryAfterSec?: unknown }).retryAfterSec;
    if (typeof retryAfter === "number") headers.set("Retry-After", String(retryAfter));
    return new Response(null, { status: error.status, headers });
  }
};

export class TelemetryRuntime implements TelemetryEngine {
  private readonly queryClient: QueryClient;
  private readonly createSdk: (options: TelemetryOptions) => Telemetry;
  private readonly gpc: () => boolean;
  private readonly storage: StorageLike | null;
  private readonly whenIdle: (run: () => void) => () => void;
  private readonly now: () => number;

  private sdk: Telemetry | null = null;
  private identity: string | null = null;
  private policy: CollectionPolicy = { decision: "pending", waitingFor: "session" };
  private granted: Purposes | null = null;
  private held: Held[] = [];
  private experiments: Record<string, string> = {};
  private readonly attached = new Map<number, () => void>();
  private consentRequest: { owner: string; cancel: () => void } | null = null;
  private consentRetry: ReturnType<typeof setTimeout> | null = null;
  private stopListening: (() => void) | null = null;
  private unguard: (() => void) | null = null;
  /** Identity-changing calls in flight, and whether their new session is still to arrive. */
  private changing = 0;
  private settling: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TelemetryRuntimeOptions) {
    this.queryClient = options.queryClient;
    this.createSdk = options.createSdk ?? createTelemetry;
    this.gpc = options.gpc ?? browserGpc;
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.whenIdle = options.whenIdle ?? defaultWhenIdle;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.stopListening) return;
    this.stopListening = this.queryClient.getQueryCache().subscribe((event) => {
      if (this.concerns(event)) this.sync();
    });
    this.unguard = this.guardIdentityChanges();
    this.sync();
  }

  /** Stop everything; what is queued is sent with keepalive (the app is going away). */
  stop(): void {
    this.stopListening?.();
    this.stopListening = null;
    this.unguard?.();
    this.unguard = null;
    if (this.settling !== null) clearTimeout(this.settling);
    this.settling = null;
    this.changing = 0;
    this.cancelConsentRequest();
    this.detachAll();
    this.sdk?.shutdown();
    this.sdk = null;
    this.held = [];
    this.identity = null;
    this.granted = null;
    this.policy = { decision: "pending", waitingFor: "session" };
  }

  /** What the runtime decided, for tests and the dev tools. */
  get state(): { policy: CollectionPolicy; pending: number; held: number; sdk: boolean } {
    return {
      policy: this.policy,
      pending: this.sdk?.pending ?? 0,
      held: this.held.length,
      sdk: this.sdk !== null,
    };
  }

  track<T extends ClientEventType>(
    type: T,
    payload: TrackPayload<T>,
    context?: TelemetryContext,
  ): void {
    // Who this event would be about is changing: it belongs to nobody the server will know.
    if (this.changing > 0 || this.settling !== null) return;
    switch (this.policy.decision) {
      case "collect":
        this.sdk?.track(type, payload, context);
        return;
      case "pending":
        this.held.push({ type, payload, context, at: this.now() });
        if (this.held.length > MAX_HELD) this.held.splice(0, this.held.length - MAX_HELD);
        // A signed-out device reads the consent only once there is something to decide about.
        if (this.policy.waitingFor === "consent") this.requestConsentFor(this.currentSession());
        return;
      case "none":
        return;
    }
  }

  /** Forget what is queued or held, keep collecting (`discardPendingEvents`). */
  discardPending(): void {
    this.held = [];
    this.sdk?.discard();
  }

  /**
   * Wrap the API client's identity-changing calls: the moment one starts, everything queued is
   * dropped (and a batch in flight abandoned), and nothing is tracked until the new session is in
   * the cache. Without it, a batch sent between the server switching identity and the app
   * learning of it would be stamped with the new identity: another profile's, or nobody's.
   * Screens may also call `discardPendingEvents()` before such a call; both guards hold alone.
   */
  private guardIdentityChanges(): () => void {
    let client: Record<string, unknown>;
    try {
      client = api() as unknown as Record<string, unknown>;
    } catch {
      return () => {}; // no client yet (tests that build the runtime alone)
    }
    const replaced: Array<[string, unknown]> = [];
    for (const name of IDENTITY_CHANGES) {
      const original = client[name];
      if (typeof original !== "function" || GUARDED in original) continue;
      const call = original as (...args: unknown[]) => Promise<unknown>;
      const guarded = (...args: unknown[]) => {
        this.beginIdentityChange();
        let result: Promise<unknown>;
        try {
          result = Promise.resolve(call.apply(client, args));
        } catch (error) {
          this.endIdentityChange();
          throw error;
        }
        return result.finally(() => this.endIdentityChange());
      };
      Object.defineProperty(guarded, GUARDED, { value: true });
      try {
        client[name] = guarded;
        replaced.push([name, original]);
      } catch {
        // a frozen client: the session-change guard in `sync` still holds
      }
    }
    return () => {
      for (const [name, original] of replaced) client[name] = original;
    };
  }

  private beginIdentityChange(): void {
    this.changing += 1;
    if (this.settling !== null) clearTimeout(this.settling);
    this.settling = null;
    this.discardPending();
  }

  private endIdentityChange(): void {
    this.changing = Math.max(0, this.changing - 1);
    if (this.changing > 0) return;
    // The caller applies the new session right after; `sync` ends the wait when it arrives.
    this.settling = setTimeout(() => {
      this.settling = null;
    }, IDENTITY_SETTLE_MS);
  }

  /** A card or row asked to be observed (`registry`). */
  observed(id: number, observation: Observation): void {
    if (this.sdk) this.attach(id, observation);
    else if (this.policy.decision === "pending" && this.policy.waitingFor === "consent") {
      this.requestConsentFor(this.currentSession());
    }
  }

  /** A card or row is gone, or no longer wants observing. */
  unobserved(id: number): void {
    this.attached.get(id)?.();
    this.attached.delete(id);
  }

  // --- Following the session and the consent -----------------------------------------------

  private concerns(event: QueryCacheNotifyEvent): boolean {
    if (event.type !== "added" && event.type !== "removed" && event.type !== "updated") {
      return false;
    }
    if (event.type === "updated" && event.action.type !== "success") {
      // Only settled data moves the policy (a refetch in flight keeps what is in force).
      if (event.action.type !== "setState") return false;
    }
    const key = event.query.queryKey;
    const session = qk.session();
    return (
      (key[0] === session[0] && key[1] === session[1] && key.length === 2) || isConsentKey(key)
    );
  }

  private currentSession(): SessionState | undefined {
    return this.queryClient.getQueryData<SessionState>(qk.session());
  }

  private sync(): void {
    const session = this.currentSession();
    if (session) {
      const identity = identityOf(session);
      if (this.identity !== null && identity !== this.identity) this.forgetIdentity();
      // The device id belongs to one account (or to the signed-out device): never carried
      // into another, so two accounts that used this browser cannot be linked (review L4).
      this.claimDeviceId(deviceOwnerOf(session));
      // The session an identity change was waiting for has arrived (or another did).
      if (this.changing === 0 && this.settling !== null) {
        clearTimeout(this.settling);
        this.settling = null;
      }
      this.identity = identity;
      this.experiments = session.experiments ?? {};
    }
    const consent =
      session && !isRestrictedSession(session)
        ? this.queryClient.getQueryData<ConsentState>(consentKey(consentOwner(session)))
        : undefined;
    const policy = collectionPolicy({ session, consent, gpc: this.gpc() });
    // Signed in, the prompt needs the consent anyway: read it once the page is idle. Signed
    // out, nothing is read until there is an event to decide about.
    if (
      policy.decision === "pending" &&
      policy.waitingFor === "consent" &&
      session?.authenticated
    ) {
      this.requestConsentFor(session);
    }
    this.apply(policy);
  }

  private apply(policy: CollectionPolicy): void {
    this.policy = policy;
    if (policy.decision === "pending") return;
    if (policy.decision === "none") {
      this.held = [];
      this.granted = null;
      this.dispose();
      return;
    }
    if (withdrew(this.granted, policy.purposes)) this.sdk?.discard();
    this.granted = policy.purposes;
    if (!this.sdk) {
      this.sdk = this.createSdk({
        app: { platform: "web", version: APP_VERSION },
        fetch: sendThroughApi,
        storage: this.storage,
        impressionSampleRate: IMPRESSION_SAMPLE_RATE,
        flushIntervalMs: FLUSH_INTERVAL_MS,
      });
      for (const [id, observation] of registry.observations) this.attach(id, observation);
    }
    this.sdk.setDefaults({ experiments: this.experiments });
    const held = this.held;
    this.held = [];
    for (const event of held) {
      this.sdk.track(event.type, event.payload as TrackPayload<typeof event.type>, event.context, {
        occurredAt: event.at,
      });
    }
  }

  /** Another identity: nothing queued or held for the previous one may ever be sent. */
  private forgetIdentity(): void {
    this.held = [];
    this.granted = null;
    this.cancelConsentRequest();
    if (this.sdk) {
      this.detachAll();
      this.sdk.discard();
      this.sdk.shutdown({ flush: false });
      this.sdk = null;
    }
  }

  /**
   * Keep the stored device id only for the account it was made under: another account (or the
   * signed-out device after an account, or the other way round) starts with a fresh one.
   */
  private claimDeviceId(owner: string): void {
    try {
      const previous = this.storage?.getItem(DEVICE_OWNER_STORAGE_KEY) ?? null;
      if (previous === owner) return;
      if (previous !== null || this.storage?.getItem(DEVICE_ID_STORAGE_KEY) !== null) {
        if (this.sdk) {
          this.detachAll();
          this.sdk.discard();
          this.sdk.shutdown({ flush: false });
          this.sdk = null;
        }
        this.storage?.removeItem(DEVICE_ID_STORAGE_KEY);
      }
      this.storage?.setItem(DEVICE_OWNER_STORAGE_KEY, owner);
    } catch {
      // storage blocked: the SDK keeps an id for this page only, which no other account sees
    }
  }

  /** Collection is not allowed: no SDK, nothing queued, no device id kept. */
  private dispose(): void {
    if (this.sdk) {
      this.detachAll();
      this.sdk.discard();
      this.sdk.shutdown({ flush: false });
      this.sdk = null;
    }
    try {
      this.storage?.removeItem(DEVICE_ID_STORAGE_KEY);
    } catch {
      // storage blocked: nothing was kept there either
    }
  }

  private attach(id: number, observation: Observation): void {
    if (!this.sdk || this.attached.has(id)) return;
    const stop =
      observation.kind === "impression"
        ? this.sdk.observeImpression(observation.element, observation.card)
        : this.sdk.observeRowView(observation.element, observation.row);
    this.attached.set(id, stop);
  }

  private detachAll(): void {
    for (const stop of this.attached.values()) stop();
    this.attached.clear();
  }

  // --- Reading the consent off the critical path -------------------------------------------

  private requestConsentFor(session: SessionState | undefined): void {
    if (!session) return;
    const owner = consentOwner(session);
    if (this.consentRequest?.owner === owner || this.consentRetry !== null) return;
    this.cancelConsentRequest();
    const cancel = this.whenIdle(() => {
      this.queryClient.fetchQuery(consentQuery(owner)).then(
        () => {
          if (this.consentRequest?.owner === owner) this.consentRequest = null;
        },
        () => {
          if (this.consentRequest?.owner !== owner) return;
          this.consentRequest = null;
          // Unknown consent collects nothing; ask again later, quietly.
          this.consentRetry = setTimeout(() => {
            this.consentRetry = null;
            if (this.stopListening) this.sync();
          }, CONSENT_RETRY_MS);
        },
      );
    });
    this.consentRequest = { owner, cancel };
  }

  private cancelConsentRequest(): void {
    this.consentRequest?.cancel();
    this.consentRequest = null;
    if (this.consentRetry !== null) clearTimeout(this.consentRetry);
    this.consentRetry = null;
  }
}

// --- Starting and stopping ----------------------------------------------------------------------

let current: TelemetryRuntime | null = null;

/** Start the engine for this app instance (`<TelemetryRuntimeMount />` does, once idle). */
export function startTelemetry(options: TelemetryRuntimeOptions): TelemetryRuntime {
  if (current) stopTelemetry(current);
  current = new TelemetryRuntime(options);
  attachEngine(current);
  current.start();
  return current;
}

export function stopTelemetry(runtime: TelemetryRuntime): void {
  detachEngine(runtime);
  runtime.stop();
  if (current === runtime) current = null;
}
