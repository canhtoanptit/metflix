/**
 * The pipeline's privacy jobs against the local Worker (docs/CLOUDFLARE.md §10.4): what a
 * scheduler runs on a real account, with the round trip a local mode needs because the
 * pipeline cannot read miniflare's R2.
 *
 *   export-events  pending exports from `GET /system/privacy/exports` → the lake into the
 *                  pipeline store → `webflix-recs export-events` → its outputs into R2
 *                  (`privacy/export-events/…`) → `POST /system/privacy/exports/results`
 *   erase          pending keys from `GET /system/privacy/erasures` → everything the job
 *                  rewrites into the store → `webflix-recs erase` → rewritten and removed objects
 *                  back into R2 → `POST /system/privacy/erasures/confirm` (only after they are)
 *   compact        the lake into the store → `webflix-recs compact` → Parquet files and
 *                  manifests into R2
 *   retain         the lake, its quarantine, `recs/` and `experiments/results/` into the store
 *                  → `webflix-recs retain` with the Worker's own retention periods → what it
 *                  deleted, deleted from R2 (daily in the loop; lib/lake-jobs.ts)
 *
 * The staff API is called with a `webflix-jobs` token (client credentials at the development
 * issuer's staff realm, as a Keycloak service account would be). R2 is reached through the
 * running dev server's Local Explorer API (explorer-store.ts), so the Worker keeps serving.
 *
 * Who owns what: R2 owns what the product writes or reads (`events/`, `events-quarantine/`,
 * `privacy/export-events/`, `recs/`): pulled as an exact mirror (or, for `recs/`, merged into
 * the store's own runs) and pushed back as a diff against what was pulled, uploads first (a
 * manifest after its data) and deletions last, which is the readers' consistency rule. The
 * store owns the pipeline's working data (`recs-work/`, the erasure plan included), as R2 owns
 * it on a real account. A key the Worker wrote after the pull is never touched.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlobStore } from "@webflix/core";
import { createExplorerBlobStore } from "./explorer-store.ts";
import { type RetentionPeriods, retentionEnvironment } from "./lake-jobs.ts";
import { REPO_ROOT } from "./platform.ts";

/** The development issuer's service client for jobs (`WEBFLIX_DEV_CLIENTS.staffJobs`). */
export const JOBS_CLIENT = { id: "webflix-jobs", secret: "dev-only-jobs-client-secret" };
export const DEFAULT_RECS_BIN = join(REPO_ROOT, "services", "recs", ".venv", "bin", "webflix-recs");

export type SyncMode = "mirror" | "overlay";
export interface SyncSpec {
  prefix: string;
  mode: SyncMode;
}

const EXPORT_SYNC: SyncSpec[] = [
  { prefix: "events/", mode: "mirror" },
  { prefix: "privacy/export-events/", mode: "mirror" },
];
const ERASE_SYNC: SyncSpec[] = [
  { prefix: "events/", mode: "mirror" },
  { prefix: "events-quarantine/", mode: "mirror" },
  { prefix: "privacy/export-events/", mode: "mirror" },
  { prefix: "recs/", mode: "overlay" },
];
const COMPACT_SYNC: SyncSpec[] = [
  { prefix: "events/", mode: "mirror" },
  { prefix: "events-quarantine/", mode: "mirror" },
];
/** Everything R2 holds that `retain` expires (the store owns `recs-work/`, as R2 does in production). */
const RETAIN_SYNC: SyncSpec[] = [
  { prefix: "events/", mode: "mirror" },
  { prefix: "events-quarantine/", mode: "mirror" },
  { prefix: "recs/", mode: "overlay" },
  { prefix: "experiments/results/", mode: "overlay" },
];
/** How often the loop runs `retain` (it deletes by day; the chart runs it daily too). */
export const RETAIN_EVERY_MS = 24 * 60 * 60 * 1000;

export interface PipelineContext {
  /** The dev server, e.g. `http://localhost:8787`. */
  origin: string;
  bucket: string;
  storeDir: string;
  recsBin: string;
  log: (message: string) => void;
  /** Overrides for tests. */
  r2?: BlobStore;
  fetch?: typeof fetch;
}

// --- The staff API, as a job ------------------------------------------------------------------

async function jobsToken(context: PipelineContext): Promise<string> {
  const doFetch = context.fetch ?? fetch;
  const response = await doFetch(`${context.origin}/dev-idp/staff/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${JOBS_CLIENT.id}:${JOBS_CLIENT.secret}`)}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  const body = (await response.json().catch(() => null)) as { access_token?: string } | null;
  if (!response.ok || !body?.access_token) {
    throw new Error(
      `no webflix-jobs token from ${context.origin}/dev-idp/staff/token (${response.status}): is the dev server up?`,
    );
  }
  return body.access_token;
}

