/**
 * Port: the current time. Inject it everywhere time matters so tests control it.
 * Note for Workers: `Date.now()` only advances across I/O inside a request; that is fine for
 * every use here (expiries, timestamps) and the reason nothing measures elapsed CPU with it.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A clock that only moves when told to. Starts at 2026-01-01T00:00:00Z by default. */
export class ManualClock implements Clock {
  private current: number;

  constructor(startMs: number = Date.UTC(2026, 0, 1)) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    if (ms < 0) throw new RangeError("ManualClock cannot go backwards");
    this.current += ms;
  }

  set(ms: number): void {
    this.current = ms;
  }
}

export function toIsoString(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
