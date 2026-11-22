/**
 * A data export in batch mode, end to end, with the pipeline's real `export-events` job: the
 * Node dev composition writes the lake to a filesystem blob store and assembles the export
 * without its events; the job reads that same store (services/recs/.venv) and writes the
 * member's events under `privacy/export-events/`; the product folds its results in. Skipped,
 * with that reason, where services/recs/.venv does not exist (`make recs-setup`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ClientEventInput, createRouteClient, routes } from "@webflix/contracts";
import { makeClientEventInput } from "@webflix/contracts/fixtures";
import type { MemoryJobQueue } from "@webflix/core/memory";
import { FIXTURE_CATALOG, FIXTURE_DEMO_ACCOUNT, FIXTURE_MANIFEST } from "@webflix/core/testing";
import { migrateToLatest } from "@webflix/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadApiConfig } from "../src/config.ts";
import { createHttpApp, createRuntime, type Runtime } from "../src/runtime.ts";
import { createCookieJar } from "./cookie-jar.ts";

const REPO = resolve(import.meta.dirname, "..", "..", "..");
const RECS = join(REPO, "services", "recs");
const JOB = join(RECS, ".venv", "bin", "webflix-recs");
const work = mkdtempSync(join(tmpdir(), "webflix-export-batch-"));
const blobDir = join(work, "store");
let runtime: Runtime;
let queue: MemoryJobQueue;

beforeAll(async () => {
  runtime = createRuntime(
    loadApiConfig({
      WEBFLIX_DATABASE_URL: "sqlite::memory:",
      WEBFLIX_BLOB_STORE: "fs",
      WEBFLIX_BLOB_DIR: blobDir,
      WEBFLIX_MEDIA_DIR: "none",
      WEBFLIX_EVENT_SINK: "lake",
      WEBFLIX_CONSENT_MODE: "opt-out",
      WEBFLIX_EXPORT_EVENTS: "batch",
      WEBFLIX_PAYMENT_PROVIDER: "memory",
      WEBFLIX_LOG_LEVEL: "error",
    }),
    "api",
  );
  await migrateToLatest(runtime.infra.database);
  await runtime.services.seeder.seed({
    catalog: FIXTURE_CATALOG,
    demoAccount: FIXTURE_DEMO_ACCOUNT,
    manifest: FIXTURE_MANIFEST,
  });
  queue = runtime.infra.jobs.queue as MemoryJobQueue;
  queue.setProcessor(runtime.services.processor);
});

afterAll(async () => {
  await runtime?.close();
  rmSync(work, { recursive: true, force: true });
});

function browser() {
  const app = createHttpApp(runtime);
  const jar = createCookieJar();
  const fetchVia = async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Cookie", jar.header());
    const response = await app.request(url, { ...init, headers });
    jar.store(response);
    return response;
  };
  return { api: createRouteClient(routes, { fetch: fetchVia }), fetch: fetchVia };
}

let sequence = 0;
function clientEvent(deviceId: string): ClientEventInput {
  sequence += 1;
  return makeClientEventInput("title.open", {
    eventId: `0193a1d2-7c4e-7a10-8f00-${sequence.toString(16).padStart(12, "0")}`,
    deviceId,
    sessionSeq: sequence,
    payload: { titleId: "t-orbit" },
  });
}

async function memberWithEvents(email: string, deviceId: string) {
  const member = browser();
  const password = "correct horse battery";
  await member.api.signup({ body: { email, password } });
  const { groups } = await member.api.listAvatars();
  const avatarId = groups[0]?.avatars[0]?.id ?? "";
  const profile = await member.api.createProfile({ body: { name: "Holder", avatarId } });
  await member.api.selectProfile({ body: { profileId: profile.id } });
  const events = [clientEvent(deviceId), clientEvent(deviceId), clientEvent(deviceId)];
  expect(await member.api.ingestEvents({ body: { events } })).toEqual({ accepted: 3, dropped: 0 });
  return { ...member, password, events };
}

describe.skipIf(!existsSync(JOB))("a batch-mode export with the real export-events job", () => {
  it("is assembled, extracted by the job from the same store, folded in and downloadable", async () => {
    const member = await memberWithEvents("batch-export@example.com", "dev-batch-1");
    // Another member's events in the same hours must not reach this export.
    await memberWithEvents("batch-other@example.com", "dev-batch-2");
    await queue.drain();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await member.api.elevate({ body: { password: member.password } });
    const started = await member.api.requestDataExport();
    await queue.drain();
    expect((await member.api.listPrivacyRequests()).items[0]).toMatchObject({
      id: started.id,
      status: "processing",
    });

    const pending = await runtime.services.events.staff.pendingExports(10);
    expect(pending.requests.map((request) => request.requestId)).toEqual([started.id]);
    writeFileSync(join(work, "requests.json"), JSON.stringify(pending));
    const summary = execFileSync(
      JOB,
      [
        "--store",
        blobDir,
        "export-events",
        "--requests",
        join(work, "requests.json"),
        "--results",
        join(work, "results.json"),
        "--grace-minutes",
        "0",
      ],
      { cwd: RECS, env: { PATH: process.env.PATH ?? "" }, encoding: "utf8", timeout: 120_000 },
    );
    expect(summary).toContain('"command": "export-events"');
    const results = JSON.parse(readFileSync(join(work, "results.json"), "utf8"));
    expect(results.results).toMatchObject([{ requestId: started.id, status: "complete" }]);

    const outcome = await runtime.services.events.staff.recordExportResults(results);
    expect(outcome).toEqual({ completed: [started.id], erased: [], kept: [], ignored: [] });
    const done = (await member.api.listPrivacyRequests()).items[0];
    expect(done?.status).toBe("completed");
    const document = (await (await member.fetch(done?.downloadUrl ?? "")).json()) as {
      events: { eventId: string }[];
    };
    const ids = document.events.map((event) => event.eventId);
    for (const event of member.events) expect(ids).toContain(event.eventId);
    expect(ids).toHaveLength(member.events.length + 1); // and the sign-up, nothing of the other
    // What the job wrote was deleted once folded in; the export itself remains.
    const { items } = await runtime.infra.blobs.list({ prefix: "privacy/" });
    expect(items.map((item) => item.key)).toEqual([`privacy/exports/${started.id}.json.gz`]);
    expect(await runtime.services.events.staff.pendingExports(10)).toEqual({ requests: [] });
  });
});
