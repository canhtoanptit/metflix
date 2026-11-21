/** Expired sign-ins are deleted by a scheduled, bounded job (docs/BACKEND.md, jobs). */
import { describe, expect, it } from "vitest";
import { SESSION_CLEANUP_BATCH, sessionCleanupJob } from "../../src/index.ts";
import { createTestServices } from "../../src/testing/index.ts";
import { makeSessionRecord } from "../../src/testing/records.ts";
import { openLogin } from "./helpers.ts";

describe("session cleanup", () => {
  it("runs with every scheduler tick and deletes only expired sessions", async () => {
    const t = await createTestServices();
    const client = { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0" };
    const short = await t.services.auth.login(
      { email: "demo@webflix.dev", password: "webflix-demo", rememberMe: false },
      client,
      openLogin,
    );
    const long = await t.services.auth.login(
      { email: "demo@webflix.dev", password: "webflix-demo" },
      client,
      openLogin,
    );
    t.clock.advance(2 * 24 * 60 * 60 * 1000);
    await t.services.scheduler.tick();
    await t.queue.drain();
    const sessions = await t.deps.repos.sessions.listForAccount("demo-account", 0);
    expect(sessions).toHaveLength(1);
    expect(await t.services.auth.authenticate(long.token)).not.toBeNull();
    expect(await t.services.auth.authenticate(short.token)).toBeNull();
    expect(t.logger.records.filter((record) => record.msg === "sessions.cleaned_up")).toEqual([
      expect.objectContaining({ deleted: 1, more: false }),
    ]);
  });

  it("drains a backlog one bounded batch at a time", async () => {
    const t = await createTestServices();
    const total = SESSION_CLEANUP_BATCH + 20;
    for (let index = 0; index < total; index += 1) {
      await t.deps.repos.sessions.create(
        makeSessionRecord({
          id: `ses-${index}`,
          tokenHash: `hash-${index}`,
          accountId: "demo-account",
          expiresAt: t.clock.now() - 1000,
        }),
      );
    }
    await t.deps.jobs.publish(sessionCleanupJob.create({}));
    await t.queue.drain();
    const runs = t.logger.records.filter((record) => record.msg === "sessions.cleaned_up");
    expect(runs.map((record) => record.deleted)).toEqual([SESSION_CLEANUP_BATCH, 20]);
    expect(await t.deps.repos.sessions.listForAccount("demo-account", 0)).toHaveLength(0);
  });
});
