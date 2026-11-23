/**
 * Data exports whose events come from the pipeline (batch mode), the recovery of a lost export
 * job (both modes), the erasure listing, and forgetting a profile that became restricted.
 */
import type { LakeEvent } from "@webflix/contracts";
import { describe, expect, it } from "vitest";
import { loadEventsConfig } from "../../src/areas/events/config.ts";
import type { ExportEventsResults } from "../../src/areas/events/privacy.ts";
import {
  createSubjectKeys,
  DEV_ONLY_PSEUDONYM_KEY,
  encodeLakeObject,
  hexEncode,
} from "../../src/index.ts";
import {
  clientEvent,
  createMember,
  DAY_MS,
  elevate,
  eventServices,
  lakeEvents,
  type Member,
  settle,
} from "./helpers.ts";

type Services = Awaited<ReturnType<typeof eventServices>>;
const keys = createSubjectKeys(DEV_ONLY_PSEUDONYM_KEY);

/** A member with events in the lake, then a batch-mode export waiting for its events. */
async function waiting(t: Services, id = "acc-batch") {
  const member = await createMember(t, id);
  await t.services.events.ingest({
    auth: member.as("adult"),
    events: [clientEvent("impression"), clientEvent("title.open")],
    gpc: false,
    country: null,
  });
  await settle(t);
  t.clock.advance(1000);
  await elevate(t, member);
  const request = await t.services.events.requestExport(member.as("adult"));
  await settle(t);
  return { member, request };
}

/** What `export-events` writes for a request: the events file and its manifest. */
async function pipelineOutput(t: Services, requestId: string, events: unknown[]) {
  const bytes = await encodeLakeObject(events as LakeEvent[]);
  const file = await t.sink.putDocument(`export-events/${requestId}/events.ndjson.gz`, bytes);
  const manifest = await t.sink.putDocument(
    `export-events/${requestId}/manifest.json`,
    new TextEncoder().encode("{}"),
  );
  const sha256 = hexEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  return { file, manifest, bytes: bytes.byteLength, sha256, events: events.length };
}

function results(
  entries: Partial<ExportEventsResults["results"][number]> &
    Pick<ExportEventsResults["results"][number], "requestId" | "status">,
): ExportEventsResults {
  return {
    format: "webflix.export-events-results",
    formatVersion: 1,
    generatedAt: "2026-06-15T13:00:00.000Z",
    results: [{ from: "2025-05-15T12:00:00.000Z", to: "2026-06-15T12:00:01.000Z", ...entries }],
  };
}

async function listed(t: Services, member: Member) {
  return (await t.services.events.listPrivacyRequests(member.as("adult"))).items[0];
}

describe("the export mode", () => {
  it("is inline in dev mode and batch everywhere else; inline is refused on Cloudflare", () => {
    const mode = (vars: Record<string, string>) =>
      loadEventsConfig({ vars, environment: "development" });
    expect(mode({ WEBFLIX_MODE: "dev" }).config.exportEvents).toBe("inline");
    expect(mode({ WEBFLIX_MODE: "k8s" }).config.exportEvents).toBe("batch");
    expect(mode({ WEBFLIX_MODE: "cloudflare" }).config.exportEvents).toBe("batch");
    expect(mode({ WEBFLIX_MODE: "k8s", WEBFLIX_EXPORT_EVENTS: "inline" }).issues).toEqual([]);
    expect(mode({ WEBFLIX_MODE: "cloudflare", WEBFLIX_EXPORT_EVENTS: "inline" }).issues).toEqual([
      expect.stringMatching(/^WEBFLIX_EXPORT_EVENTS=inline: not on Cloudflare/),
    ]);
  });
});

