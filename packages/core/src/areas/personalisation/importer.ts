import { type FileMetaData, parquetMetadata, parquetRead } from "hyparquet/src/index.js";
import { sha256Hex } from "../../encoding.ts";
import type { BlobStore } from "../../ports/blob-store.ts";
import type { Clock } from "../../ports/clock.ts";
import { type Logger, serializeError } from "../../ports/logger.ts";
import {
  decodeProfileLists,
  type ImportCapacity,
  MAX_NEIGHBOURS_PER_TITLE,
  MAX_PROFILE_ERASURE,
  type Neighbour,
  type ProfileLists,
  type RecommendationStore,
  rollbackTarget,
} from "../../ports/recommendation-store.ts";

/**
 * The recommendation importer (milestone 2 §7.2): reads the pipeline's published artefacts from
 * the blob store and publishes them into the `RecommendationStore`, following the importer
 * contract of services/recs/README.md ("Artefacts"):
 *
 * 1. `recs/current.json` names the run and the SHA-256 of its manifest;
 * 2. the manifest must match that digest and be format `webflix.recs`, major version 1;
 * 3. every file must match the manifest's byte count and SHA-256, checked as it is read;
 * 4. the run is begun, filled one bounded batch at a time (neighbours, then each profile shard
 *    one row group at a time, so memory stays bounded), then activated in one write.
 *
 * Any failure marks the run `failed` and removes what was written of it; the served run is
 * never touched, so members keep the previous model (or the rule engine). After an activation
 * the importer keeps the newest `keep` runs (rollback needs the previous one) and deletes the
 * rest. Portable: Node (the command-line entry and the job) and the Workers runtime.
 */

export const RECS_PREFIX = "recs/";
export const RECS_POINTER_KEY = `${RECS_PREFIX}current.json`;
const POINTER_FORMAT = "webflix.recs-pointer";
const MANIFEST_FORMAT = "webflix.recs";
const SUPPORTED_MAJOR = 1;
const RUN_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{8}$/;
/** Neighbour rows per store write (50 INSERTs of 16 rows on SQL). */
const NEIGHBOUR_BATCH = 800;
/** Profiles per store write (20 INSERTs of 25 rows on SQL; 500 KV keys). */
const PROFILE_BATCH = 500;
/** Runs kept after an activation, the active one included. */
export const DEFAULT_KEPT_RUNS = 2;

export class RecommendationImportError extends Error {
  override readonly name: string = "RecommendationImportError";
}

/** The run has more lists than the store can take in one import (`importCapacity`). */
export class RecommendationImportTooLargeError extends RecommendationImportError {
  override readonly name = "RecommendationImportTooLargeError";
  readonly profileLists: number;
  readonly maxProfileLists: number;

  constructor(message: string, profileLists: number, maxProfileLists: number) {
    super(message);
    this.profileLists = profileLists;
    this.maxProfileLists = maxProfileLists;
  }
}

/** What a published (or named) version holds, read from its pointer and manifest only. */
export interface RecommendationVersionSummary {
  run: string;
  /** The manifest's SHA-256: what the version holds (a rewrite of the same run changes it). */
  manifestSha256: string;
  /** Rows of its profile shards (an upper bound on the lists an import writes). */
  profileLists: number;
  neighbourRows: number;
}

/** The version the importer would import, verified like an import, without importing it. */
export async function inspectRecommendations(
  blobs: BlobStore,
  run?: string,
): Promise<RecommendationVersionSummary> {
  const { manifest, manifestSha256 } = await locateVersion(blobs, run);
  return {
    run: manifest.run,
    manifestSha256,
    profileLists: rowsOf(manifest, "profiles"),
    neighbourRows: rowsOf(manifest, "neighbours"),
  };
}

/** The refusal of a run larger than `capacity`, or null when it fits. */
export function importCapacityProblem(
  run: string,
  profileLists: number,
  capacity: ImportCapacity | undefined,
): string | null {
  if (!capacity || profileLists <= capacity.maxProfileLists) return null;
  return `Run ${run} has ${profileLists} profile lists; an import here writes at most ${capacity.maxProfileLists}: ${capacity.explanation}`;
}

