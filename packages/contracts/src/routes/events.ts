import { EVENT_BATCH_MAX_BYTES } from "../constants.ts";
import { EventBatch, EventBatchAck, RecentEvents, RecentEventsQuery } from "../events.ts";
import {
  ConsentState,
  DataExport,
  DataExportParams,
  DataExportQuery,
  PrivacyRequest,
  PrivacyRequestList,
  UpdateConsentBody,
} from "../privacy.ts";
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
      "At most 50 events and 64 KiB, all from one device. Signed out allowed. The server stamps `receivedAt` and the subject (pseudonymous keys, plan, country, restricted, consent) from the session; events without consent, and every client event of a restricted profile, are dropped (`dropped`), never an error. Every request is limited twice by the `events` policy: per account (signed out: per client address) and per device (`deviceId`).",
    body: EventBatch,
    maxBodyBytes: EVENT_BATCH_MAX_BYTES,
    response: EventBatchAck,
    successStatus: 202,
    rateLimit: "events",
    rateLimitScope: "handler",
    examples: {
      request: {
        events: [
          {
            eventId: "0193a1d2-7c4e-7a10-8f00-000000000001",
            type: "impression",
            version: 1,
            occurredAt: "2026-11-22T10:15:30.120Z",
            deviceId: "d7f3a91c2b6e4d08",
            sessionSeq: 17,
            app: { platform: "web", version: "2026.11.22" },
            context: {
              surface: "home",
              rowId: "home:trending",
              rowRank: 3,
              rank: 2,
              experiments: {},
              policy: { id: "rules-v1", explore: false },
            },
            payload: { titleId: "t-sintel", sampleRate: 0.25 },
          },
        ],
      },
      response: { accepted: 1, dropped: 0 },
    },
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
  downloadDataExport: defineRoute({
    method: "GET",
    path: "/privacy/exports/:id",
    tag: "privacy",
    area: "events",
    auth: "account-holder",
    summary: "Download a completed data export (the signed link from the email)",
    description:
      "The link (`PrivacyRequest.downloadUrl`) carries a signed token bound to the request and the account, valid until `expiresAt`; the caller must also be signed in to that account as its holder. `not_found` for an unknown, foreign, unfinished or expired export, or a bad token. The export email does not link here: it opens the web app at `{public origin}/account/privacy/exports/{id}#token={token}` (the token in the fragment, never sent to a server by the page load), which asks the member to sign in and then calls this route with that token.",
    params: DataExportParams,
    query: DataExportQuery,
    response: DataExport,
    errors: ["not_found"],
  }),
  listPrivacyRequests: defineRoute({
    method: "GET",
    path: "/privacy/requests",
    tag: "privacy",
    area: "events",
    auth: "account-holder",
    summary: "Exports and deletion requests of the account, and the terms of a new one",
    description:
      "Newest first. `terms` are this deployment's settings a member may want before asking (the cooling-off period, how long an export link lasts, how long an export normally takes, how long events are kept), from configuration. A deletion's `membership` says what it did to the membership (stopping, ending on `endsAt`, renewing, ended, none) and whether to offer resuming it.",
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
      "Needs a fresh account-holder proof. The request is recorded first; then the membership's renewals are stopped through billing (it ends at the close of its period, or with the account if that comes first), retried on every scheduler tick if billing cannot answer (`membership.status: stopping`). Keeping the account leaves the membership set to end (`membership.resumable`). Billing records are retained as the law requires; the pseudonymous key mapping is deleted and the subject's events are erased at the next compaction.",
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
