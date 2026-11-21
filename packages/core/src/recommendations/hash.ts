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
