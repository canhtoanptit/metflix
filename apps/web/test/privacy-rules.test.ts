/**
 * The privacy rules the browser enforces (docs/BLUEPRINT-M2.md §6.3), each with a test that
 * fails when the rule is broken: the app's telemetry engine (`src/app/telemetry/engine.ts`)
 * over the real SDK, with a fake transport recording every request that would leave.
 *
 * - nothing from a kids or restricted profile, and no device id kept for one;
 * - nothing before consent in opt-in mode (and nothing tracked before it is sent after it);
 * - withdrawing consent empties the buffer at once; withdrawing everything also forgets the
 *   device id;
 * - Global Privacy Control is honoured in opt-out mode, except where the member said yes;
 * - another profile, or signing out, empties the buffer: nothing is sent as someone else's.
 */
import { QueryClient } from "@tanstack/react-query";
import {
  type ApiClient,
  type ClientEventInput,
  type ConsentState,
  createRouteClient,
  type Profile,
  routes,
  type SessionState,
} from "@webflix/contracts";
import { createTelemetry, DEVICE_ID_STORAGE_KEY } from "@webflix/telemetry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, setApiClient } from "../src/app/api.ts";
import { qk } from "../src/app/query/keys.ts";
import { consentKey } from "../src/app/telemetry/consent.ts";
import { TelemetryRuntime } from "../src/app/telemetry/engine.ts";
import { setMockConsentMode } from "../src/mocks/privacy.ts";
import { createMockServer } from "../src/mocks/server.ts";
import { initialState } from "../src/mocks/state.ts";

const FLUSH_MS = 15_000;

interface Sent {
  events: ClientEventInput[];
}

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "profile-adult",
    name: "Adult",
    avatar: { id: "a1", name: "Comet", imageUrl: "/cdn/img/a1.webp", groupId: "g" },
    isKids: false,
    maturityCeiling: "18+",
    isLocked: false,
    settings: { autoplayNextEpisode: true, autoplayPreviews: true, subtitleLanguage: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function signedIn(active: Profile | null, accountId = "acct-1"): SessionState {
  const adult = profile();
  return {
    authenticated: true,
    account: { id: accountId, email: "m@example.com", createdAt: "2026-01-01T00:00:00.000Z" },
    subscription: {
      planId: "standard",
      status: "active",
      startedAt: "2026-01-01T00:00:00.000Z",
      currentPeriodEnd: "2026-12-01T00:00:00.000Z",
      canceledAt: null,
    },
    plan: {
      id: "standard",
      name: "Standard",
      priceMonthly: { amount: 1099, currency: "USD" },
      maxStreams: 2,
      maxVideoHeight: 1080,
      features: [],
    } as unknown as Extract<SessionState, { authenticated: true }>["plan"],
    profiles: [adult],
    activeProfile: active,
    experiments: { "recs.learned-vs-rules": "treatment" },
  };
}

function consent(
  mode: ConsentState["mode"],
  answers: Partial<
    Record<
      "analytics" | "personalisation",
      { granted: boolean; source: "banner" | "settings" | "gpc" | null }
    >
  > = {},
  gpc = false,
): ConsentState {
  const fallback = mode === "opt-out";
  const purpose = (name: "analytics" | "personalisation") => ({
    granted: mode !== "off" && (answers[name]?.granted ?? fallback),
    source: answers[name]?.source ?? null,
    updatedAt: answers[name] ? "2026-11-22T10:00:00.000Z" : null,
  });
  return {
    mode,
    gpc,
    promptRequired: mode === "opt-in" && Object.keys(answers).length < 2,
    purposes: { analytics: purpose("analytics"), personalisation: purpose("personalisation") },
  };
}

function setup(options: { gpc?: boolean } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const sent: Sent[] = [];
  const storage = memoryStorage();
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ accepted: 1, dropped: 0 }), { status: 202 });
  }) as unknown as typeof globalThis.fetch;
  // A consent read that never answers: tests put the consent in the cache themselves.
  setApiClient({ getConsent: () => new Promise(() => {}) } as unknown as ApiClient);
  const runtime = new TelemetryRuntime({
    queryClient,
    createSdk: (sdkOptions) =>
      createTelemetry({
        ...sdkOptions,
        fetch,
        IntersectionObserver: null,
        document: null,
        window: null,
      }),
    gpc: () => options.gpc ?? false,
    storage,
    whenIdle: (run) => {
      run();
      return () => {};
    },
  });
  const setSession = (session: SessionState) => queryClient.setQueryData(qk.session(), session);
  const setConsent = (owner: string, state: ConsentState) =>
    queryClient.setQueryData(consentKey(owner), state);
  const sentEvents = () => sent.flatMap((request) => request.events);
  const flushTimers = () => vi.advanceTimersByTimeAsync(FLUSH_MS);
  return { queryClient, runtime, sent, sentEvents, storage, setSession, setConsent, flushTimers };
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 10, 23, 10, 0, 0) });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a kids or restricted profile", () => {
  it.each([
    ["a kids profile", profile({ id: "profile-kids", isKids: true, maturityCeiling: "7+" })],
    [
      "a profile with a lowered maturity ceiling",
      profile({ id: "profile-teen", maturityCeiling: "13+" }),
    ],
  ])("sends nothing at all from %s, and keeps no device id", async (_name, restricted) => {
    const t = setup();
    t.setSession(signedIn(restricted));
    // Even an account that granted everything: the profile is never profiled.
    t.setConsent(
      "acct-1",
      consent("opt-out", {
        analytics: { granted: true, source: "settings" },
        personalisation: { granted: true, source: "settings" },
      }),
    );
    t.runtime.start();
    t.runtime.track("title.open", { titleId: "t-sintel" }, { surface: "home" });
    t.runtime.track("search.query", { queryLength: 4, resultCount: 2 });
    await t.flushTimers();
    expect(t.sent).toHaveLength(0);
    expect(t.runtime.state).toMatchObject({ sdk: false, held: 0, pending: 0 });
    expect(t.storage.data.has(DEVICE_ID_STORAGE_KEY)).toBe(false);
    t.runtime.stop();
  });

  it("drops what an adult profile queued the moment a kids profile becomes active", async () => {
    const t = setup();
    t.setSession(signedIn(profile()));
    t.setConsent("acct-1", consent("opt-out"));
    t.runtime.start();
    t.runtime.track("title.open", { titleId: "t-adult-pick" });
    expect(t.runtime.state.pending).toBe(1);
    t.setSession(signedIn(profile({ id: "profile-kids", isKids: true, maturityCeiling: "7+" })));
    t.runtime.track("title.open", { titleId: "t-kids-pick" });
    await t.flushTimers();
    expect(t.sent).toHaveLength(0);
    expect(t.storage.data.has(DEVICE_ID_STORAGE_KEY)).toBe(false);
    t.runtime.stop();
  });
});

