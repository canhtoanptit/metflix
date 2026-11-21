import { afterEach, describe, expect, it, vi } from "vitest";
import {
  changedPreferenceKeys,
  clampVolume,
  createLocalPreferenceStorage,
  createMemoryPreferenceStorage,
  DEFAULT_PREFERENCES,
  resolvePreferences,
  sanitizePreferences,
  stepRate,
} from "../src/core/preferences.ts";

describe("preferences", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("validates stored data field by field", () => {
    expect(
      sanitizePreferences({
        volume: 0.456,
        muted: "yes",
        subtitleLanguage: "pt-BR",
        audioLanguage: "<script>",
        playbackRate: 3,
      }),
    ).toEqual({ volume: 0.46, subtitleLanguage: "pt-BR" });
    expect(sanitizePreferences(null)).toEqual({});
    expect(sanitizePreferences("garbage")).toEqual({});
    expect(sanitizePreferences({ subtitleLanguage: null })).toEqual({ subtitleLanguage: null });
  });

  it("resolves defaults ← stored ← host overrides", () => {
    expect(resolvePreferences(null, undefined)).toEqual(DEFAULT_PREFERENCES);
    expect(
      resolvePreferences(
        { volume: 0.3, subtitleLanguage: "es", playbackRate: 1.5 },
        { subtitleLanguage: "en" },
      ),
    ).toEqual({ volume: 0.3, muted: false, subtitleLanguage: "en", playbackRate: 1.5 });
  });

  it("clamps volume and steps rates within the supported set", () => {
    expect(clampVolume(1.4)).toBe(1);
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(Number.NaN)).toBe(1);
    expect(stepRate(1, 1)).toBe(1.25);
    expect(stepRate(1.5, 1)).toBe(1.5);
    expect(stepRate(0.5, -1)).toBe(0.5);
    expect(stepRate(1.1, -1)).toBe(0.75);
  });

  it("reports which keys changed", () => {
    expect(
      changedPreferenceKeys(DEFAULT_PREFERENCES, {
        ...DEFAULT_PREFERENCES,
        muted: true,
        subtitleLanguage: "es",
      }),
    ).toEqual(["muted", "subtitleLanguage"]);
  });

  it("memory storage round-trips a copy", () => {
    const storage = createMemoryPreferenceStorage();
    const value = { ...DEFAULT_PREFERENCES, volume: 0.4 };
    storage.save(value);
    value.volume = 1;
    expect(storage.load()).toEqual({ ...DEFAULT_PREFERENCES, volume: 0.4 });
  });

  it("local storage persists JSON and never throws", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
      },
    });
    const storage = createLocalPreferenceStorage("k");
    storage.save({ ...DEFAULT_PREFERENCES, muted: true });
    expect(JSON.parse(store.get("k") ?? "")).toMatchObject({ muted: true });
    expect(storage.load()).toMatchObject({ muted: true });

    store.set("k", "{not json");
    expect(storage.load()).toBeNull();

    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new DOMException("denied", "SecurityError");
      },
    });
    expect(() => storage.save(DEFAULT_PREFERENCES)).not.toThrow();
    expect(storage.load()).toBeNull();
  });
});