describe("a batch-mode export", () => {
  it("is assembled without its events, listed for the pipeline, and reads nothing from the lake", async () => {
    const t = await eventServices({ WEBFLIX_EXPORT_EVENTS: "batch" }, {});
    let scanned = 0;
    const accountEvents = t.sink.accountEvents.bind(t.sink);
    t.sink.accountEvents = async (options) => {
      scanned += 1;
      return accountEvents(options);
    };
    const { member, request } = await waiting(t);
    expect(scanned).toBe(0);
    expect(await listed(t, member)).toMatchObject({ status: "processing", downloadUrl: null });
    expect(t.ports.email.mailbox()).toEqual([]);
    // Everything the lake still holds, up to the request: never cut at the retention period.
    expect(await t.services.events.staff.pendingExports(10)).toEqual({
      requests: [
        {
          requestId: request.id,
          accountKey: await keys.account(member.accountId),
          from: "1970-01-01T00:00:00.000Z",
          to: request.requestedAt,
        },
      ],
    });
    // A new request is still refused: one export at a time.
    await expect(t.services.events.requestExport(member.as("adult"))).rejects.toMatchObject({
      code: "privacy_request_pending",
    });
  });

  it("is finished by a complete result: events verified and folded in, documents cleaned up", async () => {
    const t = await eventServices({ WEBFLIX_EXPORT_EVENTS: "batch" }, {});
    const { member, request } = await waiting(t);
    const accountKey = await keys.account(member.accountId);
    const theirs = lakeEvents(t.sink).filter((event) => event.subject.account === accountKey);
    expect(theirs.length).toBeGreaterThanOrEqual(2);
    const output = await pipelineOutput(t, request.id, theirs);
    const outcome = await t.services.events.staff.recordExportResults(
      results({ requestId: request.id, status: "complete", ...output }),
    );
    expect(outcome).toEqual({ completed: [request.id], erased: [], kept: [], ignored: [] });
    const done = await listed(t, member);
    expect(done).toMatchObject({ status: "completed" });
    const token = new URL(`http://x${done?.downloadUrl}`).searchParams.get("token") ?? "";
    const document = await t.services.events.downloadExport(member.as("adult"), request.id, token);
    expect(document.events.map((event) => event.eventId).sort()).toEqual(
      theirs.map((event) => event.eventId).sort(),
    );
    expect(document.account.email).toBe("acc-batch@example.com");
    expect(t.ports.email.mailbox()).toMatchObject([{ template: "data-export-ready" }]);
    // The partial document and the pipeline's two are gone; only the export itself remains.
    expect(t.sink.documentKeys()).toEqual([`privacy/exports/${request.id}.json.gz`]);
    expect(await t.services.events.staff.pendingExports(10)).toEqual({ requests: [] });
    // The same result again (a retried operator call) does no harm.
    expect(
      await t.services.events.staff.recordExportResults(
        results({ requestId: request.id, status: "complete", ...output }),
      ),
    ).toEqual({ completed: [], erased: [], kept: [], ignored: [request.id] });
    expect(t.ports.email.mailbox()).toHaveLength(1);
  });

  it("refuses a result whose file does not check out, and keeps the request listed", async () => {
    const t = await eventServices({ WEBFLIX_EXPORT_EVENTS: "batch" }, {});
    const { member, request } = await waiting(t);
    const accountKey = await keys.account(member.accountId);
    const theirs = lakeEvents(t.sink).filter((event) => event.subject.account === accountKey);
    const output = await pipelineOutput(t, request.id, theirs);
    const record = (patch: Record<string, unknown>) =>
      t.services.events.staff.recordExportResults(
        results({ requestId: request.id, status: "complete", ...output, ...patch }),
      );
    expect((await record({ bytes: output.bytes + 1 })).kept).toEqual([request.id]);
    expect((await record({ sha256: "0".repeat(64) })).kept).toEqual([request.id]);
    expect(
      (await record({ file: `privacy/export-events/${request.id}/../../exports/x.json.gz` })).kept,
    ).toEqual([request.id]);
    // Another account's event slipped in: refused whole.
    const foreign = await createMember(t, "acc-foreign");
    await t.services.events.ingest({
      auth: foreign.as("adult"),
      events: [clientEvent("impression")],
      gpc: false,
      country: null,
    });
    await settle(t);
    await t.sink.deleteDocument(output.file);
    await t.sink.deleteDocument(output.manifest);
    const mixed = await pipelineOutput(t, request.id, lakeEvents(t.sink));
    expect((await record(mixed)).kept).toEqual([request.id]);
    const still = await t.deps.repos.events.getPrivacyRequest(request.id);
    expect(still).toMatchObject({ status: "processing" });
    expect(still?.lastError).toMatch(/another account/);
    expect((await t.services.events.staff.pendingExports(10)).requests).toHaveLength(1);
    expect(t.ports.email.mailbox()).toEqual([]);
  });

  it("is finished with no events when the account is being erased; kept when deferred or failed", async () => {
    const t = await eventServices({ WEBFLIX_EXPORT_EVENTS: "batch" }, {});
    const { member, request } = await waiting(t);
    const deferred = await t.services.events.staff.recordExportResults(
      results({ requestId: request.id, status: "deferred", notBefore: "2026-06-15T13:15:00.000Z" }),
    );
    expect(deferred.kept).toEqual([request.id]);
    const failed = await t.services.events.staff.recordExportResults(
      results({ requestId: request.id, status: "failed", error: "store unreachable" }),
    );
    expect(failed.kept).toEqual([request.id]);
    expect((await t.deps.repos.events.getPrivacyRequest(request.id))?.lastError).toMatch(
      /store unreachable/,
    );
    expect((await t.services.events.staff.pendingExports(10)).requests).toHaveLength(1);
    const erased = await t.services.events.staff.recordExportResults(
      results({ requestId: request.id, status: "erased" }),
    );
    expect(erased.erased).toEqual([request.id]);
    const done = await listed(t, member);
    const token = new URL(`http://x${done?.downloadUrl}`).searchParams.get("token") ?? "";
    const document = await t.services.events.downloadExport(member.as("adult"), request.id, token);
    expect(document.events).toEqual([]);
  });

  it("ignores a result for an unknown request, or one that never waited for events", async () => {
    const t = await eventServices({ WEBFLIX_EXPORT_EVENTS: "batch" }, {});
    const inline = await eventServices({}, {});
    const member = await createMember(inline, "acc-inline");
    await elevate(inline, member);
    const request = await inline.services.events.requestExport(member.as("adult"));
    await settle(inline);
    const before = await inline.deps.repos.events.getPrivacyRequest(request.id);
    expect(
      await inline.services.events.staff.recordExportResults(
        results({ requestId: request.id, status: "erased" }),
      ),
    ).toEqual({ completed: [], erased: [], kept: [], ignored: [request.id] });
    expect(await inline.deps.repos.events.getPrivacyRequest(request.id)).toEqual(before);
    expect(
      (
        await t.services.events.staff.recordExportResults(
          results({ requestId: "0193a1d2-0000-7000-8000-00000000dead", status: "complete" }),
        )
      ).ignored,
    ).toHaveLength(1);
  });

  it("is cancelled, its partial document deleted, when the account is erased meanwhile", async () => {
    // A short cooling-off: the export is still within its day when the erasure runs.
    const t = await eventServices(
      { WEBFLIX_EXPORT_EVENTS: "batch", WEBFLIX_DELETION_COOLING_OFF_SEC: "3600" },
      {},
    );
    const { member, request } = await waiting(t);
    await t.services.events.requestDeletion(member.as("adult"));
    t.clock.advance(3600_000 + 1);
    await t.services.scheduler.tick();
    await settle(t);
    expect(await t.deps.repos.events.getPrivacyRequest(request.id)).toMatchObject({
      status: "canceled",
      exportBlobKey: null,
    });
    expect(t.sink.documentKeys()).toEqual([]);
    expect(await t.services.events.staff.pendingExports(10)).toEqual({ requests: [] });
  });
});

