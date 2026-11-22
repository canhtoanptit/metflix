/**
 * Mutable mock backend state: account, profiles, active profile, per-profile library. Persisted
 * to localStorage so reloads (and Playwright `page.goto`) keep the session, like a cookie would.
 */
import {
  DEFAULT_PROFILE_SETTINGS,
  DEMO_ACCOUNT_EMAIL,
  type MATURITY_LEVELS,
  type PaymentMethod,
  type PlanId,
  type Profile,
  type ProfileSettings,
  type RatingValue,
} from "@webflix/contracts";
import type { MockBillingState } from "./billing.ts";
import { avatarById, avatarCatalog, iso } from "./catalog.ts";
import type { MockIdentityState } from "./identity.ts";

export type MockScenario = "anonymous" | "account" | "profile";

export const MOCK_STATE_KEY = "webflix:mock-state";
export const MOCK_SETTINGS_KEY = "webflix:mock-settings";
/** `?mock-session=anonymous|account|profile` resets the mock to that session on load. */
export const MOCK_SESSION_PARAM = "mock-session";

type Maturity = (typeof MATURITY_LEVELS)[number];

export interface MockProfileRecord {
  id: string;
  name: string;
  avatarId: string;
  isKids: boolean;
  maturityCeiling: Maturity;
  pin: string | null;
  settings: ProfileSettings;
  createdAt: string;
  myList: string[];
  ratings: Record<string, RatingValue>;
  /** titleId → { episodeId, positionSec, durationSec } */
  progress: Record<string, { episodeId: string | null; positionSec: number; durationSec: number }>;
  history: Array<{ id: string; titleId: string; episodeId: string | null; watchedAt: string }>;
  readNotifications: string[];
}

export interface MockState {
  signedIn: boolean;
  account: {
    id: string;
    email: string;
    password: string;
    createdAt: string;
    /**
     * Behave as the shared demo account (`demo_account_protected`). Off in the seeded state, so
     * mock mode can exercise every profile and account flow.
     */
    isDemo?: true;
  };
  planId: PlanId;
  subscriptionStatus: "active" | "canceling" | "ended";
  profiles: MockProfileRecord[];
  activeProfileId: string | null;
  devices: Array<{ id: string; label: string; deviceType: "desktop" | "mobile" | "tablet" | "tv" }>;
  /** Set by `PUT /account/payment-method`; the seeded Visa until then. */
  paymentMethod?: PaymentMethod;
  /** Milestone 2 sign-in (mocks/identity.ts); absent means its defaults. */
  identity?: MockIdentityState;
  /** Milestone 2 billing (mocks/billing.ts); absent means the seeded paid membership. */
  billing?: MockBillingState;
}

export interface MockSettings {
  /** Simulated network latency (ms). */
  latencyMs: number;
  /** Operation ids that answer 500 (error-state development). */
  failing: string[];
}

export const DEFAULT_SETTINGS: MockSettings = { latencyMs: 250, failing: [] };

function profile(
  index: number,
  name: string,
  options: Partial<MockProfileRecord> = {},
): MockProfileRecord {
  const avatars = avatarCatalog().groups.flatMap((group) => group.avatars);
  return {
    id: `profile-${name.toLowerCase()}`,
    name,
    avatarId: avatars[index % avatars.length]?.id ?? "avatar-01-comet",
    isKids: false,
    maturityCeiling: "18+",
    pin: null,
    settings: { ...DEFAULT_PROFILE_SETTINGS },
    createdAt: iso((400 - index * 30) * 86_400_000),
    myList: [],
    ratings: {},
    progress: {},
    history: [],
    readNotifications: [],
    ...options,
  };
}

