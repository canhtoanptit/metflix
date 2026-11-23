/**
 * Tables of the personalisation area (migrations 0005_personalisation, 0009_personalisation_lists).
 * See schema.ts.
 */

export interface RecommendationModelsTable {
  run: string;
  /** `importing` | `ready` | `active` | `failed` (`RECOMMENDATION_MODEL_STATUSES`). */
  status: string;
  as_of: number;
  expires_at: number;
  imported_at: number;
  activated_at: number | null;
  manifest_sha256: string | null;
  error: string | null;
  /** When the import completed (0009). */
  finished_at: number | null;
}

export interface RecommendationNeighboursTable {
  model_version: string;
  title_id: string;
  rank: number;
  neighbour_id: string;
  score: number;
  support: number;
}

/** Unused since 0009 (one row per profile cannot publish or roll back a run). */
export interface RecommendationProfilesTable {
  profile_key: string;
  model_version: string;
  /** The pipeline's profile-lists JSON, as imported. */
  payload: string;
  expires_at: number;
}

/** Per-profile lists keyed by run (0009): the pipeline's profile-lists JSON, as imported. */
export interface RecommendationProfileListsTable {
  model_version: string;
  profile_key: string;
  payload: string;
  expires_at: number;
}

export interface EditorialBillboardsTable {
  view: string;
  title_ids_json: string;
  updated_at: number;
  updated_by: string;
}

export interface EditorialCollectionsTable {
  id: string;
  name: string;
  description: string | null;
  view: string;
  position: number;
  status: string;
  created_at: number;
  updated_at: number;
  updated_by: string;
}

export interface EditorialCollectionItemsTable {
  collection_id: string;
  position: number;
  title_id: string;
}

export interface TitleAvailabilityTable {
  title_id: string;
  available: number;
  available_from: number | null;
  available_until: number | null;
  updated_at: number;
  updated_by: string;
}

export interface RecommendationWithdrawalsTable {
  subject_key: string;
  account_key: string;
  kind: string;
  withdrawn_at: number;
}

export interface PersonalisationTables {
  recommendation_models: RecommendationModelsTable;
  recommendation_neighbours: RecommendationNeighboursTable;
  recommendation_profiles: RecommendationProfilesTable;
  recommendation_profile_lists: RecommendationProfileListsTable;
  editorial_billboards: EditorialBillboardsTable;
  editorial_collections: EditorialCollectionsTable;
  editorial_collection_items: EditorialCollectionItemsTable;
  title_availability: TitleAvailabilityTable;
  recommendation_withdrawals: RecommendationWithdrawalsTable;
}

/** Parents first. */
export const PERSONALISATION_TABLES = [
  "recommendation_models",
  "recommendation_neighbours",
  "recommendation_profiles",
  "recommendation_profile_lists",
  "editorial_billboards",
  "editorial_collections",
  "editorial_collection_items",
  "title_availability",
  "recommendation_withdrawals",
] as const satisfies readonly (keyof PersonalisationTables)[];