function rowsOf(manifest: Manifest, table: string): number {
  return manifest.files
    .filter((file) => file.table === table)
    .reduce((sum, file) => sum + file.rows, 0);
}

export interface RecommendationImportOptions {
  blobs: BlobStore;
  store: RecommendationStore;
  clock: Clock;
  logger: Logger;
  /**
   * Import this run's version (`recs/v={run}/manifest.json`) instead of the published pointer's:
   * for a version that was scored but not published (the smoke preset's runs), or to re-import
   * an older one. Without the pointer there is no published digest: the manifest's own is
   * recorded.
   */
  run?: string;
  /** Runs kept after the activation, the active one included (default 2). */
  keep?: number;
  /**
   * The profile keys this run must not store lists for (privacy review M3): erasures still
   * unsettled for data known at the run's `asOf`, profiles whose account withdrew consent to
   * personalisation. Read once per import, before any list is written; a failure fails the
   * import (nothing is stored without the check).
   */
  withheld?: (asOf: number) => Promise<ReadonlySet<string>>;
}

export interface RecommendationImportResult {
  /**
   * `unchanged`: the published version is the one served (same run, same manifest digest).
   * `rewritten`: the served run was published again with other content (the pipeline's erasure
   * removed rows from it): applied in place, what it no longer holds dropped.
   */
  status: "imported" | "unchanged" | "rewritten";
  run: string;
  /** The run served before (null: none, or unchanged). */
  previous: string | null;
  neighbourRows: number;
  profiles: number;
  /** Lists already expired when imported (never served, so not written). */
  expiredProfiles: number;
  /** Lists of withheld keys (erased, being erased, withdrawn): never written. */
  withheldProfiles: number;
  /** `rewritten`: stored lists the new version no longer holds (or withholds), dropped. */
  removedProfiles: number;
  /** Runs deleted after the activation. */
  deleted: string[];
  durationMs: number;
  /**
   * Set by the personalisation service after a change (not `unchanged`): whether the shared
   * caches were told (retried a few times). False: every process still serves the change within
   * `MODEL_MAX_AGE_MS` (30 s), and the command-line importer exits 3 to say so.
   */
  cacheInvalidated?: boolean;
}

interface ManifestFile {
  path: string;
  table: string;
  rows: number;
  bytes: number;
  sha256: string;
}

interface Manifest {
  run: string;
  asOf: number;
  expiresAt: number;
  files: ManifestFile[];
}

