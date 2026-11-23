import {
  type ConsentRecord,
  type EventsRepository,
  erasedAddress,
  OPEN_PRIVACY_STATUSES,
  PARTIAL_EXPORT_SUFFIX,
  type PrivacyErasureRecord,
  type PrivacyRequestRecord,
  type PrivacyRequestStatus,
} from "../../areas/events/repository.ts";
import type { MemoryStore } from "../repositories.ts";

const copy = <T>(value: T): T => structuredClone(value);
/** When an erasure started (one left in progress before that was recorded: its due time). */
const erasureStart = (record: PrivacyRequestRecord) => record.startedAt ?? record.scheduledFor ?? 0;
const byTimeThenId = (a: ConsentRecord, b: ConsentRecord) =>
  a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * In-memory `EventsRepository` (same observable behaviour as the SQL one: both pass
 * `describeEventsRepositoryContract`). `store` is milestone 1's in-memory state, which the
 * account deletion cascades through like the database's foreign keys.
 */
export function createMemoryEventsRepository(store?: MemoryStore): EventsRepository {
  const consents: ConsentRecord[] = [];
  const requests = new Map<string, PrivacyRequestRecord>();
  const erasures = new Map<string, PrivacyErasureRecord>();
  const tick = () => {
    if (store) store.queries += 1;
  };

  return {
    async addConsent(record) {
      tick();
      if (store && !store.accounts.has(record.accountId)) {
        throw new Error(`No account ${record.accountId}`); // as the foreign key refuses it
      }
      consents.push(copy(record));
    },

    async consentsAt(accountId, at) {
      tick();
      const latest = new Map<string, ConsentRecord>();
      for (const record of [...consents].sort(byTimeThenId)) {
        // Only the member can grant: a support grant is never the answer in force.
        const supportGrant = record.source === "support" && record.granted;
        if (record.accountId === accountId && record.createdAt <= at && !supportGrant) {
          latest.set(record.purpose, record);
        }
      }
      return [...latest.values()].map(copy);
    },

    async listConsents(accountId) {
      tick();
      return consents
        .filter((record) => record.accountId === accountId)
        .sort(byTimeThenId)
        .map(copy);
    },

    async createPrivacyRequest(record) {
      tick();
      const open = [...requests.values()].some(
        (existing) =>
          existing.accountId === record.accountId &&
          existing.kind === record.kind &&
          (OPEN_PRIVACY_STATUSES as readonly PrivacyRequestStatus[]).includes(existing.status),
      );
      if (open) return false;
      requests.set(record.id, copy(record));
      return true;
    },

    async getPrivacyRequest(id) {
      tick();
      const record = requests.get(id);
      return record ? copy(record) : null;
    },

    async listPrivacyRequests(accountId) {
      tick();
      return [...requests.values()]
        .filter((record) => record.accountId === accountId)
        .sort((a, b) => b.requestedAt - a.requestedAt || (a.id < b.id ? 1 : -1))
        .map(copy);
    },

    async transitionPrivacyRequest(id, from, patch) {
      tick();
      const record = requests.get(id);
      if (!record || !from.includes(record.status)) return false;
      requests.set(id, { ...record, ...copy(patch) });
      return true;
    },

    async dueDeletions(now, limit) {
      tick();
      return [...requests.values()]
        .filter(
          (record) =>
            record.kind === "deletion" &&
            record.status === "scheduled" &&
            record.scheduledFor !== null &&
            record.scheduledFor <= now,
        )
        .sort((a, b) => (a.scheduledFor ?? 0) - (b.scheduledFor ?? 0))
        .slice(0, limit)
        .map(copy);
    },

    async expiredExports(now, limit) {
      tick();
      return [...requests.values()]
        .filter(
          (record) =>
            record.kind === "export" &&
            record.exportBlobKey !== null &&
            record.expiresAt !== null &&
            record.expiresAt < now,
        )
        .sort((a, b) => (a.expiresAt ?? 0) - (b.expiresAt ?? 0))
        .slice(0, limit)
        .map(copy);
    },

    async waitingExports(limit) {
      tick();
      return [...requests.values()]
        .filter(
          (record) =>
            record.kind === "export" &&
            record.status === "processing" &&
            record.exportBlobKey?.endsWith(PARTIAL_EXPORT_SUFFIX) === true,
        )
        .sort((a, b) => a.requestedAt - b.requestedAt || (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map(copy);
    },

    async staleExports(before, limit) {
      tick();
      return [...requests.values()]
        .filter(
          (record) =>
            record.kind === "export" &&
            (record.status === "pending" || record.status === "processing") &&
            (record.exportBlobKey === null ||
              !record.exportBlobKey.endsWith(PARTIAL_EXPORT_SUFFIX)) &&
            record.updatedAt < before,
        )
        .sort((a, b) => a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map(copy);
    },

    async overdueExports(before, limit) {
      tick();
      return [...requests.values()]
        .filter(
          (record) =>
            record.kind === "export" &&
            (record.status === "pending" || record.status === "processing") &&
            record.requestedAt < before,
        )
        .sort((a, b) => a.requestedAt - b.requestedAt || (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map(copy);
    },

    async dueErasureRetries(now, limit) {
      tick();
      return [...requests.values()]
        .filter(
          (record) =>
            record.kind === "deletion" &&
            record.status === "processing" &&
            (record.retryAt === null || record.retryAt <= now),
        )
        .sort((a, b) => erasureStart(a) - erasureStart(b) || (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map(copy);
    },

    async erasuresInProgress(limit) {
      tick();
      return [...requests.values()]
        .filter((record) => record.kind === "deletion" && record.status === "processing")
        .sort((a, b) => erasureStart(a) - erasureStart(b) || (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map(copy);
    },

    async deletionsStoppingMembership(limit) {
      tick();
      return [...requests.values()]
        .filter(
          (record) =>
            record.kind === "deletion" &&
            record.status === "scheduled" &&
            record.membershipStep === "stopping",
        )
        .sort((a, b) => a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map(copy);
    },

    async addErasures(records) {
      tick();
      for (const record of records) {
        const existing = erasures.get(record.subjectKey);
        if (!existing) erasures.set(record.subjectKey, copy(record));
        else if (existing.compactedAt !== null) {
          // Asked for again after it was settled: new history to erase.
          erasures.set(record.subjectKey, {
            ...existing,
            requestedAt: record.requestedAt,
            compactedAt: null,
          });
        }
      }
    },

    async pendingErasures(limit) {
      tick();
      return [...erasures.values()]
        .filter((record) => record.compactedAt === null && record.accountKey === null)
        .sort(
          (a, b) =>
            a.requestedAt - b.requestedAt ||
            (a.subjectKey < b.subjectKey ? -1 : a.subjectKey > b.subjectKey ? 1 : 0),
        )
        .slice(0, limit)
        .map(copy);
    },

    async markErasuresCompacted(subjectKeys, at) {
      tick();
      const confirmed = new Set(subjectKeys);
      for (const [key, record] of erasures) {
        if (record.compactedAt !== null) continue;
        if (
          confirmed.has(key) ||
          (record.accountKey !== null && confirmed.has(record.accountKey))
        ) {
          erasures.set(key, { ...record, compactedAt: at });
        }
      }
    },

    async erasuresOf(subjectKeys) {
      tick();
      return [...new Set(subjectKeys)]
        .map((key) => erasures.get(key))
        .filter((record): record is PrivacyErasureRecord => record !== undefined)
        .map(copy);
    },

    async erasuresUnsettledAt(asOf, after, limit) {
      tick();
      return [...erasures.values()]
        .filter((record) => record.compactedAt === null || record.compactedAt >= asOf)
        .filter((record) => after === null || record.subjectKey > after)
        .sort((a, b) => (a.subjectKey < b.subjectKey ? -1 : a.subjectKey > b.subjectKey ? 1 : 0))
        .slice(0, limit)
        .map(copy);
    },

    async openPlaybackBefore(cutoff, limit) {
      tick();
      return [...(store?.playback.values() ?? [])]
        .filter((session) => session.endedAt === null && session.lastHeartbeatAt < cutoff)
        .sort((a, b) => a.lastHeartbeatAt - b.lastHeartbeatAt || (a.id < b.id ? -1 : 1))
        .slice(0, limit)
        .map(copy);
    },

    async takeOutbox(limit) {
      tick();
      return [...(store?.eventOutbox ?? [])]
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, limit)
        .map(copy);
    },

    async deleteOutbox(ids) {
      tick();
      if (!store) return;
      const gone = new Set(ids);
      store.eventOutbox = store.eventOutbox.filter((event) => !gone.has(event.id));
    },

    async deleteAccount(accountId) {
      tick();
      if (!store?.accounts.has(accountId)) return false;
      store.deleteAccountCascade(accountId);
      store.eventOutbox = store.eventOutbox.filter((event) => event.accountId !== accountId);
      // The consents' foreign key cascades in SQL; privacy requests have none (kept).
      for (let index = consents.length - 1; index >= 0; index -= 1) {
        if (consents[index]?.accountId === accountId) consents.splice(index, 1);
      }
      return true;
    },

    async lockAccountForErasure(accountId, at) {
      tick();
      const account = store?.accounts.get(accountId);
      if (!store || !account) return false;
      for (const [id, session] of store.sessions) {
        if (session.accountId === accountId) store.sessions.delete(id);
      }
      store.accounts.set(accountId, {
        ...account,
        email: erasedAddress(accountId),
        passwordHash: "",
        updatedAt: at,
      });
      store.eventOutbox = store.eventOutbox.filter((event) => event.accountId !== accountId);
      return true;
    },

    async pruneFinishedExports(before) {
      tick();
      let pruned = 0;
      for (const [id, record] of requests) {
        const finished = ["completed", "failed", "canceled"].includes(record.status);
        if (record.kind === "export" && finished && record.requestedAt < before) {
          requests.delete(id);
          pruned += 1;
        }
      }
      return pruned;
    },

    async pruneSettledErasures(before) {
      tick();
      let pruned = 0;
      for (const [key, record] of erasures) {
        if (record.compactedAt !== null && record.compactedAt < before) {
          erasures.delete(key);
          pruned += 1;
        }
      }
      return pruned;
    },

    async pruneAggregates() {
      tick();
      return 0; // no daily aggregates are kept in memory
    },
  };
}
