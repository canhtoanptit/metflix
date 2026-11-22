/**
 * The event lake in the Node dev composition, end to end, and the pipeline reading it: events go
 * through the real HTTP app (`POST /events`, playback, consent) into the filesystem blob store
 * (`WEBFLIX_EVENT_SINK=lake`), and services/recs's own reader (`webflix_recs.lake.read_events`)
 * then reads that directory. The Python half runs only where services/recs/.venv exists
 * (`make recs-setup`); it is skipped, with that reason, elsewhere.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFsBlobStore } from "@webflix/adapters-node";
import { type ClientEventInput, createRouteClient, LakeEvent, routes } from "@webflix/contracts";
import { makeClientEventInput } from "@webflix/contracts/fixtures";
import { createBlobLakeEventSink, createUuidV7Generator, decodeLakeObject } from "@webflix/core";
import { MemoryBlobStore, type MemoryJobQueue } from "@webflix/core/memory";
import {
  describeEventSinkContract,
  FIXTURE_CATALOG,
  FIXTURE_DEMO_ACCOUNT,
  FIXTURE_MANIFEST,
  readAll,
} from "@webflix/core/testing";
import { migrateToLatest } from "@webflix/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadApiConfig } from "../src/config.ts";
import { createHttpApp, createRuntime, type Runtime } from "../src/runtime.ts";
import { createCookieJar } from "./cookie-jar.ts";

const REPO = resolve(import.meta.dirname, "..", "..", "..");
const PYTHON = join(REPO, "services", "recs", ".venv", "bin", "python");
const blobDir = mkdtempSync(join(tmpdir(), "webflix-lake-"));
let runtime: Runtime;
let queue: MemoryJobQueue;

beforeAll(async () => {
  const config = loadApiConfig({
    WEBFLIX_DATABASE_URL: "sqlite::memory:",
    WEBFLIX_BLOB_STORE: "fs",
    WEBFLIX_BLOB_DIR: blobDir,
    WEBFLIX_MEDIA_DIR: "none",
    WEBFLIX_EVENT_SINK: "lake",
    WEBFLIX_CONSENT_MODE: "opt-out",
    // Other areas' adapters stay in memory: this test is about the lake.
    WEBFLIX_PAYMENT_PROVIDER: "memory",
    WEBFLIX_LOG_LEVEL: "error",
  });
  runtime = createRuntime(config, "api");
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
  rmSync(blobDir, { recursive: true, force: true });
});

describeEventSinkContract("lake writer over the filesystem blob store (dev mode)", () => {
  const root = mkdtempSync(join(tmpdir(), "webflix-lake-contract-"));
  const blobs = createFsBlobStore({ root });
  return {
    sink: createBlobLakeEventSink({ blobs, ids: createUuidV7Generator() }),
    async readBack() {
      const { items } = await blobs.list({ prefix: "events/" });
      return Promise.all(
        items.map(async (item) => {
          const object = await blobs.get(item.key);
          if (!object) throw new Error(`${item.key} vanished`);
          return { key: item.key, events: await decodeLakeObject(await readAll(object.body)) };
        }),
      );
    },
    cleanup: async () => rmSync(root, { recursive: true, force: true }),
  };
});

let sequence = 0;
function clientEvent(
  type: "impression" | "title.open",
  rowRank: number,
  rank: number,
): ClientEventInput {
  sequence += 1;
  return makeClientEventInput(type, {
    eventId: `0193a1d2-7c4e-7a10-8f00-${sequence.toString(16).padStart(12, "0")}`,
    deviceId: "dev-node-lake",
    sessionSeq: sequence,
    context: {
      surface: "home",
      rowId: "home:trending",
      rowRank,
      rank,
      experiments: {},
      policy: { id: "rules-v1", explore: rank % 10 === 0 },
    },
    payload: type === "impression" ? { titleId: "t-orbit", sampleRate: 1 } : { titleId: "t-orbit" },
  });
}

/** Lake objects on disk, through the blob store (the filesystem layout encodes names). */
async function lakeObjects() {
  const { items } = await runtime.infra.blobs.list({ prefix: "events/" });
  return Promise.all(
    items.map(async (item) => {
      const object = await runtime.infra.blobs.get(item.key);
      if (!object) throw new Error(`${item.key} vanished`);
      return { key: item.key, events: await decodeLakeObject(await readAll(object.body)) };
    }),
  );
}

