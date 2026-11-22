import {
  API_BASE_PATH,
  DataExport,
  type DeletionMembership,
  type JsonValue,
  LakeEvent,
  type MembershipState,
  type PrivacyRequest,
  type PrivacyTerms,
} from "@webflix/contracts";
import * as z from "zod";
import { hexEncode, utf8Decode, utf8Encode } from "../../encoding.ts";
import { AppError } from "../../errors.ts";
import { toIsoString } from "../../ports/clock.ts";
import {
  decodeLakeObject,
  PRIVATE_DOCUMENT_PREFIX,
  type SubjectKeys,
} from "../../ports/event-sink.ts";
import { keepEarliestReceipt } from "../../ports/lake-reader.ts";
import { serializeError } from "../../ports/logger.ts";
import { createHmacTokenSigner } from "../../ports/token-signer.ts";
import type { AuthContext, ServiceDependencies } from "../../services/context.ts";
import { createCredentialChecks } from "../../services/credentials.ts";
import { isDemoAccount } from "../../services/privileges.ts";
import { sendTemplatedEmail } from "../identity/email.ts";
import type { AreaModule } from "../module.ts";
import { privacyEraseJob, privacyExportJob } from "./jobs.ts";
import type { OtherAreas } from "./neighbours.ts";
import {
  type MembershipStep,
  PARTIAL_EXPORT_SUFFIX,
  type PrivacyRequestRecord,
} from "./repository.ts";

const Instant = z
  .string()
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$/);
const RequestId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

/** What the export takes from identity's `exportAccountData` (its other fields stay there). */
const IdentityExportPart = z.object({
  profiles: DataExport.shape.profiles.default([]),
  devices: DataExport.shape.devices.default([]),
});

/**
 * The results document of the pipeline's `export-events`
 * (services/recs/schemas/export-events-results.schema.json), as the operator route passes it.
 */
export const ExportEventsResults = z.object({
  format: z.literal("webflix.export-events-results"),
  formatVersion: z.literal(1),
  generatedAt: Instant,
  results: z.array(
    z.object({
      requestId: RequestId,
      status: z.enum(["complete", "erased", "deferred", "failed"]),
      from: Instant,
      to: Instant,
      events: z.number().int().nonnegative().optional(),
      file: z.string().optional(),
      manifest: z.string().optional(),
      bytes: z.number().int().nonnegative().optional(),
      sha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
      generatedAt: Instant.optional(),
      reused: z.boolean().optional(),
      notBefore: Instant.optional(),
      error: z.string().optional(),
    }),
  ),
});
export type ExportEventsResults = z.input<typeof ExportEventsResults>;

/** The exports the pipeline must extract (services/recs/schemas/export-events-requests.schema.json). */
export interface ExportEventsRequestList {
  requests: { requestId: string; accountKey: string; from: string; to: string }[];
}

/** What `recordExportResults` did with each result, by request id. */
export interface ExportResultsOutcome {
  /** Events folded in, the export finished and emailed. */
  completed: string[];
  /** The account is being deleted: finished with no events. */
  erased: string[];
  /** Deferred, failed or refused (size, digest, content): still listed. */
  kept: string[];
  /** Unknown, already finished, or not waiting for events: nothing changed. */
  ignored: string[];
}

const DAY_MS = 24 * 3600 * 1000;
const HISTORY_PAGE = 100;
const SWEEP_BATCH = 25;
/** An export job not heard of for this long is queued again; a request this old is given up. */
const RECOVER_EXPORT_AFTER_MS = 15 * 60_000;
const GIVE_UP_EXPORT_AFTER_MS = 24 * 3600_000;
const EXPORT_TOKEN_PURPOSE = "privacy-export";
/** Deletions whose renewals are still being stopped, retried per sweep (provider calls). */
const MEMBERSHIP_RETRY_BATCH = 10;

/**
 * The web app's page the export email links to: `{origin}{EXPORT_LANDING_PATH}/{id}#token=…`.
 * It asks the member to sign in, then downloads through `GET /privacy/exports/:id?token=`.
 */
export const EXPORT_LANDING_PATH = "/account/privacy/exports";

/** Billing's view of the membership, as the privacy state reads it (its service's answer). */
interface LiveMembership {
  state: MembershipState;
  entitlement: { entitled: boolean };
}

/** When the membership ends if nothing changes: the trial's end while trialing, else the period's. */
function periodEnd(state: MembershipState): number | null {
  const end =
    state.status === "trialing"
      ? (state.trialEndsAt ?? state.currentPeriodEnd)
      : (state.currentPeriodEnd ?? state.trialEndsAt);
  return end === null ? null : Date.parse(end);
}

