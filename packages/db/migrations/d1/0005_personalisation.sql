-- GENERATED from packages/db/src/migrations/personalisation/0005_personalisation.ts. Do not edit.
-- Regenerate with `pnpm --filter @webflix/db generate`; apply with `wrangler d1 migrations apply`.

create table "recommendation_models" ("run" text not null primary key, "status" text not null, "as_of" integer not null, "expires_at" integer not null, "imported_at" integer not null, "activated_at" integer, "manifest_sha256" text, "error" text);
create table "recommendation_neighbours" ("model_version" text not null, "title_id" text not null, "rank" integer not null, "neighbour_id" text not null, "score" real not null, "support" integer not null, constraint "recommendation_neighbours_pkey" primary key ("model_version", "title_id", "rank"));
create table "recommendation_profiles" ("profile_key" text not null primary key, "model_version" text not null, "payload" text not null, "expires_at" integer not null);
create index "recommendation_profiles_model_idx" on "recommendation_profiles" ("model_version");
create table "editorial_billboards" ("view" text not null primary key, "title_ids_json" text not null, "updated_at" integer not null, "updated_by" text not null);
create table "editorial_collections" ("id" text not null primary key, "name" text not null, "description" text, "view" text not null, "position" integer not null, "status" text not null, "created_at" integer not null, "updated_at" integer not null, "updated_by" text not null);
create table "editorial_collection_items" ("collection_id" text not null references "editorial_collections" ("id") on delete cascade, "position" integer not null, "title_id" text not null, constraint "editorial_collection_items_pkey" primary key ("collection_id", "position"));
create table "title_availability" ("title_id" text not null primary key, "available" integer not null, "available_from" integer, "available_until" integer, "updated_at" integer not null, "updated_by" text not null);