/** Imports the published (or the given) run. Throws `RecommendationImportError` on bad input. */
export async function importRecommendations(
  options: RecommendationImportOptions,
): Promise<RecommendationImportResult> {
  const { blobs, store, clock, logger } = options;
  const started = clock.now();
  const located = await locateVersion(blobs, options.run);
  const active = await store.activeModel();
  if (active?.run === located.manifest.run) {
    // Decided by content, not by name: a version rewritten under the same run is applied.
    if (active.manifestSha256 !== located.manifestSha256) {
      return applyRewrite(options, located, started);
    }
    logger.info("recs.import_unchanged", { run: active.run });
    return {
      status: "unchanged",
      run: active.run,
      previous: null,
      neighbourRows: 0,
      profiles: 0,
      expiredProfiles: 0,
      withheldProfiles: 0,
      removedProfiles: 0,
      deleted: [],
      durationMs: clock.now() - started,
    };
  }
  const { manifest } = located;
  const run = manifest.run;
  const model = {
    run,
    asOf: manifest.asOf,
    expiresAt: manifest.expiresAt,
    importedAt: started,
    manifestSha256: located.manifestSha256,
  };
  // Refused before anything is written, and recorded on the run so the operator sees why.
  const tooLarge = importCapacityProblem(run, rowsOf(manifest, "profiles"), store.importCapacity);
  if (tooLarge) {
    await store.beginImport(model);
    await store.failImport(run, tooLarge);
    logger.warn("recs.import_refused", { run, reason: tooLarge });
    throw new RecommendationImportTooLargeError(
      tooLarge,
      rowsOf(manifest, "profiles"),
      store.importCapacity?.maxProfileLists ?? 0,
    );
  }
  await store.beginImport({
    run,
    asOf: manifest.asOf,
    expiresAt: manifest.expiresAt,
    importedAt: started,
    manifestSha256: located.manifestSha256,
  });
  logger.info("recs.import_started", { run, files: manifest.files.length });
  let neighbourRows = 0;
  let profiles = 0;
  let expiredProfiles = 0;
  let withheldProfiles = 0;
  try {
    const withheld = options.withheld ? await options.withheld(manifest.asOf) : new Set<string>();
    for (const file of manifest.files.filter((entry) => entry.table === "neighbours")) {
      const rows = await readNeighbours(await readVerified(blobs, run, file), file);
      for (let index = 0; index < rows.length; index += NEIGHBOUR_BATCH) {
        await store.putNeighbours(run, rows.slice(index, index + NEIGHBOUR_BATCH));
      }
      neighbourRows += rows.length;
    }
    const now = clock.now();
    for (const file of manifest.files.filter((entry) => entry.table === "profiles")) {
      const bytes = await readVerified(blobs, run, file);
      const counted = await importProfiles(bytes, file, run, now, withheld, async (lists) => {
        for (let index = 0; index < lists.length; index += PROFILE_BATCH) {
          await store.putProfileLists(run, lists.slice(index, index + PROFILE_BATCH));
        }
      });
      profiles += counted.written;
      expiredProfiles += counted.expired;
      withheldProfiles += counted.withheld;
    }
    await store.activate(run, clock.now());
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error("recs.import_failed", { run, error: serializeError(error) });
    await store.failImport(run, reason).catch(() => undefined);
    throw error instanceof RecommendationImportError
      ? error
      : new RecommendationImportError(`Import of ${run} failed: ${reason}`, { cause: error });
  }
  const deleted = await pruneRuns(store, options.keep ?? DEFAULT_KEPT_RUNS, logger);
  const result: RecommendationImportResult = {
    status: "imported",
    run,
    previous: active?.run ?? null,
    neighbourRows,
    profiles,
    expiredProfiles,
    withheldProfiles,
    removedProfiles: 0,
    deleted,
    durationMs: clock.now() - started,
  };
  logger.info("recs.import_activated", { ...result, deleted: deleted.join(",") });
  return result;
}

/** What applying a rewrite will do, counted before anything is written. */
interface RewritePlan {
  withheld: ReadonlySet<string>;
  /** Lists the version holds that will be written (fresh, not withheld). */
  written: number;
  expired: number;
  withheldCount: number;
  /** Stored keys of the run the version no longer holds (or withholds). */
  removed: string[];
  /** Runs registered now: a removed key is deleted from each. */
  runs: number;
  /** Pages of stored keys read to find `removed`. */
  listPages: number;
  /**
   * Store operations the rewrite makes: one per list written, one per removed key and run, one
   * per page of stored keys (on Workers KV through the binding, each comes out of the
   * invocation's 1,000).
   */
  operations: number;
}

async function planRewrite(
  options: RecommendationImportOptions,
  manifest: Manifest,
  now: number,
): Promise<RewritePlan> {
  const { blobs, store } = options;
  const run = manifest.run;
  const withheld = options.withheld ? await options.withheld(manifest.asOf) : new Set<string>();
  const held = new Set<string>();
  let expired = 0;
  let withheldCount = 0;
  for (const file of manifest.files.filter((entry) => entry.table === "profiles")) {
    const bytes = await readVerified(blobs, run, file);
    const counted = await importProfiles(bytes, file, run, now, withheld, async (lists) => {
      for (const list of lists) held.add(list.profileKey);
    });
    expired += counted.expired;
    withheldCount += counted.withheld;
  }
  for (const file of manifest.files.filter((entry) => entry.table === "neighbours")) {
    await readNeighbours(await readVerified(blobs, run, file), file);
  }
  const removed: string[] = [];
  let listPages = 0;
  let cursor: string | null = null;
  do {
    const page: { keys: string[]; cursor: string | null } = await store.profileKeys(run, cursor);
    listPages += 1;
    for (const key of page.keys) if (!held.has(key)) removed.push(key);
    cursor = page.cursor;
  } while (cursor !== null);
  const runs = (await store.models()).length;
  return {
    withheld,
    written: held.size,
    expired,
    withheldCount,
    removed,
    runs,
    listPages,
    operations: held.size + removed.length * runs + listPages,
  };
}

