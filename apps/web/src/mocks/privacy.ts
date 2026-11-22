/**
 * Mock of the events area's member routes (docs/BACKEND.md §3, "Behaviour events and privacy"):
 * consent per account under the deployment's mode, behaviour events, "Download your data" and
 * account deletion. Its state is kept beside the main mock state (its own storage key) so the
 * rest of the mock is untouched; `?mock-session=` resets both.
 *
 * - `?mock-consent=opt-in|opt-out|off` picks the deployment's consent mode (default opt-in, the
 *   mode that asks), and is remembered.
 * - Global Privacy Control is read from the browser (`navigator.globalPrivacyControl`), as the
 *   server reads `Sec-GPC`: in opt-out mode it records a `gpc` withdrawal for each purpose the
 *   member never answered.
 * - An export completes a few seconds after it is requested (a dev server's inline job);
 *   `?mock-export=batch` plays a deployment whose export waits for a scheduled job instead (it
 *   stays "processing"). A deletion is scheduled fourteen days out (the server's default) and
 *   stops the membership's renewals, as the server does; keeping the account leaves it set to end.
 * - The export email's link (`/account/privacy/exports/{id}#token=…`) works against
 *   `downloadDataExport` with the token `mock-{id}`.
 * - Accepted events are kept in memory, newest last, at `globalThis.__WEBFLIX_MOCK_EVENTS__`
 *   for browser specs.
 */
import {
  type ClientEventInput,
  CONSENT_MODES,
  type ConsentPurpose,
  type ConsentState,
  type DataExport,
  DEFAULT_MATURITY_CEILING,
  type DeletionMembership,
  MATURITY_LEVELS,
  type PrivacyRequest,
  type PrivacyTerms,
} from "@webflix/contracts";
import { billingOf } from "./billing.ts";
import { type MockHandlers, MockProblem } from "./handlers.ts";
import { MOCK_SESSION_PARAM, type MockState, saveState } from "./state.ts";

type ConsentMode = ConsentState["mode"];
type Source = "banner" | "settings" | "gpc" | "support";

interface ConsentRecord {
  granted: boolean;
  source: Source;
  at: string;
}

interface MockPrivacyState {
  mode: ConsentMode;
  /** Who reads an export's events: the export itself (seconds) or a scheduled job (never, here). */
  exportMode?: "inline" | "batch";
  /** accountId → purpose → latest answer */
  consents: Record<string, Partial<Record<ConsentPurpose, ConsentRecord>>>;
  /** accountId → requests, newest first */
  requests: Record<string, PrivacyRequest[]>;
}

const STORAGE_KEY = "webflix:mock-privacy";
const MODE_PARAM = "mock-consent";
const EXPORT_PARAM = "mock-export";
const PURPOSES: readonly ConsentPurpose[] = ["analytics", "personalisation"];
const EXPLICIT: ReadonlySet<Source> = new Set(["banner", "settings", "support"]);
/** How long the mock's export "job" takes. */
const EXPORT_MS = 4000;
const COOLING_OFF_MS = 14 * 86_400_000;
const LINK_TTL_MS = 7 * 86_400_000;

