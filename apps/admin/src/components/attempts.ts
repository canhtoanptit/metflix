/**
 * Attempts at a change, kept in this tab's memory for as long as the tab lives (never stored).
 * Closing a dialog, or leaving the page, while its request is still running or after it ended
 * without a clear answer does not forget it: opening the same action again shows where that
 * attempt stands instead of a fresh form, so a second click cannot become a second refund.
 *
 * The idempotency key of a billing action is created here, when the staff member opens the form
 * (the moment the intention forms), and kept through every send of that form: a double click, a
 * renewal after 401, "check again" after no answer. A new key is made only for a new intention:
 * after a refusal the staff member corrects the form, or after they confirm an unclear attempt
 * did not happen.
 */
import type { ClassifiedFailure } from "../api/errors.ts";

export type AttemptPhase = "editing" | "sending" | "succeeded" | "unresolved";

export interface Attempt {
  /** The billing action's idempotency key (a UUID). */
  idempotencyKey: string;
  phase: AttemptPhase;
  /** The request id of the last send. */
  requestId: string | null;
  /**
   * The request id of this key's first send: the one its audit entry carries (later sends of the
   * same key are answered from that entry, or refused as a conflict, and write none).
   */
  firstRequestId: string | null;
  failure: ClassifiedFailure | null;
  /** The answer of a send that succeeded after its dialog was closed. */
  result: unknown;
  startedAt: number | null;
}

const attempts = new Map<string, Attempt>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function fresh(): Attempt {
  return {
    idempotencyKey: crypto.randomUUID(),
    phase: "editing",
    requestId: null,
    firstRequestId: null,
    failure: null,
    result: undefined,
    startedAt: null,
  };
}

export function subscribeAttempts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The attempt for `scope` (an action on a target), created when the form opens. */
export function openAttempt(scope: string): Attempt {
  const existing = attempts.get(scope);
  if (existing) return existing;
  const created = fresh();
  attempts.set(scope, created);
  return created;
}

export function peekAttempt(scope: string): Attempt | undefined {
  return attempts.get(scope);
}

export function updateAttempt(scope: string, patch: Partial<Attempt>): Attempt {
  const next = { ...openAttempt(scope), ...patch };
  attempts.set(scope, next);
  emit();
  return next;
}

/** A new intention: a new key, back to the form. */
export function renewAttempt(scope: string): Attempt {
  const next = fresh();
  attempts.set(scope, next);
  emit();
  return next;
}

/** Settled and seen (or a form closed before anything was sent): forget it. */
export function closeAttempt(scope: string): void {
  if (attempts.delete(scope)) emit();
}

/** Scopes with a send in flight or an unclear end (for a page to say so). */
export function unsettledScopes(prefix: string): string[] {
  return [...attempts.entries()]
    .filter(
      ([scope, attempt]) =>
        scope.startsWith(prefix) && (attempt.phase === "sending" || attempt.phase === "unresolved"),
    )
    .map(([scope]) => scope);
}

/** Tests only. */
export function resetAttempts(): void {
  attempts.clear();
  emit();
}
