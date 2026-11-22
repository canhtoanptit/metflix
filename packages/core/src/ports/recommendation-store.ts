/**
 * Port: precomputed recommendations for serving (milestone 2 §3, §7.2). The importer
 * (`areas/personalisation/importer.ts`) fills it from the pipeline's artefacts
 * (services/recs/README.md, "Artefacts: the contract for the importer"); the request path reads
 * the active run. SQLite (dev), PostgreSQL (k8s), D1 for models and neighbours with Workers KV
 * for per-profile lists (Cloudflare).
 *
 * Everything is scoped by run, so importing is a publish, not a copy:
 * - A run is begun (`importing`), filled, then activated. Readers only ever ask for the active
 *   run (`activeModel`, `servingSnapshot`), so a half-imported run is never served, and the
 *   switch is one write (`activate`), visible all at once.
 * - The previous run keeps its data until it is deleted: rolling back is `activate(previous)`,
 *   one write again. The importer keeps a bounded number of runs (`deleteRun` for the rest).
 *
 * Contract (`describeRecommendationStoreContract`):
 * - `activate` makes exactly one run `active` (the one before it becomes `ready`) and refuses a
 *   run that was never begun or that failed; `deleteRun` refuses the active run.
 * - `servingSnapshot` is the active run's registration and every neighbour row of it in one
 *   read, by title then rank; null before the first activation.
 * - Neighbours: at most `MAX_NEIGHBOURS_PER_TITLE` per title, ranks 1-based, scores in (0, 1]
 *   (`assertNeighbours`); writing the same rows twice leaves one copy.
 * - Per-profile lists are keyed by (run, profile key), one read per profile; a list whose
 *   `expiresAt` has passed is not returned (cold start, not an error). Writing the same list
 *   twice leaves one copy.
 * - Adapters chunk bulk writes to the 100-parameter limit (16 neighbour rows, 25 profile rows
 *   per statement on SQL; KV writes one key per list).
 */
export interface RecommendationStore {
  /** The run being served, or null (nothing activated yet). */
  activeModel(): Promise<RecommendationModel | null>;
  /** Every registered run, most recently imported first. */
  models(): Promise<RecommendationModel[]>;
  /** The active run and all its neighbour rows, in one read (what serving caches). */
  servingSnapshot(): Promise<ServingSnapshot | null>;
  /** One profile's lists in `run`, or null (none, or expired at `now`, epoch ms). */
  profileLists(run: string, profileKey: string, now: number): Promise<ProfileLists | null>;

  // --- The importer ---------------------------------------------------------------------------
  /**
   * Registers `run` as `importing` (again, if it was `ready` or `failed`: idempotent). Nothing
   * of it is served. Refuses the active run: it is never rewritten in place.
   */
  beginImport(model: NewRecommendationModel): Promise<void>;
  putNeighbours(run: string, rows: readonly Neighbour[]): Promise<void>;
  /** Lists of `run` (each list's `run` must be `run`). */
  putProfileLists(run: string, lists: readonly ProfileLists[]): Promise<void>;
  /** Marks a begun run `failed` with the reason (it stays unserved; `deleteRun` drops it). */
  failImport(run: string, error: string): Promise<void>;
  /** Serve `run` from now on (one write). The previously active run becomes `ready`. */
  activate(run: string, now: number): Promise<void>;
  /** Drops a run's registration, neighbours and lists (never the active run). */
  deleteRun(run: string): Promise<void>;
  /**
   * Drops these profiles' lists in every registered run (account deletion, §6.3): nothing of
   * them is served or kept afterwards. At most `MAX_PROFILE_ERASURE` keys per call.
   */
  deleteProfileLists(profileKeys: readonly string[]): Promise<void>;
}

export const RECOMMENDATION_MODEL_STATUSES = ["importing", "ready", "active", "failed"] as const;
export type RecommendationModelStatus = (typeof RECOMMENDATION_MODEL_STATUSES)[number];

export interface NewRecommendationModel {
  /** `YYYYMMDD-HHMMSS-<recipe8>` (the pipeline's manifest `run`). */
  run: string;
  /** Knowledge cutoff, epoch ms. */
  asOf: number;
  /** After this the lists are stale (asOf + 3 days), epoch ms. */
  expiresAt: number;
  /** When the import began, epoch ms. */
  importedAt: number;
  /** SHA-256 of the manifest that was imported. */
  manifestSha256: string | null;
}

export interface RecommendationModel extends NewRecommendationModel {
  status: RecommendationModelStatus;
  /** Last time it became the active run (null: never served). */
  activatedAt: number | null;
  /** When its import completed (its first activation); null while importing or failed. */
  finishedAt: number | null;
  /** Why the import failed (`failed` only). */
  error: string | null;
}

export interface ServingSnapshot {
  model: RecommendationModel;
  /** Every neighbour row of the active run, by title id then rank. */
  neighbours: Neighbour[];
}

export interface Neighbour {
  titleId: string;
  /** 1-based, contiguous per title. */
  rank: number;
  neighbourId: string;
  /** In (0, 1], non-increasing with rank. */
  score: number;
  /** Profiles who watched both (0: content-only similarity). */
  support: number;
}

