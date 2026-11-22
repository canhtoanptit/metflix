import { EVENT_BATCH_MAX_BYTES } from "../constants.ts";
import { EventBatch, EventBatchAck, RecentEvents, RecentEventsQuery } from "../events.ts";
import { ConsentState, PrivacyRequest, PrivacyRequestList, UpdateConsentBody } from "../privacy.ts";
import { defineRoute } from "../route.ts";

/**
 * Routes of the `events` area. Milestone 2's behaviour events, consent, data export and account
 * deletion, and the events read-back for the suites (docs/BLUEPRINT-M2.md §6). Part of `routes`
 * (src/routes.ts): the key is the operation id and the client method name.
 */
export const eventsRoutes = {
  ingestEvents: defineRoute({
    method: "POST",
    path: "/events",
    tag: "events",
    area: "events",
    auth: "public",
    summary: "Behaviour events from the telemetry SDK",
    description:
      "At most 50 events and 64 KiB. Signed out allowed. The server stamps `receivedAt` and the subject (pseudonymous keys, plan, country, restricted, consent) from the session; events without consent, and every client event of a restricted profile, are dropped (`dropped`), never an error. Limited per account, or per client address signed out (`events`).",
    body: EventBatch,
    maxBodyBytes: EVENT_BATCH_MAX_BYTES,
    response: EventBatchAck,
    successStatus: 202,
    rateLimit: "events",
  }),
  getConsent: defineRoute({
    method: "GET",
    path: "/privacy/consent",
    tag: "privacy",
    area: "events",
    auth: "public",
    summary: "The consent in force for the caller and whether to ask",
    response: ConsentState,
  }),
  updateConsent: defineRoute({
    method: "PUT",
    path: "/privacy/consent",
    tag: "privacy",
    area: "events",
    auth: "account",
    summary: "Grant or withdraw consent for one purpose",
    description:
      "Per account; the latest answer wins and emits a `consent.change` event. A restricted profile answers `unrestricted_profile_required` (checked by the handler).",
    body: UpdateConsentBody,
    response: ConsentState,
    errors: ["unrestricted_profile_required"],
    examples: { request: { purpose: "personalisation", granted: false, source: "settings" } },
  }),
  requestDataExport: defineRoute({
    method: "POST",
    path: "/privacy/export",
    tag: "privacy",
    area: "events",
    auth: "account-holder",
    summary: "Download your data: start an export (emailed as a signed link)",
    response: PrivacyRequest,
    successStatus: 202,
    errors: ["privacy_request_pending", "reauthentication_required", "demo_account_protected"],
  }),
  listPrivacyRequests: defineRoute({
    method: "GET",
    path: "/privacy/requests",
    tag: "privacy",
    area: "events",
    auth: "account-holder",
    summary: "Exports and deletion requests of the account",
    response: PrivacyRequestList,
  }),
  requestAccountDeletion: defineRoute({
    method: "POST",
    path: "/account/deletion",
    tag: "privacy",
    area: "events",
    auth: "account-holder",
    summary: "Delete the account after a cooling-off period",
    description:
      "Needs a fresh account-holder proof. Billing records are retained as the law requires; the pseudonymous key mapping is deleted and the subject's events are erased at the next compaction.",
    response: PrivacyRequest,
    successStatus: 202,
    errors: ["privacy_request_pending", "reauthentication_required", "demo_account_protected"],
  }),
  cancelAccountDeletion: defineRoute({
    method: "DELETE",
    path: "/account/deletion",
    tag: "privacy",
    area: "events",
    auth: "account-holder",
    summary: "Cancel a deletion during its cooling-off period",
    response: null,
    errors: ["not_found"],
  }),
  getRecentEvents: defineRoute({
    method: "GET",
    path: "/diagnostics/events",
    tag: "diagnostics",
    area: "events",
    auth: "account",
    summary: "Events ingestion accepted recently for this account (not in production)",
    description:
      "What the suites read back to prove consent and restricted profiles are honoured. `not_found` in production.",
    query: RecentEventsQuery,
    response: RecentEvents,
    errors: ["not_found"],
  }),
} as const;
