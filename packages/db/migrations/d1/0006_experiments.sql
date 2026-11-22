-- GENERATED from packages/db/src/migrations/experiments/0006_experiments.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

create table "experiments" ("key" text not null primary key, "name" text not null, "description" text, "status" text not null, "unit" text not null, "layer" text not null, "allocation_start" integer not null, "allocation_end" integer not null, "salt" text not null, "targeting_json" text not null, "variants_json" text not null, "control" text not null, "primary_metric" text not null, "secondary_metrics_json" text not null, "alpha" real not null, "power" real, "minimum_detectable_effect" real not null, "srm_threshold" real, "starts_at" integer, "ends_at" integer, "registered_at" integer, "version" integer not null, "created_at" integer not null, "updated_at" integer not null);
create index "experiments_status_idx" on "experiments" ("status");
create table "experiment_results" ("experiment_key" text not null, "computed_at" integer not null, "report_json" text not null, constraint "experiment_results_pkey" primary key ("experiment_key", "computed_at"));
