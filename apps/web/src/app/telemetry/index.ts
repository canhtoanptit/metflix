/**
 * Telemetry: the one module the app reports behaviour events through (docs/BLUEPRINT-M2.md §6).
 *
 * Reporting never costs the member anything: no request of its own, no error, no layout work.
 * Whether anything is collected is decided here, not by screens: nothing from a kids or
 * restricted profile, nothing before consent where it is required, nothing in `off` mode, and
 * Global Privacy Control honoured. Experiment assignments are added to every event from the
 * session. Screens only say what happened and where:
 *
 *   // A page: everything below gets its surface and ranking policy.
 *   <TelemetryScope context={{ surface: "home", policy: page.policy }}>…</TelemetryScope>
 *
 *   // A row and its cards (1-based positions; the billboard is rowRank 1). One impression or
 *   // row view per appearance: again only after it left the screen entirely and came back.
 *   const rowRef = useRowViewRef({ rowKind: row.kind, itemCount: row.items.length,
 *     context: { rowId: row.id, rowRank } });
 *   const cardRef = useImpressionRef({ titleId: card.id, context: { rowId: row.id, rowRank, rank } });
 *   // With the card's own ref: `useMergedRefs` from `@webflix/ui` (never an inline `mergeRefs`,
 *   // which restarts the observation on every render).
 *   <TitleTileLink ref={useMergedRefs(ownRef, cardRef)} … />
 *
 *   // What the member did (the same rowRank and rank on the title-open after an impression).
 *   const track = useTrack();
 *   track("title.open", { titleId }, { rowId: row.id, rowRank, rank });
 *   track("search.query", { queryLength: q.length, resultCount });   // never the query text
 *
 *   // Outside React (a mutation's onSuccess): the plain function, context spelled out.
 *   track("list.add", { titleId }, { surface: "title-detail" });
 */
export {
  answerConsent,
  consentOwner,
  consentQuery,
  useAnswerConsent,
  useConsent,
} from "./consent.ts";
export {
  browserGpc,
  effectivePurposes,
  isRestrictedProfile,
  type Purposes,
} from "./policy.ts";
export {
  TelemetryRuntimeMount,
  TelemetryScope,
  useImpressionRef,
  useRowViewRef,
  useTelemetryScope,
  useTrack,
} from "./react.tsx";
export {
  discardPendingEvents,
  observeImpression,
  observeRowView,
  type RowViewInput,
  type TelemetryContext,
  type TrackPayload,
  track,
} from "./runtime.ts";