async function pipe(bytes: Uint8Array, transform: TransformStream<Uint8Array, Uint8Array>) {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gzipJson(value: unknown): Promise<Uint8Array> {
  return pipe(
    utf8Encode(JSON.stringify(value)),
    new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
}

export async function gunzipJson(bytes: Uint8Array): Promise<unknown> {
  const text = utf8Decode(
    await pipe(
      bytes,
      new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
    ),
  );
  return JSON.parse(text) as unknown;
}

/**
 * Member rights (§6.3): "Download your data" (an asynchronous export to a signed link, sent by
 * email) and "Delete account" (a fresh account-holder proof, a cooling-off period, then
 * erasure; billing records retained). Both are jobs, idempotent under at-least-once delivery:
 * every step is a compare-and-set on the request's status or safe to repeat.
 */
export function createPrivacy(
  deps: ServiceDependencies,
  keys: SubjectKeys,
  otherAreas: OtherAreas,
  /** Moves the event outbox to the lake, so an export also holds the newest server events. */
  drainOutbox: () => Promise<unknown> = async () => undefined,
) {
  const { repos, clock, ids, jobs, logger, config, eventSink } = deps;
  const credentials = createCredentialChecks(deps);
  const signer = createHmacTokenSigner({ keys: config.media.tokenKeys, clock });

  function guardRequester(auth: AuthContext): void {
    if (isDemoAccount(auth.session.accountId)) throw new AppError("demo_account_protected");
  }

  async function requireFreshProof(auth: AuthContext): Promise<void> {
    // The account-holder proof (§4.2) is identity's: credentials.ts grants and honours it.
    if (!(await credentials.isElevated(auth))) throw new AppError("reauthentication_required");
  }

  function downloadPath(id: string, token: string): string {
    return `${API_BASE_PATH}/privacy/exports/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`;
  }

  async function exportToken(record: PrivacyRequestRecord): Promise<string> {
    return signer.sign({
      purpose: EXPORT_TOKEN_PURPOSE,
      exp: Math.floor((record.expiresAt ?? 0) / 1000),
      requestId: record.id,
      accountId: record.accountId,
    });
  }

  function downloadable(record: PrivacyRequestRecord, now: number): boolean {
    return (
      record.kind === "export" &&
      record.status === "completed" &&
      record.exportBlobKey !== null &&
      record.expiresAt !== null &&
      record.expiresAt > now
    );
  }

  /**
   * What a deletion did to the membership. `live` is billing's current answer, read only for
   * the account's latest deletion while it can still matter (scheduled or cancelled); without
   * it the stored step speaks.
   */
  function membershipView(
    record: PrivacyRequestRecord,
    live: LiveMembership | null,
    now: number,
  ): DeletionMembership | null {
    if (record.kind !== "deletion" || record.membershipStep === null) return null;
    const plain = (status: DeletionMembership["status"]): DeletionMembership => ({
      status,
      endsAt: null,
      resumable: false,
    });
    const step = record.membershipStep;
    if (record.status === "processing" || record.status === "completed") {
      return plain(step === "none" ? "none" : "ended"); // the erasure ends it
    }
    if (step === "none") return plain("none");
    if (step === "stopping" && (record.status === "scheduled" || live === null)) {
      return plain("stopping");
    }
    let endsAt = record.membershipEndsAt;
    if (live) {
      if (!live.entitlement.entitled) return plain(step === "ending" ? "ended" : "none");
      if (!live.state.cancelAtPeriodEnd) return plain("renewing");
      endsAt = periodEnd(live.state) ?? endsAt;
    } else if (endsAt !== null && endsAt <= now) {
      return plain("ended");
    }
    if (record.status === "scheduled" && record.scheduledFor !== null && endsAt !== null) {
      endsAt = Math.min(endsAt, record.scheduledFor);
    }
    return {
      status: "ending",
      endsAt: endsAt === null ? null : toIsoString(endsAt),
      resumable: record.status === "canceled" && live !== null,
    };
  }

  /** The member's view of a request. Staff never receive the download link. */
  async function present(
    record: PrivacyRequestRecord,
    options: { withLink: boolean; live?: LiveMembership | null },
  ): Promise<PrivacyRequest> {
    const now = clock.now();
    const link = options.withLink && downloadable(record, now);
    return {
      id: record.id,
      kind: record.kind,
      status: record.status,
      requestedAt: toIsoString(record.requestedAt),
      scheduledFor: record.scheduledFor === null ? null : toIsoString(record.scheduledFor),
      completedAt: record.completedAt === null ? null : toIsoString(record.completedAt),
      downloadUrl: link ? downloadPath(record.id, await exportToken(record)) : null,
      expiresAt:
        record.kind === "export" && record.expiresAt !== null && record.exportBlobKey !== null
          ? toIsoString(record.expiresAt)
          : null,
      membership: membershipView(record, options.live ?? null, now),
    };
  }

  /** What a member may want to know before asking (configuration only: no database read). */
  function terms(): PrivacyTerms {
    const settings = config.events;
    return {
      deletionCoolingOffSec: settings.deletionCoolingOffSec,
      exportLinkTtlSec: settings.exportLinkTtlSec,
      exportMode: settings.exportEvents,
      exportTypicalSec: settings.exportTypicalSec,
      eventsRetentionDays: settings.rawRetentionDays,
      aggregatesRetentionDays: settings.aggregateRetentionDays,
    };
  }

  /** Billing's current answer for the account, or null when it cannot give one right now. */
  async function liveMembership(accountId: string): Promise<LiveMembership | null> {
    try {
      return await otherAreas().billing.membership(accountId, null);
    } catch (error) {
      logger.warn("privacy.membership_unreadable", { error: serializeError(error) });
      return null;
    }
  }

  /**
   * A deletion stops the membership's renewals (it ends at the close of its period) through
   * billing's service, never its repository. Never throws for billing's answer: no membership
   * a provider renews is `none`; anything else (the provider briefly unavailable, a membership
   * still renewing afterwards) leaves the step `stopping` for the sweep to try again.
   */
  async function stopRenewals(record: PrivacyRequestRecord): Promise<PrivacyRequestRecord> {
    const billing = otherAreas().billing;
    let outcome: { membershipStep: MembershipStep; membershipEndsAt: number | null };
    try {
      await billing.cancel(record.accountId);
      const after = await billing.membership(record.accountId, null);
      if (after.entitlement.entitled && !after.state.cancelAtPeriodEnd) {
        throw new Error(`the membership still renews (${after.state.status})`);
      }
      outcome =
        after.entitlement.entitled && after.state.cancelAtPeriodEnd
          ? { membershipStep: "ending", membershipEndsAt: periodEnd(after.state) }
          : { membershipStep: "none", membershipEndsAt: null };
    } catch (error) {
      if (error instanceof AppError && error.code === "subscription_required") {
        outcome = { membershipStep: "none", membershipEndsAt: null };
      } else {
        logger.warn("privacy.deletion_renewals_not_stopped", {
          requestId: record.id,
          error: serializeError(error),
        });
        const lastError = `renewals not stopped yet: ${String((error as Error)?.message ?? error)}`;
        // Touched, so the next sweep tries the others first.
        await repos.events.transitionPrivacyRequest(record.id, ["scheduled"], {
          lastError: lastError.slice(0, 500),
          updatedAt: clock.now(),
        });
        return record;
      }
    }
    await repos.events.transitionPrivacyRequest(record.id, ["scheduled", "canceled"], {
      ...outcome,
      lastError: null,
      updatedAt: clock.now(),
    });
    logger.info("privacy.deletion_renewals_stopped", {
      requestId: record.id,
      membership: outcome.membershipStep,
    });
    return { ...record, ...outcome };
  }

  // --- Export -------------------------------------------------------------------------------

  /** The receipt window of an export's events: the raw retention up to the request. */
  function eventsWindow(record: PrivacyRequestRecord): { fromMs: number; toMs: number } {
    return {
      fromMs: record.requestedAt - config.events.rawRetentionDays * DAY_MS,
      toMs: record.requestedAt,
    };
  }

  /**
   * Inline mode: every lake event of the account in the window, read by this job through the
   * port (raw objects and compacted hours, by the pipeline's reader contract), validated.
   */
  async function inlineEvents(record: PrivacyRequestRecord): Promise<LakeEvent[]> {
    const read = await eventSink.accountEvents({
      accountKey: await keys.account(record.accountId),
      ...eventsWindow(record),
    });
    const events: LakeEvent[] = [];
    for (const raw of read.events) {
      const parsed = LakeEvent.safeParse(raw);
      if (parsed.success) events.push(parsed.data);
      else logger.warn("privacy.export_event_invalid", { requestId: record.id });
    }
    return events;
  }

  async function historyOf(profileId: string) {
    const entries = [];
    let before: { watchedAt: number; id: string } | undefined;
    for (;;) {
      const page = await repos.library.listHistory(profileId, {
        limit: HISTORY_PAGE,
        ...(before ? { before } : {}),
      });
      entries.push(...page);
      const last = page.at(-1);
      if (page.length < HISTORY_PAGE || !last) break;
      before = { watchedAt: last.watchedAt, id: last.id };
    }
    return entries;
  }

  /**
   * The export document without its events: the account (identity's service), the library,
   * consents and privacy requests (this area's), and every other area's part through its
   * export hook (`areas`). The events come from the lake: inline, or from the pipeline.
   */
  async function collectAccountParts(record: PrivacyRequestRecord): Promise<DataExport> {
    const now = clock.now();
    const accountId = record.accountId;
    // The account through identity's service: it exists with or without a membership.
    const member = await otherAreas().identity.getMemberIdentity(accountId);
    const [consents, requests] = await Promise.all([
      repos.events.listConsents(accountId),
      repos.events.listPrivacyRequests(accountId),
    ]);
    const areas: Record<string, JsonValue> = {};
    for (const [name, module] of Object.entries(otherAreas()) as [string, AreaModule][]) {
      if (module.exportAccountData) areas[name] = await module.exportAccountData(accountId);
    }
    // Profiles (settings, avatars) and devices in full are identity's part (its milestone 1
    // tables); the document's top-level lists repeat them in the contract's shape.
    const identityPart = IdentityExportPart.parse(areas.identity ?? {});
    const library: DataExport["library"] = [];
    for (const profile of member.profiles) {
      const [signals, history] = await Promise.all([
        repos.library.loadSignals(profile.id),
        historyOf(profile.id),
      ]);
      library.push({
        profileId: profile.id,
        myList: signals.myList.map((entry) => ({
          titleId: entry.titleId,
          addedAt: toIsoString(entry.addedAt),
        })),
        ratings: signals.ratings.map((entry) => ({
          titleId: entry.titleId,
          value: entry.value,
          ratedAt: toIsoString(entry.ratedAt),
        })),
        progress: signals.progress.map((entry) => ({
          titleId: entry.titleId,
          episodeId: entry.episodeId,
          positionSec: entry.positionSec,
          durationSec: entry.durationSec,
          completed: entry.completed,
          updatedAt: toIsoString(entry.updatedAt),
        })),
        history: history.map((entry) => ({
          titleId: entry.titleId,
          episodeId: entry.episodeId,
          watchedAt: toIsoString(entry.watchedAt),
        })),
      });
    }
    return {
      format: "webflix.data-export",
      formatVersion: 1,
      requestId: record.id,
      generatedAt: toIsoString(now),
      account: {
        id: member.account.id,
        email: member.account.email,
        createdAt: member.account.createdAt,
      },
      profiles: identityPart.profiles,
      devices: identityPart.devices,
      library,
      consents: consents.map((entry) => ({
        purpose: entry.purpose,
        granted: entry.granted,
        source: entry.source,
        at: toIsoString(entry.createdAt),
      })),
      privacyRequests: requests.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        status: entry.status,
        requestedAt: toIsoString(entry.requestedAt),
        completedAt: entry.completedAt === null ? null : toIsoString(entry.completedAt),
      })),
      events: [],
      areas,
      notes: [
        "Behaviour events are stored under pseudonymous keys derived from your account and profile ids; the ones listed are every event the event lake holds for your account within its retention period.",
        "Your membership and invoices are under areas.billing, your sign-in methods and email verification under areas.identity.",
        "Payment card details are held by the payment provider, never by Webflix; invoices and payment records are kept by Webflix and the provider for as long as the law requires.",
        "Recommendations are computed from the data above and are not stored as separate personal data.",
      ],
    };
  }

  async function sendExportEmail(record: PrivacyRequestRecord, to: string): Promise<void> {
    // The web app's page, which can ask the member to sign in first (the email is usually
    // opened later, elsewhere). The token rides in the fragment, like identity's links: never
    // sent to a server by the page load, never in an access log or a Referer.
    const token = await exportToken(record);
    const link = `${config.publicOrigin}${EXPORT_LANDING_PATH}/${encodeURIComponent(record.id)}#token=${encodeURIComponent(token)}`;
    // Identity's templates and suppression list; at most one message per export.
    const outcome = await sendTemplatedEmail(deps, {
      to,
      template: "data-export-ready",
      data: { link, expiresAt: toIsoString(record.expiresAt ?? clock.now()) },
      idempotencyKey: `privacy-export:${record.id}`,
    });
    if (!outcome.sent) {
      // The address bounced or complained before: the export is still listed with its link.
      logger.info("privacy.export_email_suppressed", { requestId: record.id });
    }
  }

  const finalKey = (id: string) => `${PRIVATE_DOCUMENT_PREFIX}exports/${id}.json.gz`;
  const partialKey = (id: string) =>
    `${PRIVATE_DOCUMENT_PREFIX}exports/${id}${PARTIAL_EXPORT_SUFFIX}`;
  const pipelineKeys = (id: string) => ({
    events: `${PRIVATE_DOCUMENT_PREFIX}export-events/${id}/events.ndjson.gz`,
    manifest: `${PRIVATE_DOCUMENT_PREFIX}export-events/${id}/manifest.json`,
  });
  const nameOf = (key: string) => key.slice(PRIVATE_DOCUMENT_PREFIX.length);

  /** Batch mode: assembled, its partial document stored, waiting for the pipeline's result. */
  function isWaitingForEvents(record: PrivacyRequestRecord): boolean {
    return (
      record.kind === "export" &&
      record.status === "processing" &&
      record.exportBlobKey?.endsWith(PARTIAL_EXPORT_SUFFIX) === true
    );
  }

  async function errorOn(requestId: string, error: unknown): Promise<void> {
    await repos.events
      .transitionPrivacyRequest(requestId, ["processing"], {
        lastError: String((error as Error)?.message ?? error).slice(0, 500),
        updatedAt: clock.now(),
      })
      .catch(() => undefined);
  }

  /**
   * Write the finished document, email the link (at most once per export), complete the
   * request. A retry replaces what an interrupted attempt left. False when the request was
   * finished (or cancelled) meanwhile.
   */
  async function finishExport(
    record: PrivacyRequestRecord,
    document: DataExport,
    events: LakeEvent[],
  ): Promise<boolean> {
    const finished: DataExport = { ...document, generatedAt: toIsoString(clock.now()), events };
    await eventSink.deleteDocument(finalKey(record.id));
    const key = await eventSink.putDocument(nameOf(finalKey(record.id)), await gzipJson(finished));
    const expiresAt = clock.now() + config.events.exportLinkTtlSec * 1000;
    await sendExportEmail({ ...record, exportBlobKey: key, expiresAt }, document.account.email);
    const completed = await repos.events.transitionPrivacyRequest(record.id, ["processing"], {
      status: "completed",
      exportBlobKey: key,
      expiresAt,
      completedAt: clock.now(),
      lastError: null,
      updatedAt: clock.now(),
    });
    if (completed) {
      logger.info("privacy.export_completed", { requestId: record.id, events: events.length });
    }
    return completed;
  }

  /** The `privacy.export` job: inline, the whole export; batch, all but the events. */
  async function runExport(requestId: string): Promise<void> {
    const record = await repos.events.getPrivacyRequest(requestId);
    if (record?.kind !== "export") return;
    if (record.status !== "pending" && record.status !== "processing") return;
    if (isWaitingForEvents(record)) return; // assembled already: the pipeline's turn
    await repos.events.transitionPrivacyRequest(requestId, ["pending", "processing"], {
      status: "processing",
      updatedAt: clock.now(),
    });
    try {
      await drainOutbox();
      const document = await collectAccountParts(record);
      if (config.events.exportEvents === "inline") {
        await finishExport(record, document, await inlineEvents(record));
        return;
      }
      await eventSink.deleteDocument(partialKey(record.id));
      const key = await eventSink.putDocument(
        nameOf(partialKey(record.id)),
        await gzipJson(document),
      );
      await repos.events.transitionPrivacyRequest(requestId, ["processing"], {
        exportBlobKey: key,
        lastError: null,
        updatedAt: clock.now(),
      });
      logger.info("privacy.export_waiting_for_events", { requestId });
    } catch (error) {
      await errorOn(requestId, error);
      throw error;
    }
  }

  /** Batch mode: the requests the pipeline's `export-events` must extract (listed until done). */
  async function pendingExports(limit: number): Promise<ExportEventsRequestList> {
    const records = await repos.events.waitingExports(limit);
    return {
      requests: await Promise.all(
        records.map(async (record) => {
          const window = eventsWindow(record);
          return {
            requestId: record.id,
            accountKey: await keys.account(record.accountId),
            from: toIsoString(window.fromMs),
            to: toIsoString(window.toMs),
          };
        }),
      ),
    };
  }

  /**
   * The pipeline's output for one complete request, verified: the file under the request's
   * own prefix, its size and SHA-256 as the result says, every line a lake event of this
   * account in the request's window.
   */
  async function pipelineEvents(
    record: PrivacyRequestRecord,
    result: ExportEventsResults["results"][number],
  ): Promise<LakeEvent[]> {
    const expected = pipelineKeys(record.id).events;
    if (result.file !== undefined && result.file !== expected) {
      throw new Error(`the result names ${result.file}, not ${expected}`);
    }
    if (result.bytes === undefined || result.sha256 === undefined) {
      throw new Error("the result has no size or SHA-256");
    }
    const bytes = await eventSink.getDocument(expected);
    if (!bytes) throw new Error(`${expected} is missing`);
    if (bytes.byteLength !== result.bytes) {
      throw new Error(`${expected}: ${bytes.byteLength} bytes, the result says ${result.bytes}`);
    }
    const digest = hexEncode(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))),
    );
    if (digest !== result.sha256) throw new Error(`${expected}: SHA-256 does not match`);
    const accountKey = await keys.account(record.accountId);
    const window = eventsWindow(record);
    const events: LakeEvent[] = [];
    for (const raw of await decodeLakeObject(bytes)) {
      const parsed = LakeEvent.safeParse(raw);
      if (!parsed.success) throw new Error(`${expected}: a line is not a lake event`);
      const received = Date.parse(parsed.data.receivedAt);
      if (parsed.data.subject.account !== accountKey) {
        throw new Error(`${expected}: an event of another account`);
      }
      if (received < window.fromMs || received >= window.toMs) {
        throw new Error(`${expected}: an event outside the request's window`);
      }
      events.push(parsed.data);
    }
    if (result.events !== undefined && result.events !== events.length) {
      throw new Error(`${expected}: ${events.length} events, the result says ${result.events}`);
    }
    return keepEarliestReceipt(events) as LakeEvent[];
  }

  /**
   * Batch mode: fold the pipeline's results in (its `--results` document). `complete`: the
   * events verified and folded in, the export finished and emailed, the pipeline's documents
   * deleted. `erased` (the account is being deleted): finished with no events. `deferred` and
   * `failed`: listed again next time (a failure's error recorded). A result for an unknown,
   * finished or not-yet-assembled request changes nothing.
   */
  async function recordExportResults(input: ExportEventsResults): Promise<ExportResultsOutcome> {
    const document = ExportEventsResults.parse(input);
    const outcome: ExportResultsOutcome = { completed: [], erased: [], kept: [], ignored: [] };
    for (const result of document.results) {
      const record = await repos.events.getPrivacyRequest(result.requestId);
      if (!record || !isWaitingForEvents(record) || record.exportBlobKey === null) {
        outcome.ignored.push(result.requestId);
        continue;
      }
      if (result.status === "deferred") {
        outcome.kept.push(record.id);
        continue;
      }
      if (result.status === "failed") {
        await errorOn(record.id, `export-events failed: ${result.error ?? "no detail"}`);
        outcome.kept.push(record.id);
        continue;
      }
      try {
        const partial = await eventSink.getDocument(record.exportBlobKey);
        if (!partial) throw new Error(`${record.exportBlobKey} is missing`);
        const assembled = DataExport.parse(await gunzipJson(partial));
        const events = result.status === "complete" ? await pipelineEvents(record, result) : [];
        if (!(await finishExport(record, assembled, events))) {
          outcome.ignored.push(record.id);
          continue;
        }
        const pipeline = pipelineKeys(record.id);
        await eventSink.deleteDocument(record.exportBlobKey);
        await eventSink.deleteDocument(pipeline.events);
        await eventSink.deleteDocument(pipeline.manifest);
        (result.status === "complete" ? outcome.completed : outcome.erased).push(record.id);
      } catch (error) {
        logger.warn("privacy.export_result_refused", {
          requestId: record.id,
          error: serializeError(error),
        });
        await errorOn(record.id, error);
        outcome.kept.push(record.id);
      }
    }
    return outcome;
  }

  // --- Deletion and erasure ------------------------------------------------------------------

  /** The `privacy.erase` job: everything that must go goes; billing records stay (D-M2-6). */
  async function runErasure(requestId: string): Promise<void> {
    const record = await repos.events.getPrivacyRequest(requestId);
    if (record?.kind !== "deletion") return;
    const now = clock.now();
    if (record.status === "scheduled" && (record.scheduledFor ?? Number.POSITIVE_INFINITY) > now) {
      return; // not due: the cooling-off period is still running
    }
    if (isDemoAccount(record.accountId)) return;
    const claimed = await repos.events.transitionPrivacyRequest(
      requestId,
      ["scheduled", "processing"],
      { status: "processing", updatedAt: now },
    );
    if (!claimed) return; // cancelled, or completed by another delivery
    const accountId = record.accountId;
    try {
      // Erasure keys first: a retry after the account row is gone still has them.
      // The profiles through identity's service; on a retry after the account row went, none
      // are left and their keys were recorded by the earlier attempt.
      const profiles = await otherAreas()
        .identity.getMemberIdentity(accountId)
        .then((member) => member.profiles)
        .catch((error: unknown) => {
          if (error instanceof AppError && error.code === "not_found") return [];
          throw error;
        });
      const accountKey = await keys.account(accountId);
      await repos.events.addErasures([
        {
          subjectKey: accountKey,
          kind: "account",
          accountKey: null,
          requestedAt: now,
          compactedAt: null,
        },
        // The account's key covers its profiles: listed under it, settled with it.
        ...(await Promise.all(
          profiles.map(async (profile) => ({
            subjectKey: await keys.profile(profile.id),
            kind: "profile" as const,
            accountKey,
            requestedAt: now,
            compactedAt: null,
          })),
        )),
      ]);
      for (const module of Object.values(otherAreas()) as AreaModule[]) {
        await module.eraseAccountData?.(accountId);
      }
      await deps.streamGate.releaseAll(accountId);
      for (const request of await repos.events.listPrivacyRequests(accountId)) {
        // An export still in progress ends here: there will be nothing to send it to.
        const open =
          request.kind === "export" &&
          (request.status === "pending" || request.status === "processing");
        if (request.exportBlobKey === null && !open) continue;
        if (request.exportBlobKey !== null) await eventSink.deleteDocument(request.exportBlobKey);
        await repos.events.transitionPrivacyRequest(request.id, [request.status], {
          ...(open ? { status: "canceled" as const } : {}),
          exportBlobKey: null,
          updatedAt: clock.now(),
        });
      }
      await repos.events.deleteAccount(accountId);
      await repos.events.transitionPrivacyRequest(requestId, ["processing"], {
        status: "completed",
        completedAt: clock.now(),
        lastError: null,
        updatedAt: clock.now(),
      });
      logger.info("privacy.account_erased", { requestId, profiles: profiles.length });
    } catch (error) {
      await repos.events
        .transitionPrivacyRequest(requestId, ["processing"], {
          lastError: String((error as Error)?.message ?? error).slice(0, 500),
          updatedAt: clock.now(),
        })
        .catch(() => undefined);
      throw error;
    }
  }

  /** The `privacy.sweep` job (every scheduler tick): due erasures, lost and expired exports. */
  async function sweep(): Promise<void> {
    const now = clock.now();
    const due = await repos.events.dueDeletions(now, SWEEP_BATCH);
    if (due.length > 0) {
      await jobs.publishBatch(
        due.map((record) => privacyEraseJob.create({ requestId: record.id })),
      );
    }
    // Exports whose job was lost or dead-lettered: queued again, and given up after a day so
    // the member is never left unable to ask again.
    for (const record of await repos.events.staleExports(
      now - RECOVER_EXPORT_AFTER_MS,
      SWEEP_BATCH,
    )) {
      if (record.requestedAt < now - GIVE_UP_EXPORT_AFTER_MS) {
        await repos.events.transitionPrivacyRequest(record.id, ["pending", "processing"], {
          status: "failed",
          lastError: "the export did not complete in time; ask for a new one",
          updatedAt: now,
        });
        logger.warn("privacy.export_given_up", { requestId: record.id });
        continue;
      }
      if (
        await repos.events.transitionPrivacyRequest(record.id, [record.status], { updatedAt: now })
      ) {
        await jobs.publish(privacyExportJob.create({ requestId: record.id }));
        logger.info("privacy.export_requeued", { requestId: record.id });
      }
    }
    // Deletions whose membership renewals billing could not stop yet: tried again every tick.
    for (const record of await repos.events.deletionsStoppingMembership(MEMBERSHIP_RETRY_BATCH)) {
      await stopRenewals(record);
    }
    for (const record of await repos.events.expiredExports(now, SWEEP_BATCH)) {
      if (record.exportBlobKey === null) continue;
      await eventSink.deleteDocument(record.exportBlobKey);
      await repos.events.transitionPrivacyRequest(record.id, [record.status], {
        exportBlobKey: null,
        updatedAt: now,
      });
    }
  }

  return {
    present,

    async requestExport(auth: AuthContext): Promise<PrivacyRequest> {
      guardRequester(auth);
      await requireFreshProof(auth);
      const now = clock.now();
      const record: PrivacyRequestRecord = {
        id: ids.next(),
        accountId: auth.session.accountId,
        kind: "export",
        status: "pending",
        requestedAt: now,
        scheduledFor: null,
        completedAt: null,
        exportBlobKey: null,
        expiresAt: null,
        lastError: null,
        updatedAt: now,
        membershipStep: null,
        membershipEndsAt: null,
      };
      if (!(await repos.events.createPrivacyRequest(record))) {
        throw new AppError("privacy_request_pending");
      }
      try {
        await jobs.publish(privacyExportJob.create({ requestId: record.id }));
      } catch (error) {
        logger.error("privacy.export_enqueue_failed", { error: serializeError(error) });
        await repos.events.transitionPrivacyRequest(record.id, ["pending"], {
          status: "failed",
          lastError: "could not be queued",
          updatedAt: clock.now(),
        });
        throw new AppError("service_unavailable", { detail: "The export could not start; retry" });
      }
      return present(record, { withLink: true });
    },

    async list(accountId: string, options: { withLink: boolean }): Promise<PrivacyRequest[]> {
      const records = await repos.events.listPrivacyRequests(accountId);
      // Billing's current answer, for the latest deletion only, and only while it can matter.
      const latest = records.find((record) => record.kind === "deletion");
      const asks =
        latest !== undefined &&
        (latest.status === "scheduled" || latest.status === "canceled") &&
        (latest.membershipStep === "ending" ||
          (latest.membershipStep === "stopping" && latest.status === "canceled"));
      const live = asks ? await liveMembership(accountId) : null;
      return Promise.all(
        records.map((record) =>
          present(record, { ...options, live: record === latest ? live : null }),
        ),
      );
    },

    terms,

    async download(auth: AuthContext, requestId: string, token: string): Promise<DataExport> {
      const notFound = () => new AppError("not_found", { detail: "No such export" });
      const verified = await signer.verify(token, EXPORT_TOKEN_PURPOSE);
      if (
        !verified.valid ||
        verified.claims.requestId !== requestId ||
        verified.claims.accountId !== auth.session.accountId
      ) {
        throw notFound();
      }
      const record = await repos.events.getPrivacyRequest(requestId);
      if (!record || record.accountId !== auth.session.accountId) throw notFound();
      if (!downloadable(record, clock.now()) || record.exportBlobKey === null) throw notFound();
      const bytes = await eventSink.getDocument(record.exportBlobKey);
      if (!bytes) throw notFound();
      return DataExport.parse(await gunzipJson(bytes));
    },

    async requestDeletion(auth: AuthContext): Promise<PrivacyRequest> {
      guardRequester(auth);
      await requireFreshProof(auth);
      const now = clock.now();
      const record: PrivacyRequestRecord = {
        id: ids.next(),
        accountId: auth.session.accountId,
        kind: "deletion",
        status: "scheduled",
        requestedAt: now,
        scheduledFor: now + config.events.deletionCoolingOffSec * 1000,
        completedAt: null,
        exportBlobKey: null,
        expiresAt: null,
        lastError: null,
        updatedAt: now,
        membershipStep: "stopping",
        membershipEndsAt: null,
      };
      // Recorded first, whatever billing answers next; then the renewals stop (or the sweep
      // keeps trying until they do).
      if (!(await repos.events.createPrivacyRequest(record))) {
        throw new AppError("privacy_request_pending");
      }
      const stored = await stopRenewals(record).catch((error: unknown) => {
        logger.warn("privacy.deletion_renewals_not_stopped", {
          requestId: record.id,
          error: serializeError(error),
        });
        return record;
      });
      return present(stored, { withLink: false });
    },

    /** Cancel the account's deletion while its cooling-off period runs; false when none. */
    async cancelDeletion(accountId: string): Promise<boolean> {
      const open = (await repos.events.listPrivacyRequests(accountId)).find(
        (record) => record.kind === "deletion" && record.status === "scheduled",
      );
      if (!open) return false;
      return repos.events.transitionPrivacyRequest(open.id, ["scheduled"], {
        status: "canceled",
        updatedAt: clock.now(),
      });
    },

    runExport,
    runErasure,
    sweep,
    pendingExports,
    recordExportResults,
  };
}

export type Privacy = ReturnType<typeof createPrivacy>;