/** The refusal of a rewrite larger than `capacity` (every operation counted), or null. */
function rewriteCapacityProblem(
  run: string,
  plan: RewritePlan,
  capacity: ImportCapacity | undefined,
): string | null {
  if (!capacity || plan.operations <= capacity.maxProfileLists) return null;
  return `Rewriting run ${run} takes ${plan.operations} store operations (${plan.written} lists written, ${plan.removed.length} removed from ${plan.runs} runs, ${plan.listPages} pages of keys read); an import here makes at most ${capacity.maxProfileLists}: ${capacity.explanation}`;
}

/**
 * The refusal an import of the published (or named) version would end in for its size, said
 * before queuing it (the staff route): a new run's lists, or everything a rewrite of the served
 * run would do. Null when it fits, or when the store has no limit.
 */
export async function importSizeProblem(
  options: RecommendationImportOptions,
): Promise<string | null> {
  const capacity = options.store.importCapacity;
  if (!capacity) return null;
  const located = await locateVersion(options.blobs, options.run);
  const active = await options.store.activeModel();
  const { manifest } = located;
  if (active?.run !== manifest.run) {
    return importCapacityProblem(manifest.run, rowsOf(manifest, "profiles"), capacity);
  }
  if (active.manifestSha256 === located.manifestSha256) return null;
  const plan = await planRewrite(options, manifest, options.clock.now());
  return rewriteCapacityProblem(manifest.run, plan, capacity);
}

/**
 * The served run published again with other content (services/recs `erase` removes an erased
 * subject's rows from published versions and re-points `recs/current.json` at the rewritten
 * manifest). The active run cannot be re-imported beside itself, so the rewrite is applied in
 * place, every file verified first as in an import: its neighbours and lists written over the
 * stored ones (each key is replaced at once, so readers see the old or the new list), then
 * every stored list the version no longer holds (or withholds) dropped, then its digest
 * recorded. Everything it will do is counted first (`planRewrite`): a rewrite larger than the
 * store takes in one invocation is refused before anything is written, never part-way.
 * Idempotent: an interrupted rewrite is finished by the next import.
 */
async function applyRewrite(
  options: RecommendationImportOptions,
  located: { manifest: Manifest; manifestSha256: string },
  started: number,
): Promise<RecommendationImportResult> {
  const { blobs, store, clock, logger } = options;
  const { manifest } = located;
  const run = manifest.run;
  const now = clock.now();
  let plan: RewritePlan;
  try {
    plan = await planRewrite(options, manifest, now);
  } catch (error) {
    logger.error("recs.rewrite_failed", { run, error: serializeError(error) });
    throw error instanceof RecommendationImportError
      ? error
      : new RecommendationImportError(`Rewrite of ${run} failed: ${String(error)}`, {
          cause: error,
        });
  }
  const tooLarge = rewriteCapacityProblem(run, plan, store.importCapacity);
  if (tooLarge) {
    logger.warn("recs.rewrite_refused", { run, reason: tooLarge });
    throw new RecommendationImportTooLargeError(
      tooLarge,
      plan.operations,
      store.importCapacity?.maxProfileLists ?? 0,
    );
  }
  logger.info("recs.rewrite_started", { run, files: manifest.files.length });
  try {
    let neighbourRows = 0;
    for (const file of manifest.files.filter((entry) => entry.table === "neighbours")) {
      const rows = await readNeighbours(await readVerified(blobs, run, file), file);
      for (let index = 0; index < rows.length; index += NEIGHBOUR_BATCH) {
        await store.putNeighbours(run, rows.slice(index, index + NEIGHBOUR_BATCH));
      }
      neighbourRows += rows.length;
    }
    let profiles = 0;
    for (const file of manifest.files.filter((entry) => entry.table === "profiles")) {
      const bytes = await readVerified(blobs, run, file);
      const counted = await importProfiles(bytes, file, run, now, plan.withheld, async (lists) => {
        for (let index = 0; index < lists.length; index += PROFILE_BATCH) {
          await store.putProfileLists(run, lists.slice(index, index + PROFILE_BATCH));
        }
      });
      profiles += counted.written;
    }
    // Every stored list of the run the version does not hold any more: dropped (in every run,
    // so a rollback cannot bring an erased subject's list back either).
    const { removed } = plan;
    for (let index = 0; index < removed.length; index += MAX_PROFILE_ERASURE) {
      await store.deleteProfileLists(removed.slice(index, index + MAX_PROFILE_ERASURE));
    }
    await store.recordManifest(run, located.manifestSha256);
    const result: RecommendationImportResult = {
      status: "rewritten",
      run,
      previous: null,
      neighbourRows,
      profiles,
      expiredProfiles: plan.expired,
      withheldProfiles: plan.withheldCount,
      removedProfiles: removed.length,
      deleted: [],
      durationMs: clock.now() - started,
    };
    logger.info("recs.rewrite_applied", { ...result, deleted: "" });
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error("recs.rewrite_failed", { run, error: serializeError(error) });
    throw error instanceof RecommendationImportError
      ? error
      : new RecommendationImportError(`Rewrite of ${run} failed: ${reason}`, { cause: error });
  }
}

