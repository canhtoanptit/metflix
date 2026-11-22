import type { BrowseView } from "@webflix/contracts";
import type { AuditRecord } from "../experiments/audit.ts";

/**
 * Repository port of the personalisation area's editorial data (what staff control, milestone
 * 2 §8.3): billboards pinned per view, curated collections (editorial rows) and title
 * availability overrides, in `editorial_billboards`, `editorial_collections`,
 * `editorial_collection_items` and `title_availability` (migrations under
 * `packages/db/src/migrations/personalisation/`). They are separate from the catalogue's tables,
 * which the seeder rewrites, so staff decisions survive a re-seed. Every staff change writes its
 * `audit_log` row in the same batch. The recommendation models are the `RecommendationStore`'s.
 *
 * Implemented in memory by `packages/core/src/memory/areas/personalisation.ts` and on every
 * dialect by `packages/db/src/repositories/areas/personalisation.ts`; both pass
 * `describePersonalisationRepositoryContract`. The D1 rules hold: one batch per write, at most
 * 100 bound parameters per statement, and serving reads everything in one round trip
 * (`loadEditorial`).
 */
export interface PersonalisationRepository {
  /** Everything serving needs, in one round trip (cached by serving). */
  loadEditorial(): Promise<EditorialData>;
  getBillboard(view: BrowseView): Promise<EditorialBillboardRecord | null>;
  /** Replaces a view's pinned titles (empty: the engine chooses), with its audit row. */
  setBillboard(record: EditorialBillboardRecord, audit: AuditRecord): Promise<void>;
  listCollections(): Promise<EditorialCollectionRecord[]>;
  getCollection(id: string): Promise<EditorialCollectionRecord | null>;
  /** Creates or replaces a collection and its items, with its audit row. */
  saveCollection(record: EditorialCollectionRecord, audit: AuditRecord): Promise<void>;
  /** Deletes a collection and its items, with its audit row; false if there was none. */
  deleteCollection(id: string, audit: AuditRecord): Promise<boolean>;
  getAvailability(titleId: string): Promise<TitleAvailabilityRecord | null>;
  /** Sets a title's availability override, with its audit row. */
  setAvailability(record: TitleAvailabilityRecord, audit: AuditRecord): Promise<void>;
}

export interface EditorialBillboardRecord {
  view: BrowseView;
  titleIds: string[];
  updatedAt: number;
  updatedBy: string;
}

export interface EditorialCollectionRecord {
  id: string;
  name: string;
  description: string | null;
  view: BrowseView;
  /** Row position on the view (1-based) once published. */
  position: number;
  status: "draft" | "published";
  titleIds: string[];
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}

export interface TitleAvailabilityRecord {
  titleId: string;
  available: boolean;
  availableFrom: number | null;
  availableUntil: number | null;
  updatedAt: number;
  updatedBy: string;
}

export interface EditorialData {
  billboards: EditorialBillboardRecord[];
  /** Published collections only, by view then position. */
  collections: EditorialCollectionRecord[];
  availability: TitleAvailabilityRecord[];
}

/** Whether staff made a title unavailable at `now` (no override: available). */
export function isUnavailable(record: TitleAvailabilityRecord | undefined, now: number): boolean {
  if (!record) return false;
  if (!record.available) return true;
  if (record.availableFrom !== null && now < record.availableFrom) return true;
  if (record.availableUntil !== null && now >= record.availableUntil) return true;
  return false;
}