describe("consent in opt-in mode", () => {
  it("collects nothing and stores nothing until a purpose is granted", async () => {
    const t = setup();
    t.setSession(signedIn(profile()));
    t.setConsent("acct-1", consent("opt-in"));
    t.runtime.start();
    t.runtime.track("title.open", { titleId: "t-before" });
    await t.flushTimers();
    expect(t.sent).toHaveLength(0);
    expect(t.storage.data.has(DEVICE_ID_STORAGE_KEY)).toBe(false);
    t.setConsent(
      "acct-1",
      consent("opt-in", {
        analytics: { granted: false, source: "banner" },
        personalisation: { granted: true, source: "banner" },
      }),
    );
    t.runtime.track("title.open", { titleId: "t-after" });
    await t.flushTimers();
    // Consent is not retroactive: only what happened after it was given.
    expect(t.sentEvents().map((event) => event.payload)).toEqual([{ titleId: "t-after" }]);
    expect(t.sentEvents()[0]?.context.experiments).toEqual({
      "recs.learned-vs-rules": "treatment",
    });
    expect(t.storage.data.has(DEVICE_ID_STORAGE_KEY)).toBe(true);
    t.runtime.stop();
  });

  it("holds events while the consent is being read, then drops them if it was not given", async () => {
    const t = setup();
    t.setSession(signedIn(profile()));
    t.runtime.start();
    t.runtime.track("title.open", { titleId: "t-early" });
    expect(t.runtime.state).toMatchObject({ held: 1, sdk: false });
    t.setConsent("acct-1", consent("opt-in"));
    await t.flushTimers();
    expect(t.sent).toHaveLength(0);
    expect(t.runtime.state.held).toBe(0);
    t.runtime.stop();
  });

  it("hands held events over with their own time once the consent allows them", async () => {
    const t = setup();
    t.setSession(signedIn(profile()));
    t.runtime.start();
    t.runtime.track("title.open", { titleId: "t-early" });
    await vi.advanceTimersByTimeAsync(700);
    t.setConsent(
      "acct-1",
      consent("opt-in", {
        analytics: { granted: true, source: "settings" },
        personalisation: { granted: true, source: "settings" },
      }),
    );
    await t.flushTimers();
    expect(t.sentEvents()).toHaveLength(1);
    expect(t.sentEvents()[0]?.occurredAt).toBe("2026-11-23T10:00:00.000Z");
    t.runtime.stop();
  });

  it("collects nothing in off mode", async () => {
    const t = setup();
    t.setSession(signedIn(profile()));
    t.setConsent("acct-1", consent("off"));
    t.runtime.start();
    t.runtime.track("title.open", { titleId: "t-1" });
    await t.flushTimers();
    expect(t.sent).toHaveLength(0);
    t.runtime.stop();
  });
});