/**
 * Serves the previously active run again: one write (`activate`), because the importer keeps
 * the previous run's data. Null when there is nothing to roll back to.
 */
export async function rollbackRecommendations(
  store: RecommendationStore,
  now: number,
): Promise<{ from: string | null; to: string } | null> {
  const models = await store.models();
  const target = rollbackTarget(models);
  if (!target) return null;
  const from = models.find((model) => model.status === "active")?.run ?? null;
  await store.activate(target.run, now);
  return { from, to: target.run };
}

/** Keeps the active run and the newest `keep - 1` others that were served; deletes the rest. */
async function pruneRuns(
  store: RecommendationStore,
  keep: number,
  logger: Logger,
): Promise<string[]> {
  const models = await store.models();
  const kept = new Set<string>();
  const active = models.find((model) => model.status === "active");
  if (active) kept.add(active.run);
  const retained = models
    .filter((model) => model.status === "ready")
    .sort((a, b) => (b.activatedAt ?? b.importedAt) - (a.activatedAt ?? a.importedAt));
  for (const model of retained.slice(0, Math.max(0, keep - 1))) kept.add(model.run);
  const deleted: string[] = [];
  for (const model of models) {
    if (kept.has(model.run)) continue;
    try {
      await store.deleteRun(model.run);
      deleted.push(model.run);
    } catch (error) {
      // A run activated meanwhile (a rollback) is kept; the next import retries the others.
      logger.warn("recs.prune_skipped", { run: model.run, error: serializeError(error) });
    }
  }
  return deleted;
}

// --- Discovery and verification --------------------------------------------------------------

async function locateVersion(
  blobs: BlobStore,
  run: string | undefined,
): Promise<{ manifest: Manifest; manifestSha256: string }> {
  let manifestKey: string;
  let expectedSha: string | null = null;
  let pointerRun: string | null = null;
  if (run === undefined) {
    const pointerBytes = await readBlob(blobs, RECS_POINTER_KEY);
    if (!pointerBytes)
      throw new RecommendationImportError(`No ${RECS_POINTER_KEY}: nothing published`);
    const pointer = parseJsonObject(pointerBytes, RECS_POINTER_KEY);
    if (pointer.format !== POINTER_FORMAT) {
      throw new RecommendationImportError(`${RECS_POINTER_KEY}: not a ${POINTER_FORMAT}`);
    }
    requireMajor(pointer.formatVersion, RECS_POINTER_KEY);
    if (typeof pointer.run !== "string" || !RUN_PATTERN.test(pointer.run)) {
      throw new RecommendationImportError(`${RECS_POINTER_KEY}: invalid run`);
    }
    if (typeof pointer.manifest !== "string" || typeof pointer.manifestSha256 !== "string") {
      throw new RecommendationImportError(`${RECS_POINTER_KEY}: manifest and its digest required`);
    }
    manifestKey = pointer.manifest;
    expectedSha = pointer.manifestSha256.toLowerCase();
    pointerRun = pointer.run;
  } else {
    if (!RUN_PATTERN.test(run)) throw new RecommendationImportError(`Invalid run ${run}`);
    manifestKey = `${RECS_PREFIX}v=${run}/manifest.json`;
  }
  const manifestBytes = await readBlob(blobs, manifestKey);
  if (!manifestBytes) throw new RecommendationImportError(`No manifest at ${manifestKey}`);
  const manifestSha256 = await sha256Hex(manifestBytes);
  if (expectedSha !== null && manifestSha256 !== expectedSha) {
    throw new RecommendationImportError(
      `${manifestKey}: SHA-256 ${manifestSha256} does not match the pointer's ${expectedSha}`,
    );
  }
  const manifest = parseManifest(parseJsonObject(manifestBytes, manifestKey), manifestKey);
  const expectedRun = pointerRun ?? run;
  if (manifest.run !== expectedRun) {
    throw new RecommendationImportError(
      `${manifestKey}: run ${manifest.run}, expected ${expectedRun}`,
    );
  }
  return { manifest, manifestSha256 };
}