async function staff<T>(
  context: PipelineContext,
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const doFetch = context.fetch ?? fetch;
  const response = await doFetch(`${context.origin}/api/admin/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(method === "POST"
        ? { "X-Webflix-Client": "web", "Content-Type": "application/json" }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${method} /api/admin/v1${path}: ${response.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

// --- Moving objects between R2 and the pipeline store -----------------------------------------

/** What was copied, per key: R2's etag and the store's, at the last pull or push. */
type SyncRecord = Record<string, { r2: string; local: string }>;

async function listAll(store: BlobStore, prefix: string) {
  const items = new Map<string, { size: number; etag: string }>();
  let cursor: string | null = null;
  do {
    const page = await store.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const item of page.items) items.set(item.key, { size: item.size, etag: item.etag });
    cursor = page.cursor;
  } while (cursor);
  return items;
}

async function readAll(
  store: BlobStore,
  key: string,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string } | null> {
  const object = await store.get(key);
  if (!object) return null;
  return {
    bytes: new Uint8Array(await new Response(object.body).arrayBuffer()),
    contentType: object.contentType,
  };
}

/** Manifests last: a reader that sees one finds its data complete. */
function manifestsLast(keys: string[]): string[] {
  const manifest = (key: string) =>
    /(^|\/)(_compaction|manifest)\.json$/.test(key) || key === "recs/current.json";
  return [...keys.filter((key) => !manifest(key)).sort(), ...keys.filter(manifest).sort()];
}

/**
 * R2 and the pipeline store, for one round trip: `pull` brings the store to R2's state for the
 * given prefixes (exactly, or merged for `overlay`), `push` sends the store's changes since the
 * pull. Exported for tests.
 */
export class Mirror {
  readonly r2: BlobStore;
  readonly store: BlobStore;
  private readonly recordPath: string;
  private record: SyncRecord = {};
  /** The store's etags right after the pull, per synced prefix. */
  private snapshot = new Map<string, string>();
  /** Keys R2 held at the pull. */
  private inR2 = new Set<string>();

  constructor(r2: BlobStore, store: BlobStore, recordDir: string) {
    this.r2 = r2;
    this.store = store;
    this.recordPath = join(recordDir, "cf-sync.json");
  }

  async load(): Promise<void> {
    this.record = JSON.parse(
      await readFile(this.recordPath, "utf8").catch(() => "{}"),
    ) as SyncRecord;
  }

  private async save(): Promise<void> {
    await writeFile(this.recordPath, `${JSON.stringify(this.record)}\n`);
  }

  async pull(specs: readonly SyncSpec[]) {
    const report = { downloaded: 0, removed: 0, unchanged: 0, bytes: 0 };
    for (const { prefix, mode } of specs) {
      const remote = await listAll(this.r2, prefix);
      const local = await listAll(this.store, prefix);
      for (const [key, item] of remote) {
        this.inR2.add(key);
        const known = this.record[key];
        if (known && known.r2 === item.etag && local.get(key)?.etag === known.local) {
          report.unchanged += 1;
          continue;
        }
        const object = await readAll(this.r2, key);
        if (!object) continue; // deleted since the listing
        const written = await this.store.put(key, object.bytes, {
          contentType: object.contentType,
        });
        this.record[key] = { r2: item.etag, local: written.etag };
        report.downloaded += 1;
        report.bytes += object.bytes.byteLength;
      }
      if (mode === "mirror") {
        const gone = [...local.keys()].filter((key) => !remote.has(key));
        if (gone.length > 0) await this.store.delete(gone);
        for (const key of gone) delete this.record[key];
        report.removed += gone.length;
      }
      for (const [key, item] of await listAll(this.store, prefix))
        this.snapshot.set(key, item.etag);
    }
    await this.save();
    return report;
  }

  /** The store's changes since the pull, into R2: uploads (manifests last), then deletions. */
  async push(specs: readonly SyncSpec[]) {
    const report = { uploaded: 0, deleted: 0, bytes: 0 };
    const uploads: string[] = [];
    const deletions: string[] = [];
    for (const { prefix, mode } of specs) {
      const after = await listAll(this.store, prefix);
      for (const [key, item] of after) {
        if (this.snapshot.get(key) === item.etag) continue;
        // Overlay (`recs/`): only what R2 serves is rewritten there; the store's own unpushed
        // runs stay the store's until `make cf-recs-push`.
        if (mode === "overlay" && !this.inR2.has(key)) continue;
        uploads.push(key);
      }
      // Deleted by the job from what R2 held at the pull: deleted from R2 too, in either mode
      // (an overlay's own unpushed runs were never in R2, so they are never deleted there).
      for (const key of this.snapshot.keys()) {
        if (key.startsWith(prefix) && !after.has(key) && this.inR2.has(key)) deletions.push(key);
      }
    }
    for (const key of manifestsLast(uploads)) {
      const object = await readAll(this.store, key);
      if (!object) continue;
      const written = await this.r2.put(key, object.bytes, { contentType: object.contentType });
      const local = (await this.store.head(key))?.etag ?? "";
      this.record[key] = { r2: written.etag, local };
      report.uploaded += 1;
      report.bytes += object.bytes.byteLength;
    }
    if (deletions.length > 0) {
      await this.r2.delete(deletions);
      for (const key of deletions) delete this.record[key];
      report.deleted = deletions.length;
    }
    await this.save();
    return report;
  }
}

// --- Running the pipeline ---------------------------------------------------------------------

interface JobRun {
  code: number;
  summary: Record<string, unknown> | null;
  stderr: string;
  seconds: number;
}

async function runPipeline(
  context: PipelineContext,
  args: string[],
  env: Readonly<Record<string, string>> = {},
): Promise<JobRun> {
  if (!existsSync(context.recsBin)) {
    throw new Error(
      `${context.recsBin} is missing: run \`make recs-setup\` (the pipeline's Python environment)`,
    );
  }
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(context.recsBin, ["--store", context.storeDir, "--workers", "2", ...args], {
      env: { ...process.env, WEBFLIX_RECS_THREADS: "2", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      // One JSON summary on stdout (indented over several lines).
      let summary: Record<string, unknown> | null = null;
      try {
        summary = JSON.parse(stdout.trim()) as Record<string, unknown>;
      } catch {
        summary = null;
      }
      resolve({ code: code ?? 1, summary, stderr, seconds: (Date.now() - started) / 1000 });
    });
  });
}

