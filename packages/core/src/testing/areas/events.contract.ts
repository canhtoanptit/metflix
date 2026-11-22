import { describe, expect, it } from "vitest";
import { heartbeatCredit } from "../../areas/events/playback-events.ts";
import type { ConsentRecord, PrivacyRequestRecord } from "../../areas/events/repository.ts";
import type { Repositories } from "../../repositories/ports.ts";
import { type HarnessBase, type HarnessFactory, useHarness } from "../harness.ts";
import {
  DAY_MS,
  makeAccountRecord,
  makeProfileRow,
  makeSessionRecord,
  makeSubscriptionRecord,
  T0,
} from "../records.ts";

export interface EventsRepositoryHarness extends HarnessBase {
  repos: Repositories;
}

const consent = (overrides: Partial<ConsentRecord>): ConsentRecord => ({
  id: "0193a1d2-7c4e-7a10-8f00-000000000001",
  accountId: "acc-1",
  purpose: "analytics",
  granted: true,
  source: "banner",
  createdAt: T0,
  ...overrides,
});

const request = (overrides: Partial<PrivacyRequestRecord>): PrivacyRequestRecord => ({
  id: "pr-1",
  accountId: "acc-1",
  kind: "export",
  status: "pending",
  requestedAt: T0,
  scheduledFor: null,
  completedAt: null,
  exportBlobKey: null,
  expiresAt: null,
  lastError: null,
  updatedAt: T0,
  ...overrides,
});

/**
 * Contract of the events area's repository (`repos.events`), run against memory, SQLite,
 * PostgreSQL and D1.
 */