describe("the event lake in the dev composition", () => {
  it("writes what the HTTP app accepts as gzip NDJSON under events/dt=…/hh=…/ on disk", async () => {
    const app = createHttpApp(runtime);
    const jar = createCookieJar();
    const api = createRouteClient(routes, {
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Cookie", jar.header());
        const response = await app.request(url, { ...init, headers });
        jar.store(response);
        return response;
      },
    });
    await api.login({ body: { email: "demo@webflix.dev", password: "webflix-demo" } });
    await api.selectProfile({ body: { profileId: "pr-demo" } });
    const events: ClientEventInput[] = [];
    for (let rank = 1; rank <= 40; rank += 1) events.push(clientEvent("impression", 2, rank));
    events.push(clientEvent("title.open", 2, 7));
    expect(await api.ingestEvents({ body: { events } })).toEqual({ accepted: 41, dropped: 0 });
    const playback = await api.createPlaybackSession({ body: { titleId: "t-lanterns" } });
    await api.endPlaybackSession({ params: { id: playback.id } });
    await api.updateConsent({ body: { purpose: "analytics", granted: true, source: "settings" } });
    await api.selectProfile({ body: { profileId: "pr-kids" } });
    expect(await api.ingestEvents({ body: { events: [clientEvent("impression", 2, 1)] } })).toEqual(
      {
        accepted: 0,
        dropped: 1,
      },
    );
    // The scheduler's tick drains the event outbox (playback's events), then the queue runs.
    await runtime.services.scheduler.tick();
    await queue.drain();

    const objects = await lakeObjects();
    expect(objects.length).toBeGreaterThanOrEqual(4);
    for (const object of objects) {
      expect(object.key).toMatch(
        /^events\/dt=\d{4}-\d{2}-\d{2}\/hh=\d{2}\/[0-9a-f-]{36}\.ndjson\.gz$/,
      );
      for (const event of object.events) expect(LakeEvent.safeParse(event).success).toBe(true);
    }
    const types = objects.flatMap((object) =>
      (object.events as LakeEvent[]).map((event) => event.type),
    );
    expect(types.filter((type) => type === "impression")).toHaveLength(40);
    expect(types).toEqual(
      expect.arrayContaining([
        "title.open",
        "playback.start",
        "playback.abandon",
        "consent.change",
        "auth.signin",
      ]),
    );
    // The filesystem store's own layout (what LocalStorage in services/recs reads).
    expect(readdirSync(join(blobDir, "data"))).toContain("events");
  });

  it("keeps the pipeline's committed fixture (services/recs/tests/fixtures/ingested) valid", async () => {
    const dir = join(REPO, "services", "recs", "tests", "fixtures", "ingested");
    const files = readdirSync(dir).filter((name) => name.endsWith(".ndjson.gz"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const events = await decodeLakeObject(new Uint8Array(readFileSync(join(dir, file))));
      for (const event of events) expect(LakeEvent.safeParse(event).success, file).toBe(true);
    }
  });

  it.skipIf(!existsSync(PYTHON))(
    "is read by the pipeline's own reader: every line valid, positions intact",
    () => {
      const script = [
        "import json, sys",
        "from webflix_recs.lake import read_events",
        "frames, stats, hours = read_events(sys.argv[1])",
        "rows = [r for f in frames for r in f.iter_rows(named=True)]",
        "imp = [r for r in rows if r['type'] == 'impression']",
        "print(json.dumps({'stats': stats.to_dict(), 'hours': hours, 'rows': len(rows),",
        "  'types': sorted({r['type'] for r in rows}),",
        "  'restricted': sum(1 for r in rows if r['restricted']),",
        "  'ranked': sum(1 for r in imp if r['ctx_row_rank'] == 2 and r['ctx_rank'] is not None and r['ctx_policy'] == 'rules-v1'),",
        "  'explore': sum(1 for r in imp if r['ctx_explore'])}))",
      ].join("\n");
      const output = execFileSync(PYTHON, ["-I", "-c", script, blobDir], {
        cwd: join(REPO, "services", "recs"),
        env: { PATH: process.env.PATH ?? "", PYTHONPATH: join(REPO, "services", "recs", "src") },
        encoding: "utf8",
        timeout: 120_000,
      });
      const result = JSON.parse(output.trim().split("\n").at(-1) ?? "{}");
      expect(result.stats.invalid).toBe(0);
      expect(result.stats.unparseable).toBe(0);
      expect(result.stats.valid).toBe(result.rows);
      expect(result.rows).toBeGreaterThanOrEqual(45);
      expect(result.types).toEqual(
        expect.arrayContaining(["impression", "title.open", "playback.start", "consent.change"]),
      );
      expect(result.restricted).toBe(0);
      expect(result.ranked).toBe(40);
      expect(result.explore).toBe(4);
    },
  );
});