describe("withdrawing consent", () => {
  it("empties the buffer at once, even when another purpose stays granted", async () => {
    const t = setup();
    t.setSession(signedIn(profile()));
    t.setConsent("acct-1", consent("opt-out"));
    t.runtime.start();
    t.runtime.track("title.open", { titleId: "t-queued-1" });
    t.runtime.track("title.open", { titleId: "t-queued-2" });
    expect(t.runtime.state.pending).toBe(2);
    t.setConsent(
      "acct-1",
      consent("opt-out", { personalisation: { granted: false, source: "settings" } }),
    );
    expect(t.runtime.state.pending).toBe(0);
    t.runtime.track("title.open", { titleId: "t-later" });
    await t.flushTimers();
    expect(t.sentEvents().map((event) => event.payload)).toEqual([{ titleId: "t-later" }]);
    t.runtime.stop();
  });

  it("withdrawing everything stops collection and forgets the device id", async () => {
    const t = setup();
    t.setSession(signedIn(profile()));
    t.setConsent("acct-1", consent("opt-out"));
    t.runtime.start();
    t.runtime.track("title.open", { titleId: "t-queued" });
    expect(t.storage.data.has(DEVICE_ID_STORAGE_KEY)).toBe(true);
    t.setConsent(
      "acct-1",
      consent("opt-out", {
        analytics: { granted: false, source: "settings" },
        personalisation: { granted: false, source: "settings" },
      }),
    );
    t.runtime.track("title.open", { titleId: "t-after" });
    await t.flushTimers();
    expect(t.sent).toHaveLength(0);
    expect(t.runtime.state.sdk).toBe(false);
    expect(t.storage.data.has(DEVICE_ID_STORAGE_KEY)).toBe(false);
    t.runtime.stop();
  });
});

describe("Global Privacy Control", () => {
  it("counts as no for every purpose the member has not answered (opt-out mode)", async () => {
    const t = setup({ gpc: true });
    t.setSession(signedIn(profile()));
    // The server did not see the header (a proxy dropped it): the browser still honours it.
    t.setConsent("acct-1", consent("opt-out"));
    t.runtime.start();
    t.runtime.track("title.open", { titleId: "t-1" });
    await t.flushTimers();
    expect(t.sent).toHaveLength(0);
    expect(t.runtime.state.policy).toEqual({ decision: "none", reason: "not-granted" });
    t.runtime.stop();
  });

  it("gives way to the member's own yes", async () => {
    const t = setup({ gpc: true });
    t.setSession(signedIn(profile()));
    t.setConsent(
      "acct-1",
      consent("opt-out", { analytics: { granted: true, source: "settings" } }, true),
    );
    t.runtime.start();
    t.runtime.track("title.open", { titleId: "t-1" });
    await t.flushTimers();
    expect(t.sentEvents()).toHaveLength(1);
    t.runtime.stop();
  });
});

