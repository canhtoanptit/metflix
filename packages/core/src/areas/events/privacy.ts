import {
  API_BASE_PATH,
  DataExport,
  type JsonValue,
  LakeEvent,
  type PrivacyRequest,
} from "@webflix/contracts";
import { utf8Decode, utf8Encode } from "../../encoding.ts";
import { AppError } from "../../errors.ts";
import { toIsoString } from "../../ports/clock.ts";
import type { SubjectKeys } from "../../ports/event-sink.ts";
import { serializeError } from "../../ports/logger.ts";
import { createHmacTokenSigner } from "../../ports/token-signer.ts";
import type { AuthContext, ServiceDependencies } from "../../services/context.ts";
import { createCredentialChecks } from "../../services/credentials.ts";
import { isDemoAccount } from "../../services/privileges.ts";
import { sendTemplatedEmail } from "../identity/email.ts";
import type { AreaModule } from "../module.ts";
import { privacyEraseJob, privacyExportJob } from "./jobs.ts";
import type { OtherAreas } from "./neighbours.ts";
import type { PrivacyRequestRecord } from "./repository.ts";

const DAY_MS = 24 * 3600 * 1000;
const HISTORY_PAGE = 100;
const SWEEP_BATCH = 25;
const EXPORT_TOKEN_PURPOSE = "privacy-export";

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

  /** The member's view of a request. Staff never receive the download link. */
  async function present(
    record: PrivacyRequestRecord,
    options: { withLink: boolean },
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
    };
  }

  // --- Export -------------------------------------------------------------------------------

  /** Every lake event of the account within the raw retention window, as stored. */
  async function accountEvents(accountId: string, now: number): Promise<LakeEvent[]> {
    const accountKey = await keys.account(accountId);
    const fromMs = now - config.events.rawRetentionDays * DAY_MS;
    const toMs = now + 3600 * 1000;
    const found: LakeEvent[] = [];
    let cursor: string | null = null;
    do {
      const page = await eventSink.scan({ fromMs, toMs, cursor, limit: 100 });
      for (const object of page.objects) {
        for (const raw of object.events) {
          const parsed = LakeEvent.safeParse(raw);
          if (parsed.success && parsed.data.subject.account === accountKey) found.push(parsed.data);
        }
      }
      cursor = page.cursor;
    } while (cursor !== null);
    // At least once: the lake may hold an event twice; the member gets each once.
    const unique = new Map(found.map((event) => [event.eventId, event]));
    return [...unique.values()].sort((a, b) =>
      a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0,
    );
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
   * The export document. Milestone 1's account, membership, profiles, devices and library are
   * read here directly (identity and billing contribute their milestone 2 data through
   * `AreaModule.exportAccountData`, under `areas`).
   */
  async function collectExport(record: PrivacyRequestRecord): Promise<DataExport> {
    const now = clock.now();
    const accountId = record.accountId;
    // The account through identity's service: it exists with or without a membership.
    const member = await otherAreas().identity.getMemberIdentity(accountId);
    // Profiles and devices in full (settings, avatars, each device): identity's milestone 1
    // tables, keyed by the account, which `getMemberIdentity` summarises without them.
    const [profiles, devices, consents, requests] = await Promise.all([
      repos.profiles.list(accountId),
      repos.sessions.listForAccount(accountId, now),
      repos.events.listConsents(accountId),
      repos.events.listPrivacyRequests(accountId),
    ]);
    const library: DataExport["library"] = [];
    for (const profile of profiles) {
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
    const areas: Record<string, JsonValue> = {};
    for (const [name, module] of Object.entries(otherAreas()) as [string, AreaModule][]) {
      if (module.exportAccountData) areas[name] = await module.exportAccountData(accountId);
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
      profiles: profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        avatarId: profile.avatarId,
        kids: profile.isKids,
        maturityCeiling: profile.maturityCeiling,
        locked: profile.pinHash !== null,
        settings: { ...profile.settings },
        createdAt: toIsoString(profile.createdAt),
      })),
      devices: devices.map((session) => ({
        id: session.id,
        label: session.deviceLabel,
        type: session.deviceType,
        signedInAt: toIsoString(session.createdAt),
        lastSeenAt: toIsoString(session.lastSeenAt),
        expiresAt: toIsoString(session.expiresAt),
      })),
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
      events: await accountEvents(accountId, now),
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
    const link = `${config.publicOrigin}${downloadPath(record.id, await exportToken(record))}`;
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

  /** The `privacy.export` job. */
  async function runExport(requestId: string): Promise<void> {
    const record = await repos.events.getPrivacyRequest(requestId);
    if (record?.kind !== "export") return;
    if (record.status !== "pending" && record.status !== "processing") return;
    const now = clock.now();
    await repos.events.transitionPrivacyRequest(requestId, ["pending"], {
      status: "processing",
      updatedAt: now,
    });
    try {
      await drainOutbox();
      const document = await collectExport(record);
      const name = `exports/${record.id}.json.gz`;
      // A retried attempt replaces what an interrupted one left.
      await eventSink.deleteDocument(`privacy/${name}`);
      const key = await eventSink.putDocument(name, await gzipJson(document));
      const completed: PrivacyRequestRecord = {
        ...record,
        status: "completed",
        exportBlobKey: key,
        expiresAt: clock.now() + config.events.exportLinkTtlSec * 1000,
        completedAt: clock.now(),
      };
      await sendExportEmail(completed, document.account.email);
      await repos.events.transitionPrivacyRequest(requestId, ["processing"], {
        status: "completed",
        exportBlobKey: completed.exportBlobKey,
        expiresAt: completed.expiresAt,
        completedAt: completed.completedAt,
        lastError: null,
        updatedAt: clock.now(),
      });
      logger.info("privacy.export_completed", { requestId, events: document.events.length });
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
      await repos.events.addErasures([
        {
          subjectKey: await keys.account(accountId),
          kind: "account",
          requestedAt: now,
          compactedAt: null,
        },
        ...(await Promise.all(
          profiles.map(async (profile) => ({
            subjectKey: await keys.profile(profile.id),
            kind: "profile" as const,
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
        if (request.exportBlobKey === null) continue;
        await eventSink.deleteDocument(request.exportBlobKey);
        await repos.events.transitionPrivacyRequest(request.id, [request.status], {
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

  /** The `privacy.sweep` job (every scheduler tick): due erasures, expired exports. */
  async function sweep(): Promise<void> {
    const now = clock.now();
    const due = await repos.events.dueDeletions(now, SWEEP_BATCH);
    if (due.length > 0) {
      await jobs.publishBatch(
        due.map((record) => privacyEraseJob.create({ requestId: record.id })),
      );
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
      return Promise.all(records.map((record) => present(record, options)));
    },

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
      };
      if (!(await repos.events.createPrivacyRequest(record))) {
        throw new AppError("privacy_request_pending");
      }
      return present(record, { withLink: false });
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
  };
}

export type Privacy = ReturnType<typeof createPrivacy>;