describe("a lost export job", () => {
  for (const mode of ["inline", "batch"] as const) {
    it(`is queued again by the sweep, and given up after a day (${mode})`, async () => {
      const t = await eventServices({ WEBFLIX_EXPORT_EVENTS: mode }, {});
      const member = await createMember(t, `acc-lost-${mode}`);
      await elevate(t, member);
      // The job is lost: published, never delivered.
      const publish = t.queue.publish.bind(t.queue);
      let lose = true;
      t.queue.publish = async (job, options) => {
        if (lose && job.type === "privacy.export") return;
        return publish(job, options);
      };
      const request = await t.services.events.requestExport(member.as("adult"));
      lose = false;
      await settle(t);
      expect((await listed(t, member))?.status).toBe("pending");
      // Not yet: a quarter of an hour.
      t.clock.advance(10 * 60_000);
      await t.services.scheduler.tick();
      await settle(t);
      expect((await listed(t, member))?.status).toBe("pending");
      t.clock.advance(6 * 60_000);
      await t.services.scheduler.tick();
      await settle(t);
      const recovered = await t.deps.repos.events.getPrivacyRequest(request.id);
      if (mode === "inline") expect(recovered?.status).toBe("completed");
      else {
        expect(recovered?.status).toBe("processing");
        expect((await t.services.events.staff.pendingExports(10)).requests).toHaveLength(1);
      }
    });
  }

  it("that keeps failing is given up after a day, so the member can ask again", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t, "acc-dead");
    await elevate(t, member);
    t.sink.accountEvents = async () => {
      throw new Error("the lake is unreadable");
    };
    const request = await t.services.events.requestExport(member.as("adult"));
    for (let hour = 0; hour < 26; hour += 1) {
      t.clock.advance(3600_000);
      await t.services.scheduler.tick();
      await settle(t);
    }
    expect(await t.deps.repos.events.getPrivacyRequest(request.id)).toMatchObject({
      status: "failed",
    });
    await elevate(t, member);
    await expect(t.services.events.requestExport(member.as("adult"))).resolves.toMatchObject({
      status: "pending",
    });
  });
});