describe("another identity", () => {
  it("never sends what one profile queued as another's", async () => {
    const t = setup();
    t.setSession(signedIn(profile({ id: "profile-a", name: "A" })));
    t.setConsent("acct-1", consent("opt-out"));
    t.runtime.start();
    t.runtime.track("title.open", { titleId: "t-a" });
    expect(t.runtime.state.pending).toBe(1);
    t.setSession(signedIn(profile({ id: "profile-b", name: "B" })));
    expect(t.runtime.state.pending).toBe(0);
    t.runtime.track("title.open", { titleId: "t-b" });
    await t.flushTimers();
    expect(t.sentEvents().map((event) => event.payload)).toEqual([{ titleId: "t-b" }]);
    t.runtime.stop();
  });

  it("drops everything queued when the member signs out", async () => {
    const t = setup();
    t.setSession(signedIn(profile()));
    t.setConsent("acct-1", consent("opt-out"));
    t.runtime.start();
    t.runtime.track("title.open", { titleId: "t-member" });
    t.setSession({ authenticated: false });
    // Signed out, an opt-in deployment collects nothing from an anonymous device.
    t.setConsent("anonymous", consent("opt-in"));
    await t.flushTimers();
    expect(t.sent).toHaveLength(0);
    expect(t.storage.data.has(DEVICE_ID_STORAGE_KEY)).toBe(false);
    t.runtime.stop();
  });

  it("never sends a member's queued events as an anonymous device's after sign-out", async () => {
    const t = setup();
    t.setSession(signedIn(profile()));
    t.setConsent("acct-1", consent("opt-out"));
    t.runtime.start();
    t.runtime.track("title.open", { titleId: "t-member" });
    t.setSession({ authenticated: false });
    // An opt-out deployment does collect from an anonymous device: only its own events.
    t.setConsent("anonymous", consent("opt-out"));
    t.runtime.track("signup.step", { step: "email", outcome: "viewed" }, { surface: "signup" });
    await t.flushTimers();
    expect(t.sentEvents().map((event) => event.type)).toEqual(["signup.step"]);
    t.runtime.stop();
  });

  it("drops a batch that was being retried when the profile changes", async () => {
    const t = setup();
    let fail = true;
    const sent: string[][] = [];
    const runtime = new TelemetryRuntime({
      queryClient: t.queryClient,
      createSdk: (sdkOptions) =>
        createTelemetry({
          ...sdkOptions,
          IntersectionObserver: null,
          document: null,
          window: null,
          fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as Sent;
            sent.push(body.events.map((event) => (event.payload as { titleId: string }).titleId));
            return new Response(null, { status: fail ? 503 : 202 });
          }) as typeof globalThis.fetch,
        }),
      storage: t.storage,
      gpc: () => false,
      whenIdle: (run) => {
        run();
        return () => {};
      },
    });
    t.setSession(signedIn(profile({ id: "profile-a" })));
    t.setConsent("acct-1", consent("opt-out"));
    runtime.start();
    runtime.track("title.open", { titleId: "t-a" });
    await vi.advanceTimersByTimeAsync(FLUSH_MS); // first attempt: 503, kept for a retry
    expect(sent).toEqual([["t-a"]]);
    fail = false;
    t.setSession(signedIn(profile({ id: "profile-b" })));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent).toEqual([["t-a"]]); // never retried as profile B's
    runtime.stop();
  });
});

describe("the device id", () => {
  it("is never carried from one account to another, or to the signed-out device", async () => {
    const t = setup();
    t.setSession(signedIn(profile(), "acct-a"));
    t.setConsent("acct-a", consent("opt-out"));
    t.runtime.start();
    t.runtime.track("title.open", { titleId: "t-a" });
    await t.flushTimers();
    t.setSession({ authenticated: false });
    t.setConsent("anonymous", consent("opt-out"));
    t.runtime.track("signup.step", { step: "email", outcome: "viewed" }, { surface: "signup" });
    await t.flushTimers();
    t.setSession(signedIn(profile(), "acct-b"));
    t.setConsent("acct-b", consent("opt-out"));
    t.runtime.track("title.open", { titleId: "t-b" });
    await t.flushTimers();
    const devices = t.sentEvents().map((event) => event.deviceId);
    expect(devices).toHaveLength(3);
    expect(new Set(devices).size).toBe(3);
    t.runtime.stop();
  });

  it("stays the same across a profile switch within one account", async () => {
    const t = setup();
    t.setSession(signedIn(profile({ id: "profile-a" })));
    t.setConsent("acct-1", consent("opt-out"));
    t.runtime.start();
    t.runtime.track("title.open", { titleId: "t-a" });
    await t.flushTimers();
    t.setSession(signedIn(profile({ id: "profile-b" })));
    t.runtime.track("title.open", { titleId: "t-b" });
    await t.flushTimers();
    const devices = t.sentEvents().map((event) => event.deviceId);
    expect(devices).toHaveLength(2);
    expect(devices[0]).toBe(devices[1]);
    t.runtime.stop();
  });

  it("drops an id left by another account in an earlier visit", async () => {
    const t = setup();
    t.storage.setItem("webflix.deviceId", "left-by-someone-else");
    t.storage.setItem("webflix.deviceId.owner", "account:acct-other");
    t.setSession(signedIn(profile()));
    t.setConsent("acct-1", consent("opt-out"));
    t.runtime.start();
    t.runtime.track("title.open", { titleId: "t-1" });
    await t.flushTimers();
    expect(t.sentEvents()[0]?.deviceId).not.toBe("left-by-someone-else");
    t.runtime.stop();
  });
});

