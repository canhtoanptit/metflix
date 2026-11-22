/**
 * Port: precomputed recommendations for serving (milestone 2 §3, §7.2). The importer job fills it
 * from the pipeline's artefacts (services/recs/README.md, "Artefacts: the contract for the
 * importer"); the engine reads it on the request path. SQLite (dev), PostgreSQL (k8s), D1 for
 * neighbours and KV for per-profile lists (Cloudflare).
 *
 * Contract (`describeRecommendationStoreContract`):
 * - Reads see the active model only: neighbours of a run being imported stay invisible until
 *   `activate(run)`, so a half-imported run is never served. `deleteRun` drops a retired run.
 * - Neighbours come back by rank (1-based, contiguous), at most `MAX_NEIGHBOURS_PER_TITLE` per
 *   title, for at most `MAX_NEIGHBOUR_LOOKUP` titles per call (bounded statements on D1).
 * - Per-profile lists are one read per profile, last write wins, and each names its run (a
 *   reader that sees old and new lists side by side during an import is consistent per
 *   profile). A list whose `expiresAt` has passed is not returned: the engine falls back to the
 *   milestone 1 rules (cold start, not an error).
 * - Writes are idempotent: importing the same run twice leaves one copy. Adapters chunk bulk
 *   writes to the 100-parameter limit (16 neighbour rows, 25 profile rows per statement).
 */
export interface RecommendationStore {
  activeModel(): Promise<RecommendationModel | null>;
  /** Neighbours in the active model of each title asked (titles without any are absent). */
  neighbours(titleIds: readonly string[]): Promise<Map<string, Neighbour[]>>;
  /** One profile's lists, or null (none, or expired at `now`, epoch ms). */
  profileLists(profileKey: string, now: number): Promise<ProfileLists | null>;

  // --- The importer ---------------------------------------------------------------------------
  /** Registers a run being imported (idempotent). Nothing of it is served yet. */
  beginImport(model: RecommendationModel): Promise<void>;
  putNeighbours(run: string, rows: readonly Neighbour[]): Promise<void>;
  putProfileLists(lists: readonly ProfileLists[]): Promise<void>;
  /** Serve `run` from now on (it must have been begun). */
  activate(run: string): Promise<void>;
  /** Drop a run's neighbours and registration (never the active run). */
  deleteRun(run: string): Promise<void>;
  /** Drop the lists of profiles absent from the new run (the importer computes which). */
  deleteProfileLists(profileKeys: readonly string[]): Promise<void>;
}

export interface RecommendationModel {
  /** `YYYYMMDD-HHMMSS-<recipe8>` (the pipeline's manifest `run`). */
  run: string;
  /** Knowledge cutoff, epoch ms. */
  asOf: number;
  /** After this the lists are stale (asOf + 3 days), epoch ms. */
  expiresAt: number;
  /** When the import began, epoch ms. */
  importedAt: number;
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
export const MAX_NEIGHBOUR_LOOKUP = 25;

/** Shared validation of a neighbour lookup: every adapter calls it. */
export function assertNeighbourLookup(titleIds: readonly string[]): void {
  if (titleIds.length > MAX_NEIGHBOUR_LOOKUP) {
    throw new RangeError(`At most ${MAX_NEIGHBOUR_LOOKUP} titles per neighbour lookup`);
  }
}

/** Shared validation of neighbour rows before they are written. */
export function assertNeighbours(rows: readonly Neighbour[]): void {
  for (const row of rows) {
    if (!Number.isInteger(row.rank) || row.rank < 1 || row.rank > MAX_NEIGHBOURS_PER_TITLE) {
      throw new RangeError(`Neighbour rank must be 1-${MAX_NEIGHBOURS_PER_TITLE}`);
    }
    if (row.neighbourId === row.titleId) throw new RangeError("A title is not its own neighbour");
    if (!(row.score > 0 && row.score <= 1))
      throw new RangeError("Neighbour score must be in (0, 1]");
  }
}