describe("the erasure listing", () => {
  it("never hides an account behind profile records, whatever the limit", async () => {
    const t = await eventServices({}, {});
    const deleted: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const member = await createMember(t, `acc-gone-${index}`);
      await elevate(t, member);
      await t.services.events.requestDeletion(member.as("adult"));
      deleted.push(await keys.account(member.accountId));
      t.clock.advance(1000);
    }
    t.clock.advance(14 * DAY_MS + 1);
    await t.services.scheduler.tick();
    await settle(t);
    // Each account has three profile records; the listing is the accounts.
    // (Erased in one run: the same request time, so ordered by key.)
    const ordered = [...deleted].sort();
    expect(await t.services.events.staff.pendingErasures(2)).toEqual(ordered.slice(0, 2));
    expect(await t.services.events.staff.pendingErasures(100)).toEqual(ordered);
    await t.services.events.staff.confirmErasures(deleted);
    expect(await t.services.events.staff.pendingErasures(100)).toEqual([]);
  });
});

describe("forgetting a profile that became restricted", () => {
  it("lists that profile's key alone, once, never the account or its other profiles", async () => {
    const t = await eventServices({}, {});
    const member = await createMember(t);
    const forget = () =>
      t.services.seams.forgetProfileBehaviour({
        accountId: member.accountId,
        profileId: member.profiles.teen.id,
      });
    await forget();
    await forget();
    const teenKey = await keys.profile(member.profiles.teen.id);
    expect(await t.services.events.staff.pendingErasures(100)).toEqual([teenKey]);
    // The pipeline's erase job removes its history and confirms the key.
    await t.services.events.staff.confirmErasures([teenKey]);
    expect(await t.services.events.staff.pendingErasures(100)).toEqual([]);
    // Restricted again later (new history in between): listed again.
    t.clock.advance(DAY_MS);
    await forget();
    expect(await t.services.events.staff.pendingErasures(100)).toEqual([teenKey]);
    // The account and its other profiles go on as before.
    expect(await t.deps.repos.accounts.get(member.accountId)).not.toBeNull();
    await t.services.events.ingest({
      auth: member.as("adult"),
      events: [clientEvent("impression")],
      gpc: false,
      country: null,
    });
    await settle(t);
    expect(lakeEvents(t.sink).filter((event) => event.type === "impression")).toHaveLength(1);
  });
});
