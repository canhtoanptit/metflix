import { describe, expect, it } from "vitest";
import type { HeartbeatWrite } from "../repositories/ports.ts";
import { type Repositories, UniqueViolationError } from "../repositories/ports.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "./harness.ts";
import {
  DAY_MS,
  makeAccountRecord,
  makeCatalogWrite,
  makeProfileRow,
  makeSessionRecord,
  makeSubscriptionRecord,
  T0,
} from "./records.ts";

export interface RepositoryHarness extends HarnessBase {
  /** Repositories over an empty, migrated database. */
  repos: Repositories;
}

/**
 * Contract every `Repositories` implementation must pass: in-memory (core), SQLite and
 * Postgres (Node), D1 (workerd). One suite, so the dialects are provably equivalent where it
 * matters: what the services observe.
 */
export function describeRepositoryContract(
  name: string,
  factory: HarnessFactory<RepositoryHarness>,
): void {
  describe(`Repositories contract: ${name}`, () => {
    const h = useHarness(factory);
    const repos = () => h().repos;

    /** An account with one session, plus the catalog (avatars) profiles refer to. */
    async function signUp(
      overrides: {
        accountId?: string;
        email?: string;
        sessionId?: string;
        tokenHash?: string;
      } = {},
    ) {
      const accountId = overrides.accountId ?? "acc-1";
      await repos().accounts.createWithSession({
        account: makeAccountRecord({
          id: accountId,
          email: overrides.email ?? "viewer@example.com",
        }),
        subscription: makeSubscriptionRecord({ accountId }),
        session: makeSessionRecord({
          id: overrides.sessionId ?? `ses-${accountId}`,
          tokenHash: overrides.tokenHash ?? `hash-${accountId}`,
          accountId,
        }),
      });
      return accountId;
    }

    async function withCatalog() {
      await repos().seed.replaceCatalog(makeCatalogWrite());
    }

    function heartbeat(overrides: Partial<HeartbeatWrite> = {}): HeartbeatWrite {
      return {
        playbackSessionId: "ps-1",
        profileId: "pro-1",
        titleId: "t-teen",
        episodeId: null,
        positionSec: 100,
        durationSec: 5400,
        state: "playing",
        completed: false,
        now: T0 + 30_000,
        maxCreditSec: 90,
        historyId: "h-1",
        ends: false,
        ...overrides,
      };
    }

    async function startPlayback(
      id = "ps-1",
      overrides: { titleId?: string; profileId?: string } = {},
    ) {
      await repos().playback.create({
        id,
        accountId: "acc-1",
        profileId: overrides.profileId ?? "pro-1",
        sessionId: "ses-acc-1",
        titleId: overrides.titleId ?? "t-teen",
        episodeId: null,
        assetId: "v-1",
        maxVideoHeight: 1080,
        startedAt: T0,
        lastHeartbeatAt: T0,
        endedAt: null,
        positionSec: 0,
        durationSec: 5400,
        watchedSec: 0,
        state: "playing",
      });
    }

    describe("accounts", () => {
      it("creates an account, its membership and first session together", async () => {
        await signUp();
        expect(await repos().accounts.emailExists("viewer@example.com")).toBe(true);
        expect(await repos().accounts.emailExists("other@example.com")).toBe(false);
        expect(await repos().accounts.findByEmail("viewer@example.com")).toEqual(
          makeAccountRecord(),
        );
        expect(await repos().accounts.get("acc-1")).toEqual({
          account: makeAccountRecord(),
          subscription: makeSubscriptionRecord(),
        });
        expect((await repos().sessions.findActive("hash-acc-1", T0))?.session).toEqual(
          makeSessionRecord({ id: "ses-acc-1", tokenHash: "hash-acc-1" }),
        );
        expect(await repos().accounts.get("acc-missing")).toBeNull();
      });

      it("rejects a duplicate email atomically", async () => {
        await signUp();
        await expect(
          signUp({ accountId: "acc-2", email: "viewer@example.com" }),
        ).rejects.toBeInstanceOf(UniqueViolationError);
        expect(await repos().accounts.get("acc-2")).toBeNull();
        expect(await repos().sessions.findActive("hash-acc-2", T0)).toBeNull();
      });

      it("changes the email unless another account has it", async () => {
        await signUp();
        await signUp({ accountId: "acc-2", email: "two@example.com" });
        await expect(
          repos().accounts.updateEmail("acc-2", "viewer@example.com", T0 + 1),
        ).rejects.toBeInstanceOf(UniqueViolationError);
        await repos().accounts.updateEmail("acc-2", "new@example.com", T0 + 1);
        expect((await repos().accounts.findByEmail("new@example.com"))?.updatedAt).toBe(T0 + 1);
      });

      it("changes the password and revokes every other session", async () => {
        await signUp();
        await repos().sessions.create(
          makeSessionRecord({ id: "ses-other", tokenHash: "hash-other" }),
        );
        await repos().accounts.changePassword({
          accountId: "acc-1",
          passwordHash: "new-hash",
          keepSessionId: "ses-acc-1",
          now: T0 + 5,
        });
        expect((await repos().accounts.findByEmail("viewer@example.com"))?.passwordHash).toBe(
          "new-hash",
        );
        expect(await repos().sessions.findActive("hash-other", T0)).toBeNull();
        expect(await repos().sessions.findActive("hash-acc-1", T0)).not.toBeNull();

        await repos().accounts.updatePasswordHash("acc-1", "rehashed", T0 + 6);
        expect((await repos().accounts.findByEmail("viewer@example.com"))?.passwordHash).toBe(
          "rehashed",
        );
      });

      it("saves membership changes", async () => {
        await signUp();
        const changed = makeSubscriptionRecord({
          planId: "premium",
          canceledAt: T0 + 10,
          card: null,
          updatedAt: T0 + 10,
        });
        await repos().accounts.saveSubscription(changed);
        expect((await repos().accounts.get("acc-1"))?.subscription).toEqual(changed);
      });
    });

    describe("sessions", () => {
      it("finds live sessions only, with the active profile and its avatar", async () => {
        await withCatalog();
        await signUp();
        expect(await repos().sessions.findActive("hash-acc-1", T0 + 31 * DAY_MS)).toBeNull();
        expect(await repos().sessions.findActive("nope", T0)).toBeNull();

        await repos().profiles.createWithinLimit(makeProfileRow(), 5);
        expect(await repos().sessions.setActiveProfile("ses-acc-1", "acc-1", "pro-1")).toBe(true);
        const active = await repos().sessions.findActive("hash-acc-1", T0);
        expect(active?.session.activeProfileId).toBe("pro-1");
        expect(active?.profile).toEqual({
          ...makeProfileRow(),
          avatar: {
            id: "av-1",
            groupId: "ag-1",
            name: "Fox",
            imageUrl: "/cdn/img/avatars/av-1.webp",
            position: 0,
          },
        });
      });

      it("only binds profiles of the same account", async () => {
        await signUp();
        await signUp({ accountId: "acc-2", email: "two@example.com" });
        await repos().profiles.createWithinLimit(
          makeProfileRow({ id: "pro-2", accountId: "acc-2" }),
          5,
        );
        expect(await repos().sessions.setActiveProfile("ses-acc-1", "acc-1", "pro-2")).toBe(false);
        expect(await repos().sessions.setActiveProfile("ses-acc-1", "acc-2", "pro-2")).toBe(false);
        expect(await repos().sessions.setActiveProfile("ses-acc-2", "acc-2", "pro-2")).toBe(true);
        expect(await repos().sessions.setActiveProfile("ses-acc-2", "acc-2", null)).toBe(true);
        expect((await repos().sessions.findActive("hash-acc-2", T0))?.profile).toBeNull();
      });

      it("lists, touches and revokes devices per account", async () => {
        await signUp();
        await signUp({ accountId: "acc-2", email: "two@example.com" });
        await repos().sessions.create(
          makeSessionRecord({ id: "ses-b", tokenHash: "hash-b", lastSeenAt: T0 + 100 }),
        );
        await repos().sessions.create(
          makeSessionRecord({ id: "ses-old", tokenHash: "hash-old", expiresAt: T0 - 1 }),
        );
        await repos().sessions.touch("ses-acc-1", T0 + 200);
        const listed = await repos().sessions.listForAccount("acc-1", T0);
        expect(listed.map((session) => session.id)).toEqual(["ses-acc-1", "ses-b"]);
        expect(listed[0]?.lastSeenAt).toBe(T0 + 200);

        expect(await repos().sessions.delete("acc-2", "ses-b")).toBe(false);
        expect(await repos().sessions.delete("acc-1", "ses-b")).toBe(true);
        expect(await repos().sessions.delete("acc-1", "ses-b")).toBe(false);
        await repos().sessions.deleteAllForAccount("acc-1");
        expect(await repos().sessions.listForAccount("acc-1", T0)).toEqual([]);
        expect(await repos().sessions.listForAccount("acc-2", T0)).toHaveLength(1);
      });

      it("deletes expired sessions in bounded batches, oldest first", async () => {
        await signUp();
        for (let index = 0; index < 5; index += 1) {
          await repos().sessions.create(
            makeSessionRecord({
              id: `ses-old-${index}`,
              tokenHash: `hash-old-${index}`,
              expiresAt: T0 + index * 1000,
            }),
          );
        }
        const now = T0 + 10_000;
        expect(await repos().sessions.deleteExpired(now, 3)).toBe(3);
        expect(await repos().sessions.findActive("hash-old-3", T0)).not.toBeNull();
        expect(await repos().sessions.findActive("hash-old-0", T0 - 1)).toBeNull();
        expect(await repos().sessions.deleteExpired(now, 3)).toBe(2);
        expect(await repos().sessions.deleteExpired(now, 3)).toBe(0);
        // The account's live session stays.
        expect(await repos().sessions.listForAccount("acc-1", now)).toHaveLength(1);
      });
    });

    describe("profiles", () => {
      it("creates profiles up to the limit, oldest first", async () => {
        await withCatalog();
        await signUp();
        for (let index = 0; index < 3; index += 1) {
          const created = await repos().profiles.createWithinLimit(
            makeProfileRow({ id: `pro-${index}`, name: `P${index}`, createdAt: T0 + 10 - index }),
            3,
          );
          expect(created).toBe(true);
        }
        expect(await repos().profiles.createWithinLimit(makeProfileRow({ id: "pro-x" }), 3)).toBe(
          false,
        );
        const listed = await repos().profiles.list("acc-1");
        expect(listed.map((profile) => profile.id)).toEqual(["pro-2", "pro-1", "pro-0"]);
        expect(await repos().profiles.get("acc-1", "pro-x")).toBeNull();
        expect(await repos().profiles.get("acc-2", "pro-1")).toBeNull();
      });

      it("updates every mutable field", async () => {
        await withCatalog();
        await signUp();
        await repos().profiles.createWithinLimit(makeProfileRow(), 5);
        const updated = makeProfileRow({
          name: "Kiddo",
          avatarId: "av-2",
          isKids: true,
          maturityCeiling: "7+",
          pinHash: "pin-hash",
          settings: { autoplayNextEpisode: false, autoplayPreviews: false, subtitleLanguage: "vi" },
          updatedAt: T0 + 1,
        });
        const { id: _id, accountId: _account, createdAt: _created, ...patch } = updated;
        expect(await repos().profiles.update("acc-1", "pro-1", patch)).toBe(true);
        expect(await repos().profiles.update("acc-2", "pro-1", patch)).toBe(false);
        expect(await repos().profiles.update("acc-1", "pro-x", patch)).toBe(false);
        const stored = await repos().profiles.get("acc-1", "pro-1");
        expect(stored).toMatchObject({ ...updated, avatar: { id: "av-2", name: "Owl" } });
      });

      it("writes only the patched fields, so concurrent edits of different fields both land", async () => {
        await withCatalog();
        await signUp();
        await repos().profiles.createWithinLimit(
          makeProfileRow({
            settings: { autoplayNextEpisode: true, autoplayPreviews: true, subtitleLanguage: "en" },
          }),
          5,
        );
        // Two requests that read the same row, then write: a rename, and a settings change.
        await repos().profiles.update("acc-1", "pro-1", { name: "Renamed", updatedAt: T0 + 1 });
        await repos().profiles.update("acc-1", "pro-1", {
          settings: { autoplayPreviews: false },
          updatedAt: T0 + 2,
        });
        await repos().profiles.update("acc-1", "pro-1", {
          settings: { subtitleLanguage: null },
          pinHash: "pin-hash",
          updatedAt: T0 + 3,
        });
        expect(await repos().profiles.get("acc-1", "pro-1")).toMatchObject({
          name: "Renamed",
          avatarId: makeProfileRow().avatarId,
          pinHash: "pin-hash",
          settings: { autoplayNextEpisode: true, autoplayPreviews: false, subtitleLanguage: null },
          updatedAt: T0 + 3,
        });
      });

      it("sends the profile's other sessions back to the gate in the same write", async () => {
        await withCatalog();
        await signUp();
        await repos().profiles.createWithinLimit(makeProfileRow({ id: "pro-1" }), 5);
        await repos().profiles.createWithinLimit(
          makeProfileRow({ id: "pro-2", createdAt: T0 + 1 }),
          5,
        );
        for (const id of ["ses-b", "ses-c", "ses-d"]) {
          await repos().sessions.create(
            makeSessionRecord({ id, tokenHash: `hash-${id}`, activeProfileId: null }),
          );
        }
        await repos().sessions.setActiveProfile("ses-acc-1", "acc-1", "pro-1");
        await repos().sessions.setActiveProfile("ses-b", "acc-1", "pro-1");
        await repos().sessions.setActiveProfile("ses-c", "acc-1", "pro-2");
        await repos().sessions.setActiveProfile("ses-d", "acc-1", "pro-1");
        await repos().profiles.update(
          "acc-1",
          "pro-1",
          { pinHash: "pin-hash", updatedAt: T0 + 1 },
          { unbindSessionsExcept: "ses-acc-1" },
        );
        const bound = Object.fromEntries(
          (await repos().sessions.listForAccount("acc-1", T0)).map((session) => [
            session.id,
            session.activeProfileId,
          ]),
        );
        expect(bound).toEqual({
          "ses-acc-1": "pro-1",
          "ses-b": null,
          "ses-c": "pro-2",
          "ses-d": null,
        });
      });

      it("reports a missing avatar as null", async () => {
        await signUp();
        await repos().profiles.createWithinLimit(makeProfileRow({ avatarId: "av-gone" }), 5);
        expect((await repos().profiles.get("acc-1", "pro-1"))?.avatar).toBeNull();
      });

      it("deletes a profile with everything it owns, but never the last one", async () => {
        await withCatalog();
        await signUp();
        await signUp({ accountId: "acc-2", email: "two@example.com" });
        await repos().profiles.createWithinLimit(makeProfileRow({ id: "pro-1" }), 5);
        await repos().profiles.createWithinLimit(
          makeProfileRow({ id: "pro-2", createdAt: T0 + 1 }),
          5,
        );
        await repos().sessions.setActiveProfile("ses-acc-1", "acc-1", "pro-1");
        await repos().library.addToMyList("pro-1", "t-teen", T0);
        await repos().library.setRating("pro-1", "t-teen", "love", T0);
        await startPlayback();
        await repos().playback.recordHeartbeat(heartbeat());

        expect(await repos().profiles.deleteUnlessLast("acc-2", "pro-1")).toBe("not_found");
        expect(await repos().profiles.deleteUnlessLast("acc-1", "pro-1")).toBe("deleted");
        expect(await repos().profiles.deleteUnlessLast("acc-1", "pro-1")).toBe("not_found");
        expect(await repos().profiles.deleteUnlessLast("acc-1", "pro-2")).toBe("last");

        const signals = await repos().library.loadSignals("pro-1");
        expect(signals).toEqual({ myList: [], ratings: [], progress: [] });
        expect(await repos().library.listHistory("pro-1", { limit: 10 })).toEqual([]);
        expect(await repos().playback.get("ps-1")).toBeNull();
        const session = await repos().sessions.findActive("hash-acc-1", T0);
        expect(session?.session.activeProfileId).toBeNull();
        expect(session?.profile).toBeNull();
      });
    });

    describe("catalog", () => {
      it("round-trips the catalog through a snapshot", async () => {
        const catalog = makeCatalogWrite();
        await repos().seed.replaceCatalog(catalog);
        const snapshot = await repos().catalog.loadSnapshot();
        expect(snapshot.version).toBe("v1");
        expect(snapshot.titles).toEqual(
          [...catalog.titles].sort((a, b) => a.id.localeCompare(b.id)),
        );
        expect(snapshot.genres.map((genre) => genre.slug)).toEqual(["drama", "comedy"]);
        expect(snapshot.genres[1]).toEqual(catalog.genres[1]);
        expect(snapshot.credits).toEqual([
          {
            titleId: "t-series",
            personId: "p-bo",
            role: "creator",
            character: null,
            position: 0,
            personName: "Bo Lind",
          },
          {
            titleId: "t-teen",
            personId: "p-ana",
            role: "cast",
            character: "Lead",
            position: 0,
            personName: "Ana Ruiz",
          },
          {
            titleId: "t-teen",
            personId: "p-bo",
            role: "director",
            character: null,
            position: 0,
            personName: "Bo Lind",
          },
        ]);
        expect(snapshot.seasons).toEqual(catalog.seasons);
        expect(snapshot.episodes.map((episode) => episode.id)).toEqual([
          "e-s1e1",
          "e-s1e2",
          "e-s2e1",
        ]);
        expect(snapshot.episodes[0]).toEqual({
          id: "e-s1e1",
          titleId: "t-series",
          seasonNumber: 1,
          number: 1,
          seq: 1,
          name: "One",
          runtimeSec: 1800,
          videoAssetId: "v-1",
          isPlayable: true,
        });
        expect(await repos().catalog.listTitleIds()).toEqual([
          "t-adult",
          "t-all",
          "t-series",
          "t-teen",
        ]);
      });

      it("replaces the whole catalog on re-seed", async () => {
        await repos().seed.replaceCatalog(makeCatalogWrite());
        const smaller = makeCatalogWrite({
          version: "v2",
          titles: makeCatalogWrite().titles.filter((title) => title.id !== "t-adult"),
        });
        await repos().seed.replaceCatalog(smaller);
        const snapshot = await repos().catalog.loadSnapshot();
        expect(snapshot.version).toBe("v2");
        expect(snapshot.titles.map((title) => title.id)).toEqual(["t-all", "t-series", "t-teen"]);
      });

      it("serves episodes, playback media and avatars", async () => {
        await withCatalog();
        const season1 = await repos().catalog.listEpisodes("t-series", 1);
        expect(season1.map((episode) => episode.id)).toEqual(["e-s1e1", "e-s1e2"]);
        expect(season1[0]?.synopsis).toBe("It begins.");
        expect(await repos().catalog.listEpisodes("t-series", 9)).toEqual([]);

        const media = await repos().catalog.loadPlaybackMedia({
          assetId: "v-1",
          episodeIds: ["e-s1e2", "e-s2e1"],
        });
        expect(media.asset).toEqual(makeCatalogWrite().videoAssets[0]);
        expect(media.episodes.map((episode) => episode.id).sort()).toEqual(["e-s1e2", "e-s2e1"]);
        expect(
          (await repos().catalog.loadPlaybackMedia({ assetId: "v-x", episodeIds: [] })).asset,
        ).toBeNull();

        const avatars = await repos().catalog.listAvatars();
        expect(avatars.groups).toEqual([{ id: "ag-1", name: "Classics", position: 0 }]);
        expect(avatars.avatars.map((avatar) => avatar.id)).toEqual(["av-1", "av-2"]);
        expect(await repos().catalog.getAvatar("av-2")).toMatchObject({ name: "Owl" });
        expect(await repos().catalog.getAvatar("av-9")).toBeNull();
      });
    });

    describe("library", () => {
      async function withProfile() {
        await withCatalog();
        await signUp();
        await repos().profiles.createWithinLimit(makeProfileRow(), 5);
      }

      it("keeps My List idempotent, most recent first", async () => {
        await withProfile();
        await repos().library.addToMyList("pro-1", "t-teen", T0);
        await repos().library.addToMyList("pro-1", "t-all", T0 + 10);
        await repos().library.addToMyList("pro-1", "t-teen", T0 + 20);
        expect((await repos().library.loadSignals("pro-1")).myList).toEqual([
          { titleId: "t-all", addedAt: T0 + 10 },
          { titleId: "t-teen", addedAt: T0 },
        ]);
        await repos().library.removeFromMyList("pro-1", "t-all");
        await repos().library.removeFromMyList("pro-1", "t-all");
        expect((await repos().library.loadSignals("pro-1")).myList).toEqual([
          { titleId: "t-teen", addedAt: T0 },
        ]);
      });

      it("sets, overwrites and clears ratings", async () => {
        await withProfile();
        await repos().library.setRating("pro-1", "t-teen", "like", T0);
        await repos().library.setRating("pro-1", "t-teen", "love", T0 + 1);
        await repos().library.setRating("pro-1", "t-all", "dislike", T0);
        expect((await repos().library.loadSignals("pro-1")).ratings).toEqual([
          { titleId: "t-teen", value: "love", ratedAt: T0 + 1 },
          { titleId: "t-all", value: "dislike", ratedAt: T0 },
        ]);
        await repos().library.clearRating("pro-1", "t-teen");
        expect((await repos().library.loadSignals("pro-1")).ratings).toHaveLength(1);
      });

      it("records progress and history per item; hiding lasts until the next heartbeat", async () => {
        await withProfile();
        await startPlayback();
        await repos().playback.recordHeartbeat(heartbeat());
        await repos().playback.recordHeartbeat(
          heartbeat({ positionSec: 130, now: T0 + 60_000, historyId: "h-ignored" }),
        );
        const [progress] = (await repos().library.loadSignals("pro-1")).progress;
        expect(progress).toEqual({
          profileId: "pro-1",
          itemId: "t-teen",
          titleId: "t-teen",
          episodeId: null,
          positionSec: 130,
          durationSec: 5400,
          completed: false,
          hidden: false,
          updatedAt: T0 + 60_000,
        });
        expect(await repos().library.listHistory("pro-1", { limit: 10 })).toEqual([
          {
            id: "h-1",
            profileId: "pro-1",
            itemId: "t-teen",
            titleId: "t-teen",
            episodeId: null,
            watchedAt: T0 + 60_000,
          },
        ]);

        await repos().library.hideFromContinueWatching("pro-1", "t-teen");
        expect((await repos().library.loadSignals("pro-1")).progress[0]?.hidden).toBe(true);
        await repos().playback.recordHeartbeat(heartbeat({ positionSec: 160, now: T0 + 90_000 }));
        expect((await repos().library.loadSignals("pro-1")).progress[0]?.hidden).toBe(false);
      });

      it("pages viewing activity newest first without gaps", async () => {
        await withProfile();
        await startPlayback();
        const items = ["e-s1e1", "e-s1e2", "e-s2e1"];
        for (const [index, episodeId] of items.entries()) {
          await repos().playback.recordHeartbeat(
            heartbeat({ titleId: "t-series", episodeId, historyId: `h-${index}`, now: T0 + index }),
          );
        }
        // Two entries share a timestamp: the id breaks the tie.
        await repos().playback.recordHeartbeat(heartbeat({ historyId: "h-9", now: T0 + 2 }));
        const seen: string[] = [];
        let before: { watchedAt: number; id: string } | undefined;
        for (let page = 0; page < 5; page += 1) {
          const entries = await repos().library.listHistory("pro-1", { limit: 2, before });
          seen.push(...entries.map((entry) => entry.id));
          const last = entries[entries.length - 1];
          if (entries.length < 2 || !last) break;
          before = { watchedAt: last.watchedAt, id: last.id };
        }
        expect(seen).toEqual(["h-9", "h-2", "h-1", "h-0"]);
      });

      it("removes a history entry together with its progress", async () => {
        await withProfile();
        await startPlayback();
        await repos().playback.recordHeartbeat(heartbeat());
        expect(await repos().library.deleteHistoryEntry("pro-2", "h-1")).toBe(false);
        expect(await repos().library.deleteHistoryEntry("pro-1", "h-1")).toBe(true);
        expect(await repos().library.deleteHistoryEntry("pro-1", "h-1")).toBe(false);
        expect((await repos().library.loadSignals("pro-1")).progress).toEqual([]);
      });
    });

    describe("playback", () => {
      async function withSession() {
        await withCatalog();
        await signUp();
        await repos().profiles.createWithinLimit(makeProfileRow(), 5);
        await startPlayback();
      }

      it("credits position advance while playing, bounded by the session's credit clock", async () => {
        await withSession();
        const beat = async (seconds: number, positionSec: number, extra = {}) => {
          await repos().playback.recordHeartbeat(
            heartbeat({ now: T0 + seconds * 1000, positionSec, ...extra }),
          );
          return (await repos().playback.get("ps-1"))?.watchedSec;
        };
        // Watching at 1x: the advance is credited.
        expect(await beat(30, 30)).toBeCloseTo(30);
        // 70 s of position in 30 s (faster playback, or a seek while playing): 30 s.
        expect(await beat(60, 100)).toBeCloseTo(60);
        // Paused after 15 more seconds of playing: those are credited.
        expect(await beat(75, 115, { state: "paused" })).toBeCloseTo(75);
        // A seek while paused, minutes later, earns nothing (the interval began paused)...
        expect(await beat(300, 900, { state: "paused" })).toBeCloseTo(75);
        // ...nor does the report that playback resumed.
        expect(await beat(301, 900)).toBeCloseTo(75);
        // Thirty seconds of playing after the resume report: credited in full.
        expect(await beat(331, 930)).toBeCloseTo(105);
        // A seek backwards credits nothing (never negative).
        expect(await beat(361, 800)).toBeCloseTo(105);
        // A long gap: the per-heartbeat cap applies.
        expect(await beat(900, 1500, { maxCreditSec: 90 })).toBeCloseTo(195);
        const session = await repos().playback.get("ps-1");
        expect(session).toMatchObject({ positionSec: 1500, state: "playing", endedAt: null });
        expect(session?.lastHeartbeatAt).toBeLessThanOrEqual(T0 + 900_000);
      });

      it("never credits more wall-clock time than passed, however many heartbeats arrive", async () => {
        await withSession();
        // Twelve heartbeats two seconds in, each claiming five more seconds of watching.
        for (let beat = 1; beat <= 12; beat += 1) {
          await repos().playback.recordHeartbeat(
            heartbeat({ positionSec: beat * 5, now: T0 + 2_000 }),
          );
        }
        expect((await repos().playback.get("ps-1"))?.watchedSec).toBeCloseTo(2);
        // Spread over the next second at ten a second: still bounded by the clock.
        for (let beat = 1; beat <= 10; beat += 1) {
          await repos().playback.recordHeartbeat(
            heartbeat({ positionSec: 60 + beat * 5, now: T0 + 2_000 + beat * 100 }),
          );
        }
        expect((await repos().playback.get("ps-1"))?.watchedSec).toBeCloseTo(3);
        // Twice the speed for five minutes: five minutes.
        for (let beat = 1; beat <= 10; beat += 1) {
          await repos().playback.recordHeartbeat(
            heartbeat({ positionSec: 110 + beat * 60, now: T0 + 3_000 + beat * 30_000 }),
          );
        }
        expect((await repos().playback.get("ps-1"))?.watchedSec).toBeCloseTo(303);
      });

      it("carries a few seconds of jitter to the next heartbeat instead of losing them", async () => {
        await withSession();
        // One heartbeat arrives a second late, the next on time: both full intervals count.
        await repos().playback.recordHeartbeat(heartbeat({ positionSec: 30, now: T0 + 31_000 }));
        await repos().playback.recordHeartbeat(heartbeat({ positionSec: 60, now: T0 + 60_000 }));
        expect((await repos().playback.get("ps-1"))?.watchedSec).toBeCloseTo(60);
        // Slack older than the carry is forfeited: an interval paused at its start earns
        // nothing, and playing resumes with at most the carry in hand.
        await repos().playback.recordHeartbeat(
          heartbeat({ positionSec: 60, now: T0 + 70_000, state: "paused" }),
        );
        await repos().playback.recordHeartbeat(heartbeat({ positionSec: 60, now: T0 + 200_000 }));
        await repos().playback.recordHeartbeat(heartbeat({ positionSec: 120, now: T0 + 201_000 }));
        expect((await repos().playback.get("ps-1"))?.watchedSec).toBeCloseTo(66);
      });

      it("ignores a report that lands after the session ended: the final position stays", async () => {
        await withSession();
        // The release (with the final position) commits first; a heartbeat sent a moment earlier,
        // already past the service's checks, writes after it with an older position.
        await repos().playback.recordHeartbeat(
          heartbeat({ positionSec: 40, now: T0 + 40_000, ends: true }),
        );
        await repos().library.hideFromContinueWatching("pro-1", "t-teen");
        await repos().playback.recordHeartbeat(
          heartbeat({ positionSec: 20, now: T0 + 41_000, historyId: "h-late" }),
        );
        const [progress] = (await repos().library.loadSignals("pro-1")).progress;
        expect(progress).toMatchObject({ positionSec: 40, hidden: true, updatedAt: T0 + 40_000 });
        expect(await repos().library.listHistory("pro-1", { limit: 10 })).toMatchObject([
          { id: "h-1", watchedAt: T0 + 40_000 },
        ]);
        // Nor does it create progress for an item the session never reported.
        await repos().playback.recordHeartbeat(
          heartbeat({ titleId: "t-all", positionSec: 99, now: T0 + 42_000, historyId: "h-other" }),
        );
        expect((await repos().library.loadSignals("pro-1")).progress).toHaveLength(1);
      });

      it("ends a session with its final report in the same write", async () => {
        await withSession();
        await repos().playback.recordHeartbeat(
          heartbeat({ positionSec: 40, now: T0 + 40_000, ends: true }),
        );
        const ended = await repos().playback.get("ps-1");
        expect(ended).toMatchObject({ endedAt: T0 + 40_000, positionSec: 40 });
        expect(ended?.watchedSec).toBeCloseTo(40);
        const progress = (await repos().library.loadSignals("pro-1")).progress;
        expect(progress).toMatchObject([{ itemId: "t-teen", positionSec: 40 }]);
        // Nothing is credited to an ended session afterwards.
        await repos().playback.recordHeartbeat(heartbeat({ positionSec: 90, now: T0 + 90_000 }));
        expect((await repos().playback.get("ps-1"))?.watchedSec).toBeCloseTo(40);
        expect((await repos().playback.get("ps-1"))?.endedAt).toBe(T0 + 40_000);
      });

      it("ends sessions idempotently and stops crediting them", async () => {
        await withSession();
        await repos().playback.end("ps-1", T0 + 10);
        await repos().playback.end("ps-1", T0 + 20);
        expect((await repos().playback.get("ps-1"))?.endedAt).toBe(T0 + 10);
        await repos().playback.recordHeartbeat(heartbeat({ positionSec: 50, now: T0 + 30_000 }));
        expect((await repos().playback.get("ps-1"))?.watchedSec).toBe(0);
        expect(await repos().playback.get("ps-missing")).toBeNull();
        expect(await repos().playback.deleteStartedBefore(T0 + 1)).toBe(1);
        expect(await repos().playback.get("ps-1")).toBeNull();
      });
    });

    describe("stats", () => {
      it("rolls up a day idempotently: views need a minute of watching per profile", async () => {
        await withCatalog();
        await signUp();
        await repos().profiles.createWithinLimit(makeProfileRow(), 5);
        await repos().profiles.createWithinLimit(
          makeProfileRow({ id: "pro-2", createdAt: T0 + 1 }),
          5,
        );
        await startPlayback("ps-1");
        await startPlayback("ps-2", { profileId: "pro-2" });
        await startPlayback("ps-3", { profileId: "pro-2", titleId: "t-all" });
        await repos().playback.recordHeartbeat(
          heartbeat({ playbackSessionId: "ps-1", positionSec: 90, now: T0 + 90_000 }),
        );
        await repos().playback.recordHeartbeat(
          heartbeat({
            playbackSessionId: "ps-2",
            profileId: "pro-2",
            positionSec: 20,
            now: T0 + 20_000,
            historyId: "h-2",
          }),
        );
        const dayStart = T0 - (T0 % DAY_MS);
        for (let run = 0; run < 2; run += 1) {
          await repos().stats.rollupPlaybackDay("2026-06-01", dayStart, dayStart + DAY_MS);
        }
        await repos().stats.rollupPlaybackDay(
          "2026-06-02",
          dayStart + DAY_MS,
          dayStart + 2 * DAY_MS,
        );
        const views = await repos().stats.dailyViews("2026-06-01");
        expect(views).toEqual([
          { day: "2026-06-01", titleId: "t-all", views: 0 },
          { day: "2026-06-01", titleId: "t-teen", views: 1 },
        ]);
      });

      it("adds up a profile's sessions of a title that day: two 40 s sessions are one view", async () => {
        await withCatalog();
        await signUp();
        await repos().profiles.createWithinLimit(makeProfileRow(), 5);
        await startPlayback("ps-1");
        await startPlayback("ps-2");
        for (const [id, historyId] of [
          ["ps-1", "h-1"],
          ["ps-2", "h-2"],
        ] as const) {
          await repos().playback.recordHeartbeat(
            heartbeat({ playbackSessionId: id, positionSec: 40, now: T0 + 40_000, historyId }),
          );
        }
        const dayStart = T0 - (T0 % DAY_MS);
        await repos().stats.rollupPlaybackDay("2026-06-01", dayStart, dayStart + DAY_MS);
        expect(await repos().stats.dailyViews("2026-06-01")).toEqual([
          { day: "2026-06-01", titleId: "t-teen", views: 1 },
        ]);
      });

      it("keeps the synthetic baseline separate from real playback", async () => {
        await repos().stats.upsertBaseline([
          {
            day: "2026-06-01",
            titleId: "t-teen",
            source: "seed",
            views: 40,
            watchSec: 100,
            profiles: 40,
          },
        ]);
        await repos().stats.upsertBaseline([
          {
            day: "2026-06-01",
            titleId: "t-teen",
            source: "seed",
            views: 50,
            watchSec: 100,
            profiles: 50,
          },
          {
            day: "2026-06-02",
            titleId: "t-all",
            source: "seed",
            views: 5,
            watchSec: 10,
            profiles: 5,
          },
        ]);
        expect(await repos().stats.hasBaseline("2026-06-02")).toBe(true);
        expect(await repos().stats.hasBaseline("2026-06-03")).toBe(false);
        expect(await repos().stats.dailyViews("2026-06-02")).toEqual([
          { day: "2026-06-02", titleId: "t-all", views: 5 },
        ]);
        await repos().seed.replaceBaselineStats([
          {
            day: "2026-06-03",
            titleId: "t-adult",
            source: "seed",
            views: 7,
            watchSec: 1,
            profiles: 7,
          },
        ]);
        expect(await repos().stats.dailyViews("2026-01-01")).toEqual([
          { day: "2026-06-03", titleId: "t-adult", views: 7 },
        ]);
      });
    });

    describe("notifications", () => {
      async function withProfile() {
        await withCatalog();
        await signUp();
        await repos().profiles.createWithinLimit(makeProfileRow(), 5);
      }
      const query = { profileId: "pro-1", maxMaturityRank: 4, since: 0, limit: 10 };

      it("lists by maturity and age, newest first, with read state", async () => {
        await withProfile();
        const all = await repos().notifications.listForProfile(query);
        expect(all.map((notification) => notification.id)).toEqual(["n-1", "n-2"]);
        expect(all[1]).toMatchObject({
          kind: "new-arrival",
          titleId: "t-adult",
          readAt: null,
          image: { aspectRatio: 16 / 9 },
        });
        const kids = await repos().notifications.listForProfile({ ...query, maxMaturityRank: 1 });
        expect(kids.map((notification) => notification.id)).toEqual(["n-1"]);
        const recent = await repos().notifications.listForProfile({ ...query, since: T0 - DAY_MS });
        expect(recent.map((notification) => notification.id)).toEqual(["n-1"]);
      });

      it("marks some or all read, idempotently, and keeps receipts across re-seeds", async () => {
        await withProfile();
        await repos().notifications.markRead(query, ["n-2", "n-missing"], T0 + 1);
        await repos().notifications.markRead(query, ["n-2"], T0 + 2);
        let listed = await repos().notifications.listForProfile(query);
        expect(listed.map((notification) => notification.readAt)).toEqual([null, T0 + 1]);
        await repos().notifications.markRead({ ...query, maxMaturityRank: 1 }, "all", T0 + 3);
        listed = await repos().notifications.listForProfile(query);
        expect(listed.map((notification) => notification.readAt)).toEqual([T0 + 3, T0 + 1]);

        const catalog = makeCatalogWrite({ version: "v2" });
        await repos().seed.replaceCatalog({
          ...catalog,
          notifications: catalog.notifications.filter((notification) => notification.id === "n-2"),
        });
        listed = await repos().notifications.listForProfile(query);
        expect(listed.map((notification) => [notification.id, notification.readAt])).toEqual([
          ["n-2", T0 + 1],
        ]);
      });
    });

    describe("meta and seeding", () => {
      it("stores settings", async () => {
        expect(await repos().meta.get("k")).toBeNull();
        await repos().meta.set("k", "one", T0);
        await repos().meta.set("k", "two", T0 + 1);
        expect(await repos().meta.get("k")).toBe("two");
        await repos().ping();
      });

      it("replaces an account and everything it owns", async () => {
        await withCatalog();
        await signUp({ accountId: "acc-old" });
        await repos().profiles.createWithinLimit(
          makeProfileRow({ id: "pro-old", accountId: "acc-old" }),
          5,
        );
        await repos().library.addToMyList("pro-old", "t-teen", T0);
        await repos().seed.replaceAccount({
          account: makeAccountRecord({ id: "acc-new" }),
          subscription: makeSubscriptionRecord({ accountId: "acc-new", planId: "premium" }),
          profiles: [makeProfileRow({ id: "pro-new", accountId: "acc-new" })],
          myList: [{ profileId: "pro-new", titleId: "t-all", addedAt: T0 }],
          ratings: [{ profileId: "pro-new", titleId: "t-all", value: "love", ratedAt: T0 }],
          progress: [
            {
              profileId: "pro-new",
              itemId: "e-s1e1",
              titleId: "t-series",
              episodeId: "e-s1e1",
              positionSec: 300,
              durationSec: 1800,
              completed: false,
              hidden: false,
              updatedAt: T0,
            },
          ],
          history: [
            {
              id: "h-new",
              profileId: "pro-new",
              itemId: "e-s1e1",
              titleId: "t-series",
              episodeId: "e-s1e1",
              watchedAt: T0,
            },
          ],
        });
        expect(await repos().accounts.get("acc-old")).toBeNull();
        expect(await repos().sessions.findActive("hash-acc-old", T0)).toBeNull();
        expect((await repos().library.loadSignals("pro-old")).myList).toEqual([]);
        expect((await repos().accounts.get("acc-new"))?.subscription.planId).toBe("premium");
        const signals = await repos().library.loadSignals("pro-new");
        expect(signals.myList).toEqual([{ titleId: "t-all", addedAt: T0 }]);
        expect(signals.ratings).toHaveLength(1);
        expect(signals.progress).toHaveLength(1);
        expect(await repos().library.listHistory("pro-new", { limit: 5 })).toHaveLength(1);
      });
    });
  });
}
