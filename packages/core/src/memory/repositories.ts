import { maturityRank } from "../domain/maturity.ts";
import {
  type ActiveSession,
  HEARTBEAT_CARRY_SEC,
  type Repositories,
  UniqueViolationError,
} from "../repositories/ports.ts";
import type {
  AccountRecord,
  AvatarGroupRecord,
  AvatarRecord,
  CatalogWrite,
  CreditRecord,
  EpisodeRecord,
  GenreRecord,
  HistoryRecord,
  NotificationRecord,
  PersonRecord,
  PlaybackSessionRecord,
  ProfileRecord,
  ProfileRow,
  ProgressRecord,
  RatingEntry,
  SeasonRecord,
  SessionRecord,
  SubscriptionRecord,
  TitleDayStats,
  TitleRecord,
  TitleStatRecord,
  VideoAssetRecord,
} from "../repositories/records.ts";
import { createMemoryAdminRepository } from "./areas/admin.ts";
import { createMemoryBillingRepository } from "./areas/billing.ts";
import { createMemoryEventsRepository } from "./areas/events.ts";
import { createMemoryExperimentsRepository } from "./areas/experiments.ts";
import { createMemoryIdentityRepository } from "./areas/identity.ts";
import { createMemoryPersonalisationRepository } from "./areas/personalisation.ts";

const copy = <T>(value: T): T => structuredClone(value);
const key = (...parts: string[]) => parts.join("\u0000");

/**
 * A view: one profile credited with at least a minute of a title that day, all its sessions
 * of the title together (as in SQL).
 */
const VIEW_THRESHOLD_SEC = 60;

/** All state of the in-memory repositories; exposed for tests that need to peek. */
export class MemoryStore {
  accounts = new Map<string, AccountRecord>();
  subscriptions = new Map<string, SubscriptionRecord>();
  sessions = new Map<string, SessionRecord>();
  profiles = new Map<string, ProfileRow>();
  avatarGroups: AvatarGroupRecord[] = [];
  avatars: AvatarRecord[] = [];
  genres: GenreRecord[] = [];
  people: PersonRecord[] = [];
  titles: TitleRecord[] = [];
  credits: CreditRecord[] = [];
  seasons: SeasonRecord[] = [];
  episodes: EpisodeRecord[] = [];
  videoAssets: VideoAssetRecord[] = [];
  notifications = new Map<string, NotificationRecord & { seedVersion: string | null }>();
  notificationReads = new Map<string, number>();
  myList = new Map<string, { profileId: string; titleId: string; addedAt: number }>();
  ratings = new Map<string, RatingEntry & { profileId: string }>();
  progress = new Map<string, ProgressRecord>();
  history = new Map<string, HistoryRecord>();
  playback = new Map<string, PlaybackSessionRecord>();
  stats = new Map<string, TitleStatRecord>();
  meta = new Map<string, string>();
  /** Round trips, counted like the SQL adapters count them (tests assert query budgets). */
  queries = 0;

  deleteProfileCascade(profileId: string): void {
    this.profiles.delete(profileId);
    for (const [id, entry] of this.myList)
      if (entry.profileId === profileId) this.myList.delete(id);
    for (const [id, entry] of this.ratings)
      if (entry.profileId === profileId) this.ratings.delete(id);
    for (const [id, entry] of this.progress)
      if (entry.profileId === profileId) this.progress.delete(id);
    for (const [id, entry] of this.history)
      if (entry.profileId === profileId) this.history.delete(id);
    for (const [id, entry] of this.playback)
      if (entry.profileId === profileId) this.playback.delete(id);
    for (const id of this.notificationReads.keys()) {
      if (id.startsWith(`${profileId}\u0000`)) this.notificationReads.delete(id);
    }
    for (const session of this.sessions.values()) {
      if (session.activeProfileId === profileId) session.activeProfileId = null;
    }
  }

  deleteAccountCascade(accountId: string): void {
    this.accounts.delete(accountId);
    this.subscriptions.delete(accountId);
    for (const [id, session] of this.sessions)
      if (session.accountId === accountId) this.sessions.delete(id);
    for (const profile of [...this.profiles.values()]) {
      if (profile.accountId === accountId) this.deleteProfileCascade(profile.id);
    }
    for (const [id, entry] of this.playback)
      if (entry.accountId === accountId) this.playback.delete(id);
  }