/** One profile's lists (the pipeline's `recs-profile-lists` payload, decoded). */
export interface ProfileLists {
  /** Pseudonymous profile key (22 characters). */
  profileKey: string;
  run: string;
  generatedAt: number;
  expiresAt: number;
  rows: ProfileListRow[];
}

export interface ProfileListRow {
  /** `personal`, `top-picks`, `billboard`, `because-you-watched`; unknown types are ignored. */
  type: string;
  /** `because-you-watched`: the source title id; otherwise null. */
  param: string | null;
  /** [titleId, score], in the row's order. */
  items: [string, number][];
}

export const MAX_NEIGHBOURS_PER_TITLE = 40;
/** Profile keys per `deleteProfileLists` call (an account has at most a handful). */
export const MAX_PROFILE_ERASURE = 50;

/** Shared validation of neighbour rows before they are written: every adapter calls it. */
export function assertNeighbours(rows: readonly Neighbour[]): void {
  for (const row of rows) {
    if (!Number.isInteger(row.rank) || row.rank < 1 || row.rank > MAX_NEIGHBOURS_PER_TITLE) {
      throw new RangeError(`Neighbour rank must be 1-${MAX_NEIGHBOURS_PER_TITLE}`);
    }
    if (row.neighbourId === row.titleId) throw new RangeError("A title is not its own neighbour");
    if (!(row.score > 0 && row.score <= 1)) {
      throw new RangeError("Neighbour score must be in (0, 1]");
    }
    if (!Number.isInteger(row.support) || row.support < 0) {
      throw new RangeError("Neighbour support must be a whole number");
    }
  }
}

/** Shared validation of per-profile lists before they are written: every adapter calls it. */
export function assertProfileLists(run: string, lists: readonly ProfileLists[]): void {
  for (const list of lists) {
    if (list.run !== run) {
      throw new RangeError(`Lists of ${list.profileKey} belong to ${list.run}, not ${run}`);
    }
    if (!/^[A-Za-z0-9_-]{22}$/.test(list.profileKey)) {
      throw new RangeError("A profile key is 22 base64url characters");
    }
  }
}

/**
 * The stored form of one profile's lists: exactly the pipeline's payload format
 * (`schemas/recs-profile-lists.schema.json`: `v`, `profile`, `run`, ISO `generatedAt` and
 * `expiresAt`, `rows`), so a KV value or a database row reads like the artefact it came from.
 */
export function encodeProfileLists(lists: ProfileLists): string {
  return JSON.stringify({
    v: PROFILE_LISTS_VERSION,
    profile: lists.profileKey,
    run: lists.run,
    generatedAt: new Date(lists.generatedAt).toISOString(),
    expiresAt: new Date(lists.expiresAt).toISOString(),
    rows: lists.rows,
  });
}

export const PROFILE_LISTS_VERSION = 1;

/**
 * Parses a payload (the pipeline's or `encodeProfileLists`'). Refuses an unknown major version
 * and malformed shapes; ignores fields it does not know (services/recs README: readers ignore
 * what they do not know within a major). Unknown row types are kept: the engine ignores them.
 */
export function decodeProfileLists(payload: string): ProfileLists {
  const value: unknown = JSON.parse(payload);
  if (typeof value !== "object" || value === null) throw new TypeError("Lists: not an object");
  const record = value as Record<string, unknown>;
  if (record.v !== PROFILE_LISTS_VERSION) {
    throw new TypeError(`Lists: unsupported version ${String(record.v)}`);
  }
  const generatedAt = Date.parse(String(record.generatedAt));
  const expiresAt = Date.parse(String(record.expiresAt));
  if (typeof record.profile !== "string" || typeof record.run !== "string") {
    throw new TypeError("Lists: profile and run must be strings");
  }
  if (!Number.isFinite(generatedAt) || !Number.isFinite(expiresAt)) {
    throw new TypeError("Lists: generatedAt and expiresAt must be ISO instants");
  }
  if (!Array.isArray(record.rows)) throw new TypeError("Lists: rows must be an array");
  const rows = record.rows.map((row: unknown): ProfileListRow => {
    const entry = (typeof row === "object" && row !== null ? row : {}) as Record<string, unknown>;
    if (typeof entry.type !== "string") throw new TypeError("Lists: a row needs a type");
    if (entry.param !== null && typeof entry.param !== "string") {
      throw new TypeError("Lists: a row's param is a string or null");
    }
    if (!Array.isArray(entry.items)) throw new TypeError("Lists: a row's items must be an array");
    const items = entry.items.map((item: unknown): [string, number] => {
      if (
        !Array.isArray(item) ||
        typeof item[0] !== "string" ||
        typeof item[1] !== "number" ||
        !Number.isFinite(item[1])
      ) {
        throw new TypeError("Lists: an item is [titleId, score]");
      }
      return [item[0], item[1]];
    });
    return { type: entry.type, param: entry.param, items };
  });
  return { profileKey: record.profile, run: record.run, generatedAt, expiresAt, rows };
}

/** The run that `activate` would roll back to: the most recently served run still kept. */
export function rollbackTarget(models: readonly RecommendationModel[]): RecommendationModel | null {
  return (
    models
      .filter((model) => model.status === "ready" && model.activatedAt !== null)
      .sort((a, b) => (b.activatedAt ?? 0) - (a.activatedAt ?? 0))[0] ?? null
  );
}
