/**
 * Telemetry's surface: what screens call (`track`, the observers, `discardPendingEvents`), kept
 * light so it can sit in the app's first chunk. It hands everything to the engine
 * (`./engine.ts`: the SDK, the session and consent rules), which loads once the page is idle.
 *
 * Until the engine is there, an event reported is dropped (at most the first moment of an app
 * start, before anything could have been decided about consent), and an observation waits: it is
 * kept here and handed over, so a card on screen still counts once the engine starts.
 */
import type { ClientEventType, EventPayload } from "@webflix/contracts";
import type { ContextInput, RowViewInput } from "@webflix/telemetry";

/** Where an event happened: surface, row, positions, ranking policy (experiments are added). */
export type TelemetryContext = Omit<ContextInput, "experiments">;
/** What `track` takes for an event type (`sampleRate` is the SDK's). */
export type TrackPayload<T extends ClientEventType> = Omit<EventPayload<T>, "sampleRate">;
export type { RowViewInput };

export type Observation =
  | { kind: "impression"; element: Element; card: { titleId: string; context?: TelemetryContext } }
  | { kind: "row"; element: Element; row: RowViewInput };

/** What the engine offers this surface. */
export interface TelemetryEngine {
  track<T extends ClientEventType>(
    type: T,
    payload: TrackPayload<T>,
    context?: TelemetryContext,
  ): void;
  /** A card or row asked to be observed. */
  observed(id: number, observation: Observation): void;
  /** A card or row is gone, or no longer wants observing. */
  unobserved(id: number): void;
  discardPending(): void;
}

let engine: TelemetryEngine | null = null;

/**
 * Cards and rows that asked to be observed, kept outside any engine: they mount (their ref
 * callbacks run) before the engine starts, and they outlive an SDK that consent stops and starts
 * again.
 */
export const registry = { observations: new Map<number, Observation>(), next: 1 };

export function attachEngine(next: TelemetryEngine): void {
  engine = next;
}

export function detachEngine(which: TelemetryEngine): void {
  if (engine === which) engine = null;
}

function register(observation: Observation): () => void {
  const id = registry.next++;
  registry.observations.set(id, observation);
  engine?.observed(id, observation);
  return () => {
    registry.observations.delete(id);
    engine?.unobserved(id);
  };
}

/**
 * Report one behaviour event. Fire and forget: never throws, never waits, sends nothing when the
 * member's profile or consent says not to.
 *
 *   track("title.open", { titleId }, { surface: "home", rowId, rowRank, rank, policy });
 *
 * Inside React prefer `useTrack()`, which adds the nearest `<TelemetryScope>`'s context.
 */
export function track<T extends ClientEventType>(
  type: T,
  payload: TrackPayload<T>,
  context?: TelemetryContext,
): void {
  try {
    engine?.track(type, payload, context);
  } catch {
    // Telemetry must never cost the member anything, an exception least of all.
  }
}

/**
 * Drop everything waiting to be sent, now. For flows about to change who the events are about
 * (signing out, switching profile), called before their request: the engine also drops the queue
 * when an identity-changing request starts and when the new session arrives; this is the
 * screen's own guard on top.
 */
export function discardPendingEvents(): void {
  try {
    engine?.discardPending();
  } catch {
    // never fails the flow that calls it
  }
}

/** Observe a card for one impression (half visible for a second). Returns a stop function. */
export function observeImpression(
  element: Element,
  card: { titleId: string; context?: TelemetryContext },
): () => void {
  return register({ kind: "impression", element, card });
}

/** Observe a row for one `row.view` (half visible for a second). Returns a stop function. */
export function observeRowView(element: Element, row: RowViewInput): () => void {
  return register({ kind: "row", element, row });
}
