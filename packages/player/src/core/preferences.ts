/**
 * Viewer preferences the player remembers between sessions: volume, mute, subtitle and audio
 * language, playback speed. Stored as JSON through a tiny storage port (localStorage by
 * default) and always reported to the host, which may sync them to the profile.
 */

export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5] as const;

export interface PlayerPreferences {
  /** 0…1. */
  volume: number;
  muted: boolean;
  /**
   * Subtitle language (BCP 47). `null` means subtitles off; absent means "no preference" (the
   * session's default track, if any, is used).
   */
  subtitleLanguage?: string | null;
  /** Preferred audio language; absent means the stream default. */
  audioLanguage?: string | null;
  playbackRate: number;
}

export const DEFAULT_PREFERENCES: PlayerPreferences = {
  volume: 1,
  muted: false,
  playbackRate: 1,
};

/** Where preferences persist. Implementations must never throw from `load`. */
export interface PreferenceStorage {
  load(): unknown;
  save(value: PlayerPreferences): void;
}

export const DEFAULT_PREFERENCES_KEY = "webflix.player.preferences.v1";

/**
 * localStorage-backed storage. Every access is guarded: Safari private mode, disabled storage
 * and quota errors degrade to "nothing remembered", never to a broken player.
 */
export function createLocalPreferenceStorage(key = DEFAULT_PREFERENCES_KEY): PreferenceStorage {
  const storage = (): Storage | null => {
    try {
      return typeof window === "undefined" ? null : window.localStorage;
    } catch {
      return null;
    }
  };
  return {
    load() {
      try {
        const raw = storage()?.getItem(key);
        return raw ? (JSON.parse(raw) as unknown) : null;
      } catch {
        return null;
      }
    },
    save(value) {
      try {
        storage()?.setItem(key, JSON.stringify(value));
      } catch {
        // Quota or privacy mode: preferences simply are not remembered.
      }
    },
  };
}

/** In-memory storage (tests, SSR, hosts that persist elsewhere). */
export function createMemoryPreferenceStorage(initial: unknown = null): PreferenceStorage & {
  readonly value: unknown;
} {
  let value: unknown = initial;
  return {
    get value() {
      return value;
    },
    load: () => value,
    save(next) {
      value = structuredClone(next);
    },
  };
}

const isLanguage = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(value);

/** Validate untrusted stored data field by field; anything malformed is dropped. */
export function sanitizePreferences(input: unknown): Partial<PlayerPreferences> {
  if (!input || typeof input !== "object") return {};
  const raw = input as Record<string, unknown>;
  const out: Partial<PlayerPreferences> = {};
  if (typeof raw.volume === "number" && Number.isFinite(raw.volume)) {
    out.volume = clampVolume(raw.volume);
  }
  if (typeof raw.muted === "boolean") out.muted = raw.muted;
  if (raw.subtitleLanguage === null || isLanguage(raw.subtitleLanguage)) {
    out.subtitleLanguage = raw.subtitleLanguage;
  }
  if (raw.audioLanguage === null || isLanguage(raw.audioLanguage)) {
    out.audioLanguage = raw.audioLanguage;
  }
  if (typeof raw.playbackRate === "number" && isSupportedRate(raw.playbackRate)) {
    out.playbackRate = raw.playbackRate;
  }
  return out;
}

/**
 * Effective preferences: defaults ← stored ← host overrides. Host overrides win because they
 * carry the profile's server-side settings (e.g. its subtitle language).
 */
export function resolvePreferences(
  stored: unknown,
  overrides: Partial<PlayerPreferences> | undefined,
): PlayerPreferences {
  return {
    ...DEFAULT_PREFERENCES,
    ...sanitizePreferences(stored),
    ...sanitizePreferences(overrides ?? {}),
  };
}

export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 1;
  return Math.round(Math.min(1, Math.max(0, volume)) * 100) / 100;
}

export function isSupportedRate(rate: number): boolean {
  return (PLAYBACK_RATES as readonly number[]).includes(rate);
}

/** The next supported rate up or down from `rate` (clamped at the ends). */
export function stepRate(rate: number, direction: 1 | -1): number {
  const rates = PLAYBACK_RATES as readonly number[];
  const index = rates.indexOf(rate);
  const from = index === -1 ? rates.indexOf(1) : index;
  return rates[Math.min(rates.length - 1, Math.max(0, from + direction))] ?? 1;
}

/** Keys whose values differ (for `onPreferencesChange`). */
export function changedPreferenceKeys(
  previous: PlayerPreferences,
  next: PlayerPreferences,
): (keyof PlayerPreferences)[] {
  const keys: (keyof PlayerPreferences)[] = [
    "volume",
    "muted",
    "subtitleLanguage",
    "audioLanguage",
    "playbackRate",
  ];
  return keys.filter((key) => previous[key] !== next[key]);
}
