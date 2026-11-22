/** Tables of the experiments area (migration 0006_experiments). Representations: see schema.ts. */

export interface ExperimentsTable {
  key: string;
  name: string;
  description: string | null;
  status: string;
  unit: string;
  layer: string;
  allocation_start: number;
  allocation_end: number;
  salt: string;
  targeting_json: string;
  variants_json: string;
  control: string;
  primary_metric: string;
  secondary_metrics_json: string;
  alpha: number;
  power: number | null;
  minimum_detectable_effect: number;
  srm_threshold: number | null;
  starts_at: number | null;
  ends_at: number | null;
  registered_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
  /** The status assignment follows until `status_change_at` (0017). */
  previous_status: string | null;
  /** When `status` takes effect for assignment (0017); null: in effect. */
  status_change_at: number | null;
}

export interface ExperimentResultsTable {
  experiment_key: string;
  computed_at: number;
  report_json: string;
}

export interface ExperimentsTables {
  experiments: ExperimentsTable;
  experiment_results: ExperimentResultsTable;
}

/** Parents first. */
export const EXPERIMENTS_TABLES = [
  "experiments",
  "experiment_results",
] as const satisfies readonly (keyof ExperimentsTables)[];