function parseManifest(value: Record<string, unknown>, key: string): Manifest {
  if (value.format !== MANIFEST_FORMAT) {
    throw new RecommendationImportError(`${key}: not a ${MANIFEST_FORMAT} manifest`);
  }
  requireMajor(value.formatVersion, key);
  const run = value.run;
  const asOf = Date.parse(String(value.asOf));
  const expiresAt = Date.parse(String(value.expiresAt));
  if (typeof run !== "string" || !RUN_PATTERN.test(run)) {
    throw new RecommendationImportError(`${key}: invalid run`);
  }
  if (!Number.isFinite(asOf) || !Number.isFinite(expiresAt) || expiresAt <= asOf) {
    throw new RecommendationImportError(
      `${key}: asOf and expiresAt must be ISO instants, in order`,
    );
  }
  if (!Array.isArray(value.files)) throw new RecommendationImportError(`${key}: files missing`);
  const files = value.files.map((entry: unknown): ManifestFile => {
    const file = (typeof entry === "object" && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    if (
      typeof file.path !== "string" ||
      typeof file.table !== "string" ||
      typeof file.sha256 !== "string" ||
      !Number.isInteger(file.bytes) ||
      !Number.isInteger(file.rows) ||
      file.path.split("/").some((segment) => segment === ".." || segment === "")
    ) {
      throw new RecommendationImportError(`${key}: malformed file entry`);
    }
    return {
      path: file.path,
      table: file.table,
      rows: file.rows as number,
      bytes: file.bytes as number,
      sha256: file.sha256.toLowerCase(),
    };
  });
  if (!files.some((file) => file.table === "neighbours")) {
    throw new RecommendationImportError(`${key}: no neighbours table`);
  }
  // Unknown tables are ignored within a major version (services/recs README).
  return { run, asOf, expiresAt, files };
}

function requireMajor(version: unknown, key: string): void {
  if (version !== SUPPORTED_MAJOR) {
    throw new RecommendationImportError(
      `${key}: format version ${String(version)} is not supported (this importer reads ${SUPPORTED_MAJOR})`,
    );
  }
}

async function readVerified(
  blobs: BlobStore,
  run: string,
  file: ManifestFile,
): Promise<ArrayBuffer> {
  const key = `${RECS_PREFIX}v=${run}/${file.path}`;
  const bytes = await readBlob(blobs, key);
  if (!bytes) throw new RecommendationImportError(`${key}: missing`);
  if (bytes.byteLength !== file.bytes) {
    throw new RecommendationImportError(
      `${key}: ${bytes.byteLength} bytes, the manifest says ${file.bytes}`,
    );
  }
  const digest = await sha256Hex(bytes);
  if (digest !== file.sha256) {
    throw new RecommendationImportError(`${key}: SHA-256 does not match the manifest`);
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function readBlob(blobs: BlobStore, key: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const object = await blobs.get(key);
  if (!object) return null;
  const bytes = new Uint8Array(object.size);
  let offset = 0;
  const reader = object.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (offset + value.byteLength > bytes.byteLength) {
      await reader.cancel();
      throw new RecommendationImportError(`${key}: longer than its declared size`);
    }
    bytes.set(value, offset);
    offset += value.byteLength;
  }
  if (offset !== bytes.byteLength) {
    throw new RecommendationImportError(`${key}: shorter than its declared size`);
  }
  return bytes;
}

function parseJsonObject(bytes: Uint8Array, key: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RecommendationImportError(`${key}: not JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecommendationImportError(`${key}: not a JSON object`);
  }
  return value as Record<string, unknown>;
}

// --- Parquet ----------------------------------------------------------------------------------

function metadataOf(bytes: ArrayBuffer, path: string, rows: number): FileMetaData {
  const metadata = parquetMetadata(bytes);
  if (Number(metadata.num_rows) !== rows) {
    throw new RecommendationImportError(
      `${path}: ${Number(metadata.num_rows)} rows, the manifest says ${rows}`,
    );
  }
  return metadata;
}

async function readRows(
  bytes: ArrayBuffer,
  metadata: FileMetaData,
  columns: string[],
  rowStart: number,
  rowEnd: number,
): Promise<Record<string, unknown>[]> {
  let result: Record<string, unknown>[] = [];
  await parquetRead({
    file: bytes,
    metadata,
    columns,
    rowStart,
    rowEnd,
    rowFormat: "object",
    onComplete: (rows) => {
      result = rows;
    },
  });
  return result;
}

/** Every neighbour row of the file, checked: ranks contiguous from 1, scores in (0, 1]. */
function readNeighboursRows(rows: Record<string, unknown>[], path: string): Neighbour[] {
  const neighbours: Neighbour[] = [];
  const lastRank = new Map<string, number>();
  for (const row of rows) {
    const neighbour: Neighbour = {
      titleId: String(row.title_id),
      rank: Number(row.rank),
      neighbourId: String(row.neighbour_id),
      score: Number(row.score),
      support: Number(row.support),
    };
    const expected = (lastRank.get(neighbour.titleId) ?? 0) + 1;
    if (neighbour.rank !== expected || neighbour.rank > MAX_NEIGHBOURS_PER_TITLE) {
      throw new RecommendationImportError(
        `${path}: ${neighbour.titleId} rank ${neighbour.rank}, expected ${expected} (ranks are contiguous, at most ${MAX_NEIGHBOURS_PER_TITLE})`,
      );
    }
    lastRank.set(neighbour.titleId, neighbour.rank);
    neighbours.push(neighbour);
  }
  return neighbours;
}

async function readNeighbours(bytes: ArrayBuffer, file: ManifestFile): Promise<Neighbour[]> {
  const metadata = metadataOf(bytes, file.path, file.rows);
  const rows = await readRows(
    bytes,
    metadata,
    ["title_id", "rank", "neighbour_id", "score", "support"],
    0,
    file.rows,
  );
  return readNeighboursRows(rows, file.path);
}

async function importProfiles(
  bytes: ArrayBuffer,
  file: ManifestFile,
  run: string,
  now: number,
  withheld: ReadonlySet<string>,
  write: (lists: ProfileLists[]) => Promise<void>,
): Promise<{ written: number; expired: number; withheld: number }> {
  const metadata = metadataOf(bytes, file.path, file.rows);
  let written = 0;
  let expired = 0;
  let skipped = 0;
  let rowStart = 0;
  // One row group at a time (at most 10,000 rows by the artefact contract): bounded memory.
  for (const group of metadata.row_groups) {
    const rowEnd = rowStart + Number(group.num_rows);
    const rows = await readRows(bytes, metadata, ["profile_key", "payload"], rowStart, rowEnd);
    const lists: ProfileLists[] = [];
    for (const row of rows) {
      const profileKey = String(row.profile_key);
      let decoded: ProfileLists;
      try {
        decoded = decodeProfileLists(String(row.payload));
      } catch (error) {
        throw new RecommendationImportError(
          `${file.path}: lists of ${profileKey}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (decoded.profileKey !== profileKey || decoded.run !== run) {
        throw new RecommendationImportError(
          `${file.path}: the payload of ${profileKey} names ${decoded.profileKey} in ${decoded.run}`,
        );
      }
      if (withheld.has(profileKey)) {
        skipped += 1;
        continue;
      }
      if (decoded.expiresAt <= now) {
        expired += 1;
        continue;
      }
      lists.push(decoded);
    }
    await write(lists);
    written += lists.length;
    rowStart = rowEnd;
  }
  return { written, expired, withheld: skipped };
}