  withAvatar(profile: ProfileRow): ProfileRecord {
    const avatar = this.avatars.find((candidate) => candidate.id === profile.avatarId) ?? null;
    return copy({ ...profile, avatar });
  }
}

/**
 * In-memory `Repositories` with the same observable behaviour as the SQL ones (both pass
 * `describeRepositoryContract`). Every method completes without awaiting in the middle, so
 * each is atomic on the single JS thread, like a batch.
 */
export function createMemoryRepositories(store = new MemoryStore()): Repositories & {
  store: MemoryStore;
} {
  const s = store;
  const tick = () => {
    s.queries += 1;
  };
  const emailTaken = (email: string, exceptId?: string) =>
    [...s.accounts.values()].some((account) => account.email === email && account.id !== exceptId);

  return {
    store,

    async ping() {
      tick();
    },

    // Milestone 2: each area's in-memory repository (memory/areas/<area>.ts).
    identity: createMemoryIdentityRepository(),
    billing: createMemoryBillingRepository(),
    events: createMemoryEventsRepository(),
    personalisation: createMemoryPersonalisationRepository(),
    experiments: createMemoryExperimentsRepository(),
    admin: createMemoryAdminRepository(),

    accounts: {
      async emailExists(email) {
        tick();
        return emailTaken(email);
      },
      async findByEmail(email) {
        tick();
        const account = [...s.accounts.values()].find((candidate) => candidate.email === email);
        return account ? copy(account) : null;
      },
      async get(accountId) {
        tick();
        const account = s.accounts.get(accountId);
        const subscription = s.subscriptions.get(accountId);
        return account && subscription
          ? { account: copy(account), subscription: copy(subscription) }
          : null;
      },
      async createWithSession({ account, subscription, session }) {
        tick();
        if (emailTaken(account.email) || s.accounts.has(account.id)) {
          throw new UniqueViolationError("email");
        }
        s.accounts.set(account.id, copy(account));
        s.subscriptions.set(account.id, copy(subscription));
        s.sessions.set(session.id, copy(session));
      },
      async updateEmail(accountId, email, now) {
        tick();
        if (emailTaken(email, accountId)) throw new UniqueViolationError("email");
        const account = s.accounts.get(accountId);
        if (account) Object.assign(account, { email, updatedAt: now });
      },
      async updatePasswordHash(accountId, passwordHash, now) {
        tick();
        const account = s.accounts.get(accountId);
        if (account) Object.assign(account, { passwordHash, updatedAt: now });
      },
      async changePassword({ accountId, passwordHash, keepSessionId, now }) {
        tick();
        const account = s.accounts.get(accountId);
        if (account) Object.assign(account, { passwordHash, updatedAt: now });
        for (const [id, session] of s.sessions) {
          if (session.accountId === accountId && id !== keepSessionId) s.sessions.delete(id);
        }
      },
      async saveSubscription(subscription) {
        tick();
        s.subscriptions.set(subscription.accountId, copy(subscription));
      },
    },

    sessions: {
      async create(session) {
        tick();
        s.sessions.set(session.id, copy(session));
      },
      async findActive(tokenHash, now): Promise<ActiveSession | null> {
        tick();
        const session = [...s.sessions.values()].find(
          (candidate) => candidate.tokenHash === tokenHash && candidate.expiresAt > now,
        );
        if (!session) return null;
        const profile = session.activeProfileId
          ? s.profiles.get(session.activeProfileId)
          : undefined;
        return {
          session: copy(session),
          profile:
            profile && profile.accountId === session.accountId ? s.withAvatar(profile) : null,
        };
      },
      async touch(sessionId, now) {
        tick();
        const session = s.sessions.get(sessionId);
        if (session) session.lastSeenAt = now;
      },
      async setActiveProfile(sessionId, accountId, profileId) {
        tick();
        const session = s.sessions.get(sessionId);
        if (!session || session.accountId !== accountId) return false;
        if (profileId !== null && s.profiles.get(profileId)?.accountId !== accountId) return false;
        session.activeProfileId = profileId;
        return true;
      },
      async listForAccount(accountId, now) {
        tick();
        return [...s.sessions.values()]
          .filter((session) => session.accountId === accountId && session.expiresAt > now)
          .sort((a, b) => b.lastSeenAt - a.lastSeenAt || b.id.localeCompare(a.id))
          .map(copy);
      },
      async delete(accountId, sessionId) {
        tick();
        const session = s.sessions.get(sessionId);
        if (!session || session.accountId !== accountId) return false;
        s.sessions.delete(sessionId);
        return true;
      },
      async deleteAllForAccount(accountId) {
        tick();
        for (const [id, session] of s.sessions)
          if (session.accountId === accountId) s.sessions.delete(id);
      },
      async deleteExpired(now, limit) {
        tick();
        const expired = [...s.sessions.values()]
          .filter((session) => session.expiresAt <= now)
          .sort((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id))
          .slice(0, limit);
        for (const session of expired) s.sessions.delete(session.id);
        return expired.length;
      },
    },

    profiles: {
      async list(accountId) {
        tick();
        return [...s.profiles.values()]
          .filter((profile) => profile.accountId === accountId)
          .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
          .map((profile) => s.withAvatar(profile));
      },
      async get(accountId, profileId) {
        tick();
        const profile = s.profiles.get(profileId);
        return profile && profile.accountId === accountId ? s.withAvatar(profile) : null;
      },
      async createWithinLimit(profile, maxProfiles) {
        tick();
        const count = [...s.profiles.values()].filter(
          (p) => p.accountId === profile.accountId,
        ).length;
        if (count >= maxProfiles) return false;
        if (s.profiles.has(profile.id)) throw new UniqueViolationError("id");
        s.profiles.set(profile.id, copy(profile));
        return true;
      },
      async update(accountId, profileId, patch, options = {}) {
        tick();
        const existing = s.profiles.get(profileId);
        if (!existing || existing.accountId !== accountId) return false;
        const { settings, ...fields } = copy(patch);
        s.profiles.set(profileId, {
          ...existing,
          ...fields,
          settings: { ...existing.settings, ...settings },
        });
        if (options.unbindSessionsExcept !== undefined) {
          for (const session of s.sessions.values()) {
            if (
              session.activeProfileId === profileId &&
              session.id !== options.unbindSessionsExcept
            ) {
              session.activeProfileId = null;
            }
          }
        }
        return true;
      },
      async deleteUnlessLast(accountId, profileId) {
        tick();
        const profile = s.profiles.get(profileId);
        if (!profile || profile.accountId !== accountId) return "not_found";
        const count = [...s.profiles.values()].filter((p) => p.accountId === accountId).length;
        if (count <= 1) return "last";
        s.deleteProfileCascade(profileId);
        return "deleted";
      },
    },

    catalog: {
      async loadSnapshot() {
        tick();
        const people = new Map(s.people.map((person) => [person.id, person.name]));
        return copy({
          version: s.meta.get("catalog.version") ?? "empty",
          genres: [...s.genres].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
          titles: [...s.titles].sort((a, b) => a.id.localeCompare(b.id)),
          credits: s.credits
            .filter((credit) => people.has(credit.personId))
            .map((credit) => ({ ...credit, personName: people.get(credit.personId) ?? "" }))
            .sort(
              (a, b) =>
                a.titleId.localeCompare(b.titleId) ||
                a.role.localeCompare(b.role) ||
                a.position - b.position,
            ),
          seasons: [...s.seasons].sort(
            (a, b) => a.titleId.localeCompare(b.titleId) || a.number - b.number,
          ),
          episodes: [...s.episodes]
            .sort((a, b) => a.titleId.localeCompare(b.titleId) || a.seq - b.seq)
            .map(({ synopsis: _synopsis, still: _still, ...summary }) => summary),
          packagedAssets: s.videoAssets
            .filter((asset) => asset.kind === "packaged" && asset.maxHeight !== null)
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((asset) => ({ id: asset.id, maxHeight: asset.maxHeight ?? 0 })),
        });
      },
      async listEpisodes(titleId, seasonNumber) {
        tick();
        return s.episodes
          .filter((episode) => episode.titleId === titleId && episode.seasonNumber === seasonNumber)
          .sort((a, b) => a.number - b.number)
          .map(copy);
      },
      async loadPlaybackMedia({ assetId, episodeIds }) {
        tick();
        const asset = s.videoAssets.find((candidate) => candidate.id === assetId);
        return {
          asset: asset ? copy(asset) : null,
          episodes: s.episodes.filter((episode) => episodeIds.includes(episode.id)).map(copy),
        };
      },
      async listAvatars() {
        tick();
        const order = <T extends { position: number; id: string }>(a: T, b: T) =>
          a.position - b.position || a.id.localeCompare(b.id);
        return {
          groups: [...s.avatarGroups].sort(order).map(copy),
          avatars: [...s.avatars].sort(order).map(copy),
        };
      },
      async getAvatar(avatarId) {
        tick();
        const avatar = s.avatars.find((candidate) => candidate.id === avatarId);
        return avatar ? copy(avatar) : null;
      },
      async listTitleIds() {
        tick();
        return s.titles.map((title) => title.id).sort();
      },
    },

    library: {
      async loadSignals(profileId) {
        tick();
        return copy({
          myList: [...s.myList.values()]
            .filter((entry) => entry.profileId === profileId)
            .sort((a, b) => b.addedAt - a.addedAt || a.titleId.localeCompare(b.titleId))
            .map(({ titleId, addedAt }) => ({ titleId, addedAt })),
          ratings: [...s.ratings.values()]
            .filter((entry) => entry.profileId === profileId)
            .sort((a, b) => b.ratedAt - a.ratedAt || a.titleId.localeCompare(b.titleId))
            .map(({ titleId, value, ratedAt }) => ({ titleId, value, ratedAt })),
          progress: [...s.progress.values()]
            .filter((entry) => entry.profileId === profileId)
            .sort((a, b) => b.updatedAt - a.updatedAt || a.itemId.localeCompare(b.itemId)),
        });
      },
      async addToMyList(profileId, titleId, now) {
        tick();
        const id = key(profileId, titleId);
        if (!s.myList.has(id)) s.myList.set(id, { profileId, titleId, addedAt: now });
      },
      async removeFromMyList(profileId, titleId) {
        tick();
        s.myList.delete(key(profileId, titleId));
      },
      async setRating(profileId, titleId, value, now) {
        tick();
        s.ratings.set(key(profileId, titleId), { profileId, titleId, value, ratedAt: now });
      },
      async clearRating(profileId, titleId) {
        tick();
        s.ratings.delete(key(profileId, titleId));
      },
      async hideFromContinueWatching(profileId, titleId) {
        tick();
        for (const entry of s.progress.values()) {
          if (entry.profileId === profileId && entry.titleId === titleId) entry.hidden = true;
        }
      },
      async listHistory(profileId, { before, limit }) {
        tick();
        return [...s.history.values()]
          .filter((entry) => entry.profileId === profileId)
          .filter(
            (entry) =>
              !before ||
              entry.watchedAt < before.watchedAt ||
              (entry.watchedAt === before.watchedAt && entry.id < before.id),
          )
          .sort((a, b) => b.watchedAt - a.watchedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
          .slice(0, limit)
          .map(copy);
      },
      async deleteHistoryEntry(profileId, entryId) {
        tick();
        for (const [id, entry] of s.history) {
          if (entry.id === entryId && entry.profileId === profileId) {
            s.history.delete(id);
            s.progress.delete(key(profileId, entry.itemId));
            return true;
          }
        }
        return false;
      },
    },

    playback: {
      async create(session) {
        tick();
        s.playback.set(session.id, copy(session));
      },
      async get(playbackSessionId) {
        tick();
        const session = s.playback.get(playbackSessionId);
        return session ? copy(session) : null;
      },
      async recordHeartbeat(write) {
        tick();
        const itemId = write.episodeId ?? write.titleId;
        const session = s.playback.get(write.playbackSessionId);
        // As in SQL: a report for a session that has ended (a release won the race) is ignored.
        if (!session || session.endedAt !== null) return;
        {
          // As in SQL: what the previous report's state and the credit clock allow.
          const active = session.state === "playing" || session.state === "buffering";
          const credit = active
            ? Math.max(
                0,
                Math.min(
                  write.positionSec - session.positionSec,
                  (write.now - session.lastHeartbeatAt) / 1000,
                  write.maxCreditSec,
                ),
              )
            : 0;
          Object.assign(session, {
            watchedSec: session.watchedSec + credit,
            positionSec: write.positionSec,
            durationSec: write.durationSec,
            state: write.state,
            lastHeartbeatAt: Math.max(
              session.lastHeartbeatAt + Math.round(credit * 1000),
              write.now - HEARTBEAT_CARRY_SEC * 1000,
            ),
            endedAt: write.ends ? write.now : null,
          });
        }
        s.progress.set(key(write.profileId, itemId), {
          profileId: write.profileId,
          itemId,
          titleId: write.titleId,
          episodeId: write.episodeId,
          positionSec: write.positionSec,
          durationSec: write.durationSec,
          completed: write.completed,
          hidden: false,
          updatedAt: write.now,
        });
        const historyKey = key(write.profileId, itemId);
        const existing = s.history.get(historyKey);
        s.history.set(historyKey, {
          id: existing?.id ?? write.historyId,
          profileId: write.profileId,
          itemId,
          titleId: write.titleId,
          episodeId: write.episodeId,
          watchedAt: write.now,
        });
      },
      async end(playbackSessionId, now) {
        tick();
        const session = s.playback.get(playbackSessionId);
        if (session && session.endedAt === null) session.endedAt = now;
      },
      async deleteStartedBefore(cutoff) {
        tick();
        let deleted = 0;
        for (const [id, session] of s.playback) {
          if (session.startedAt < cutoff) {
            s.playback.delete(id);
            deleted += 1;
          }
        }
        return deleted;
      },
    },

    stats: {
      async rollupPlaybackDay(day, fromMs, toMs) {
        tick();
        // Seconds credited per profile per title that day, summed over its sessions.
        const byTitle = new Map<string, Map<string, number>>();
        for (const session of s.playback.values()) {
          if (session.startedAt < fromMs || session.startedAt >= toMs) continue;
          const profiles = byTitle.get(session.titleId) ?? new Map<string, number>();
          profiles.set(
            session.profileId,
            (profiles.get(session.profileId) ?? 0) + session.watchedSec,
          );
          byTitle.set(session.titleId, profiles);
        }
        for (const [titleId, profiles] of byTitle) {
          const watched = [...profiles.values()];
          s.stats.set(key(day, titleId, "playback"), {
            day,
            titleId,
            source: "playback",
            views: watched.filter((seconds) => seconds >= VIEW_THRESHOLD_SEC).length,
            watchSec: watched.reduce((sum, seconds) => sum + seconds, 0),
            profiles: profiles.size,
          });
        }
      },
      async upsertBaseline(rows) {
        tick();
        for (const row of rows) {
          s.stats.set(key(row.day, row.titleId, "seed"), { ...copy(row), source: "seed" });
        }
      },
      async hasBaseline(day) {
        tick();
        return [...s.stats.values()].some((row) => row.day === day && row.source === "seed");
      },
      async dailyViews(fromDay) {
        tick();
        const sums = new Map<string, { day: string; titleId: string; views: number }>();
        for (const row of s.stats.values()) {
          if (row.day < fromDay) continue;
          const id = key(row.day, row.titleId);
          const entry = sums.get(id) ?? { day: row.day, titleId: row.titleId, views: 0 };
          entry.views += row.views;
          sums.set(id, entry);
        }
        return [...sums.values()].sort(
          (a, b) => a.day.localeCompare(b.day) || a.titleId.localeCompare(b.titleId),
        );
      },
      async titleDays(titleId, fromDay) {
        tick();
        const days = new Map<string, TitleDayStats>();
        for (const row of s.stats.values()) {
          if (row.titleId !== titleId || row.day < fromDay) continue;
          const entry = days.get(row.day) ?? {
            day: row.day,
            baselineViews: 0,
            playbackViews: 0,
            playbackWatchSec: 0,
            playbackProfiles: 0,
          };
          if (row.source === "seed") entry.baselineViews += row.views;
          else {
            entry.playbackViews += row.views;
            entry.playbackWatchSec += row.watchSec;
            entry.playbackProfiles += row.profiles;
          }
          days.set(row.day, entry);
        }
        return [...days.values()].sort((a, b) => b.day.localeCompare(a.day));
      },
    },

    notifications: {
      async listForProfile({ profileId, maxMaturityRank, since, limit }) {
        tick();
        return [...s.notifications.values()]
          .filter(
            (notification) =>
              maturityRank(notification.maturity) <= maxMaturityRank &&
              notification.createdAt >= since,
          )
          .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
          .slice(0, limit)
          .map(({ seedVersion: _seedVersion, ...notification }) => ({
            ...copy(notification),
            readAt: s.notificationReads.get(key(profileId, notification.id)) ?? null,
          }));
      },
      async markRead({ profileId, maxMaturityRank, since }, ids, now) {
        tick();
        for (const notification of s.notifications.values()) {
          if (maturityRank(notification.maturity) > maxMaturityRank) continue;
          if (notification.createdAt < since) continue;
          if (ids !== "all" && !ids.includes(notification.id)) continue;
          const id = key(profileId, notification.id);
          if (!s.notificationReads.has(id)) s.notificationReads.set(id, now);
        }
      },
    },

    meta: {
      async get(metaKey) {
        tick();
        return s.meta.get(metaKey) ?? null;
      },
      async set(metaKey, value) {
        tick();
        s.meta.set(metaKey, value);
      },
    },

    seed: {
      async replaceCatalog(catalog: CatalogWrite) {
        tick();
        s.genres = copy(catalog.genres);
        s.people = copy(catalog.people);
        s.titles = copy(catalog.titles);
        s.credits = copy(catalog.credits);
        s.seasons = copy(catalog.seasons);
        s.episodes = copy(catalog.episodes);
        s.videoAssets = copy(catalog.videoAssets);
        s.avatarGroups = copy(catalog.avatarGroups);
        s.avatars = copy(catalog.avatars);
        for (const notification of catalog.notifications) {
          s.notifications.set(notification.id, {
            ...copy(notification),
            seedVersion: catalog.version,
          });
        }
        for (const [id, notification] of s.notifications) {
          if (notification.seedVersion !== null && notification.seedVersion !== catalog.version) {
            s.notifications.delete(id);
            for (const readKey of s.notificationReads.keys()) {
              if (readKey.endsWith(`\u0000${id}`)) s.notificationReads.delete(readKey);
            }
          }
        }
        s.meta.set("catalog.version", catalog.version);
      },
      async replaceAccount(write) {
        tick();
        for (const account of [...s.accounts.values()]) {
          if (account.email === write.account.email || account.id === write.account.id) {
            s.deleteAccountCascade(account.id);
          }
        }
        s.accounts.set(write.account.id, copy(write.account));
        s.subscriptions.set(write.account.id, copy(write.subscription));
        for (const profile of write.profiles) s.profiles.set(profile.id, copy(profile));
        for (const entry of write.myList)
          s.myList.set(key(entry.profileId, entry.titleId), copy(entry));
        for (const entry of write.ratings)
          s.ratings.set(key(entry.profileId, entry.titleId), copy(entry));
        for (const entry of write.progress)
          s.progress.set(key(entry.profileId, entry.itemId), copy(entry));
        for (const entry of write.history)
          s.history.set(key(entry.profileId, entry.itemId), copy(entry));
      },
      async replaceBaselineStats(rows) {
        tick();
        for (const [id, row] of s.stats) if (row.source === "seed") s.stats.delete(id);
        for (const row of rows) {
          s.stats.set(key(row.day, row.titleId, "seed"), { ...copy(row), source: "seed" });
        }
      },
    },
  };
}