/** The demo account: three profiles (one PIN-locked, one kids) with some history. */
export function initialState(scenario: MockScenario): MockState {
  const mara = profile(0, "Mara", {
    myList: ["t-meridian", "t-sintel", "t-the-glass-orchard", "t-ninth-moon", "t-velvet-static"],
    progress: {
      "t-house-of-cinders": {
        episodeId: "e-house-of-cinders-s1e3",
        positionSec: 1520,
        durationSec: 2880,
      },
      "t-kilometer-zero": { episodeId: null, positionSec: 3100, durationSec: 6900 },
      "t-signal-hill": { episodeId: "e-signal-hill-s2e1", positionSec: 600, durationSec: 2700 },
      "t-tears-of-steel": { episodeId: null, positionSec: 410, durationSec: 734 },
      "t-chrome-lotus": { episodeId: "e-chrome-lotus-s1e5", positionSec: 2100, durationSec: 2580 },
      "t-the-salt-road": { episodeId: null, positionSec: 1800, durationSec: 7200 },
    },
    ratings: { "t-sintel": "love", "t-snowline": "like" },
    history: [
      {
        id: "h-1",
        titleId: "t-house-of-cinders",
        episodeId: "e-house-of-cinders-s1e3",
        watchedAt: iso(3_600_000),
      },
      { id: "h-2", titleId: "t-kilometer-zero", episodeId: null, watchedAt: iso(26 * 3_600_000) },
      {
        id: "h-3",
        titleId: "t-signal-hill",
        episodeId: "e-signal-hill-s2e1",
        watchedAt: iso(50 * 3_600_000),
      },
      { id: "h-4", titleId: "t-sintel", episodeId: null, watchedAt: iso(9 * 86_400_000) },
    ],
  });
  const theo = profile(1, "Theo", { pin: "1234", myList: ["t-cold-ledger"] });
  const kids = profile(2, "Kids", {
    isKids: true,
    maturityCeiling: "7+",
    avatarId: avatarCatalog().groups[1]?.avatars[0]?.id ?? "avatar-09-echo",
  });
  return {
    signedIn: scenario !== "anonymous",
    account: {
      id: "acct-demo",
      email: DEMO_ACCOUNT_EMAIL,
      password: "webflix-demo",
      createdAt: iso(400 * 86_400_000),
    },
    planId: "standard",
    subscriptionStatus: "active",
    profiles: [mara, theo, kids],
    activeProfileId: scenario === "profile" ? mara.id : null,
    devices: [
      { id: "device-this", label: "Chrome on macOS", deviceType: "desktop" },
      { id: "device-tv", label: "Living room TV", deviceType: "tv" },
      { id: "device-phone", label: "Safari on iPhone", deviceType: "mobile" },
    ],
  };
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadState(): MockState {
  const store = storage();
  const scenario = readScenarioParam();
  if (scenario) {
    const state = initialState(scenario);
    saveState(state);
    return state;
  }
  const raw = store?.getItem(MOCK_STATE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as MockState;
    } catch {
      // fall through to a fresh state
    }
  }
  const state = initialState("anonymous");
  saveState(state);
  return state;
}

export function saveState(state: MockState): void {
  storage()?.setItem(MOCK_STATE_KEY, JSON.stringify(state));
}

export function loadSettings(): MockSettings {
  const raw = storage()?.getItem(MOCK_SETTINGS_KEY);
  if (!raw) return DEFAULT_SETTINGS;
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<MockSettings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: MockSettings): void {
  storage()?.setItem(MOCK_SETTINGS_KEY, JSON.stringify(settings));
}

function readScenarioParam(): MockScenario | null {
  if (typeof location === "undefined") return null;
  const value = new URLSearchParams(location.search).get(MOCK_SESSION_PARAM);
  return value === "anonymous" || value === "account" || value === "profile" ? value : null;
}

export function toProfile(record: MockProfileRecord): Profile {
  const avatar = avatarById(record.avatarId) ?? {
    id: record.avatarId,
    name: record.name,
    imageUrl: `/cdn/img/avatars/${record.avatarId}.webp`,
    groupId: "classics",
  };
  return {
    id: record.id,
    name: record.name,
    avatar,
    isKids: record.isKids,
    maturityCeiling: record.maturityCeiling,
    isLocked: record.pin !== null,
    settings: record.settings,
    createdAt: record.createdAt,
  };
}