describe("an identity change in flight", () => {
  function switchingClient() {
    let settle: { resolve: (value: unknown) => void; reject: (error: unknown) => void } | null =
      null;
    setApiClient({
      getConsent: () => new Promise(() => {}),
      selectProfile: () =>
        new Promise((resolve, reject) => {
          settle = { resolve, reject };
        }),
    } as unknown as ApiClient);
    return {
      resolve: (value: unknown) => settle?.resolve(value),
      reject: (error: unknown) => settle?.reject(error),
    };
  }

  it("drops what was queued the moment the request starts, and tracks nothing until the new session arrives", async () => {
    const t = setup();
    const request = switchingClient();
    t.setSession(signedIn(profile({ id: "profile-a" })));
    t.setConsent("acct-1", consent("opt-out"));
    t.runtime.start();
    t.runtime.track("title.open", { titleId: "t-a-queued" });
    expect(t.runtime.state.pending).toBe(1);
    const switching = api().selectProfile({ body: { profileId: "profile-b" } });
    expect(t.runtime.state.pending).toBe(0);
    t.runtime.track("title.open", { titleId: "t-during" });
    request.resolve(signedIn(profile({ id: "profile-b" })));
    await switching;
    t.runtime.track("title.open", { titleId: "t-before-the-session" });
    t.setSession(signedIn(profile({ id: "profile-b" })));
    t.runtime.track("title.open", { titleId: "t-b" });
    await t.flushTimers();
    expect(t.sentEvents().map((event) => event.payload)).toEqual([{ titleId: "t-b" }]);
    t.runtime.stop();
  });

  it("resumes after a request that changed nothing (a wrong PIN)", async () => {
    const t = setup();
    const request = switchingClient();
    t.setSession(signedIn(profile({ id: "profile-a" })));
    t.setConsent("acct-1", consent("opt-out"));
    t.runtime.start();
    const switching = api().selectProfile({ body: { profileId: "profile-b", pin: "0000" } });
    request.reject(new Error("profile_pin_invalid"));
    await expect(switching).rejects.toThrow("profile_pin_invalid");
    await vi.advanceTimersByTimeAsync(1500);
    t.runtime.track("title.open", { titleId: "t-a" });
    await t.flushTimers();
    expect(t.sentEvents().map((event) => event.payload)).toEqual([{ titleId: "t-a" }]);
    t.runtime.stop();
  });
});

describe("the transport", () => {
  it("goes through the app's API client: batches reach the server's route", async () => {
    const server = createMockServer({
      state: initialState("profile"),
      settings: { latencyMs: 0, failing: [] },
    });
    setApiClient(createRouteClient(routes, { fetch: server.fetch, validateResponses: true }));
    setMockConsentMode("opt-out");
    const queryClient = new QueryClient();
    const runtime = new TelemetryRuntime({
      queryClient,
      createSdk: (sdkOptions) =>
        createTelemetry({
          ...sdkOptions,
          IntersectionObserver: null,
          document: null,
          window: null,
        }),
      storage: memoryStorage(),
      gpc: () => false,
      whenIdle: (run) => {
        run();
        return () => {};
      },
    });
    const session = initialState("profile");
    const mara = session.profiles[0];
    if (!mara) throw new Error("no profile");
    queryClient.setQueryData(qk.session(), signedIn(profile({ id: mara.id }), session.account.id));
    queryClient.setQueryData(consentKey(session.account.id), consent("opt-out"));
    runtime.start();
    const received = (globalThis as { __WEBFLIX_MOCK_EVENTS__?: ClientEventInput[] })
      .__WEBFLIX_MOCK_EVENTS__;
    const before = received?.length ?? 0;
    runtime.track("list.add", { titleId: "t-sintel" }, { surface: "title-detail" });
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    await vi.waitFor(() =>
      expect(received?.slice(before).map((event) => event.type)).toEqual(["list.add"]),
    );
    runtime.stop();
  });
});