export function describeEventsRepositoryContract(
  name: string,
  factory: HarnessFactory<EventsRepositoryHarness>,
): void {
  describe(`EventsRepository contract: ${name}`, () => {
    const h = useHarness(factory);
    const repo = () => h().repos.events;

    async function account(id = "acc-1") {
      await h().repos.accounts.createWithSession({
        account: makeAccountRecord({ id, email: `${id}@example.com` }),
        subscription: makeSubscriptionRecord({ accountId: id }),
        session: makeSessionRecord({ id: `ses-${id}`, tokenHash: `hash-${id}`, accountId: id }),
      });
    }

    it("is composed into the repositories", () => {
      expect(h().repos.events).toBeTypeOf("object");
    });

    it("answers the latest consent per purpose at an instant, the history kept", async () => {
      await account();
      await repo().addConsent(consent({ id: "0193a1d2-0000-7000-8000-000000000001" }));
      await repo().addConsent(
        consent({
          id: "0193a1d2-0000-7000-8000-000000000002",
          purpose: "personalisation",
          granted: true,
        }),
      );
      await repo().addConsent(
        consent({
          id: "0193a1d2-0000-7000-8000-000000000003",
          granted: false,
          source: "settings",
          createdAt: T0 + 1000,
        }),
      );
      const now = await repo().consentsAt("acc-1", T0 + 5000);
      const byPurpose = Object.fromEntries(now.map((record) => [record.purpose, record]));
      expect(byPurpose.analytics).toMatchObject({ granted: false, source: "settings" });
      expect(byPurpose.personalisation).toMatchObject({ granted: true, source: "banner" });
      expect(now).toHaveLength(2);
      // At an earlier instant, the earlier answer was in force.
      const before = await repo().consentsAt("acc-1", T0 + 999);
      expect(before.find((record) => record.purpose === "analytics")?.granted).toBe(true);
      expect(await repo().consentsAt("acc-1", T0 - 1)).toEqual([]);
      expect(await repo().listConsents("acc-1")).toHaveLength(3);
      expect(await repo().consentsAt("acc-other", T0 + 5000)).toEqual([]);
    });

    it("breaks a same-millisecond tie by the later id (the latest stamp wins)", async () => {
      await account();
      await repo().addConsent(
        consent({ id: "0193a1d2-0000-7000-8000-00000000000b", granted: false }),
      );
      await repo().addConsent(
        consent({ id: "0193a1d2-0000-7000-8000-00000000000a", granted: true }),
      );
      const [only] = await repo().consentsAt("acc-1", T0);
      expect(only).toMatchObject({ id: "0193a1d2-0000-7000-8000-00000000000b", granted: false });
    });

    it("allows one open privacy request per kind and account", async () => {
      await account();
      expect(await repo().createPrivacyRequest(request({ id: "pr-1" }))).toBe(true);
      expect(await repo().createPrivacyRequest(request({ id: "pr-2" }))).toBe(false);
      expect(
        await repo().createPrivacyRequest(
          request({ id: "pr-3", kind: "deletion", status: "scheduled", scheduledFor: T0 + DAY_MS }),
        ),
      ).toBe(true);
      expect(
        await repo().transitionPrivacyRequest("pr-1", ["pending"], {
          status: "completed",
          completedAt: T0 + 10,
          updatedAt: T0 + 10,
        }),
      ).toBe(true);
      // Closed: a new export may start.
      expect(await repo().createPrivacyRequest(request({ id: "pr-4", requestedAt: T0 + 20 }))).toBe(
        true,
      );
      expect((await repo().listPrivacyRequests("acc-1")).map((record) => record.id)).toEqual([
        "pr-4",
        "pr-3",
        "pr-1",
      ]);
    });

    it("transitions a request only from the expected statuses (compare-and-set)", async () => {
      await account();
      await repo().createPrivacyRequest(request({ id: "pr-1" }));
      expect(
        await repo().transitionPrivacyRequest("pr-1", ["scheduled"], {
          status: "processing",
          updatedAt: T0 + 1,
        }),
      ).toBe(false);
      expect(
        await repo().transitionPrivacyRequest("pr-1", ["pending", "processing"], {
          status: "completed",
          exportBlobKey: "privacy/exports/pr-1.json.gz",
          expiresAt: T0 + DAY_MS,
          completedAt: T0 + 2,
          lastError: null,
          updatedAt: T0 + 2,
        }),
      ).toBe(true);
      expect(await repo().getPrivacyRequest("pr-1")).toEqual(
        request({
          id: "pr-1",
          status: "completed",
          exportBlobKey: "privacy/exports/pr-1.json.gz",
          expiresAt: T0 + DAY_MS,
          completedAt: T0 + 2,
          updatedAt: T0 + 2,
        }),
      );
      expect(await repo().getPrivacyRequest("pr-missing")).toBeNull();
      expect(
        await repo().transitionPrivacyRequest("pr-missing", ["pending"], { updatedAt: T0 }),
      ).toBe(false);
    });

    it("finds due deletions and expired exports, oldest first, bounded", async () => {
      await account("acc-1");
      await account("acc-2");
      await account("acc-3");
      await repo().createPrivacyRequest(
        request({
          id: "d-1",
          accountId: "acc-1",
          kind: "deletion",
          status: "scheduled",
          scheduledFor: T0 + 200,
        }),
      );
      await repo().createPrivacyRequest(
        request({
          id: "d-2",
          accountId: "acc-2",
          kind: "deletion",
          status: "scheduled",
          scheduledFor: T0 + 100,
        }),
      );
      await repo().createPrivacyRequest(
        request({
          id: "d-3",
          accountId: "acc-3",
          kind: "deletion",
          status: "scheduled",
          scheduledFor: T0 + DAY_MS,
        }),
      );
      expect((await repo().dueDeletions(T0 + 300, 10)).map((record) => record.id)).toEqual([
        "d-2",
        "d-1",
      ]);
      expect((await repo().dueDeletions(T0 + 300, 1)).map((record) => record.id)).toEqual(["d-2"]);
      await repo().createPrivacyRequest(
        request({
          id: "e-1",
          accountId: "acc-1",
          status: "completed",
          exportBlobKey: "privacy/exports/e-1.json.gz",
          expiresAt: T0 + 50,
        }),
      );
      await repo().createPrivacyRequest(
        request({
          id: "e-2",
          accountId: "acc-2",
          status: "completed",
          exportBlobKey: "privacy/exports/e-2.json.gz",
          expiresAt: T0 + DAY_MS,
        }),
      );
      expect((await repo().expiredExports(T0 + 100, 10)).map((record) => record.id)).toEqual([
        "e-1",
      ]);
    });

    it("records erasures once and marks them compacted", async () => {
      await repo().addErasures([
        {
          subjectKey: "aK3vB8nQ2wE5rT7yU9iO1p",
          kind: "account",
          requestedAt: T0,
          compactedAt: null,
        },
        {
          subjectKey: "pL4sD8fG2hJ6kZ1xC5vB9n",
          kind: "profile",
          requestedAt: T0,
          compactedAt: null,
        },
      ]);
      await repo().addErasures([
        {
          subjectKey: "aK3vB8nQ2wE5rT7yU9iO1p",
          kind: "account",
          requestedAt: T0 + 9,
          compactedAt: null,
        },
      ]);
      const pending = await repo().pendingErasures(10);
      expect(pending.map((record) => record.subjectKey)).toEqual([
        "aK3vB8nQ2wE5rT7yU9iO1p",
        "pL4sD8fG2hJ6kZ1xC5vB9n",
      ]);
      expect(pending[0]?.requestedAt).toBe(T0);
      await repo().markErasuresCompacted(["aK3vB8nQ2wE5rT7yU9iO1p"], T0 + 50);
      expect((await repo().pendingErasures(10)).map((record) => record.subjectKey)).toEqual([
        "pL4sD8fG2hJ6kZ1xC5vB9n",
      ]);
    });

    it("mirrors recordHeartbeat's credit exactly (playback events read no row back)", async () => {
      await account();
      await h().repos.profiles.createWithinLimit(
        makeProfileRow({ id: "p-1", accountId: "acc-1" }),
        5,
      );
      const start = T0 + DAY_MS;
      await h().repos.playback.create({
        id: "ps-credit",
        accountId: "acc-1",
        profileId: "p-1",
        sessionId: "ses-acc-1",
        titleId: "t-1",
        episodeId: null,
        assetId: null,
        maxVideoHeight: 1080,
        startedAt: start,
        lastHeartbeatAt: start,
        endedAt: null,
        positionSec: 0,
        durationSec: 600,
        watchedSec: 0,
        state: "playing",
      });
      const reports = [
        { at: 30_000, positionSec: 28, state: "playing" as const },
        { at: 40_000, positionSec: 60, state: "paused" as const }, // more than the clock allows
        { at: 70_000, positionSec: 90, state: "playing" as const }, // paused before: nothing
        { at: 140_000, positionSec: 400, state: "buffering" as const }, // capped
        { at: 170_000, positionSec: 380, state: "playing" as const }, // seek back: nothing
        { at: 200_000, positionSec: 410.5, state: "playing" as const },
      ];
      for (const report of reports) {
        const before = await h().repos.playback.get("ps-credit");
        if (!before) throw new Error("the playback session vanished");
        const now = start + report.at;
        const expected = before.watchedSec + heartbeatCredit(before, report.positionSec, now, 90);
        await h().repos.playback.recordHeartbeat({
          playbackSessionId: "ps-credit",
          profileId: "p-1",
          titleId: "t-1",
          episodeId: null,
          positionSec: report.positionSec,
          durationSec: 600,
          state: report.state,
          completed: false,
          now,
          maxCreditSec: 90,
          historyId: `h-${report.at}`,
          ends: false,
        });
        const after = await h().repos.playback.get("ps-credit");
        expect(after?.watchedSec).toBeCloseTo(expected, 6);
      }
    });

    it("keeps playback's server events in the outbox, written with the playback writes", async () => {
      await account();
      await h().repos.profiles.createWithinLimit(
        makeProfileRow({ id: "p-1", accountId: "acc-1" }),
        5,
      );
      const row = (id: string, at: number) => ({
        id,
        accountId: "acc-1",
        profileId: "p-1",
        payload: JSON.stringify({ event: { eventId: id } }),
        createdAt: at,
      });
      const start = T0 + DAY_MS;
      const session = {
        id: "ps-outbox",
        accountId: "acc-1",
        profileId: "p-1",
        sessionId: "ses-acc-1",
        titleId: "t-1",
        episodeId: null,
        assetId: null,
        maxVideoHeight: 1080,
        startedAt: start,
        lastHeartbeatAt: start,
        endedAt: null,
        positionSec: 0,
        durationSec: 600,
        watchedSec: 0,
        state: "playing" as const,
      };
      await h().repos.playback.create(session, { outbox: [row("e-start", start)] });
      const beat = (at: number, outbox: ReturnType<typeof row>[], ends = false) =>
        h().repos.playback.recordHeartbeat({
          playbackSessionId: "ps-outbox",
          profileId: "p-1",
          titleId: "t-1",
          episodeId: null,
          positionSec: 150,
          durationSec: 600,
          state: "playing",
          completed: false,
          now: at,
          maxCreditSec: 90,
          historyId: `h-${at}`,
          ends,
          outbox,
        });
      await beat(start + 30_000, [row("e-q1", start + 30_000)]);
      await beat(start + 60_000, [row("e-abandon", start + 60_000)], true);
      // Once ended, nothing more is written: not by a late report, not by another release.
      await beat(start + 90_000, [row("e-late", start + 90_000)]);
      await h().repos.playback.end("ps-outbox", start + 95_000, {
        outbox: [row("e-again", start + 95_000)],
      });
      const rows = await repo().takeOutbox(10);
      expect(rows.map((event) => event.id)).toEqual(["e-start", "e-q1", "e-abandon"]);
      expect(rows[0]).toEqual(row("e-start", start));
      expect((await repo().takeOutbox(2)).map((event) => event.id)).toEqual(["e-start", "e-q1"]);
      await repo().deleteOutbox(["e-start", "e-q1"]);
      await repo().deleteOutbox(["e-start"]);
      expect((await repo().takeOutbox(10)).map((event) => event.id)).toEqual(["e-abandon"]);
      // A release that ends a live session writes its events in the same batch.
      await h().repos.playback.create(
        { ...session, id: "ps-outbox-2", startedAt: start + 1, lastHeartbeatAt: start + 1 },
        {},
      );
      await h().repos.playback.end("ps-outbox-2", start + 2, {
        outbox: [row("e-closed", start + 2)],
      });
      expect((await repo().takeOutbox(10)).map((event) => event.id)).toEqual([
        "e-closed",
        "e-abandon",
      ]);
      // The account's waiting rows go with the account.
      await repo().deleteAccount("acc-1");
      expect(await repo().takeOutbox(10)).toEqual([]);
    });

    it("finds open playback sessions by their credit clock, for the expiry sweep", async () => {
      await account();
      await h().repos.profiles.createWithinLimit(
        makeProfileRow({ id: "p-1", accountId: "acc-1" }),
        5,
      );
      const base = T0 + DAY_MS;
      const session = (id: string, lastHeartbeatAt: number) => ({
        id,
        accountId: "acc-1",
        profileId: "p-1",
        sessionId: "ses-acc-1",
        titleId: "t-1",
        episodeId: null,
        assetId: null,
        maxVideoHeight: 1080,
        startedAt: base,
        lastHeartbeatAt,
        endedAt: null,
        positionSec: 0,
        durationSec: 600,
        watchedSec: 0,
        state: "playing" as const,
      });
      await h().repos.playback.create(session("ps-old", base + 1_000));
      await h().repos.playback.create(session("ps-older", base));
      await h().repos.playback.create(session("ps-fresh", base + 500_000));
      await h().repos.playback.create(session("ps-ended", base));
      await h().repos.playback.end("ps-ended", base + 2_000);
      const open = await repo().openPlaybackBefore(base + 100_000, 10);
      expect(open.map((record) => record.id)).toEqual(["ps-older", "ps-old"]);
      expect(open[0]).toEqual(session("ps-older", base));
      expect(
        (await repo().openPlaybackBefore(base + 100_000, 1)).map((record) => record.id),
      ).toEqual(["ps-older"]);
    });

    it("deletes an account with what cascades from it, keeping privacy requests", async () => {
      await account("acc-1");
      await account("acc-2");
      await h().repos.profiles.createWithinLimit(
        makeProfileRow({ id: "p-1", accountId: "acc-1" }),
        5,
      );
      await repo().addConsent(consent({ accountId: "acc-1" }));
      await repo().addConsent(
        consent({ id: "0193a1d2-0000-7000-8000-0000000000f2", accountId: "acc-2" }),
      );
      await repo().createPrivacyRequest(
        request({ id: "d-1", kind: "deletion", status: "processing", scheduledFor: T0 }),
      );
      expect(await repo().deleteAccount("acc-1")).toBe(true);
      expect(await repo().deleteAccount("acc-1")).toBe(false);
      expect(await h().repos.accounts.get("acc-1")).toBeNull();
      expect(await h().repos.profiles.list("acc-1")).toEqual([]);
      expect(await repo().listConsents("acc-1")).toEqual([]);
      expect(await repo().getPrivacyRequest("d-1")).not.toBeNull();
      // Another account is untouched.
      expect(await h().repos.accounts.get("acc-2")).not.toBeNull();
      expect(await repo().listConsents("acc-2")).toHaveLength(1);
    });
  });
}