function termsOf(store: MockPrivacyState): PrivacyTerms {
  const batch = store.exportMode === "batch";
  return {
    deletionCoolingOffSec: COOLING_OFF_MS / 1000,
    exportLinkTtlSec: LINK_TTL_MS / 1000,
    exportMode: batch ? "batch" : "inline",
    exportTypicalSec: batch ? 1800 : 60,
    eventsRetentionDays: 395,
    aggregatesRetentionDays: 1125,
  };
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function urlParams(): URLSearchParams | null {
  return typeof location === "undefined" ? null : new URLSearchParams(location.search);
}

function load(): MockPrivacyState {
  const params = urlParams();
  const requested = params?.get(MODE_PARAM);
  const mode = (CONSENT_MODES as readonly string[]).includes(requested ?? "")
    ? (requested as ConsentMode)
    : null;
  let state: MockPrivacyState | null = null;
  if (!params?.has(MOCK_SESSION_PARAM)) {
    try {
      const raw = storage()?.getItem(STORAGE_KEY);
      state = raw ? (JSON.parse(raw) as MockPrivacyState) : null;
    } catch {
      state = null;
    }
  }
  state ??= { mode: "opt-in", consents: {}, requests: {} };
  if (mode) state.mode = mode;
  const exportMode = params?.get(EXPORT_PARAM);
  if (exportMode === "batch" || exportMode === "inline") state.exportMode = exportMode;
  save(state);
  return state;
}

function save(state: MockPrivacyState): void {
  storage()?.setItem(STORAGE_KEY, JSON.stringify(state));
}

let cached: MockPrivacyState | null = null;
function privacy(): MockPrivacyState {
  cached ??= load();
  return cached;
}

/** Forget every answer and request (tests), keeping or setting the mode. */
export function resetMockPrivacy(mode: ConsentMode = "opt-in"): void {
  cached = { mode, consents: {}, requests: {} };
  save(cached);
  events.length = 0;
}

/** Put requests on an account (tests: an export already ready, expired, failed...). */
export function setMockPrivacyRequests(accountId: string, requests: PrivacyRequest[]): void {
  const store = privacy();
  store.requests[accountId] = requests;
  save(store);
}

/** Inline or batch exports (tests; `?mock-export=` in the browser). */
export function setMockExportMode(mode: "inline" | "batch"): void {
  const store = privacy();
  store.exportMode = mode;
  save(store);
}

/** Switch the deployment's consent mode (tests; `?mock-consent=` in the browser). */
export function setMockConsentMode(mode: ConsentMode): void {
  const store = privacy();
  store.mode = mode;
  save(store);
}

const events: ClientEventInput[] = [];
(globalThis as { __WEBFLIX_MOCK_EVENTS__?: ClientEventInput[] }).__WEBFLIX_MOCK_EVENTS__ = events;

function gpc(): boolean {
  return (
    typeof navigator !== "undefined" &&
    (navigator as { globalPrivacyControl?: unknown }).globalPrivacyControl === true
  );
}

function iso(ms = Date.now()): string {
  return new Date(ms).toISOString();
}

function activeProfile(state: MockState) {
  return state.profiles.find((profile) => profile.id === state.activeProfileId);
}

function restricted(state: MockState): boolean {
  const profile = activeProfile(state);
  if (!profile) return false;
  return (
    profile.isKids ||
    MATURITY_LEVELS.indexOf(profile.maturityCeiling) <
      MATURITY_LEVELS.indexOf(DEFAULT_MATURITY_CEILING)
  );
}

function requireAccountHolder(state: MockState): void {
  if (!state.signedIn) throw new MockProblem("unauthenticated");
  if (!activeProfile(state)) throw new MockProblem("profile_required");
  if (restricted(state)) throw new MockProblem("unrestricted_profile_required");
}

function answersOf(
  store: MockPrivacyState,
  accountId: string,
): Partial<Record<ConsentPurpose, ConsentRecord>> {
  const answers = store.consents[accountId] ?? {};
  store.consents[accountId] = answers;
  return answers;
}

/** The consent in force, as `GET /privacy/consent` presents it (the server's rules). */
function consentState(state: MockState): ConsentState {
  const store = privacy();
  const signal = gpc();
  const mode = store.mode;
  const fallback = mode === "opt-out";
  if (!state.signedIn) {
    const granted = mode !== "off" && fallback && !signal;
    const purpose = { granted, source: null, updatedAt: null };
    return {
      mode,
      gpc: signal,
      promptRequired: false,
      purposes: { analytics: { ...purpose }, personalisation: { ...purpose } },
    };
  }
  const answers = answersOf(store, state.account.id);
  if (signal && mode === "opt-out") {
    // Global Privacy Control withdraws what the member never answered themselves.
    for (const purpose of PURPOSES) {
      const record = answers[purpose];
      if (!record || (record.granted && !EXPLICIT.has(record.source))) {
        answers[purpose] = { granted: false, source: "gpc", at: iso() };
      }
    }
    save(store);
  }
  const present = (purpose: ConsentPurpose) => {
    const record = answers[purpose];
    return {
      granted: mode !== "off" && (record ? record.granted : fallback),
      source: record?.source ?? null,
      updatedAt: record?.at ?? null,
    };
  };
  return {
    mode,
    gpc: signal,
    promptRequired:
      mode === "opt-in" &&
      PURPOSES.some((purpose) => {
        const record = answers[purpose];
        return !record || !EXPLICIT.has(record.source);
      }),
    purposes: { analytics: present("analytics"), personalisation: present("personalisation") },
  };
}

/** Requests as the member sees them, moved along by the clock (the mock's "jobs"). */
function requestsOf(state: MockState): PrivacyRequest[] {
  const store = privacy();
  const list = store.requests[state.account.id] ?? [];
  store.requests[state.account.id] = list;
  const now = Date.now();
  let changed = false;
  for (const request of list) {
    if (request.kind === "deletion") {
      changed = followMembership(state, request) || changed;
      continue;
    }
    const age = now - Date.parse(request.requestedAt);
    if (request.status === "pending" && age > 800) {
      request.status = "processing";
      changed = true;
    }
    if (request.status === "processing" && age > EXPORT_MS && store.exportMode !== "batch") {
      const done = Date.parse(request.requestedAt) + EXPORT_MS;
      request.status = "completed";
      request.completedAt = iso(done);
      request.expiresAt = iso(done + LINK_TTL_MS);
      request.downloadUrl = `/api/v1/privacy/exports/${request.id}?token=mock-${request.id}`;
      changed = true;
    }
    if (
      request.status === "completed" &&
      request.expiresAt &&
      Date.parse(request.expiresAt) < now &&
      request.downloadUrl
    ) {
      request.downloadUrl = null;
      changed = true;
    }
  }
  if (changed) save(store);
  return list;
}

/** When the membership's current period (or free trial) closes. */
function periodEndOf(state: MockState): string | null {
  const m = billingOf(state).membership;
  return m.status === "trialing" ? (m.trialEndsAt ?? m.currentPeriodEnd) : m.currentPeriodEnd;
}

/**
 * Scheduling a deletion stops the renewals (billing's cancel), as the server does: the
 * membership ends at the earlier of its period's close and the erasure.
 */
function stopRenewals(state: MockState, scheduledFor: string): DeletionMembership {
  const billing = billingOf(state);
  const m = billing.membership;
  if (!["trialing", "active", "past_due", "suspended"].includes(m.status)) {
    return { status: m.status === "canceled" ? "ended" : "none", endsAt: null, resumable: false };
  }
  billing.membership = { ...m, cancelAtPeriodEnd: true };
  state.subscriptionStatus = "canceling";
  saveState(state);
  const end = periodEndOf(state);
  const endsAt = end !== null && Date.parse(end) < Date.parse(scheduledFor) ? end : scheduledFor;
  return { status: "ending", endsAt, resumable: false };
}

/** A kept account's membership: still set to end (resumable), or resumed since (renewing). */
function followMembership(state: MockState, request: PrivacyRequest): boolean {
  const before = JSON.stringify(request.membership);
  if (request.status === "canceled" && request.membership && request.membership.status !== "none") {
    const m = billingOf(state).membership;
    if (m.status === "canceled") {
      request.membership = { status: "ended", endsAt: null, resumable: false };
    } else if (m.cancelAtPeriodEnd) {
      request.membership = { status: "ending", endsAt: periodEndOf(state), resumable: true };
    } else {
      request.membership = { status: "renewing", endsAt: null, resumable: false };
    }
  }
  return JSON.stringify(request.membership) !== before;
}

function newId(kind: string): string {
  return `${kind}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const privacyHandlers: MockHandlers = {
  getConsent: (_input, state) => consentState(state),

  updateConsent: ({ body }, state) => {
    if (!state.signedIn) throw new MockProblem("unauthenticated");
    if (restricted(state)) throw new MockProblem("unrestricted_profile_required");
    const store = privacy();
    const answers = answersOf(store, state.account.id);
    answers[body.purpose] = { granted: body.granted, source: body.source, at: iso() };
    save(store);
    return consentState(state);
  },

  ingestEvents: ({ body }, state) => {
    const batch = body.events as ClientEventInput[];
    const total = batch.length;
    if (new Set(batch.map((event) => event.deviceId)).size > 1) {
      throw new MockProblem("validation_failed");
    }
    const drop = { accepted: 0, dropped: total };
    if (privacy().mode === "off" || restricted(state)) return drop;
    const consent = state.signedIn
      ? consentState(state).purposes
      : body.consent
        ? {
            analytics: { granted: body.consent.analytics },
            personalisation: { granted: body.consent.personalisation },
          }
        : consentState(state).purposes;
    if (!consent.analytics.granted && !consent.personalisation.granted) return drop;
    events.push(...batch);
    if (events.length > 500) events.splice(0, events.length - 500);
    return { accepted: total, dropped: 0 };
  },

  listPrivacyRequests: (_input, state) => {
    requireAccountHolder(state);
    return { items: requestsOf(state), terms: termsOf(privacy()) };
  },

  requestDataExport: (_input, state) => {
    requireAccountHolder(state);
    if (state.account.isDemo) throw new MockProblem("demo_account_protected");
    const list = requestsOf(state);
    if (
      list.some((item) => item.kind === "export" && ["pending", "processing"].includes(item.status))
    ) {
      throw new MockProblem("privacy_request_pending");
    }
    const request: PrivacyRequest = {
      id: newId("export"),
      kind: "export",
      status: "pending",
      requestedAt: iso(),
      scheduledFor: null,
      completedAt: null,
      downloadUrl: null,
      expiresAt: null,
      membership: null,
    };
    list.unshift(request);
    save(privacy());
    return request;
  },

  downloadDataExport: ({ params }, state): DataExport => {
    requireAccountHolder(state);
    const request = requestsOf(state).find((item) => item.id === params.id);
    if (!request?.downloadUrl) throw new MockProblem("not_found");
    const answers = privacy().consents[state.account.id] ?? {};
    return {
      format: "webflix.data-export",
      formatVersion: 1,
      requestId: request.id,
      generatedAt: request.completedAt ?? iso(),
      account: {
        id: state.account.id,
        email: state.account.email,
        createdAt: state.account.createdAt,
      },
      profiles: state.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        avatarId: profile.avatarId,
        kids: profile.isKids,
        maturityCeiling: profile.maturityCeiling,
        locked: profile.pin !== null,
        settings: { ...profile.settings },
        createdAt: profile.createdAt,
      })),
      devices: [],
      library: state.profiles.map((profile) => ({
        profileId: profile.id,
        myList: profile.myList.map((titleId) => ({ titleId, addedAt: profile.createdAt })),
        ratings: Object.entries(profile.ratings).map(([titleId, value]) => ({
          titleId,
          value,
          ratedAt: profile.createdAt,
        })),
        progress: [],
        history: profile.history.map((entry) => ({
          titleId: entry.titleId,
          episodeId: entry.episodeId,
          watchedAt: entry.watchedAt,
        })),
      })),
      consents: PURPOSES.flatMap((purpose) => {
        const record = answers[purpose];
        return record
          ? [{ purpose, granted: record.granted, source: record.source, at: record.at }]
          : [];
      }),
      privacyRequests: requestsOf(state).map((item) => ({
        id: item.id,
        kind: item.kind,
        status: item.status,
        requestedAt: item.requestedAt,
        completedAt: item.completedAt,
      })),
      events: [],
      areas: {},
      notes: ["Mock mode: a sample of what a real export holds."],
    };
  },

  requestAccountDeletion: (_input, state) => {
    requireAccountHolder(state);
    if (state.account.isDemo) throw new MockProblem("demo_account_protected");
    const list = requestsOf(state);
    if (list.some((item) => item.kind === "deletion" && item.status === "scheduled")) {
      throw new MockProblem("privacy_request_pending");
    }
    const now = Date.now();
    const scheduledFor = iso(now + COOLING_OFF_MS);
    const request: PrivacyRequest = {
      id: newId("deletion"),
      kind: "deletion",
      status: "scheduled",
      requestedAt: iso(now),
      scheduledFor,
      completedAt: null,
      downloadUrl: null,
      expiresAt: null,
      membership: stopRenewals(state, scheduledFor),
    };
    list.unshift(request);
    save(privacy());
    return request;
  },

  cancelAccountDeletion: (_input, state) => {
    requireAccountHolder(state);
    const request = requestsOf(state).find(
      (item) => item.kind === "deletion" && item.status === "scheduled",
    );
    if (!request) throw new MockProblem("not_found");
    request.status = "canceled";
    followMembership(state, request);
    save(privacy());
    return undefined;
  },
};