function jobFailure(name: string, run: JobRun): Error {
  return new Error(
    `webflix-recs ${name} exited ${run.code}: ${run.stderr.trim().split("\n").slice(-5).join(" | ")}`,
  );
}

/** One round trip at a time per store: a manual target and the dev server's loop never overlap. */
async function withLock<T>(context: PipelineContext, run: () => Promise<T>): Promise<T> {
  await mkdir(context.storeDir, { recursive: true });
  const path = join(context.storeDir, "cf-jobs.lock");
  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeFile(path, String(process.pid), { flag: "wx" });
      break;
    } catch {
      const holder = Number(await readFile(path, "utf8").catch(() => "0"));
      let alive = false;
      try {
        if (holder > 0) {
          process.kill(holder, 0);
          alive = true;
        }
      } catch {
        alive = false;
      }
      if (!alive) {
        await rm(path, { force: true });
        continue;
      }
      if (attempt > 600) throw new Error(`another round trip (PID ${holder}) holds ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  try {
    return await run();
  } finally {
    await rm(path, { force: true });
  }
}

async function workDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "webflix-cf-jobs-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function openStores(context: PipelineContext) {
  const ADAPTERS_NODE: string = "@webflix/adapters-node";
  const module = (await import(ADAPTERS_NODE)) as {
    createFsBlobStore(options: { root: string }): BlobStore;
  };
  const r2 =
    context.r2 ??
    createExplorerBlobStore({
      origin: context.origin,
      bucket: context.bucket,
      ...(context.fetch ? { fetch: context.fetch } : {}),
    });
  const mirror = new Mirror(
    r2,
    module.createFsBlobStore({ root: context.storeDir }),
    context.storeDir,
  );
  await mirror.load();
  return mirror;
}

const seconds = (since: number) => Math.round((Date.now() - since) / 100) / 10;

// --- The round trips --------------------------------------------------------------------------

export interface ExportRoundTrip {
  pending: number;
  statuses?: Record<string, number>;
  outcome?: unknown;
  pull?: Awaited<ReturnType<Mirror["pull"]>>;
  push?: Awaited<ReturnType<Mirror["push"]>>;
  jobSeconds?: number;
  seconds: number;
}

/** Pending data exports: extract their events with the pipeline, fold the results in. */
export async function exportEventsRoundTrip(
  context: PipelineContext,
  options: { graceMinutes: number },
): Promise<ExportRoundTrip> {
  const started = Date.now();
  const token = await jobsToken(context);
  const pending = await staff<{ requests: unknown[] }>(
    context,
    token,
    "GET",
    "/system/privacy/exports?limit=100",
  );
  if (pending.requests.length === 0) return { pending: 0, seconds: seconds(started) };
  return withLock(context, () =>
    workDir(async (dir) => {
      const mirror = await openStores(context);
      const pull = await mirror.pull(EXPORT_SYNC);
      const erasures = await staff<{ subjectKeys: string[] }>(
        context,
        token,
        "GET",
        "/system/privacy/erasures?limit=500",
      );
      await writeFile(join(dir, "requests.json"), JSON.stringify(pending));
      await writeFile(join(dir, "erasures.json"), JSON.stringify(erasures));
      const run = await runPipeline(context, [
        "export-events",
        "--requests",
        join(dir, "requests.json"),
        "--results",
        join(dir, "results.json"),
        "--erasures",
        join(dir, "erasures.json"),
        "--grace-minutes",
        String(options.graceMinutes),
      ]);
      // 8: some requests failed (the results say which; the others are complete).
      if (run.code !== 0 && run.code !== 8) throw jobFailure("export-events", run);
      const push = await mirror.push(EXPORT_SYNC);
      const results = JSON.parse(await readFile(join(dir, "results.json"), "utf8")) as Record<
        string,
        unknown
      >;
      const outcome = await staff(context, token, "POST", "/system/privacy/exports/results", {
        ...results,
        reason: "make cf-export-events: webflix-recs export-events on the local Worker's lake",
      });
      context.log(
        `export-events: ${JSON.stringify(run.summary?.statuses ?? {})} in ${run.seconds} s`,
      );
      return {
        pending: pending.requests.length,
        statuses: (run.summary?.statuses ?? {}) as Record<string, number>,
        outcome,
        pull,
        push,
        jobSeconds: run.seconds,
        seconds: seconds(started),
      };
    }),
  );
}

export interface EraseRoundTrip {
  pending: number;
  confirmed?: number;
  incomplete?: boolean;
  summary?: Record<string, unknown> | null;
  pull?: Awaited<ReturnType<Mirror["pull"]>>;
  push?: Awaited<ReturnType<Mirror["push"]>>;
  jobSeconds?: number;
  seconds: number;
}

/**
 * Pending erasures: the job rewrites every subject-bearing object in the store, the rewritten
 * and removed objects go back into R2, and only then are the keys confirmed. With `force`, it
 * runs even with nothing pending (the plan's watched keys: late arrivals of erased members).
 */
export async function eraseRoundTrip(
  context: PipelineContext,
  options: { force: boolean },
): Promise<EraseRoundTrip> {
  const started = Date.now();
  const token = await jobsToken(context);
  const pending = await staff<{ subjectKeys: string[] }>(
    context,
    token,
    "GET",
    "/system/privacy/erasures?limit=500",
  );
  if (pending.subjectKeys.length === 0 && !options.force)
    return { pending: 0, seconds: seconds(started) };
  return withLock(context, () =>
    workDir(async (dir) => {
      const mirror = await openStores(context);
      const pull = await mirror.pull(ERASE_SYNC);
      await writeFile(join(dir, "keys.json"), JSON.stringify(pending));
      const run = await runPipeline(context, [
        "erase",
        "--keys",
        join(dir, "keys.json"),
        "--confirm",
        join(dir, "confirm.json"),
        "--reason",
        "make cf-erase: webflix-recs erase on the local Worker's R2, written back, verified",
      ]);
      // 5: verification found something left: what was removed still goes back, nothing is confirmed.
      if (run.code !== 0 && run.code !== 5) throw jobFailure("erase", run);
      const push = await mirror.push(ERASE_SYNC);
      let confirmed = 0;
      if (run.code === 0 && existsSync(join(dir, "confirm.json"))) {
        const parsed = JSON.parse(await readFile(join(dir, "confirm.json"), "utf8")) as unknown;
        const bodies = (Array.isArray(parsed) ? parsed : [parsed]) as { subjectKeys: string[] }[];
        for (const body of bodies) {
          await staff(context, token, "POST", "/system/privacy/erasures/confirm", body);
          confirmed += body.subjectKeys.length;
        }
      }
      context.log(
        `erase: ${pending.subjectKeys.length} pending, ${confirmed} confirmed in ${run.seconds} s`,
      );
      return {
        pending: pending.subjectKeys.length,
        confirmed,
        incomplete: run.code === 5,
        summary: run.summary,
        pull,
        push,
        jobSeconds: run.seconds,
        seconds: seconds(started),
      };
    }),
  );
}

/** Compacts closed hours of the local lake and writes the Parquet files and manifests back. */
export async function compactRoundTrip(
  context: PipelineContext,
  options: { graceMinutes: number; now?: string; deleteSources: boolean },
) {
  const started = Date.now();
  return withLock(context, async () => {
    const mirror = await openStores(context);
    const pull = await mirror.pull(COMPACT_SYNC);
    const run = await runPipeline(context, [
      "compact",
      "--grace-minutes",
      String(options.graceMinutes),
      ...(options.now ? ["--now", options.now] : []),
      ...(options.deleteSources ? ["--delete-sources"] : []),
    ]);
    if (run.code !== 0) throw jobFailure("compact", run);
    const push = await mirror.push(COMPACT_SYNC);
    return { summary: run.summary, pull, push, jobSeconds: run.seconds, seconds: seconds(started) };
  });
}

export interface RetainRoundTrip {
  /** 75: another job holds the lake lease; the next round tries again. */
  busy: boolean;
  dryRun: boolean;
  periods: RetentionPeriods;
  summary?: Record<string, unknown> | null;
  pull?: Awaited<ReturnType<Mirror["pull"]>>;
  push?: Awaited<ReturnType<Mirror["push"]>>;
  jobSeconds?: number;
  seconds: number;
}

/** Exit codes of `webflix-recs retain` this tooling names (services/recs README). */
const RETAIN_EXIT: Record<number, string> = {
  2: "a retention setting is not a positive integer",
  10: "the store ignores conditional writes (the lake lease would not hold)",
};

/**
 * Retention: everything older than the Worker's own periods leaves the store, and what the job
 * deleted from what R2 held is deleted from R2 (with `dryRun`, only the plan: nothing deleted
 * anywhere). The periods are passed explicitly, so the job never falls back to its defaults
 * while the Worker runs with other values.
 */
export async function retainRoundTrip(
  context: PipelineContext,
  options: { periods: RetentionPeriods; now?: string; dryRun: boolean },
): Promise<RetainRoundTrip> {
  const started = Date.now();
  return withLock(context, async () => {
    const mirror = await openStores(context);
    const pull = await mirror.pull(RETAIN_SYNC);
    const run = await runPipeline(
      context,
      [
        "retain",
        ...(options.now ? ["--now", options.now] : []),
        ...(options.dryRun ? ["--dry-run"] : []),
      ],
      retentionEnvironment(options.periods),
    );
    const base = { dryRun: options.dryRun, periods: options.periods, pull };
    if (run.code === 75) {
      context.log("retain: the lake lease is held by another job; next round");
      return { ...base, busy: true, seconds: seconds(started) };
    }
    if (run.code !== 0) {
      const reason = RETAIN_EXIT[run.code];
      throw reason
        ? new Error(`webflix-recs retain exited ${run.code}: ${reason}`)
        : jobFailure("retain", run);
    }
    const push = options.dryRun ? undefined : await mirror.push(RETAIN_SYNC);
    // The loop's daily schedule counts real runs only.
    if (!options.dryRun) {
      await writeFile(
        join(context.storeDir, RETAIN_RECORD),
        `${JSON.stringify({ at: new Date().toISOString(), periods: options.periods })}\n`,
      );
    }
    context.log(
      `retain: ${JSON.stringify(run.summary?.removed ?? {})}${options.dryRun ? " (dry run)" : ""} in ${run.seconds} s`,
    );
    return {
      ...base,
      busy: false,
      summary: run.summary,
      ...(push ? { push } : {}),
      jobSeconds: run.seconds,
      seconds: seconds(started),
    };
  });
}

const RETAIN_RECORD = "cf-retain.json";

/** When the last real (not dry) `retain` round finished in this store, if ever. */
async function lastRetain(context: PipelineContext): Promise<number | null> {
  try {
    const record = JSON.parse(await readFile(join(context.storeDir, RETAIN_RECORD), "utf8")) as {
      at?: string;
    };
    if (!record.at) return null;
    const at = Date.parse(record.at);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/**
 * What a scheduler would run now: erasures first (an export of an erased member yields nothing),
 * then exports, then retention once a day.
 */
export async function dueRoundTrips(
  context: PipelineContext,
  options: { graceMinutes: number; periods: RetentionPeriods; now?: number },
) {
  const erase = await eraseRoundTrip(context, { force: false });
  const exports = await exportEventsRoundTrip(context, options);
  const last = await lastRetain(context);
  const now = options.now ?? Date.now();
  const retain =
    last === null || now - last >= RETAIN_EVERY_MS
      ? await retainRoundTrip(context, { periods: options.periods, dryRun: false })
      : null;
  return { erase, exports, retain };
}