const COMPACTED = join(REPO, "services", "recs", "tests", "fixtures", "compacted");

interface CompactedExpected {
  accounts: Record<string, { eventIds: string[] }>;
  hours: Record<
    string,
    {
      compacted: boolean;
      parquet?: string;
      readRawObjects: string[];
      skipRawObjects: string[];
      rowGroupsAReaderOfThisAccountReads?: Record<string, number[]>;
    }
  >;
}

/** The fixture's store (blob keys as paths) in a memory blob store, with every read recorded. */
async function compactedStore() {
  const blobs = new MemoryBlobStore();
  const root = join(COMPACTED, "store");
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(directory, entry.name))
        : [join(directory, entry.name).slice(root.length + 1)],
    );
  for (const key of walk(root)) {
    await blobs.put(key, new Uint8Array(readFileSync(join(root, key))));
  }
  const reads: { key: string; ranged: boolean }[] = [];
  const get = blobs.get.bind(blobs);
  blobs.get = async (key, options) => {
    reads.push({ key, ranged: options?.range !== undefined });
    return get(key, options);
  };
  return { blobs, reads };
}

describe("the inline export reads compacted hours by the pipeline's contract", () => {
  it("returns each fixture account's events, reading only what the contract allows", async () => {
    const expected = JSON.parse(
      readFileSync(join(COMPACTED, "expected.json"), "utf8"),
    ) as CompactedExpected;
    const covered = Object.values(expected.hours).flatMap((hour) => hour.skipRawObjects);
    const mustRead = Object.values(expected.hours).flatMap((hour) => hour.readRawObjects);
    for (const [account, want] of Object.entries(expected.accounts)) {
      const { blobs, reads } = await compactedStore();
      const sink = createBlobLakeEventSink({ blobs, ids: createUuidV7Generator() });
      const read = await sink.accountEvents({
        accountKey: account,
        fromMs: Date.parse("2026-11-22T00:00:00.000Z"),
        toMs: Date.parse("2026-11-23T00:00:00.000Z"),
      });
      const ids = read.events.map((event) => (event as { eventId: string }).eventId);
      expect(new Set(ids).size, account).toBe(ids.length); // each once
      expect([...ids].sort(), account).toEqual(want.eventIds);
      expect(read.read.objects.sort(), account).toEqual([...mustRead].sort());
      for (const key of covered) {
        expect(
          reads.some((entry) => entry.key === key),
          `${account} read ${key}`,
        ).toBe(false);
      }
      for (const hour of Object.values(expected.hours)) {
        if (!hour.parquet) continue;
        expect(read.read.rowGroups[hour.parquet], account).toEqual(
          hour.rowGroupsAReaderOfThisAccountReads?.[account] ?? [],
        );
        // The Parquet file is read in ranges (footer, column chunks), never whole.
        const parquetReads = reads.filter((entry) => entry.key === hour.parquet);
        expect(parquetReads.length).toBeGreaterThan(0);
        expect(parquetReads.every((entry) => entry.ranged)).toBe(true);
      }
      // In receipt order.
      const received = read.events.map((event) => (event as { receivedAt: string }).receivedAt);
      expect(received).toEqual([...received].sort());
    }
  });
});
