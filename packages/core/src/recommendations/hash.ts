/**
 * Small deterministic hashes (FNV-1a, 32-bit). Used where results must be stable across
 * processes, runtimes and restarts (daily billboard rotation, seeded noise), never for security.
 */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Uniform-ish value in [0, 1) derived from `text`. */
export function hash01(text: string): number {
  return fnv1a32(text) / 0x1_0000_0000;
}

/**
 * MurmurHash3's 32-bit finaliser: full avalanche. FNV-1a alone mixes its last characters
 * poorly (strings that differ only at the end land close together), which a random order or a
 * sampling decision cannot afford.
 */
export function mix32(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Well-mixed value in [0, 1) derived from `text` (for sampling decisions). */
export function mixed01(text: string): number {
  return mix32(fnv1a32(text)) / 0x1_0000_0000;
}

/**
 * A deterministic stream of values in [0, 1) seeded by `text` (mulberry32 over a mixed seed):
 * the same text always gives the same stream, on every runtime.
 */
export function seededRandom(text: string): () => number {
  let state = mix32(fnv1a32(text));
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

export function fnvHex(text: string): string {
  return fnv1a32(text).toString(16).padStart(8, "0");
}

/** UTC calendar day of an epoch-ms instant, `YYYY-MM-DD`. */
export function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the UTC day containing `epochMs`. */
export function startOfUtcDay(epochMs: number): number {
  return epochMs - (((epochMs % DAY_MS) + DAY_MS) % DAY_MS);
}

/** `YYYY-MM-DD` → epoch ms of its start (UTC). */
export function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

export function addDays(day: string, days: number): string {
  return utcDay(dayStart(day) + days * DAY_MS);
}

/** A deterministic, uniform shuffle (Fisher-Yates driven by a stream seeded by `seed`). */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const result = [...items];
  const random = seededRandom(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const value = result[index] as T;
    result[index] = result[other] as T;
    result[other] = value;
  }
  return result;
}
