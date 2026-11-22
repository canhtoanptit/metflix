/**
 * React bindings of the telemetry runtime: a scope that gives every event below it the same
 * context (the page's surface and ranking policy), a `track` that adds it, and ref callbacks
 * that observe a card or a row for its impression or row view.
 */
import { useQueryClient } from "@tanstack/react-query";
import type { ClientEventType } from "@webflix/contracts";
import {
  createContext,
  type ReactNode,
  type RefCallback,
  useCallback,
  useContext,
  useEffect,
  useMemo,
} from "react";
import { listenForConsentElsewhere } from "./consent.ts";
import {
  observeImpression,
  observeRowView,
  type RowViewInput,
  type TelemetryContext,
  type TrackPayload,
  track,
} from "./runtime.ts";

const ScopeContext = createContext<TelemetryContext>({});

/**
 * Context merged into every event reported below it (`useTrack`, `useImpressionRef`,
 * `useRowViewRef`). Scopes nest; the inner one wins field by field.
 *
 *   <TelemetryScope context={{ surface: "home", policy: page.policy }}>…</TelemetryScope>
 */
export function TelemetryScope({
  context,
  children,
}: {
  context: TelemetryContext;
  children: ReactNode;
}) {
  const outer = useContext(ScopeContext);
  // Callers pass a fresh object each render: its value, not its identity, changes the scope.
  const key = JSON.stringify(context);
  const merged = useMemo(() => ({ ...outer, ...context }), [outer, key]);
  return <ScopeContext.Provider value={merged}>{children}</ScopeContext.Provider>;
}

/** The nearest scope's context (for code that calls `track` itself). */
export function useTelemetryScope(): TelemetryContext {
  return useContext(ScopeContext);
}

/** `track` with the nearest scope's context added (the call's own context wins). */
export function useTrack(): <T extends ClientEventType>(
  type: T,
  payload: TrackPayload<T>,
  context?: TelemetryContext,
) => void {
  const scope = useContext(ScopeContext);
  return useCallback(
    (type, payload, context) => track(type, payload, { ...scope, ...context }),
    [scope],
  );
}

/**
 * A ref callback that observes a card: one impression per appearance (half visible for a
 * second; again after it has left the screen entirely and come back). Pass `null` to observe
 * nothing. Combine it with the card's own ref through `useMergedRefs` from `@webflix/ui`, which
 * keeps it attached across renders and runs its cleanup (an inline merge would restart it on
 * every render).
 *
 *   const impressionRef = useImpressionRef({ titleId: card.id, context: { rowId, rowRank, rank } });
 */
export function useImpressionRef(
  card: { titleId: string; context?: TelemetryContext } | null,
): RefCallback<Element> {
  const scope = useContext(ScopeContext);
  const titleId = card?.titleId ?? null;
  const key = JSON.stringify(card?.context ?? null);
  return useCallback(
    (element: Element | null) => {
      if (!element || titleId === null) return;
      return observeImpression(element, {
        titleId,
        context: { ...scope, ...(card?.context ?? {}) },
      });
    },
    [scope, titleId, key],
  );
}

/** A ref callback that observes a row: one `row.view` per appearance, as for a card. */
export function useRowViewRef(row: RowViewInput | null): RefCallback<Element> {
  const scope = useContext(ScopeContext);
  const key = JSON.stringify(row);
  return useCallback(
    (element: Element | null) => {
      if (!element || !row) return;
      return observeRowView(element, {
        ...row,
        context: { ...scope, ...(row.context ?? {}) },
      });
    },
    [scope, key],
  );
}

/**
 * Runs the telemetry engine for this app instance (mounted once, in the app shell). The engine
 * and the SDK are their own chunk, loaded once the page is idle: they never compete with the
 * first paint, and a page that collects nothing (a signed-out visitor in opt-in mode) still pays
 * only for this.
 */
export function TelemetryRuntimeMount() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let active = true;
    let stopEngine = () => {};
    const stopListening = listenForConsentElsewhere(queryClient);
    const cancelIdle = whenIdle(() => {
      import("./engine.ts")
        .then(({ startTelemetry, stopTelemetry }) => {
          if (!active) return;
          const engine = startTelemetry({ queryClient });
          stopEngine = () => stopTelemetry(engine);
        })
        .catch(() => {
          // No telemetry is the safe failure: nothing is collected, the member notices nothing.
        });
    });
    return () => {
      active = false;
      cancelIdle();
      stopEngine();
      stopListening();
    };
  }, [queryClient]);
  return null;
}

function whenIdle(run: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(run, { timeout: 2000 });
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(run, 0);
  return () => clearTimeout(handle);
}
