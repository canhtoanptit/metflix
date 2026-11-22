/** Tables of the personalisation area (migration 0005_personalisation). See schema.ts. */

export interface RecommendationModelsTable {
  run: string;
  /** `importing` | `active` | `retired`. */
  status: string;
  as_of: number;
  expires_at: number;
  imported_at: number;
  activated_at: number | null;
  manifest_sha256: string | null;
  error: string | null;
}

export interface RecommendationNeighboursTable {
  model_version: string;
  title_id: string;
  rank: number;
  neighbour_id: string;
  score: number;
  support: number;
}

export interface RecommendationProfilesTable {
  profile_key: string;
  model_version: string;
  /** The pipeline's profile-lists JSON, as imported. */
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

export interface PersonalisationTables {
  recommendation_models: RecommendationModelsTable;
  recommendation_neighbours: RecommendationNeighboursTable;
  recommendation_profiles: RecommendationProfilesTable;
  editorial_billboards: EditorialBillboardsTable;
  editorial_collections: EditorialCollectionsTable;
  editorial_collection_items: EditorialCollectionItemsTable;
  title_availability: TitleAvailabilityTable;
}

/** Parents first. */
export const PERSONALISATION_TABLES = [
  "recommendation_models",
  "recommendation_neighbours",
  "recommendation_profiles",
  "editorial_billboards",
  "editorial_collections",
  "editorial_collection_items",
  "title_availability",
] as const satisfies readonly (keyof PersonalisationTables)[];
